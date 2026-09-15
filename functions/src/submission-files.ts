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

export const filePreviewGatewayUrl = defineString("FILE_PREVIEW_GATEWAY_URL", { default: "" });

const PreviewIdSchema = z.string().min(1).refine((value) => value.trim().length > 0 && !value.includes("/"));
const TimelineSchema = z.object({
  jobId: z.string().min(1),
  type: z.enum(["report", "sales_floor"]),
  previewFile: z.object({ submissionId: PreviewIdSchema, fileId: PreviewIdSchema }).optional(),
});
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

export const getSubmissionTimeline = onCall(async (request) => {
  const session = requireAuth(request);
  const input = TimelineSchema.parse(request.data ?? {});
  const companyId = companyFromClaims(session.token);
  await assertJobAccess(input.jobId, companyId, session.token.role, staffFromClaimsSafe(session.token));

  if (input.previewFile) {
    const { submissionId, fileId } = input.previewFile;
    const submission = await db.collection("submissions").doc(submissionId).get();
    const data = submission.data();
    if (!submission.exists || !data || data.companyId !== companyId || data.jobId !== input.jobId || data.type !== input.type) {
      return { submissions: [] };
    }
    const file = await submission.ref.collection("files").doc(fileId).get();
    if (!file.exists) return { submissions: [] };
    const fileData = file.data()!;
    assertSubmissionFileIdentity(data, fileData, submissionId);
    return { submissions: [{
      id: submissionId, type: data.type, purpose: data.purpose, status: data.status,
      createdAt: iso(data.createdAt), completedAt: iso(data.completedAt),
      files: [await fileView(companyId, session.uid, submissionId, fileId, fileData)],
    }] };
  }

  const submissions = await db.collection("submissions")
    .where("companyId", "==", companyId)
    .where("jobId", "==", input.jobId)
    .where("type", "==", input.type)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();

  const sorted = submissions.docs.sort((a, b) => timestampMillis(b.data().createdAt) - timestampMillis(a.data().createdAt));
  const checked = await Promise.all(sorted.map(async (submission) => {
    const files = await submission.ref.collection("files").orderBy("createdAt", "asc").limit(30).get();
    for (const file of files.docs) assertSubmissionFileIdentity(submission.data(), file.data(), submission.id);
    return { submission, files };
  }));
  const groups = await Promise.all(checked.map(async ({ submission, files }) => {
    const views = await Promise.all(
      files.docs.map((file) => fileView(companyId, session.uid, submission.id, file.id, file.data()))
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
  return { submissions: groups };
});

export const getSubmissionProcessingStatus = onCall(async (request) => {
  const session = requireAuth(request);
  const input = ProcessingStatusSchema.parse(request.data ?? {});
  const companyId = companyFromClaims(session.token);
  const staffId = staffFromClaimsSafe(session.token);
  await assertJobAccess(input.jobId, companyId, session.token.role, staffId);

  const snap = await db.collection("submissions").doc(input.submissionId).get();
  if (!snap.exists || snap.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "提出が見つかりません。");
  }
  const data = snap.data()!;
  if (session.token.role !== "admin" && data.staffId !== staffId) {
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
      const replacement = await db.collection("resubmissionRequests").doc(String(data.resubmissionRequestId)).get();
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

export const getResubmissionComparison = onCall(async (request) => {
  const session = requireAuth(request);
  const input = ComparisonSchema.parse(request.data ?? {});
  const companyId = companyFromClaims(session.token);
  const ref = db.collection("resubmissionRequests").doc(input.requestId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.companyId !== companyId) throw new HttpsError("not-found", "再提出依頼が見つかりません。");
  const data = snap.data()!;
  const staffId = staffFromClaimsSafe(session.token);
  if (session.token.role !== "admin" && data.staffId !== staffId) throw new HttpsError("permission-denied", "この再提出依頼を確認できません。");

  await assertJobAccess(String(data.jobId ?? ""), companyId, session.token.role, staffId);
  const assertComparisonSubmission = (submission: FirebaseFirestore.DocumentData | undefined, replacement = false) => {
    if (!submission || ["companyId", "jobId", "type"].some(key => submission[key] !== data[key]) ||
        (replacement && (submission.staffId !== data.staffId || submission.resubmissionRequestId !== snap.id))) {
      throw new HttpsError("failed-precondition", "再提出依頼と画像の所属情報が一致しません。");
    }
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
  const source = sourceFile ? await fileView(companyId, session.uid, String(data.sourceSubmissionId), sourceFile.id, sourceFile.data()!) : null;
  const replacements = await Promise.all(replacementFiles.map(file => fileView(companyId, session.uid, String(data.replacementSubmissionId), file.id, file.data())));
  return {
    request: { id: snap.id, jobId: data.jobId, type: data.type, reasons: data.reasons ?? [], note: data.note ?? "", status: data.status, createdAt: iso(data.createdAt), submittedAt: iso(data.submittedAt) },
    source,
    replacements,
  };
});

async function handleDriveFilePreview(request: Request, response: Response) {
  try {
    const token = String(request.query.token ?? "");
    if (!/^[A-Za-z0-9_-]{30,120}$/.test(token)) { response.status(400).send("Invalid preview token"); return; }
    const hash = sha256(token);
    const snap = await db.collection("filePreviewTokens").doc(hash).get();
    if (!snap.exists) { response.status(404).send("Preview not found"); return; }
    const data = snap.data()!;
    const expires = data.expiresAt as Timestamp | undefined;
    if (data.active !== true || !expires || expires.toMillis() < Date.now()) { response.status(410).send("Preview expired"); return; }
    if (typeof data.submissionId !== "string" || !data.submissionId || data.submissionId.includes("/") ||
        typeof data.fileId !== "string" || !data.fileId || data.fileId.includes("/")) {
      response.status(410).send("Preview expired"); return;
    }
    const submissionRef = db.collection("submissions").doc(data.submissionId);
    const [submission, file] = await Promise.all([submissionRef.get(), submissionRef.collection("files").doc(data.fileId).get()]);
    const currentFile = file.data();
    try {
      assertSubmissionFileIdentity(submission.data(), currentFile, data.submissionId);
      if (submission.data()?.companyId !== data.companyId || currentFile?.status !== "completed" || currentFile.driveFileId !== data.driveFileId) {
        throw new Error("Preview source changed");
      }
    } catch {
      response.status(410).send("Preview expired"); return;
    }
    const drive = getReadonlyDriveClient();
    const result = await drive.files.get({ fileId: String(data.driveFileId), alt: "media", supportsAllDrives: true }, { responseType: "stream" });
    response.setHeader("Content-Type", String(data.contentType || "application/octet-stream"));
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(String(data.fileName || "file"))}`);
    response.setHeader("Cache-Control", "private, max-age=60");
    response.setHeader("X-Content-Type-Options", "nosniff");
    await snap.ref.set({ lastOpenedAt: FieldValue.serverTimestamp(), openCount: FieldValue.increment(1) }, { merge: true });
    (result.data as NodeJS.ReadableStream).on("error", () => { if (!response.headersSent) response.status(500).end(); else response.end(); }).pipe(response);
  } catch (error) { console.error("driveFilePreview failed", error); if (!response.headersSent) response.status(500).send("Preview error"); }
}

export const driveFilePreview = onRequest(handleDriveFilePreview);

function isPreviewableFile(contentType: string): boolean {
  return contentType.startsWith("image/") || contentType === "application/pdf";
}

async function fileView(companyId: string, actorUid: string, submissionId: string, fileId: string, data: FirebaseFirestore.DocumentData): Promise<FileView> {
  let previewUrl: string | null = null;
  const contentType = String(data.contentType ?? "");
  const base = filePreviewGatewayUrl.value().trim();
  if (base && data.status === "completed" && data.driveFileId && isPreviewableFile(contentType)) {
    const raw = randomBytes(32).toString("base64url");
    const hash = sha256(raw);
    await db.collection("filePreviewTokens").doc(hash).set({
      companyId,
      actorUid,
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

async function assertJobAccess(jobId: string, companyId: string, role: unknown, staffId: string) {
  const job = await db.collection("jobs").doc(jobId).get();
  if (!job.exists || job.data()?.companyId !== companyId) throw new HttpsError("not-found", "案件が見つかりません。");
  if (role !== "admin" && (!staffId.trim() || job.data()?.assignedStaffId !== staffId)) throw new HttpsError("permission-denied", "この案件を確認できません。");
}

function staffFromClaimsSafe(token: Record<string, unknown>): string { try { return staffFromClaims(token); } catch { return ""; } }
function sha256(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function timestampMillis(value: unknown): number { return value instanceof Timestamp ? value.toMillis() : 0; }
function iso(value: unknown): string | null { return value instanceof Timestamp ? value.toDate().toISOString() : null; }
