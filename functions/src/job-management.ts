import { randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { z } from "zod";
import { db } from "./firebase";
import { hashText } from "./case-id";
import {
  buildJobCsv,
  clientInputKeys,
  normalizeJobInput,
  normalizeMoneyRecord,
  resolvePublication,
  staffInputKeys,
} from "./job-management-core";
import {
  companyFromClaims,
  requireAdmin,
  requestId,
} from "./utils";
import { assertProductionOperational, getProductionOperationalState } from "./system-safety";

const CreateSchema = z.object({
  workDate: z.string(),
  clientName: z.string(),
  storeName: z.string(),
  storeAddress: z.string().max(300).default(""),
  storeNearestStation: z.string().max(120).default(""),
  makerName: z.string(),
  menuName: z.string(),
  entryTime: z.string().default(""),
  workTime: z.string(),
  subcontractorName: z.string().default(""),
  slots: z.number().int().min(1).max(20).default(1),
  basePay: z.union([z.number(), z.null()]).optional(),
  publicationMode: z.enum(["draft", "immediate", "scheduled"]).default("draft"),
  publishAt: z.string().nullable().optional(),
});

const DuplicateSchema = z.object({
  sourceJobId: z.string().min(1),
  workDate: z.string().optional(),
  slots: z.number().int().min(1).max(20).default(1),
  publicationMode: z.enum(["draft", "immediate", "scheduled"]).default("draft"),
  publishAt: z.string().nullable().optional(),
});

const PublicationSchema = z.object({
  jobIds: z.array(z.string().min(1)).min(1).max(100),
  action: z.enum(["publish", "schedule", "stop", "draft"]),
  publishAt: z.string().nullable().optional(),
});

const EditSchema = z.object({
  jobId: z.string().min(1),
  revision: z.number().int().min(0).optional(),
  fields: z.object({
    clientName: z.string().max(200).optional(),
    storeName: z.string().max(200).optional(),
    storeAddress: z.string().max(300).optional(),
    storeNearestStation: z.string().max(120).optional(),
    makerName: z.string().max(200).optional(),
    menuName: z.string().max(500).optional(),
    entryTime: z.string().max(100).optional(),
    workTime: z.string().max(100).optional(),
    subcontractorName: z.string().max(200).optional(),
    assignedStaffId: z.string().nullable().optional(),
    clientChargeInputs: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional(),
    staffPaymentInputs: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional(),
  }),
});

const ExportSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  groupBy: z.enum(["client", "maker"]),
  name: z.string().max(200).optional(),
  includeCancelled: z.boolean().default(false),
});

const inputSheetFields: Record<string, string> = {
  clientName: "clientName",
  storeName: "storeName",
  makerName: "makerName",
  menuName: "menuName",
  entryTime: "entryTime",
  workTime: "workTime",
  subcontractorName: "subcontractorName",
};

const appOnlyJobFields = ["storeAddress", "storeNearestStation"] as const;

export const createAdminJobGroup = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const parsed = CreateSchema.parse(request.data ?? {});
  const normalized = normalizeJobInput(parsed);
  if (normalized.errors.length) {
    throw new HttpsError("invalid-argument", normalized.errors.join(" / "));
  }

  const groupId = `group_${hashText(`${companyId}|${randomUUID()}`, 24)}`;
  const now = Timestamp.now();
  const rowCreationConfigured = await nativeJobSourceEnabled(companyId);
  const sourceReady = false;
  const publication = resolvePublication({
    requestedMode: normalized.value.publicationMode,
    publishAt: normalized.value.publishAt,
    sourceReady,
    nowIso: now.toDate().toISOString(),
  });

  const batch = db.batch();
  const jobIds: string[] = [];
  const rowQueueRef = rowCreationConfigured
    ? db.collection("sheetRowCreateQueue").doc()
    : null;

  for (let slot = 1; slot <= normalized.value.slots; slot++) {
    const jobRef = db.collection("jobs").doc();
    jobIds.push(jobRef.id);
    batch.set(jobRef, {
      companyId,
      caseId: `LKC-ADMIN-${normalized.value.workDate.replace(/-/g, "")}-${jobRef.id.slice(0, 8).toUpperCase()}`,
      groupId,
      slotNumber: slot,
      slotCount: normalized.value.slots,
      workDate: normalized.value.workDate,
      dateKey: normalized.value.workDate,
      clientName: normalized.value.clientName,
      storeName: normalized.value.storeName,
      storeAddress: normalized.value.storeAddress,
      storeNearestStation: normalized.value.storeNearestStation,
      makerName: normalized.value.makerName,
      menuName: normalized.value.menuName,
      entryTime: normalized.value.entryTime,
      workTime: normalized.value.workTime,
      subcontractorName: normalized.value.subcontractorName,
      basePay: normalized.value.basePay,
      status: publication.status,
      publishable: publication.publishable,
      recruitmentStopped: publication.recruitmentStopped,
      scheduledPublishAt: publication.scheduledPublishAt
        ? Timestamp.fromDate(new Date(publication.scheduledPublishAt))
        : null,
      publicationBlockedReason: publication.blockedReason,
      requestedPublicationMode: normalized.value.publicationMode,
      requestedPublishAt: normalized.value.publishAt
        ? Timestamp.fromDate(new Date(normalized.value.publishAt))
        : null,
      sourceReady,
      sourceCreationStatus: rowCreationConfigured ? "pending" : "disabled",
      source: { type: "admin_created", createdBy: session.uid },
      adminCreated: true,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  batch.set(db.collection("jobGroups").doc(groupId), {
    companyId,
    jobIds,
    slotCount: normalized.value.slots,
    createdBy: session.uid,
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
      actorUid: session.uid,
      idempotencyKey: `job-group-create:${groupId}`,
      createdAt: now,
      updatedAt: now,
    });
  }
  await batch.commit();

  await writeAudit(companyId, session.uid, "job.group.create", {
    groupId,
    jobIds,
    slots: normalized.value.slots,
    publicationMode: normalized.value.publicationMode,
  });

  return {
    groupId,
    jobIds,
    sourceReady,
    publication,
    rowCreationQueued: Boolean(rowQueueRef),
    rowCreationQueueId: rowQueueRef?.id ?? null,
    warning: rowQueueRef
      ? "月別タブへの安全追加を開始しました。検算完了まで案件は下書きです。"
      : "新規行の安全なスプシ作成が未有効のため、案件は下書きで保存しました。",
  };
});

export const duplicateAdminJob = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = DuplicateSchema.parse(request.data ?? {});
  const source = await requireCompanyJob(companyId, input.sourceJobId);

  const createData = {
    workDate: input.workDate ?? String(source.dateKey ?? source.workDate ?? ""),
    clientName: String(source.clientName ?? ""),
    storeName: String(source.storeName ?? ""),
    storeAddress: String(source.storeAddress ?? ""),
    storeNearestStation: String(source.storeNearestStation ?? ""),
    makerName: String(source.makerName ?? ""),
    menuName: String(source.menuName ?? ""),
    entryTime: String(source.entryTime ?? ""),
    workTime: String(source.workTime ?? ""),
    subcontractorName: String(source.subcontractorName ?? ""),
    slots: input.slots,
    basePay: numberOrNull(source.basePay),
    publicationMode: input.publicationMode,
    publishAt: input.publishAt ?? null,
  };
  const normalized = normalizeJobInput(createData);
  if (normalized.errors.length) {
    throw new HttpsError("invalid-argument", normalized.errors.join(" / "));
  }

  const groupId = `group_${hashText(`${companyId}|${randomUUID()}`, 24)}`;
  const now = Timestamp.now();
  const rowCreationConfigured = await nativeJobSourceEnabled(companyId);
  const sourceReady = false;
  const publication = resolvePublication({
    requestedMode: normalized.value.publicationMode,
    publishAt: normalized.value.publishAt,
    sourceReady,
    nowIso: now.toDate().toISOString(),
  });

  const batch = db.batch();
  const jobIds: string[] = [];
  const rowQueueRef = rowCreationConfigured
    ? db.collection("sheetRowCreateQueue").doc()
    : null;
  for (let slot = 1; slot <= input.slots; slot++) {
    const ref = db.collection("jobs").doc();
    jobIds.push(ref.id);
    batch.set(ref, {
      ...copyableJobFields(source),
      companyId,
      caseId: `LKC-DUP-${normalized.value.workDate.replace(/-/g, "")}-${ref.id.slice(0, 8).toUpperCase()}`,
      groupId,
      slotNumber: slot,
      slotCount: input.slots,
      workDate: normalized.value.workDate,
      dateKey: normalized.value.workDate,
      status: publication.status,
      publishable: publication.publishable,
      recruitmentStopped: publication.recruitmentStopped,
      scheduledPublishAt: publication.scheduledPublishAt
        ? Timestamp.fromDate(new Date(publication.scheduledPublishAt))
        : null,
      publicationBlockedReason: publication.blockedReason,
      requestedPublicationMode: normalized.value.publicationMode,
      requestedPublishAt: normalized.value.publishAt
        ? Timestamp.fromDate(new Date(normalized.value.publishAt))
        : null,
      sourceReady,
      sourceCreationStatus: rowCreationConfigured ? "pending" : "disabled",
      source: {
        type: "admin_duplicate",
        sourceJobId: input.sourceJobId,
        createdBy: session.uid,
      },
      adminCreated: true,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
  batch.set(db.collection("jobGroups").doc(groupId), {
    companyId,
    jobIds,
    slotCount: input.slots,
    duplicatedFromJobId: input.sourceJobId,
    createdBy: session.uid,
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
      actorUid: session.uid,
      idempotencyKey: `job-group-duplicate:${groupId}`,
      createdAt: now,
      updatedAt: now,
    });
  }
  await batch.commit();

  await writeAudit(companyId, session.uid, "job.group.duplicate", {
    groupId,
    sourceJobId: input.sourceJobId,
    jobIds,
  });

  return {
    groupId,
    jobIds,
    sourceReady,
    publication,
    rowCreationQueued: Boolean(rowQueueRef),
    rowCreationQueueId: rowQueueRef?.id ?? null,
  };
});

export const updateJobPublication = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = PublicationSchema.parse(request.data ?? {});
  const refs = input.jobIds.map((id) => db.collection("jobs").doc(id));
  const snapshots = await db.getAll(...refs);
  const now = Timestamp.now();
  const batch = db.batch();
  const updated: string[] = [];
  const blocked: string[] = [];

  for (const snap of snapshots) {
    if (!snap.exists || snap.data()?.companyId !== companyId) continue;
    const job = snap.data()!;
    if (job.cancelled === true || job.status === "cancelled") {
      blocked.push(snap.id);
      continue;
    }

    if (input.action === "stop") {
      batch.set(snap.ref, {
        status: job.assignedStaffId ? "assigned" : "stopped",
        publishable: false,
        recruitmentStopped: true,
        scheduledPublishAt: FieldValue.delete(),
        updatedAt: now,
        revision: FieldValue.increment(1),
      }, { merge: true });
      updated.push(snap.id);
      continue;
    }

    if (input.action === "draft") {
      if (job.assignedStaffId) {
        blocked.push(snap.id);
        continue;
      }
      batch.set(snap.ref, {
        status: "draft",
        publishable: false,
        recruitmentStopped: true,
        scheduledPublishAt: FieldValue.delete(),
        updatedAt: now,
        revision: FieldValue.increment(1),
      }, { merge: true });
      updated.push(snap.id);
      continue;
    }

    if (job.assignedStaffId) {
      blocked.push(snap.id);
      continue;
    }

    const sourceReady = job.sourceReady === true ||
      job.source?.type === "google_sheets_readonly" ||
      Boolean(job.sheetRef?.spreadsheetId);

    const mode = input.action === "schedule" ? "scheduled" : "immediate";
    const publication = resolvePublication({
      requestedMode: mode,
      publishAt: input.publishAt ?? null,
      sourceReady,
      nowIso: now.toDate().toISOString(),
    });

    batch.set(snap.ref, {
      status: publication.status,
      publishable: publication.publishable,
      recruitmentStopped: publication.recruitmentStopped,
      scheduledPublishAt: publication.scheduledPublishAt
        ? Timestamp.fromDate(new Date(publication.scheduledPublishAt))
        : FieldValue.delete(),
      publicationBlockedReason: publication.blockedReason ?? FieldValue.delete(),
      updatedAt: now,
      revision: FieldValue.increment(1),
    }, { merge: true });

    if (publication.blockedReason) blocked.push(snap.id);
    else updated.push(snap.id);
  }

  await batch.commit();
  await writeAudit(companyId, session.uid, "job.publication.update", {
    action: input.action,
    updated,
    blocked,
    publishAt: input.publishAt ?? null,
  });

  return { updated, blocked };
});

export const publishScheduledJobs = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Tokyo",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const due = await db.collection("jobs")
      .where("status", "==", "scheduled")
      .where("scheduledPublishAt", "<=", Timestamp.now())
      .limit(500)
      .get();

    const batch = db.batch();
    const stateCache = new Map<string, boolean>();
    for (const job of due.docs) {
      const data = job.data();
      const companyId = String(data.companyId ?? "");
      if (!stateCache.has(companyId)) {
        stateCache.set(companyId, companyId ? (await getProductionOperationalState(companyId)).operational : false);
      }
      if (!stateCache.get(companyId)) continue;
      const sourceReady = data.sourceReady === true ||
        data.source?.type === "google_sheets_readonly" ||
        Boolean(data.sheetRef?.spreadsheetId);
      if (!sourceReady || data.cancelled === true || data.assignedStaffId) {
        batch.set(job.ref, {
          status: sourceReady ? data.status : "draft",
          publishable: false,
          recruitmentStopped: true,
          publicationBlockedReason: sourceReady ? "invalid_state" : "sheet_source_not_ready",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        continue;
      }
      batch.set(job.ref, {
        status: "open",
        publishable: true,
        recruitmentStopped: false,
        scheduledPublishAt: FieldValue.delete(),
        publicationBlockedReason: FieldValue.delete(),
        publishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    if (!due.empty) await batch.commit();
  }
);

export const adminEditJobInputs = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  await assertProductionOperational(companyId);
  const input = EditSchema.parse(request.data ?? {});
  const jobRef = db.collection("jobs").doc(input.jobId);
  const staffRef = input.fields.assignedStaffId
    ? db.collection("staffProfiles").doc(input.fields.assignedStaffId)
    : null;
  const mappingSnap = await db.collection("sheetWriteMappings").doc(companyId).get();
  const mappingEnabled = mappingSnap.exists && mappingSnap.data()?.enabled === true;

  const moneyClient = normalizeMoneyRecord(
    input.fields.clientChargeInputs,
    clientInputKeys
  );
  const moneyStaff = normalizeMoneyRecord(
    input.fields.staffPaymentInputs,
    staffInputKeys
  );
  const errors = [...moneyClient.errors, ...moneyStaff.errors];
  if (errors.length) {
    throw new HttpsError("invalid-argument", errors.join(" / "));
  }

  const result = await db.runTransaction(async (tx) => {
    const jobSnap = await tx.get(jobRef);
    if (!jobSnap.exists || jobSnap.data()?.companyId !== companyId) {
      throw new HttpsError("not-found", "案件が見つかりません。");
    }
    const job = jobSnap.data()!;
    const currentRevision = Number(job.revision ?? 0);
    if (input.revision !== undefined && input.revision !== currentRevision) {
      throw new HttpsError(
        "aborted",
        "他の変更が先に保存されています。画面を再読込してください。"
      );
    }

    let staff: FirebaseFirestore.DocumentData | null = null;
    if (staffRef) {
      const staffSnap = await tx.get(staffRef);
      if (
        !staffSnap.exists ||
        staffSnap.data()?.companyId !== companyId ||
        staffSnap.data()?.active !== true
      ) {
        throw new HttpsError("failed-precondition", "選択したスタッフを手配できません。");
      }
      staff = staffSnap.data()!;
      const lockRef = db.collection("staffDayLocks").doc(
        `${companyId}_${staffRef.id}_${String(job.dateKey ?? job.workDate)}`
      );
      const lockSnap = await tx.get(lockRef);
      if (
        lockSnap.exists &&
        lockSnap.data()?.active === true &&
        lockSnap.data()?.jobId !== input.jobId
      ) {
        throw new HttpsError("failed-precondition", "このスタッフは同日に別シフトがあります。");
      }
    }

    const update: FirebaseFirestore.DocumentData = {
      updatedAt: Timestamp.now(),
      revision: currentRevision + 1,
      adminEditedAt: Timestamp.now(),
      adminEditedBy: session.uid,
    };
    const sheetUpdates: Record<string, unknown> = {};

    for (const [field, mappingKey] of Object.entries(inputSheetFields)) {
      const raw = input.fields[field as keyof typeof input.fields];
      if (raw === undefined) continue;
      const value = String(raw).normalize("NFKC").trim();
      update[field] = value;
      sheetUpdates[mappingKey] = value;
    }

    for (const field of appOnlyJobFields) {
      const raw = input.fields[field];
      if (raw === undefined) continue;
      update[field] = String(raw).normalize("NFKC").trim();
    }

    if (input.fields.clientChargeInputs) {
      update.clientChargeInputs = moneyClient.values;
      Object.assign(sheetUpdates, moneyClient.values);
    }
    if (input.fields.staffPaymentInputs) {
      update.staffPaymentInputs = moneyStaff.values;
      Object.assign(sheetUpdates, moneyStaff.values);
    }

    const oldStaffId = typeof job.assignedStaffId === "string"
      ? job.assignedStaffId
      : null;
    if (input.fields.assignedStaffId !== undefined) {
      const newStaffId = input.fields.assignedStaffId;
      if (oldStaffId && oldStaffId !== newStaffId) {
        tx.set(db.collection("staffDayLocks").doc(
          `${companyId}_${oldStaffId}_${String(job.dateKey ?? job.workDate)}`
        ), {
          active: false,
          releasedAt: Timestamp.now(),
          releaseReason: "admin.job.edit",
        }, { merge: true });
      }

      if (newStaffId && staff) {
        const displayName = String(staff.displayName ?? "");
        update.assignedStaffId = newStaffId;
        update.assignedStaffName = displayName;
        update.status = "assigned";
        update.publishable = false;
        sheetUpdates.staffName = displayName;
        tx.set(db.collection("staffDayLocks").doc(
          `${companyId}_${newStaffId}_${String(job.dateKey ?? job.workDate)}`
        ), {
          companyId,
          staffId: newStaffId,
          dateKey: String(job.dateKey ?? job.workDate),
          jobId: input.jobId,
          active: true,
          source: "admin.job.edit",
          updatedAt: Timestamp.now(),
        }, { merge: true });
      } else {
        update.assignedStaffId = FieldValue.delete();
        update.assignedStaffName = FieldValue.delete();
        update.status = job.cancelled ? "cancelled" :
          job.recruitmentStopped ? "stopped" : "open";
        sheetUpdates.staffName = "";
      }
    }

    tx.set(jobRef, update, { merge: true });

    const writeEnabled =
      mappingEnabled &&
      Boolean(job.sheetRef?.spreadsheetId);

    if (writeEnabled && Object.keys(sheetUpdates).length) {
      const queueRef = db.collection("sheetSyncQueue").doc();
      tx.set(queueRef, {
        companyId,
        jobId: input.jobId,
        operation: "job.admin_edit",
        updates: sheetUpdates,
        expected: buildExpected(job, sheetUpdates),
        status: "pending",
        attempts: 0,
        actorUid: session.uid,
        idempotencyKey: `job.admin_edit:${input.jobId}:${currentRevision + 1}`,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
    } else if (Object.keys(sheetUpdates).length) {
      update.pendingSourceWrite = true;
      tx.set(jobRef, {
        pendingSourceWrite: true,
        pendingSourceFields: Object.keys(sheetUpdates),
      }, { merge: true });
    }

    return {
      revision: currentRevision + 1,
      sheetWriteQueued: writeEnabled && Object.keys(sheetUpdates).length > 0,
      pendingSourceWrite: !writeEnabled && Object.keys(sheetUpdates).length > 0,
    };
  });

  await writeAudit(companyId, session.uid, "job.admin_edit", {
    jobId: input.jobId,
    fields: Object.keys(input.fields),
    result,
  });
  return result;
});

export const generateJobExport = onCall(
  { timeoutSeconds: 300, memory: "1GiB" },
  async (request) => {
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    await assertProductionOperational(companyId);
    const input = ExportSchema.parse(request.data ?? {});

    if (input.through < input.from) {
      throw new HttpsError("invalid-argument", "終了日は開始日以降にしてください。");
    }

    const snap = await db.collection("jobs")
      .where("companyId", "==", companyId)
      .where("dateKey", ">=", input.from)
      .where("dateKey", "<=", input.through)
      .orderBy("dateKey", "asc")
      .limit(5000)
      .get();

    const filtered = snap.docs
      .map((doc): FirebaseFirestore.DocumentData & { id: string } => ({ id: doc.id, ...doc.data() }))
      .filter((job) => input.includeCancelled || job.status !== "cancelled")
      .filter((job) => {
        if (!input.name) return true;
        const field = input.groupBy === "client" ? job.clientName : job.makerName;
        return String(field ?? "") === input.name;
      });

    const rows = filtered.map((job) => {
      const invoice =
        numberValue(job.financials?.clientChargeTotal) +
        numberValue(job.financials?.clientChargeAdditionsTotal);
      const payment = job.subcontractorName
        ? numberValue(job.financials?.subcontractorTotal)
        : numberValue(job.financials?.staffPaymentTotal);
      return {
        ...job,
        invoice,
        payment,
        grossProfit: invoice - payment,
      };
    });
    const csv = buildJobCsv(rows);
    const safeName = (input.name || (input.groupBy === "client" ? "全クライアント" : "全メーカー"))
      .replace(/[\\/:*?"<>|]/g, "_");
    const filename = `${input.from}_${input.through}_${safeName}_案件一覧.csv`;

    await db.collection("exportLogs").add({
      companyId,
      actorUid: session.uid,
      type: "job_csv",
      groupBy: input.groupBy,
      name: input.name ?? "",
      from: input.from,
      through: input.through,
      includeCancelled: input.includeCancelled,
      rows: rows.length,
      createdAt: FieldValue.serverTimestamp(),
    });

    return {
      filename,
      contentType: "text/csv;charset=utf-8",
      csv,
      rows: rows.length,
      summary: {
        invoice: rows.reduce((sum, row) => sum + Number(row.invoice), 0),
        payment: rows.reduce((sum, row) => sum + Number(row.payment), 0),
        grossProfit: rows.reduce((sum, row) => sum + Number(row.grossProfit), 0),
      },
    };
  }
);

async function nativeJobSourceEnabled(companyId: string): Promise<boolean> {
  const [feature, mapping] = await Promise.all([
    db.collection("companyFeatureSettings").doc(companyId).get(),
    db.doc(`companies/${companyId}/sheetMappings/shift`).get(),
  ]);
  return (
    feature.exists &&
    feature.data()?.adminJobCreationSourceReady === true &&
    mapping.exists &&
    mapping.data()?.enabled === true &&
    mapping.data()?.rowCreation?.enabled === true
  );
}

async function requireCompanyJob(
  companyId: string,
  jobId: string
): Promise<FirebaseFirestore.DocumentData> {
  const snap = await db.collection("jobs").doc(jobId).get();
  if (!snap.exists || snap.data()?.companyId !== companyId) {
    throw new HttpsError("not-found", "案件が見つかりません。");
  }
  return snap.data()!;
}

function copyableJobFields(source: FirebaseFirestore.DocumentData) {
  const keys = [
    "clientName", "storeName", "storeAddress", "storeNearestStation",
    "makerName", "menuName", "entryTime", "workTime",
    "subcontractorName", "basePay", "clientChargeInputs", "staffPaymentInputs",
    "financials",
  ];
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])
  );
}

function buildExpected(
  job: FirebaseFirestore.DocumentData,
  updates: Record<string, unknown>
): Record<string, { mode: "any" | "blank" | "exact"; value?: unknown }> {
  const expected: Record<string, { mode: "any" | "blank" | "exact"; value?: unknown }> = {};
  for (const key of Object.keys(updates)) {
    if (key === "staffName") {
      expected[key] = {
        mode: job.assignedStaffName ? "exact" : "blank",
        value: job.assignedStaffName ?? "",
      };
    } else {
      expected[key] = { mode: "any" };
    }
  }
  return expected;
}

async function writeAudit(
  companyId: string,
  actorUid: string,
  action: string,
  detail: Record<string, unknown>
): Promise<void> {
  await db.collection("auditLogs").add({
    companyId,
    actorUid,
    action,
    detail,
    requestId: requestId("audit"),
    createdAt: FieldValue.serverTimestamp(),
  });
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
