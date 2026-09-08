import { assertSubmissionFile, assertSubmissionOwner, assertReplacementRequest } from "./submission-integrity";
import { basename } from "node:path";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { db, storage } from "./firebase";
import { getWritableDriveClient } from "./google-drive-client";
import { assertTransferSource, transferSource, transferWithStableId } from "./drive-transfer";
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
    await fileRef.update({ status: "security_error", updatedAt: FieldValue.serverTimestamp() });
    return;
  }

  assertSubmissionFile(submissionSnap.data(), meta, submissionId);

  // 旧版の転送済みデータは加算済みか判別できないため、自動再加算しない。
  if (meta.driveFileId && !(meta.transferCompletedAt instanceof Timestamp) && meta.completionCounted !== true) {
    throw new HttpsError("failed-precondition", "旧版の転送済み提出です。完了数を確認してから再処理してください。");
  }
  const source = transferSource(object);
  if (meta.storagePath !== path || String(meta.size) !== source.size || meta.contentType !== source.contentType) {
    throw new HttpsError("failed-precondition", "転送元と提出メタデータが一致しません。");
  }
  assertTransferSource(meta.driveTransferPlan, source);
  const gcsFile = storage.bucket(object.bucket).file(path, { generation: source.generation });
  const jobRef = db.collection("jobs").doc(String(meta.jobId));
  const staffRef = db.collection("staffProfiles").doc(String(meta.staffId));
  const requestId = String(meta.resubmissionRequestId ?? "");
  const requestRef = requestId ? db.collection("resubmissionRequests").doc(requestId) : null;
  const { job, staff, driveConfig } = await db.runTransaction(async tx => {
    const [latest, parent, jobSnap, staffSnap, driveSnap, replacement] = await Promise.all([
      tx.get(fileRef), tx.get(db.collection("submissions").doc(submissionId)),
      tx.get(jobRef), tx.get(staffRef), tx.get(db.doc(`companies/${companyId}/settings/drive`)),
      requestRef ? tx.get(requestRef) : Promise.resolve(null),
    ]);
    const file = latest.data();
    assertSubmissionFile(parent.data(), file, submissionId);
    if (["companyId", "uid", "jobId", "staffId", "type", "submissionId", "storagePath", "size", "contentType", "resubmissionRequestId"].some(key => file?.[key] !== meta[key])) {
      throw new HttpsError("failed-precondition", "転送開始前に提出情報が変更されました。");
    }
    if (!staffSnap.exists || !driveSnap.exists) throw new HttpsError("failed-precondition", "Drive転送に必要な設定が不足しています。");
    assertSubmissionOwner(parent.data()!, jobSnap.data(), staffSnap.data());
    const config = driveSnap.data() as { rootFolderId?: string };
    if (!config.rootFolderId) throw new HttpsError("failed-precondition", "Driveルートフォルダが未設定です。");
    if (requestRef) {
      assertReplacementRequest(replacement?.data(), parent.data()!, submissionId);
      // 最初に処理を開始した提出だけが、この依頼へ差替ファイルを追加できる。
      if (!replacement?.data()?.replacementSubmissionId) tx.update(requestRef, { replacementSubmissionId: submissionId });
    }
    if (file?.completionCounted !== true) tx.set(fileRef, { status: "processing", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { job: jobSnap.data()!, staff: staffSnap.data()!, driveConfig: { rootFolderId: config.rootFolderId } };
  });

  try {
    let submittedAt = meta.transferCompletedAt instanceof Timestamp
      ? meta.transferCompletedAt : meta.completedAt instanceof Timestamp ? meta.completedAt : Timestamp.now();
    let transferResult = {
      id: typeof meta.driveFileId === "string" ? meta.driveFileId : "",
      name: String(meta.driveName ?? ""), sequence: Number(meta.sequence ?? 0),
    };
    if (!transferResult.id) {
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

      const datePart = formatMd(String(job.dateKey ?? ""));
      const storeName = sanitizeName(String(job.storeName ?? "店舗"));
      const staffName = sanitizeName(String(staff.displayName ?? "スタッフ"));
      const typeLabel = meta.type === "sales_floor" ? "（売場画像）" : "";
      const extension = extensionFromName(String(meta.originalName ?? object.name ?? ""));
      const transferred = await transferWithStableId({
        fileRef, counterRef: db.collection("fileCounters").doc(`${meta.jobId}_${meta.type}`),
        source, parentId: monthFolder,
        nameForSequence: sequence => `${datePart} ${storeName} ${staffName}さん${typeLabel}(${sequence})${extension}`,
        createBody: () => gcsFile.createReadStream(),
      });
      submittedAt = transferred.submittedAt;
      transferResult = transferred;
      // 転送結果を先に保存し、後続DB処理の再試行では同じDriveファイルを使う。
      await fileRef.update({
        driveFileId: transferResult.id, driveName: transferResult.name,
        driveWebViewLink: transferred.webViewLink, sequence: transferred.sequence,
        transferCompletedAt: submittedAt,
      });
    }
    await fileRef.update({
      status: "completed", completedAt: submittedAt, updatedAt: submittedAt,
      errorMessage: FieldValue.delete(),
    });

    const requestIdForFile = String(meta.resubmissionRequestId ?? "");
    if (requestIdForFile) {
      await markResubmissionReplacementFile({
        requestId: requestIdForFile,
        submissionId,
        fileId,
        driveFileId: transferResult.id,
        driveName: transferResult.name,
        previewContentType: String(object.contentType ?? meta.contentType ?? "application/octet-stream"),
        submittedAt,
      });
    }
    const completedAll = await db.runTransaction(async (tx) => {
      const submissionRef = db.collection("submissions").doc(submissionId);
      const [current, countedFile, currentJob, currentStaff] = await Promise.all([tx.get(submissionRef), tx.get(fileRef), tx.get(jobRef), tx.get(staffRef)]);
      assertSubmissionFile(current.data(), countedFile.data(), submissionId);
      if (!currentStaff.exists) throw new HttpsError("failed-precondition", "担当スタッフが見つかりません。");
      assertSubmissionOwner(current.data()!, currentJob.data(), currentStaff.data());
      const completedFiles = Number(current.data()?.completedFiles ?? 0) + (countedFile.data()?.completionCounted === true ? 0 : 1);
      const totalFiles = Number(current.data()?.totalFiles ?? 0);
      const completed = totalFiles > 0 && completedFiles >= totalFiles;
      const otherFailed = current.data()?.status === "error" &&
        current.data()?.failedFileId && current.data()?.failedFileId !== fileId;
      tx.set(fileRef, { completionCounted: true }, { merge: true });
      tx.set(submissionRef, {
        completedFiles,
        status: completed ? "completed" : otherFailed ? "error" : "uploading",
        ...(completed ? { completedAt: current.data()?.completedAt ?? submittedAt } : {}),
        ...(!otherFailed || completed ? { errorMessage: FieldValue.delete(), failedFileId: FieldValue.delete() } : {}),
        updatedAt: submittedAt,
      }, { merge: true });
      return completed;
    });

    if (completedAll) {
      await markSubmissionCompleted({
        submissionId,
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

  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const failedAt = FieldValue.serverTimestamp();

    await db.runTransaction(async tx => {
      const submissionRef = db.collection("submissions").doc(submissionId);
      const [latestFile, latestSubmission] = await Promise.all([tx.get(fileRef), tx.get(submissionRef)]);
      if (!latestFile.exists || !latestSubmission.exists) return;
      // 別の実行が完了させた結果を、遅れて届いた失敗で上書きしない。
      if (latestFile.data()?.completionCounted === true &&
        (latestSubmission.data()?.status !== "completed" || latestSubmission.data()?.jobStatusApplied === true)) return;
      tx.set(fileRef, { status: "error", errorMessage, updatedAt: failedAt }, { merge: true });
      tx.set(submissionRef, { status: "error", errorMessage, failedFileId: fileId, updatedAt: failedAt }, { merge: true });
    });

    throw error;
  }
  // 後片付け失敗で完了を取り消さない。イベント再試行で削除だけも再実行できる。
  await gcsFile.delete({ ignoreNotFound: true });
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
