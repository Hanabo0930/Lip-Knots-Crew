import { basename } from "node:path";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { db, storage } from "./firebase";
import { getWritableDriveClient } from "./google-drive-client";
import { readCachedFolderId, writeCachedFolderId } from "./drive-folder-cache";
import { markSubmissionCompleted } from "./submission-status";
import { markResubmissionReplacementFile, markResubmissionSubmitted } from "./resubmissions";
import {
  companyFromClaims,
  requireAuth,
  requestId,
  staffFromClaims,
} from "./utils";
import { assertProductionOperational, getProductionOperationalState } from "./system-safety";

const CreateSchema = z.object({
  jobId: z.string().min(1),
  type: z.enum(["report", "sales_floor"]),
  purpose: z.enum(["initial", "additional", "replacement"]).default("initial"),
  resubmissionRequestId: z.string().optional(),
  files: z.array(z.object({
    originalName: z.string().min(1).max(250),
    contentType: z.string().min(1).max(120),
    size: z.number().positive().max(50 * 1024 * 1024),
  })).min(1).max(20),
});

export const createUploadSession = onCall(async (request) => {
  const session = requireAuth(request);
  const input = CreateSchema.parse(request.data);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const staffId = staffFromClaims(session.token);
  const jobSnap = await db.collection("jobs").doc(input.jobId).get();

  if (!jobSnap.exists) {
    throw new HttpsError("not-found", "案件が見つかりません。");
  }
  const job = jobSnap.data() as Record<string, unknown>;
  if (job.companyId !== companyId || job.assignedStaffId !== staffId) {
    throw new HttpsError("permission-denied", "この案件へ提出できません。");
  }

  let resubmission: FirebaseFirestore.DocumentData | null = null;
  if (input.resubmissionRequestId) {
    const requestSnap = await db.collection("resubmissionRequests").doc(input.resubmissionRequestId).get();
    if (!requestSnap.exists) throw new HttpsError("not-found", "再提出依頼が見つかりません。");
    resubmission = requestSnap.data() ?? null;
    if (resubmission?.companyId !== companyId || resubmission?.staffId !== staffId || resubmission?.jobId !== input.jobId || resubmission?.type !== input.type || resubmission?.status !== "open") {
      throw new HttpsError("failed-precondition", "この再提出依頼には送信できません。");
    }
    if (resubmission.sourceFileId && input.files.length !== 1) {
      throw new HttpsError("invalid-argument", "画像単位の再送は1ファイルだけ選んでください。");
    }
  }

  const submissionRef = db.collection("submissions").doc();
  const now = Timestamp.now();
  const fileRecords = input.files.map((file) => {
    const fileId = requestId("file");
    const safeName = basename(file.originalName).replace(/[\\/:*?"<>|]/g, "_");
    const storagePath =
      `staging/${companyId}/${session.uid}/${submissionRef.id}/${fileId}/${safeName}`;
    return { fileId, storagePath, ...file };
  });

  const batch = db.batch();
  batch.set(submissionRef, {
    companyId,
    jobId: input.jobId,
    staffId,
    uid: session.uid,
    type: input.type,
    purpose: input.purpose,
    resubmissionRequestId: input.resubmissionRequestId ?? null,
    status: "uploading",
    totalFiles: fileRecords.length,
    completedFiles: 0,
    createdAt: now,
    updatedAt: now,
  });

  for (const record of fileRecords) {
    batch.set(submissionRef.collection("files").doc(record.fileId), {
      companyId,
      jobId: input.jobId,
      staffId,
      uid: session.uid,
      submissionId: submissionRef.id,
      type: input.type,
      purpose: input.purpose,
      resubmissionRequestId: input.resubmissionRequestId ?? null,
      replacesFileId: resubmission?.sourceFileId ?? null,
      replacesSubmissionId: resubmission?.sourceSubmissionId ?? null,
      status: "waiting_upload",
      storagePath: record.storagePath,
      originalName: record.originalName,
      contentType: record.contentType,
      size: record.size,
      createdAt: now,
    });
  }
  await batch.commit();

  return {
    submissionId: submissionRef.id,
    files: fileRecords.map(({ fileId, storagePath }) => ({ fileId, storagePath })),
  };
});

export const finalizeStagedUpload = onObjectFinalized(async (event) => {
  const object = event.data;
  const path = object.name ?? "";
  const parts = path.split("/");
  if (parts.length < 6 || parts[0] !== "staging") {
    return;
  }

  const companyId = parts[1];
  const uid = parts[2];
  const submissionId = parts[3];
  const fileId = parts[4];
  if (!companyId || !uid || !submissionId || !fileId) {
    return;
  }
  if (!(await getProductionOperationalState(companyId)).operational) {
    await db.collection("submissionFiles").doc(fileId).set({
      status: "paused_global",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return;
  }

  const fileRef = db.collection("submissions").doc(submissionId)
    .collection("files").doc(fileId);
  const [fileSnap, submissionSnap] = await Promise.all([
    fileRef.get(),
    db.collection("submissions").doc(submissionId).get(),
  ]);
  if (!fileSnap.exists || !submissionSnap.exists) {
    return;
  }

  const meta = fileSnap.data() as Record<string, unknown>;
  if (meta.uid !== uid || meta.companyId !== companyId) {
    await fileRef.set({ status: "security_error", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return;
  }

  await fileRef.set({ status: "processing", updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  try {
    const [jobSnap, staffSnap, driveSnap] = await Promise.all([
      db.collection("jobs").doc(String(meta.jobId)).get(),
      db.collection("staffProfiles").doc(String(meta.staffId)).get(),
      db.doc(`companies/${companyId}/settings/drive`).get(),
    ]);

    if (!jobSnap.exists || !staffSnap.exists || !driveSnap.exists) {
      throw new Error("Drive転送に必要な設定が不足しています。");
    }

    const job = jobSnap.data() as Record<string, unknown>;
    const staff = staffSnap.data() as Record<string, unknown>;
    const driveConfig = driveSnap.data() as { rootFolderId?: string };
    if (!driveConfig.rootFolderId) {
      throw new Error("Driveルートフォルダが未設定です。");
    }

    const drive = getWritableDriveClient();
    const clientFolder = await ensureFolder(
      drive,
      driveConfig.rootFolderId,
      String(job.clientName ?? "未分類")
    );
    const monthFolder = await ensureFolder(
      drive,
      clientFolder,
      String(job.monthKey ?? String(job.dateKey ?? "").slice(0, 7).replace("-0", ".").replace("-", "."))
    );

    const counterRef = db.collection("fileCounters")
      .doc(`${meta.jobId}_${meta.type}`);
    const sequence = await db.runTransaction(async (tx) => {
      const counterSnap = await tx.get(counterRef);
      const next = Number(counterSnap.data()?.value ?? 0) + 1;
      tx.set(counterRef, { value: next, updatedAt: Timestamp.now() }, { merge: true });
      return next;
    });

    const datePart = formatMd(String(job.dateKey ?? ""));
    const storeName = sanitizeName(String(job.storeName ?? "店舗"));
    const staffName = sanitizeName(String(staff.displayName ?? "スタッフ"));
    const typeLabel = meta.type === "sales_floor" ? "（売場画像）" : "";
    const extension = extensionFromName(String(meta.originalName ?? object.name ?? ""));
    const finalName = `${datePart} ${storeName} ${staffName}さん${typeLabel}(${sequence})${extension}`;

    const bucket = storage.bucket(object.bucket);
    const gcsFile = bucket.file(path);
    const response = await drive.files.create({
      requestBody: { name: finalName, parents: [monthFolder] },
      media: { mimeType: object.contentType ?? undefined, body: gcsFile.createReadStream() },
      fields: "id,name,webViewLink",
      supportsAllDrives: true,
    });

    await fileRef.set({
      status: "completed",
      driveFileId: response.data.id ?? null,
      driveName: response.data.name ?? finalName,
      driveWebViewLink: response.data.webViewLink ?? null,
      sequence,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    const submittedAt = Timestamp.now();
    const requestIdForFile = String(meta.resubmissionRequestId ?? "");
    if (requestIdForFile) {
      await markResubmissionReplacementFile({
        requestId: requestIdForFile,
        submissionId,
        fileId,
        driveFileId: response.data.id ?? null,
        driveName: response.data.name ?? finalName,
        previewContentType: String(object.contentType ?? meta.contentType ?? "application/octet-stream"),
        submittedAt,
      });
    }
    const completedAll = await db.runTransaction(async (tx) => {
      const submissionRef = db.collection("submissions").doc(submissionId);
      const current = await tx.get(submissionRef);
      if (!current.exists) return false;
      const completedFiles = Number(current.data()?.completedFiles ?? 0) + 1;
      const totalFiles = Number(current.data()?.totalFiles ?? 0);
      const completed = totalFiles > 0 && completedFiles >= totalFiles;
      tx.set(submissionRef, {
        completedFiles,
        status: completed ? "completed" : "uploading",
        ...(completed ? { completedAt: submittedAt } : {}),
        updatedAt: submittedAt,
      }, { merge: true });
      return completed;
    });

    if (completedAll) {
      await markSubmissionCompleted({
        jobId: String(meta.jobId),
        type: meta.type === "sales_floor" ? "sales_floor" : "report",
        submittedAt,
      });
      const requestId = String(meta.resubmissionRequestId ?? "");
      if (requestId) {
        await markResubmissionSubmitted({
          requestId, submissionId, submittedAt,
        });
      }
    }

    await gcsFile.delete({ ignoreNotFound: true });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const failedAt = FieldValue.serverTimestamp();

    await Promise.all([
      fileRef.set({
        status: "error",
        errorMessage,
        updatedAt: failedAt,
      }, { merge: true }),
      db.collection("submissions").doc(submissionId).set({
        status: "error",
        errorMessage,
        failedFileId: fileId,
        updatedAt: failedAt,
      }, { merge: true }),
    ]);

    throw error;
  }
});

async function ensureFolder(
  drive: ReturnType<typeof getWritableDriveClient>,
  parentId: string,
  name: string
): Promise<string> {
  const cached = readCachedFolderId(parentId, name);
  if (cached) return cached;

  const escaped = name.replace(/'/g, "\\'");
  const existing = await drive.files.list({
    q: `'${parentId}' in parents and name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const found = existing.data.files?.[0]?.id;
  if (found) {
    writeCachedFolderId(parentId, name, found);
    return found;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  if (!created.data.id) throw new Error("Driveフォルダ作成に失敗しました。");
  writeCachedFolderId(parentId, name, created.data.id);
  return created.data.id;
}

function sanitizeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function extensionFromName(name: string): string {
  const match = /\.[a-z0-9]{1,8}$/i.exec(name);
  return match?.[0]?.toLowerCase() ?? "";
}

function formatMd(dateKey: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return dateKey;
  return `${Number(match[1])}.${Number(match[2])}`;
}
