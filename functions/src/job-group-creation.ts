import { randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase";
import { hashText, createJobIdFromPersistedCaseId } from "./case-id";
import { AdminJobInput, resolvePublication } from "./job-management-core";

// 固定caseIdの生成は共用し、受信案件だけ再取込と同じjobId規則を選ぶ。
export function allocateAdminJobGroup(companyId: string, workDate: string, slots: number, persistedIdentity = false) {
  const groupId = "group_" + hashText(companyId + "|" + randomUUID(), 24);
  const jobs = Array.from({ length: slots }, () => {
    const ref = db.collection("jobs").doc();
    const caseId = "LKC-ADMIN-" + workDate.replace(/-/g, "") + "-" + ref.id.slice(0, 8).toUpperCase();
    return { id: persistedIdentity ? createJobIdFromPersistedCaseId(companyId, caseId) : ref.id, caseId };
  });
  return { groupId, jobs };
}

export function stageAdminJobGroup(writer: { set(ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData): unknown }, options: {
  companyId: string; actorUid: string; input: AdminJobInput; groupId: string;
  jobs: Array<{ id: string; caseId: string }>; rowQueueId: string | null; now: Timestamp;
  mailIntake?: { sourceKey: string; receiptId: string; candidateId: string; operationId: string };
}) {
  const { companyId, actorUid, input, groupId, jobs, now, mailIntake } = options;
  const sourceReady = false;
  const rowCreationConfigured = options.rowQueueId !== null;
  const rowQueueRef = options.rowQueueId ? db.collection("sheetRowCreateQueue").doc(options.rowQueueId) : null;
  const publication = resolvePublication({ requestedMode: input.publicationMode, publishAt: input.publishAt, sourceReady, nowIso: now.toDate().toISOString() });
  const batch = writer;
  const jobIds = jobs.map(job => job.id);
  jobs.forEach((job, index) => {
    const jobRef = db.collection("jobs").doc(job.id);
    batch.set(jobRef, {
      companyId,
      caseId: job.caseId,
      groupId,
      slotNumber: index + 1,
      slotCount: input.slots,
      workDate: input.workDate,
      dateKey: input.workDate,
      clientName: input.clientName,
      storeName: input.storeName,
      storeAddress: input.storeAddress,
      storeNearestStation: input.storeNearestStation,
      makerName: input.makerName,
      menuName: input.menuName,
      entryTime: input.entryTime,
      workTime: input.workTime,
      subcontractorName: input.subcontractorName,
      basePay: input.basePay,
      status: publication.status,
      publishable: publication.publishable,
      recruitmentStopped: publication.recruitmentStopped,
      scheduledPublishAt: publication.scheduledPublishAt
        ? Timestamp.fromDate(new Date(publication.scheduledPublishAt))
        : null,
      publicationBlockedReason: publication.blockedReason,
      requestedPublicationMode: input.publicationMode,
      requestedPublishAt: input.publishAt
        ? Timestamp.fromDate(new Date(input.publishAt))
        : null,
      sourceReady,
      sourceCreationStatus: rowCreationConfigured ? "pending" : "disabled",
      source: { type: "admin_created", createdBy: actorUid },
      ...(mailIntake ? { mailIntake } : {}),
      adminCreated: true,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
  });
  batch.set(db.collection("jobGroups").doc(groupId), {
    companyId,
    jobIds,
    slotCount: input.slots,
    createdBy: actorUid,
    createdAt: now,
    sourceReady,
    publication,
    rowCreationConfigured,
    rowCreationQueueId: rowQueueRef?.id ?? null,
  });
  if (rowQueueRef) {
    batch.set(rowQueueRef, {
      companyId,
      groupId,
      jobIds,
      status: "pending",
      attempts: 0,
      actorUid,
      idempotencyKey: `job-group-create:${groupId}`,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { groupId, jobIds, sourceReady, publication, rowCreationQueued: Boolean(rowQueueRef), rowCreationQueueId: rowQueueRef?.id ?? null,
    warning: rowQueueRef ? "月別タブへの安全追加を開始しました。検算完了まで案件は下書きです。" : "新規行の安全なスプシ作成が未有効のため、案件は下書きで保存しました。" };
}
