import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError, type Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { defineString } from "firebase-functions/params";
import { z } from "zod";
import { db } from "./firebase";
import { assertReplacementRequest, assertSubmissionCounters, assertSubmissionFileIdentity } from "./submission-integrity";
import { getReadonlyDriveClient } from "./google-drive-client";
import { companyFromClaims, requireAuth, staffFromClaims } from "./utils";
import { readActiveStaffProfile, readStaffDeviceCredential, type StaffDeviceCredential } from "./staff-session";

export const filePreviewGatewayUrl = defineString("FILE_PREVIEW_GATEWAY_URL", { default: "" });

const PreviewIdSchema = z.string().min(1).refine((value) => value.trim().length > 0 && !value.includes("/"));
const HISTORY_PAGE_SIZE = 10;
const TimelineSchema = z.object({
  jobId: z.string().min(1),
  type: z.enum(["report", "sales_floor"]),
  // Existing Firebase clients serialize an undefined optional property as null.
  previewFile: z.object({ submissionId: PreviewIdSchema, fileId: PreviewIdSchema }).nullish().transform((value) => value ?? undefined),
  previewMode: z.literal("on-demand").optional(),
  page: z.object({ afterSubmissionId: PreviewIdSchema.optional() }).strict().nullish(),
}).refine(input => (!input.previewFile || !input.previewMode) && (!input.page || input.previewMode === "on-demand"));
const ComparisonSchema = z.object({ requestId: z.string().min(1) });
const ProcessingStatusSchema = z.object({
  jobId: z.string().min(1),
  submissionId: z.string().min(1),
});

type FileView = {
  id: string;
  submissionId: string;
  originalName: string;
  driveName: string;
  contentType: string;
  sequence: number | null;
  purpose: string;
  status: string;
  previewUrl: string | null;
  completedAt: string | null;
  replacesFileId: string | null;
};

type SubmissionActor = { uid: string; role: "admin" } |
  { uid: string; role: "staff"; staffId: string; authTime: number | null; deviceCredential: StaffDeviceCredential | null };

async function readSubmissionActor(
  session: ReturnType<typeof requireAuth>,
  companyId: string,
  tx?: FirebaseFirestore.Transaction,
): Promise<SubmissionActor> {
  if (session.token.role === "admin") return { uid: session.uid, role: "admin" };
  if (session.token.role !== "staff") throw new HttpsError("permission-denied", "スタッフ権限が必要です。");
  const staffId = staffFromClaimsSafe(session.token);
  const authTime = session.token.auth_time;
  // Read-only transactions can use an older snapshot for authorization data.
  const confirmStaff = (reader: FirebaseFirestore.Transaction) =>
    readActiveStaffProfile(reader, companyId, staffId, session.uid, authTime, { requireIdentity: true, deviceClaims: session.token });
  if (tx) await confirmStaff(tx);
  else await db.runTransaction(confirmStaff);
  return { uid: session.uid, role: "staff", staffId, deviceCredential: readStaffDeviceCredential(session.token),
    authTime: typeof authTime === "number" && Number.isSafeInteger(authTime) ? authTime : null };
}

export const getSubmissionTimeline = onCall(async (request) => {
  const session = requireAuth(request);
  const input = TimelineSchema.parse(request.data ?? {});
  const companyId = companyFromClaims(session.token);
  const actor = await readSubmissionActor(session, companyId);
  await assertJobAccess(input.jobId, companyId, actor.role, actor.role === "staff" ? actor.staffId : "");

  const collection = db.collection("submissions");
  const matchesScope = (data: FirebaseFirestore.DocumentData | undefined): data is FirebaseFirestore.DocumentData =>
    !!data && data.companyId === companyId && data.jobId === input.jobId && data.type === input.type &&
    (actor.role === "admin" || data.staffId === actor.staffId);

  if (input.previewFile) {
    const { submissionId, fileId } = input.previewFile;
    const submission = await collection.doc(submissionId).get();
    const data = submission.data();
    if (!matchesScope(data)) return { submissions: [] };
    const file = await submission.ref.collection("files").doc(fileId).get();
    if (!file.exists) return { submissions: [] };
    const fileData = file.data()!;
    assertSubmissionFileIdentity(data, fileData, submissionId);
    return { submissions: [{
      id: submissionId, type: data.type, purpose: data.purpose, status: data.status,
      createdAt: iso(data.createdAt), completedAt: iso(data.completedAt),
      files: [await fileView(companyId, actor, submissionId, fileId, fileData)],
    }] };
  }

  const query = collection
    .where("companyId", "==", companyId)
    .where("jobId", "==", input.jobId)
    .where("type", "==", input.type);
  const scoped = actor.role === "staff" ? query.where("staffId", "==", actor.staffId) : query;
  const ordered = scoped.orderBy("createdAt", "desc");
  let pageQuery = ordered;
  if (input.page?.afterSubmissionId) {
    const cursor = await collection.doc(input.page.afterSubmissionId).get();
    const data = cursor.data();
    if (!matchesScope(data) || data.createdAt === undefined) {
      throw new HttpsError("failed-precondition", "提出履歴の続きが確認できません。最初から読み直してください。");
    }
    // The snapshot cursor includes the document ID, even when creation timestamps are identical.
    pageQuery = ordered.startAfter(cursor);
  }
  const submissions = await pageQuery.limit(input.page ? HISTORY_PAGE_SIZE + 1 : 100).get();
  const visible = input.page
    ? submissions.docs.slice(0, HISTORY_PAGE_SIZE)
    : submissions.docs.sort((a, b) => timestampMillis(b.data().createdAt) - timestampMillis(a.data().createdAt));
  const checked = await Promise.all(visible.map(async (submission) => {
    const files = await submission.ref.collection("files").orderBy("createdAt", "asc").limit(30).get();
    for (const file of files.docs) assertSubmissionFileIdentity(submission.data(), file.data(), submission.id);
    return { submission, files };
  }));
  const groups = await Promise.all(checked.map(async ({ submission, files }) => {
    const views = await Promise.all(
      files.docs.map((file) => fileView(companyId, actor, submission.id, file.id, file.data(), input.previewMode !== "on-demand"))
    );
    return {
      id: submission.id,
      type: submission.data().type,
      purpose: submission.data().purpose,
      status: submission.data().status,
      createdAt: iso(submission.data().createdAt),
      completedAt: iso(submission.data().completedAt),
      files: views,
    };
  }));
  if (!input.page) return { submissions: groups };
  const nextCursor = submissions.docs.length > HISTORY_PAGE_SIZE ? (visible.at(-1)?.id ?? null) : null;
  return { submissions: groups, nextCursor };
});

export const getSubmissionProcessingStatus = onCall(async (request) => {
  const session = requireAuth(request);
  const input = ProcessingStatusSchema.parse(request.data ?? {});
  const companyId = companyFromClaims(session.token);
  return db.runTransaction(async tx => {
    const actor = await readSubmissionActor(session, companyId, tx);
    await assertJobAccess(input.jobId, companyId, actor.role, actor.role === "staff" ? actor.staffId : "", tx);

    const snap = await tx.get(db.collection("submissions").doc(input.submissionId));
    if (!snap.exists || snap.data()?.companyId !== companyId) {
      throw new HttpsError("not-found", "提出が見つかりません。");
    }
    const data = snap.data()!;
    if (actor.role === "staff" && data.staffId !== actor.staffId) {
      throw new HttpsError("permission-denied", "この提出を確認できません。");
    }
    if (data.jobId !== input.jobId) {
      throw new HttpsError("permission-denied", "案件と提出が一致しません。");
    }

    assertSubmissionCounters(data);
    let status = String(data.status ?? "uploading");
    if (status === "completed") {
      if (data.completedFiles !== data.totalFiles) throw new HttpsError("failed-precondition", "提出の完了数が一致しません。");
      if (data.jobStatusApplied !== true) status = "processing";
      if (data.resubmissionRequestId) {
        const replacement = await tx.get(db.collection("resubmissionRequests").doc(String(data.resubmissionRequestId)));
        assertReplacementRequest(replacement.data(), data, snap.id);
        if (replacement.data()?.status === "open") status = "processing";
      }
    }
    return {
      status,
      completedFiles: Number(data.completedFiles ?? 0),
      totalFiles: Number(data.totalFiles ?? 0),
      errorMessage: data.errorMessage ? String(data.errorMessage) : null,
    };
  });
});

export const getResubmissionComparison = onCall(async (request) => {
  const session = requireAuth(request);
  const input = ComparisonSchema.parse(request.data ?? {});
  const companyId = companyFromClaims(session.token);
  const actor = await readSubmissionActor(session, companyId);
  const ref = db.collection("resubmissionRequests").doc(input.requestId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.companyId !== companyId) throw new HttpsError("not-found", "再提出依頼が見つかりません。");
  const data = snap.data()!;
  if (actor.role === "staff" && data.staffId !== actor.staffId) throw new HttpsError("permission-denied", "この再提出依頼を確認できません。");

  await assertJobAccess(String(data.jobId ?? ""), companyId, actor.role, actor.role === "staff" ? actor.staffId : "");
  const assertComparisonSubmission = (submission: FirebaseFirestore.DocumentData | undefined, replacement = false) => {
    if (!submission || ["companyId", "jobId", "type"].some(key => submission[key] !== data[key]) ||
        (replacement && (submission.staffId !== data.staffId || submission.resubmissionRequestId !== snap.id))) {
      throw new HttpsError("failed-precondition", "再提出依頼と画像の所属情報が一致しません。");
    }
    if (actor.role === "staff" && submission.staffId !== actor.staffId)
      throw new HttpsError("permission-denied", "この提出を確認できません。");
  };
  let sourceFile: FirebaseFirestore.DocumentSnapshot | null = null;
  if (data.sourceSubmissionId && data.sourceFileId) {
    const submission = await db.collection("submissions").doc(String(data.sourceSubmissionId)).get();
    assertComparisonSubmission(submission.data());
    const file = await submission.ref.collection("files").doc(String(data.sourceFileId)).get();
    if (file.exists) {
      assertSubmissionFileIdentity(submission.data(), file.data(), submission.id);
      sourceFile = file;
    }
  }
  let replacementFiles: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  if (data.replacementSubmissionId) {
    const submission = await db.collection("submissions").doc(String(data.replacementSubmissionId)).get();
    assertComparisonSubmission(submission.data(), true);
    const files = await submission.ref.collection("files").orderBy("createdAt", "asc").get();
    for (const file of files.docs) assertSubmissionFileIdentity(submission.data(), file.data(), submission.id);
    replacementFiles = files.docs;
  }
  // 全参照の照合が済むまでプレビュートークンを発行しない。
  const source = sourceFile ? await fileView(companyId, actor, String(data.sourceSubmissionId), sourceFile.id, sourceFile.data()!) : null;
  const replacements = await Promise.all(replacementFiles.map(file => fileView(companyId, actor, String(data.replacementSubmissionId), file.id, file.data())));
  return {
    request: { id: snap.id, jobId: data.jobId, type: data.type, scope: data.sourceFileId ? "file" : "submission", reasons: data.reasons ?? [], note: data.note ?? "", status: data.status, createdAt: iso(data.createdAt), submittedAt: iso(data.submittedAt) },
    source,
    replacements,
  };
});

async function handleDriveFilePreview(request: Request, response: Response) {
  try {
    response.setHeader("Cache-Control", "private, no-store");
    const token = String(request.query.token ?? "");
    if (!/^[A-Za-z0-9_-]{30,120}$/.test(token)) { response.status(400).send("Invalid preview token"); return; }
    const hash = sha256(token);
    const access = await db.runTransaction(async tx => {
      const snap = await tx.get(db.collection("filePreviewTokens").doc(hash));
      if (!snap.exists) return { error: 404 } as const;
      const data = snap.data()!;
      const expires = data.expiresAt;
      if (data.active !== true || !(expires instanceof Timestamp) || expires.toMillis() <= Date.now() ||
          (data.actorRole !== "staff" && data.actorRole !== "admin") ||
          ![data.actorUid, data.jobId, data.submissionId, data.fileId].every(validDocumentId)) {
        return { error: 410 } as const;
      }
      const submissionRef = db.collection("submissions").doc(data.submissionId);
      const [submission, file] = await Promise.all([tx.get(submissionRef), tx.get(submissionRef.collection("files").doc(data.fileId))]);
      const currentFile = file.data(), parent = submission.data();
      assertSubmissionFileIdentity(parent, currentFile, data.submissionId);
      if (!parent || parent.companyId !== data.companyId || parent.jobId !== data.jobId ||
          currentFile?.status !== "completed" || currentFile.driveFileId !== data.driveFileId ||
          currentFile.contentType !== data.contentType) {
        return { error: 410 } as const;
      }
      if (data.actorRole === "staff") {
        if (parent.staffId !== data.actorStaffId || !validDocumentId(data.actorStaffId)) return { error: 410 } as const;
        await readActiveStaffProfile(tx, data.companyId, data.actorStaffId, data.actorUid, data.actorAuthTime, { requireIdentity: true, deviceClaims: data.actorDeviceCredential ?? {} });
        await assertJobAccess(data.jobId, data.companyId, "staff", data.actorStaffId, tx);
      }
      return { data, ref: snap.ref, expires } as const;
    });
    if (access.error !== undefined) {
      response.status(access.error).send(access.error === 404 ? "Preview not found" : "Preview expired");
      return;
    }
    const { data, ref, expires } = access;
    if (expires.toMillis() <= Date.now()) { response.status(410).send("Preview expired"); return; }
    const drive = getReadonlyDriveClient();
    const result = await drive.files.get({ fileId: String(data.driveFileId), alt: "media", supportsAllDrives: true }, { responseType: "stream" });
    response.setHeader("Content-Type", String(data.contentType || "application/octet-stream"));
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(String(data.fileName || "file"))}`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    await ref.set({ lastOpenedAt: FieldValue.serverTimestamp(), openCount: FieldValue.increment(1) }, { merge: true });
    (result.data as NodeJS.ReadableStream).on("error", () => { if (!response.headersSent) response.status(500).end(); else response.end(); }).pipe(response);
  } catch (error) {
    if (error instanceof HttpsError && ["not-found", "permission-denied", "failed-precondition"].includes(error.code)) {
      if (!response.headersSent) response.status(410).send("Preview expired");
      return;
    }
    console.error("driveFilePreview failed", error);
    if (!response.headersSent) response.status(500).send("Preview error");
  }
}

export const driveFilePreview = onRequest(handleDriveFilePreview);

function isPreviewableFile(contentType: string): boolean {
  return contentType.startsWith("image/") || contentType === "application/pdf";
}

async function fileView(companyId: string, actor: SubmissionActor, submissionId: string, fileId: string, data: FirebaseFirestore.DocumentData, includePreview = true): Promise<FileView> {
  let previewUrl: string | null = null;
  const contentType = String(data.contentType ?? "");
  const base = includePreview ? filePreviewGatewayUrl.value().trim() : "";
  if (base && data.status === "completed" && data.driveFileId && isPreviewableFile(contentType)) {
    const raw = randomBytes(32).toString("base64url");
    const hash = sha256(raw);
    await db.collection("filePreviewTokens").doc(hash).set({
      companyId,
      actorUid: actor.uid,
      actorRole: actor.role,
      ...(actor.role === "staff" ? { actorStaffId: actor.staffId, actorAuthTime: actor.authTime, ...(actor.deviceCredential ? { actorDeviceCredential: actor.deviceCredential } : {}) } : {}),
      jobId: data.jobId,
      submissionId,
      fileId,
      driveFileId: data.driveFileId,
      fileName: data.driveName ?? data.originalName,
      contentType,
      active: true,
      expiresAt: Timestamp.fromMillis(Date.now() + 15 * 60 * 1000),
      createdAt: FieldValue.serverTimestamp(),
    });
    previewUrl = `${base}?token=${encodeURIComponent(raw)}`;
  }
  return {
    id: fileId,
    submissionId,
    originalName: String(data.originalName ?? ""),
    driveName: String(data.driveName ?? ""),
    contentType,
    sequence: Number.isFinite(Number(data.sequence)) ? Number(data.sequence) : null,
    purpose: String(data.purpose ?? ""),
    status: String(data.status ?? ""),
    previewUrl,
    completedAt: iso(data.completedAt),
    replacesFileId: data.replacesFileId ? String(data.replacesFileId) : null,
  };
}

async function assertJobAccess(jobId: string, companyId: string, role: unknown, staffId: string, tx?: FirebaseFirestore.Transaction) {
  const ref = db.collection("jobs").doc(jobId);
  const job = await (tx ? tx.get(ref) : ref.get());
  if (!job.exists || job.data()?.companyId !== companyId) throw new HttpsError("not-found", "案件が見つかりません。");
  if (role !== "admin" && (!staffId.trim() || job.data()?.assignedStaffId !== staffId)) throw new HttpsError("permission-denied", "この案件を確認できません。");
}

function validDocumentId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("/");
}

function staffFromClaimsSafe(token: Record<string, unknown>): string { try { return staffFromClaims(token); } catch { return ""; } }
function sha256(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function timestampMillis(value: unknown): number { return value instanceof Timestamp ? value.toMillis() : 0; }
function iso(value: unknown): string | null { return value instanceof Timestamp ? value.toDate().toISOString() : null; }
