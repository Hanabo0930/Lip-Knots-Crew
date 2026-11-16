import { assertSubmissionAcceptanceContext } from "./submission-acceptance-context";
import { assertSubmissionFile, assertSubmissionFileIdentity, assertSubmissionOwner, assertReplacementRequest, assertSubmissionReadiness, caseMailSubmissionContext, assertCaseMailSubmissionRevision, assertCaseMailSubmissionCurrent } from "./submission-integrity";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { basename } from "node:path";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { db, storage } from "./firebase";
import { getWritableDriveClient } from "./google-drive-client";
import { assertTransferCheckpoint, assertTransferSource, sourceKey, transferSource, transferWithStableId } from "./drive-transfer";
import { ensureSubmissionFolder } from "./drive-folder-cache";
import { markSubmissionCompleted } from "./submission-status";
import { markResubmissionReplacementFile, markResubmissionSubmitted } from "./resubmissions";
import {
  companyFromClaims,
  requireAuth,
  requestId,
  staffFromClaims,
} from "./utils";
import { submissionTransferPaused, assertPausedTransferSource } from "./submission-transfer-control";
import { createSubmissionDeadlinePolicy } from "./submission-deadline-policy";
import { readActiveStaffSession, readStaffDeviceCredential } from "./staff-session";
import { grantSubmissionUploads, revokeSubmissionUpload } from "./submission-upload-grants";
import { freshStagingPath, matchesReceiptPath, pathIssuedAfter, mayFinalizePendingUpload, matchesUploadCredential, priorReceiptPath } from "./submission-upload-authority";

const CreateSchema = z.object({
  clientRequestId: z.string().uuid().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  expectedDateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  receiptOnly: z.boolean().default(false),
  jobId: z.string().min(1),
  type: z.enum(["report", "sales_floor"]),
  purpose: z.enum(["initial", "additional", "replacement"]).default("initial"),
  resubmissionRequestId: z.string().trim().min(1).optional(),
  files: z.array(z.object({
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    originalName: z.string().min(1).max(250),
    contentType: z.string().min(1).max(120).refine(value => value === "application/pdf" || /^image\/[^\s/;]+$/.test(value), { message: "画像またはPDFを選択してください。" }),
    size: z.number().int().positive().max(50 * 1024 * 1024),
  })).min(1).max(20),
});

export const createUploadSession = onCall(async (request) => {
  const session = requireAuth(request);
  if (session.token.role !== "staff") throw new HttpsError("permission-denied", "スタッフ権限が必要です。");
  const input = CreateSchema.parse(request.data);
  if (input.receiptOnly && (!input.clientRequestId || input.expectedDateKey === undefined)) {
    throw new HttpsError("invalid-argument", "照会する提出番号と勤務日を確認してください。");
  }
  if ((input.purpose === "replacement") !== Boolean(input.resubmissionRequestId)) {
    throw new HttpsError("invalid-argument", "差替提出には再提出依頼IDが必要です。通常提出には指定できません。");
  }
  const companyId = companyFromClaims(session.token);
  if (await submissionTransferPaused(companyId)) throw new HttpsError("failed-precondition", "提出転送を一時停止しています。再開後に同じ提出を確認してください。");
  const staffId = staffFromClaims(session.token);
  if (input.clientRequestId && input.files.some(file => !file.contentSha256)) throw new HttpsError("invalid-argument", "再試行用のファイル確認情報が不足しています。");
  const fingerprint = createHash("sha256").update(JSON.stringify([input.jobId, input.type, input.purpose, input.resubmissionRequestId ?? null, input.files])).digest("hex");
  const stableId = input.clientRequestId ? "submission_" + createHash("sha256").update(JSON.stringify([companyId, staffId, session.uid, input.clientRequestId])).digest("hex") : undefined;
  const submissionRef = stableId ? db.collection("submissions").doc(stableId) : db.collection("submissions").doc();
  const now = Timestamp.now();
  const deviceCredential = readStaffDeviceCredential(session.token);
  const fileRecords = input.files.map((file, index) => {
    const fileId = input.clientRequestId ? "file_" + createHash("sha256").update(submissionRef.id + "|" + index).digest("hex").slice(0, 32) : requestId("file");
    const safeName = basename(file.originalName).replace(/[\\/:*?"<>|]/g, "_");
    const baseStoragePath =
      `staging/${companyId}/${session.uid}/${submissionRef.id}/${fileId}/${safeName}`;
    return { fileId, baseStoragePath, storagePath: freshStagingPath(baseStoragePath, deviceCredential), ...file };
  });

  const identityRef = db.collection("authIdentities").doc(session.uid);
  const loadReceipt = (readExistingOnly = false) => db.runTransaction(async (tx) => {
    const { revokedAt, identity } = await readActiveStaffSession(tx, companyId, staffId, session.uid, session.token.auth_time, { requireIdentity: true, deviceClaims: session.token });
    const jobSnap = await tx.get(db.collection("jobs").doc(input.jobId));

    if (!jobSnap.exists) {
      throw new HttpsError("not-found", "案件が見つかりません。");
    }
    const job = jobSnap.data() as Record<string, unknown>;
    if (job.companyId !== companyId || job.assignedStaffId !== staffId) {
      throw new HttpsError("permission-denied", "この案件へ提出できません。");
    }

    if (job.cancelled === true || job.status === "cancelled") throw new HttpsError("failed-precondition", "キャンセル済みの案件です。");

    if (job.status !== "assigned") throw new HttpsError("failed-precondition", "確定済みの案件だけ提出できます。");
    assertSubmissionReadiness(job);

    if (input.clientRequestId) {
      const existing = await tx.get(submissionRef);
      if (existing.exists) {
        const parent = existing.data()!;
        assertCaseMailSubmissionCurrent(parent, job);
        if (input.expectedDateKey !== undefined) assertSubmissionAcceptanceContext(job, input);
        assertCaseMailSubmissionRevision(job, input.expectedRevision);
        if (parent.companyId !== companyId || parent.uid !== session.uid || parent.staffId !== staffId ||
            parent.jobId !== input.jobId || parent.type !== input.type || parent.purpose !== input.purpose ||
            (parent.resubmissionRequestId ?? null) !== (input.resubmissionRequestId ?? null) ||
            parent.requestFingerprint !== fingerprint || parent.totalFiles !== fileRecords.length ||
            parent.acceptedDateKey !== job.dateKey || parent.acceptedAssignmentRevision !== (job.revision ?? 0) ||
            (input.expectedDateKey !== undefined && input.expectedDateKey !== parent.acceptedDateKey) ||
            (input.expectedRevision !== undefined && input.expectedRevision !== parent.acceptedAssignmentRevision)) {
          throw new HttpsError("failed-precondition", "同じ受付番号の提出内容または担当情報が変わっています。提出履歴を確認してください。");
        }
        const stored = [];
        for (const record of fileRecords) {
          const saved = (await tx.get(submissionRef.collection("files").doc(record.fileId))).data();
          assertSubmissionFile(parent, saved, submissionRef.id);
          if (!saved || !matchesReceiptPath(saved, record.baseStoragePath) ||
              ["originalName", "contentType", "size", "contentSha256"].some(key => saved[key] !== record[key as keyof typeof record])) {
            throw new HttpsError("failed-precondition", "受付済みファイルの記録を確認できません。提出履歴を確認してください。");
          }
          stored.push({ ...saved, fileId: record.fileId, baseStoragePath: record.baseStoragePath, storagePath: String(saved.storagePath) });
        }
        if (input.resubmissionRequestId) {
          const replacement = await tx.get(db.collection("resubmissionRequests").doc(input.resubmissionRequestId));
          assertReplacementRequest(replacement.data(), parent, submissionRef.id);
        }
        return { replayed: true, files: stored, revokedAt, dateKey: parent.acceptedDateKey, revision: parent.acceptedAssignmentRevision };
      }
      if (input.receiptOnly || readExistingOnly) {
        throw new HttpsError("failed-precondition", "元の提出番号の受付結果を確認できません。選択ファイルは保持しています。新しい提出を作る前に提出履歴を確認してください。");
      }
      if (!Number.isSafeInteger(job.revision ?? 0) || Number(job.revision ?? 0) < 0 || typeof job.dateKey !== "string") {
        throw new HttpsError("failed-precondition", "提出する案件の日付と版を確認できません。");
      }
    }
    if (input.expectedDateKey !== undefined) {
      try { assertSubmissionAcceptanceContext(job, input); }
      catch (error) {
        if (error instanceof HttpsError && input.clientRequestId) {
          // Only for the operation ID observed absent in this transaction.
          throw new HttpsError(error.code, error.message, {
            reason: "submission_context_changed", accepted: false,
            clientRequestId: input.clientRequestId, jobId: input.jobId, type: input.type, purpose: input.purpose,
            resubmissionRequestId: input.resubmissionRequestId ?? null,
            expectedDateKey: input.expectedDateKey, expectedRevision: input.expectedRevision ?? null,
          });
        }
        throw error;
      }
    }
    try { assertCaseMailSubmissionRevision(job, input.expectedRevision); }
    catch (error) {
      if (error instanceof HttpsError && (error.details as { reason?: unknown } | undefined)?.reason === "case_mail_submission_changed" && input.clientRequestId) {
        throw new HttpsError(error.code, error.message, { reason: "case_mail_submission_changed", accepted: false,
          clientRequestId: input.clientRequestId, expectedRevision: input.expectedRevision ?? null });
      }
      throw error;
    }
    let resubmission: FirebaseFirestore.DocumentData | null = null;
    if (input.resubmissionRequestId) {
      const requestSnap = await tx.get(db.collection("resubmissionRequests").doc(input.resubmissionRequestId));
      if (!requestSnap.exists) throw new HttpsError("not-found", "再提出依頼が見つかりません。");
      resubmission = requestSnap.data() ?? null;
      if (resubmission?.companyId !== companyId || resubmission?.staffId !== staffId || resubmission?.jobId !== input.jobId || resubmission?.type !== input.type || resubmission?.status !== "open") {
        throw new HttpsError("failed-precondition", "この再提出依頼には送信できません。");
      }
      assertCaseMailSubmissionCurrent(resubmission, job);
      if (resubmission.sourceFileId && input.files.length !== 1) {
        throw new HttpsError("invalid-argument", "画像単位の再送は1ファイルだけ選んでください。");
      }
    }

    grantSubmissionUploads(tx, identityRef, identity, fileRecords, Timestamp.now());
    tx.create(submissionRef, {
      companyId,
      jobId: input.jobId,
      staffId,
      uid: session.uid,
      type: input.type,
      purpose: input.purpose,
      resubmissionRequestId: input.resubmissionRequestId ?? null,
      ...(input.clientRequestId ? { requestFingerprint: fingerprint, acceptedDateKey: job.dateKey, acceptedAssignmentRevision: job.revision ?? 0 } : {}),
      ...(job.mailIntake ? { acceptedMailContext: caseMailSubmissionContext(job) } : {}),
      status: "uploading",
      deadlinePolicy: createSubmissionDeadlinePolicy(job.dateKey),
      totalFiles: fileRecords.length,
      completedFiles: 0,
      createdAt: now,
      updatedAt: now,
    });

    for (const record of fileRecords) {
      tx.create(submissionRef.collection("files").doc(record.fileId), {
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
        baseStoragePath: record.baseStoragePath,
        storagePath: record.storagePath,
        uploadPathIssuedAt: FieldValue.serverTimestamp(),
        ...(deviceCredential ? { uploadDeviceCredential: deviceCredential } : {}),
        ...(record.contentSha256 ? { contentSha256: record.contentSha256 } : {}),
        originalName: record.originalName,
        contentType: record.contentType,
        size: record.size,
        createdAt: now,
      });
    }
    return { replayed: false, files: fileRecords, revokedAt, dateKey: job.dateKey, revision: job.revision ?? 0 };
  });

  const receipt = await loadReceipt();

  async function renewUploadPath(fileId: string, saved: FirebaseFirestore.DocumentData, cutoff: Timestamp | null): Promise<string> {
    const fileRef = submissionRef.collection("files").doc(fileId);
    const jobRef = db.collection("jobs").doc(input.jobId);
    const newPath = freshStagingPath(saved.baseStoragePath, deviceCredential);
    return db.runTransaction(async tx => {
      const { revokedAt, identity } = await readActiveStaffSession(tx, companyId, staffId, session.uid, session.token.auth_time, { requireIdentity: true, deviceClaims: session.token });
      const [parentSnap, fileSnap, jobSnap] = await Promise.all([tx.get(submissionRef), tx.get(fileRef), tx.get(jobRef)]);
      const parent = parentSnap.data(), current = fileSnap.data(), job = jobSnap.data();
      assertSubmissionFile(parent, current, submissionRef.id);
      const held = () => new HttpsError("failed-precondition", "失効前の提出記録を確認できません。再送せず提出履歴を確認してください。");
      if ((cutoff && !revokedAt?.isEqual(cutoff)) || !current || !parent || !job ||
          parent.companyId !== companyId || parent.staffId !== staffId || parent.uid !== session.uid ||
          parent.jobId !== input.jobId || parent.requestFingerprint !== fingerprint ||
          job.companyId !== companyId || job.assignedStaffId !== staffId || job.status !== "assigned" || job.cancelled === true ||
          job.dateKey !== parent.acceptedDateKey || (job.revision ?? 0) !== parent.acceptedAssignmentRevision ||
          !matchesReceiptPath(current, saved.baseStoragePath) ||
          ["originalName", "contentType", "size", "contentSha256"].some(key => current[key] !== saved[key])) throw held();
      assertSubmissionReadiness(job);
      assertCaseMailSubmissionCurrent(parent, job);
      if (input.resubmissionRequestId) {
        const replacement = await tx.get(db.collection("resubmissionRequests").doc(input.resubmissionRequestId));
        assertReplacementRequest(replacement.data(), parent, submissionRef.id);
      }
      if (current.status !== "waiting_upload" || current.driveTransferPlan || current.driveFileId ||
          current.pausedTransferSource || current.verifiedUploadBytes || current.authorizedStagedKey) throw held();
      const issueGrant = (storagePath: string) => grantSubmissionUploads(tx, identityRef, identity, [{
        fileId, storagePath, size: saved.size, contentType: saved.contentType, contentSha256: saved.contentSha256,
      }], Timestamp.now());
      if (matchesUploadCredential(current, deviceCredential) && (!cutoff || pathIssuedAfter(current, cutoff))) {
        issueGrant(current.storagePath);
        return current.storagePath;
      }
      if (current.uploadDeviceCredential != null && deviceCredential === null) throw held();
      if (current.storagePath !== saved.storagePath) throw held();
      tx.update(fileRef, { baseStoragePath: saved.baseStoragePath, storagePath: newPath, uploadPathIssuedAt: FieldValue.serverTimestamp(),
        ...(deviceCredential ? { uploadDeviceCredential: deviceCredential } : {}),
      });
      issueGrant(newPath);
      return newPath;
    });
  }

  const files = [];
  const checkedObjects = new Map<string, ReturnType<typeof transferSource>>();
  for (const record of receipt.files) {
    let uploadRequired = true;
    let storagePath = record.storagePath;
    if (receipt.replayed) {
      const saved = record as FirebaseFirestore.DocumentData;
      if (saved.driveFileId && (saved.transferCompletedAt instanceof Timestamp || saved.completionCounted === true)) {
        uploadRequired = false;
      } else {
        const cutoff = receipt.revokedAt && !pathIssuedAfter(saved, receipt.revokedAt) ? receipt.revokedAt : null;
        const rebound = !matchesUploadCredential(saved, deviceCredential);
        const bucket = storage.bucket();
        const [object] = await bucket.file(record.storagePath).getMetadata().catch(error => {
          if (Number((error as { code?: unknown }).code) === 404) return [undefined] as const;
          throw error;
        });
        if (!object) {
          if (saved.status !== "waiting_upload") throw new HttpsError("failed-precondition", "処理中の元ファイルを確認できません。提出履歴を確認して管理者へ連絡してください。");
          storagePath = await renewUploadPath(record.fileId, saved, cutoff);
        } else {
          if (object.bucket !== bucket.name || object.name !== record.storagePath || String(object.size) !== String(saved.size) ||
              object.contentType !== saved.contentType || object.metadata?.lkcContentSha256 !== saved.contentSha256) {
            throw new HttpsError("failed-precondition", "受付済みの元ファイル情報が一致しません。再送せず管理者へ連絡してください。");
          }
          const source = transferSource(object);
          const observed = saved.authorizedStagedKey === sourceKey(source);
          if ((cutoff || rebound) && !observed) {
            storagePath = await renewUploadPath(record.fileId, saved, cutoff);
          } else {
            assertStagedReceiptSource(saved, source);
            if (saved.verifiedUploadBytes === undefined) {
              const version = bucket.file(source.path, { generation: source.generation });
              await verifyUploadBytes(version.createReadStream({ decompress: false }), saved.size, saved.contentSha256);
            }
            checkedObjects.set(record.fileId, source);
            uploadRequired = false;
          }
        }
      }
    }
    files.push({ fileId: record.fileId, storagePath, ...(input.clientRequestId ? { uploadRequired } : {}) });
  }
  if (checkedObjects.size) {
    // Recheck the saved receipt after scanning, without creating another receipt if it disappeared.
    const latest = await loadReceipt(true);
    if (receipt.revokedAt ? !latest.revokedAt?.isEqual(receipt.revokedAt) : latest.revokedAt !== null) {
      throw new HttpsError("failed-precondition", "照合中に認証情報が変更されました。提出履歴を確認してください。");
    }
    for (const file of latest.files) {
      const source = checkedObjects.get(file.fileId);
      if (source) assertStagedReceiptSource(file, source);
    }
  }
  return {
    submissionId: submissionRef.id, files,
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId, replayed: receipt.replayed } : {}),
    ...(input.expectedDateKey !== undefined
      ? { acceptedContext: { jobId: input.jobId, dateKey: receipt.dateKey, revision: receipt.revision } } : {}),
  };
});

export const finalizeStagedUpload = onObjectFinalized(async (event) => {
  const object = event.data;
  const path = object.name ?? "";
  const parts = path.split("/");
  if (parts.length !== 6 || parts[0] !== "staging" || !parts[5]) {
    return;
  }

  const companyId = parts[1];
  const uid = parts[2];
  const submissionId = parts[3];
  const fileId = parts[4];
  if (!companyId || !uid || !submissionId || !fileId) {
    return;
  }
  const fileRef = db.collection("submissions").doc(submissionId)
    .collection("files").doc(fileId);
  const identityRef = db.collection("authIdentities").doc(uid);
  if (await submissionTransferPaused(companyId)) {
    // 正規の提出記録へ停止状態を保存し、同時実行で完了した結果は戻さない。
    await db.runTransaction(async tx => {
      const submissionRef = db.collection("submissions").doc(submissionId);
      const [parentSnap, fileSnap] = await Promise.all([tx.get(submissionRef), tx.get(fileRef)]);
      if (!parentSnap.exists || !fileSnap.exists) return;
      const parent = parentSnap.data()!, file = fileSnap.data()!;
      if (file.storagePath !== path) return;
      assertSubmissionFile(parent, file, submissionId);
      if (file.companyId !== companyId || file.uid !== uid) {
        throw new HttpsError("failed-precondition", "停止対象と提出ファイルの所属情報が一致しません。");
      }
      if (file.completionCounted === true || file.status === "completed") return;
      const pausedSource = transferSource(object);
      const stagedKey = sourceKey(pausedSource);
      assertAuthorizedStagedSource(file, stagedKey);
      if (String(file.size) !== pausedSource.size || file.contentType !== pausedSource.contentType) {
        throw new HttpsError("failed-precondition", "停止対象と元ファイルの内容が一致しません。");
      }
      assertTransferSource(file.driveTransferPlan, pausedSource);
      assertPausedTransferSource(file.pausedTransferSource, pausedSource);
      if (!file.driveFileId) {
        const [identity, staff] = await Promise.all([
          tx.get(identityRef), tx.get(db.collection("staffProfiles").doc(String(file.staffId))),
        ]);
        if (staff.data()?.active !== true || staff.data()?.companyId !== companyId ||
            !mayFinalizePendingUpload(file, identity.data(), stagedKey, staff.data()?.deviceBoundAuthRequired === true)) return;
        revokeSubmissionUpload(tx, identityRef, identity.data(), fileId, path);
      }
      const updatedAt = FieldValue.serverTimestamp();
      tx.update(fileRef, { status: "paused_global", pausedTransferSource: pausedSource,
        ...(file.driveFileId ? {} : { authorizedStagedKey: stagedKey }), updatedAt });
      // 他ファイルのエラーや完了の証跡を、一時停止表示で覆わない。
      if (parent.status !== "completed" && parent.status !== "error") {
        tx.update(submissionRef, { status: "paused_global", updatedAt });
      }
    });
    return;
  }

  const [fileSnap, submissionSnap, identitySnap] = await Promise.all([
    fileRef.get(),
    db.collection("submissions").doc(submissionId).get(),
    identityRef.get(),
  ]);
  if (!fileSnap.exists || !submissionSnap.exists) {
    return;
  }

  const meta = fileSnap.data() as Record<string, unknown>;
  // A staging event can name another receipt. Require its exact saved path before treating it as that receipt.
  if (meta.storagePath !== path) return;
  assertSubmissionFile(submissionSnap.data(), meta, submissionId);
  if (meta.uid !== uid || meta.companyId !== companyId) {
    throw new HttpsError("failed-precondition", "転送元と提出ファイルの所属情報が一致しません。");
  }

  // 復旧記録の保存先が欠ける場合は、新規転送として扱わない。
  const hasTransferRecord = meta.driveFileId != null || meta.transferCompletedAt != null || meta.completionCounted === true || meta.status === "completed";
  if (hasTransferRecord && (typeof meta.driveFileId !== "string" || !meta.driveFileId.trim())) {
    throw new HttpsError("failed-precondition", "転送済み情報の保存先を確認できません。提出記録を確認してから再処理してください。");
  }
  // 旧版の転送済みデータは加算済みか判別できないため、自動再加算しない。
  if (meta.driveFileId && !(meta.transferCompletedAt instanceof Timestamp) && meta.completionCounted !== true) {
    throw new HttpsError("failed-precondition", "旧版の転送済み提出です。完了数を確認してから再処理してください。");
  }
  const source = transferSource(object);
  const stagedKey = sourceKey(source);
  assertAuthorizedStagedSource(meta, stagedKey);
  assertPausedTransferSource(meta.pausedTransferSource, source);
  if (String(meta.size) !== source.size || meta.contentType !== source.contentType) {
    throw new HttpsError("failed-precondition", "転送元と提出メタデータが一致しません。");
  }
  assertTransferSource(meta.driveTransferPlan, source);
  if (hasTransferRecord) assertTransferCheckpoint(meta);
  if (!hasTransferRecord && !mayFinalizePendingUpload(meta, identitySnap.data(), stagedKey)) return;
  const gcsFile = storage.bucket(object.bucket).file(path, { generation: source.generation });
  const jobRef = db.collection("jobs").doc(String(meta.jobId));
  const staffRef = db.collection("staffProfiles").doc(String(meta.staffId));
  const requestId = String(meta.resubmissionRequestId ?? "");
  const requestRef = requestId ? db.collection("resubmissionRequests").doc(requestId) : null;
  try {
  const expectedDigest = meta.contentSha256;
  if (expectedDigest !== undefined && (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectedDigest))) {
    throw new HttpsError("failed-precondition", "受付済みファイルの内容照合情報が不正です。");
  }
  const bytesProof = expectedDigest === undefined ? undefined
    : uploadBytesProof(source, expectedDigest);
  if (meta.verifiedUploadBytes !== undefined && meta.verifiedUploadBytes !== bytesProof) {
    throw new HttpsError("failed-precondition", "照合済みファイルと転送元の世代が一致しません。");
  }
  if (typeof expectedDigest === "string" && meta.completionCounted !== true && meta.verifiedUploadBytes === undefined) {
    await verifyUploadBytes(gcsFile.createReadStream({ decompress: false }), Number(meta.size), expectedDigest);
  }
  const authorized = await db.runTransaction(async tx => {
    const [latest, parent, jobSnap, staffSnap, driveSnap, replacement, identity] = await Promise.all([
      tx.get(fileRef), tx.get(db.collection("submissions").doc(submissionId)),
      tx.get(jobRef), tx.get(staffRef), tx.get(db.doc(`companies/${companyId}/settings/drive`)),
      requestRef ? tx.get(requestRef) : Promise.resolve(null),
      tx.get(identityRef),
    ]);
    const file = latest.data();
    assertSubmissionFile(parent.data(), file, submissionId);
    if (file && priorReceiptPath(file, path)) return null;
    if (file) assertAuthorizedStagedSource(file, stagedKey);
    if (!hasTransferRecord && (!file || staffSnap.data()?.active !== true ||
      !mayFinalizePendingUpload(file, identity.data(), stagedKey, staffSnap.data()?.deviceBoundAuthRequired === true))) return null;
    assertPausedTransferSource(file?.pausedTransferSource, source);
    if (["companyId", "uid", "jobId", "staffId", "type", "submissionId", "storagePath", "size", "contentType", "contentSha256", "resubmissionRequestId"].some(key => file?.[key] !== meta[key]) ||
        !matchesUploadCredential(file ?? {}, readStaffDeviceCredential(meta.uploadDeviceCredential)) ||
        (file?.verifiedUploadBytes !== undefined && file.verifiedUploadBytes !== bytesProof) ||
        (meta.verifiedUploadBytes !== undefined && file?.verifiedUploadBytes !== meta.verifiedUploadBytes) ||
        (bytesProof && meta.completionCounted === true && file?.completionCounted !== true && file?.verifiedUploadBytes !== bytesProof)) {
      throw new HttpsError("failed-precondition", "転送開始前に提出情報が変更されました。");
    }
    if (!staffSnap.exists || !driveSnap.exists) throw new HttpsError("failed-precondition", "Drive転送に必要な設定が不足しています。");
    assertSubmissionOwner(parent.data()!, jobSnap.data(), staffSnap.data());
    const config = driveSnap.data() as { rootFolderId?: string };
    if (!config.rootFolderId) throw new HttpsError("failed-precondition", "Driveルートフォルダが未設定です。");
    if (requestRef) {
      assertReplacementRequest(replacement?.data(), parent.data()!, submissionId);
      assertCaseMailSubmissionCurrent(replacement!.data()!, jobSnap.data()!);
      // 最初に処理を開始した提出だけが、この依頼へ差替ファイルを追加できる。
      if (!replacement?.data()?.replacementSubmissionId) tx.update(requestRef, { replacementSubmissionId: submissionId });
    }
    if (file?.completionCounted !== true) {
      revokeSubmissionUpload(tx, identityRef, identity.data(), fileId, path);
      tx.set(fileRef, {
        status: "processing", authorizedStagedKey: stagedKey,
        ...(bytesProof ? { verifiedUploadBytes: bytesProof } : {}), updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return { job: jobSnap.data()!, staff: staffSnap.data()!, driveConfig: { rootFolderId: config.rootFolderId } };
  });
  if (!authorized) return;
  const { job, staff, driveConfig } = authorized;

    let submittedAt = meta.transferCompletedAt instanceof Timestamp
      ? meta.transferCompletedAt : meta.completedAt instanceof Timestamp ? meta.completedAt : Timestamp.now();
    let transferResult = {
      id: typeof meta.driveFileId === "string" ? meta.driveFileId : "",
      name: String(meta.driveName ?? ""), sequence: Number(meta.sequence ?? 0),
    };
    if (!transferResult.id) {
      const drive = getWritableDriveClient();
      const clientFolder = await ensureSubmissionFolder(
        drive,
        driveConfig.rootFolderId,
        String(job.clientName ?? "未分類")
      );
      const monthFolder = await ensureSubmissionFolder(
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
        createBody: () => gcsFile.createReadStream({ decompress: false }),
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
      let completedAt: Timestamp | null = null;
      if (completed) {
        if (current.data()?.jobStatusApplied === true) {
          // 反映済みの履歴は現在のルールや再実行時刻で書き換えない。
          if (!(current.data()?.completedAt instanceof Timestamp)) throw new HttpsError("failed-precondition", "提出の完了時刻を確認できません。");
          completedAt = current.data()!.completedAt;
        } else {
          const allFiles = await tx.get(submissionRef.collection("files").limit(21));
          if (allFiles.docs.length !== totalFiles) throw new HttpsError("failed-precondition", "提出のファイル記録数が一致しません。");
          for (const item of allFiles.docs) {
            const saved = item.data();
            assertSubmissionFileIdentity(current.data(), saved, submissionId);
            const savedAt = saved.transferCompletedAt instanceof Timestamp ? saved.transferCompletedAt : saved.completedAt;
            if (saved.status !== "completed" || !saved.driveFileId || !(savedAt instanceof Timestamp) ||
                (item.id !== fileId && saved.completionCounted !== true)) throw new HttpsError("failed-precondition", "全ファイルの保存完了を確認できません。");
            if (!completedAt || savedAt.toMillis() > completedAt.toMillis()) completedAt = savedAt;
          }
        }
      }
      const otherFailed = current.data()?.status === "error" &&
        current.data()?.failedFileId && current.data()?.failedFileId !== fileId;
      tx.set(fileRef, { completionCounted: true }, { merge: true });
      tx.set(submissionRef, {
        completedFiles,
        status: completed ? "completed" : otherFailed ? "error" : "uploading",
        ...(completedAt ? { completedAt } : {}),
        ...(!otherFailed || completed ? { errorMessage: FieldValue.delete(), failedFileId: FieldValue.delete() } : {}),
        updatedAt: submittedAt,
      }, { merge: true });
      return completedAt;
    });

    if (completedAll) {
      await markSubmissionCompleted({
        submissionId,
        jobId: String(meta.jobId),
        type: meta.type === "sales_floor" ? "sales_floor" : "report",
        submittedAt: completedAll,
      });
      const requestId = String(meta.resubmissionRequestId ?? "");
      if (requestId) {
        await markResubmissionSubmitted({
          requestId, submissionId, submittedAt: completedAll,
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
      if (latestFile.data()?.storagePath !== path) return;
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

function assertAuthorizedStagedSource(file: FirebaseFirestore.DocumentData, stagedKey: string): void {
  if (file.authorizedStagedKey !== undefined && file.authorizedStagedKey !== stagedKey) {
    throw new HttpsError("failed-precondition", "認証照合済みの元ファイルと世代が一致しません。提出履歴を確認してください。");
  }
}

function uploadBytesProof(source: ReturnType<typeof transferSource>, digest: string): string {
  return createHash("sha256").update(JSON.stringify([source, digest])).digest("hex");
}

function assertStagedReceiptSource(file: FirebaseFirestore.DocumentData, source: ReturnType<typeof transferSource>): void {
  if (file.storagePath !== source.path || (file.verifiedUploadBytes !== undefined &&
      file.verifiedUploadBytes !== uploadBytesProof(source, file.contentSha256))) {
    throw new HttpsError("failed-precondition", "照合済みファイルと転送元の世代が一致しません。提出履歴を確認してください。");
  }
  assertAuthorizedStagedSource(file, sourceKey(source));
  assertPausedTransferSource(file.pausedTransferSource, source);
  assertTransferSource(file.driveTransferPlan, source);
}

async function verifyUploadBytes(stream: AsyncIterable<unknown>, expectedSize: number, expectedDigest: string): Promise<void> {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new HttpsError("failed-precondition", "受信ファイルの内容を照合できません。");
    size += chunk.length;
    if (size > expectedSize) throw new HttpsError("failed-precondition", "受信ファイルのサイズが受付記録と一致しません。");
    digest.update(chunk);
  }
  if (size !== expectedSize || digest.digest("hex") !== expectedDigest) {
    throw new HttpsError("failed-precondition", "受信ファイルの内容が受付記録と一致しません。提出状況を確認して管理者へ連絡してください。");
  }
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
