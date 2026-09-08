import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { z } from "zod";
import { db } from "./firebase";
import { requireAdmin, companyFromClaims } from "./utils";
import {
  createReadOnlySheetsClient,
  listSpreadsheetSheets,
  readShiftSheet,
  selectImportSheets,
} from "./sheet-reader";
import { parseShiftSheet } from "./shift-parser";
import {
  ParsedShiftJob,
  SheetParseSummary,
  ShiftImportConfig,
} from "./shift-import-types";

const ImportRequestSchema = z.object({
  sheetNames: z.array(z.string().min(1)).max(36).optional(),
});

const ColumnSchema = z.object({
  workDate: z.string().min(1),
  staffName: z.string().min(1),
  temperature: z.string().optional(),
  arrivalTime: z.string().optional(),
  clientName: z.string().min(1),
  storeName: z.string().min(1),
  makerName: z.string().min(1),
  menuName: z.string().min(1),
  entryTime: z.string().optional(),
  workTime: z.string().min(1),
  subcontractorName: z.string().optional(),
  materialStatus: z.string().optional(),
  basePayColumns: z.array(z.string()).optional(),
  clientChargeTotal: z.string().optional(),
  clientChargeAdditionColumns: z.array(z.string()).optional(),
  staffPaymentTotal: z.string().optional(),
  subcontractorTotal: z.string().optional(),
  transportation: z.string().optional(),
  purchase8: z.string().optional(),
  purchase10: z.string().optional(),
  netPrintCost: z.string().optional(),
  postageCost: z.string().optional(),
  recruitmentStopped: z.string().optional(),
  cancelled: z.string().optional(),
  cancellationReason: z.string().optional(),
  caseId: z.string().optional(),
});

const ConfigSchema = z.object({
  companyId: z.string().min(1),
  enabled: z.boolean(),
  spreadsheetId: z.string().min(10),
  spreadsheetLabel: z.string().optional(),
  monthlySheetPattern: z.string().default("^\\d{4}\\.\\d{1,2}$"),
  importFrom: z.string().nullable().optional(),
  importThrough: z.string().nullable().optional(),
  includeSheets: z.array(z.string()).optional(),
  excludeSheets: z.array(z.string()).optional(),
  headerRow: z.number().int().positive().nullable().optional(),
  dataStartRow: z.number().int().positive().nullable().optional(),
  maxRowsPerSheet: z.number().int().min(100).max(50000).default(10000),
  readRangeEndColumn: z.string().regex(/^[A-Z]+$/).default("BB"),
  maxSheetsPerRun: z.number().int().min(1).max(120).default(36),
  scheduleEnabled: z.boolean().default(false),
  markMissingAsArchived: z.boolean().default(false),
  columns: ColumnSchema,
  configVersion: z.string().default("0.2"),
});

type ImportMode = "preview" | "commit";

type ImportExecutionResult = {
  runId: string | null;
  mode: ImportMode;
  companyId: string;
  spreadsheetId: string;
  sheets: SheetParseSummary[];
  totals: {
    sheets: number;
    jobs: number;
    open: number;
    assigned: number;
    stopped: number;
    cancelled: number;
    draft: number;
    skippedRows: number;
    unresolvedStaff: number;
    writes: number;
  };
  warnings: string[];
  samples: Array<{
    caseId: string;
    sheetName: string;
    row: number;
    workDate: string;
    storeName: string;
    assignedStaffName: string;
    status: string;
  }>;
};

export const previewShiftImport = onCall(
  { timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    const input = ImportRequestSchema.parse(request.data ?? {});
    return executeShiftImport(companyId, "preview", input.sheetNames);
  }
);

export const syncShiftSheetsReadOnly = onCall(
  { timeoutSeconds: 540, memory: "2GiB" },
  async (request) => {
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    const input = ImportRequestSchema.parse(request.data ?? {});
    return executeShiftImport(companyId, "commit", input.sheetNames);
  }
);

/**
 * 5分ごとに有効な会社設定を確認します。
 * 実行が重複する可能性があるため、会社単位のリースロックを取得します。
 */
export const syncShiftSheetsScheduled = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Tokyo",
    timeoutSeconds: 540,
    memory: "2GiB",
    maxInstances: 1,
  },
  async () => {
    const configs = await db.collection("sheetImportConfigs")
      .where("enabled", "==", true)
      .where("scheduleEnabled", "==", true)
      .limit(20)
      .get();

    for (const configSnap of configs.docs) {
      try {
        await executeShiftImport(configSnap.id, "commit");
      } catch (error) {
        console.error("Scheduled shift sync failed", {
          companyId: configSnap.id,
          error,
        });
      }
    }
  }
);

export const getShiftSyncStatus = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const configSnap = await db.collection("sheetImportConfigs").doc(companyId).get();
  const runsSnap = await db.collection("sheetImportRuns")
    .where("companyId", "==", companyId)
    .orderBy("startedAt", "desc")
    .limit(10)
    .get();

  return {
    configured: configSnap.exists,
    enabled: configSnap.data()?.enabled === true,
    scheduleEnabled: configSnap.data()?.scheduleEnabled === true,
    lastRuns: runsSnap.docs.map((doc) => ({
      id: doc.id,
      ...serializeFirestoreData(doc.data()),
    })),
  };
});

async function executeShiftImport(
  companyId: string,
  mode: ImportMode,
  requestedSheets?: string[]
): Promise<ImportExecutionResult> {
  const config = await loadConfig(companyId);
  if (!config.enabled && mode === "commit") {
    throw new HttpsError(
      "failed-precondition",
      "スプシ同期設定が無効です。"
    );
  }

  const lock = mode === "commit" ? await acquireSyncLock(companyId) : null;
  let runRef: FirebaseFirestore.DocumentReference | null = null;

  try {
    if (mode === "commit") {
      runRef = db.collection("sheetImportRuns").doc();
      await runRef.set({
        companyId,
        mode,
        status: "processing",
        spreadsheetId: config.spreadsheetId,
        requestedSheets: requestedSheets ?? [],
        configVersion: config.configVersion,
        startedAt: FieldValue.serverTimestamp(),
      });
    }

    const sheets = await createReadOnlySheetsClient();
    const descriptors = await listSpreadsheetSheets(sheets, config.spreadsheetId);
    const targets = selectImportSheets(descriptors, config, requestedSheets);

    if (!targets.length) {
      throw new HttpsError(
        "not-found",
        "対象の月別タブが見つかりません。設定とタブ名を確認してください。"
      );
    }

    const allJobs: ParsedShiftJob[] = [];
    const summaries: SheetParseSummary[] = [];
    const warnings: string[] = [];

    for (const target of targets) {
      try {
        const values = await readShiftSheet(
          sheets,
          config.spreadsheetId,
          target,
          config.readRangeEndColumn,
          config.maxRowsPerSheet
        );
        const parsed = parseShiftSheet(
          config.spreadsheetId,
          target.title,
          values,
          config,
          target.sheetId
        );
        allJobs.push(...parsed.jobs);
        summaries.push(parsed.summary);
        warnings.push(...parsed.summary.warnings);
      } catch (error) {
        const message = `${target.title}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        // commitでは一部タブの読取失敗を成功扱いせず、案件反映前に停止する。
        if (mode === "commit") throw new HttpsError("unavailable", message);
        warnings.push(message);
        summaries.push({
          sheetName: target.title,
          headerRow: 0,
          dataStartRow: 0,
          rowsRead: 0,
          jobsFound: 0,
          skippedRows: 0,
          counts: { open: 0, assigned: 0, stopped: 0, cancelled: 0, draft: 0 },
          warnings: [message],
        });
      }
    }

    let unresolvedStaff = 0;
    let writes = 0;

    if (mode === "commit") {
      const staffIndex = await buildStaffNameIndex(companyId);
      unresolvedStaff = allJobs.filter(
        (job) => job.status === "assigned" &&
          job.assignedStaffName &&
          !staffIndex.byName.has(normalizeName(job.assignedStaffName))
      ).length;

      if (!lock) throw new HttpsError("internal", "取込リースを確認できません。");
      writes = await writeJobsAndLocks(
        allJobs,
        staffIndex.byName,
        runRef?.id ?? "",
        lock
      );

      if (config.markMissingAsArchived) {
        warnings.push(
          "markMissingAsArchivedは安全確認が必要なため、この版では自動アーカイブを実行していません。"
        );
      }
    }

    const totals = summarize(summaries, unresolvedStaff, writes);
    const result: ImportExecutionResult = {
      runId: runRef?.id ?? null,
      mode,
      companyId,
      spreadsheetId: config.spreadsheetId,
      sheets: summaries,
      totals,
      warnings: warnings.slice(0, 200),
      samples: allJobs.slice(0, 20).map((job) => ({
        caseId: job.caseId,
        sheetName: job.sheetRef.sheetName,
        row: job.sheetRef.currentRow,
        workDate: job.workDate,
        storeName: job.storeName,
        assignedStaffName: job.assignedStaffName,
        status: job.status,
      })),
    };

    if (runRef) {
      await runRef.set({
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
        totals,
        warnings: result.warnings,
        sheets: summaries,
      }, { merge: true });
    }

    return result;
  } catch (error) {
    if (runRef) {
      await runRef.set({
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        failedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    if (error instanceof HttpsError) throw error;
    throw new HttpsError(
      "internal",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    if (lock) await releaseSyncLock(lock);
  }
}

async function loadConfig(companyId: string): Promise<ShiftImportConfig> {
  const snap = await db.collection("sheetImportConfigs").doc(companyId).get();
  if (!snap.exists) {
    throw new HttpsError(
      "failed-precondition",
      "sheetImportConfigsに会社設定がありません。"
    );
  }

  const saved = snap.data();
  if (saved?.companyId !== undefined && saved.companyId !== companyId) {
    throw new HttpsError("failed-precondition", "取込設定の会社が一致しません。取込を停止しました。");
  }
  const parsed = ConfigSchema.safeParse({
    ...saved,
    companyId,
  });
  if (!parsed.success) {
    throw new HttpsError(
      "failed-precondition",
      "スプシ同期設定が不正です。",
      parsed.error.flatten()
    );
  }
  return parsed.data as ShiftImportConfig;
}

async function buildStaffNameIndex(companyId: string): Promise<{
  byName: Map<string, string>;
}> {
  const snap = await db.collection("staffProfiles")
    .where("companyId", "==", companyId)
    .get();
  const byName = new Map<string, string>();

  for (const doc of snap.docs) {
    const data = doc.data();
    const name = normalizeName(String(data.displayName ?? ""));
    if (!name) continue;
    if (byName.has(name) && byName.get(name) !== doc.id) {
      console.warn("Duplicate normalized staff name", { companyId, name });
      continue;
    }
    byName.set(name, doc.id);
  }
  return { byName };
}

async function writeJobsAndLocks(
  jobs: ParsedShiftJob[],
  staffNameIndex: Map<string, string>,
  runId: string,
  lock: { ref: FirebaseFirestore.DocumentReference; token: string }
): Promise<number> {
  // 案件と旧/新勤務枠を同じtransactionに収め、通信を最大25案件単位にまとめる。
  if (new Set(jobs.map((job) => job.jobId)).size !== jobs.length) {
    throw new HttpsError("failed-precondition", "取込対象に同じ案件IDが重複しています。取込を停止しました。");
  }
  let writeCount = 0;
  for (let offset = 0; offset < jobs.length; offset += 25) {
    const chunk = jobs.slice(offset, offset + 25);
    writeCount += await db.runTransaction(async (tx) => {
      const [leaseSnap] = await tx.getAll(lock.ref);
      const lease = leaseSnap?.data();
      if (!lease || lease.token !== lock.token || lease.companyId !== chunk[0]?.companyId ||
        !(lease.leaseUntil instanceof Timestamp) || lease.leaseUntil.toMillis() <= Timestamp.now().toMillis()) {
        throw new HttpsError("aborted", "取込リースの期限切れ、または所有者が変わりました。取込を停止しました。");
      }
      const jobRefs = chunk.map((job) => db.collection("jobs").doc(job.jobId));
      const snapshots = await tx.getAll(...jobRefs);
      const now = Timestamp.now();
      const plans = chunk.map((job, index) => {
        const ref = jobRefs[index];
        const snapshot = snapshots[index];
        if (!ref || !snapshot) throw new HttpsError("internal", "案件の読取結果が不足しています。取込を停止しました。");
        const old = snapshot.exists ? snapshot.data() : undefined;
        if (old && old.companyId !== job.companyId) {
          throw new HttpsError("permission-denied", "既存案件の会社が一致しません。取込を停止しました。");
        }
        const resolvedStaffId = job.assignedStaffName
          ? staffNameIndex.get(normalizeName(job.assignedStaffName)) ?? null
          : null;
        const override = old?.appOverride as { type?: string; active?: boolean } | undefined;
        const sourceMatchesOverride = override?.type === "cancel"
          ? job.cancelled === true
          : override?.type === "restore" ? job.cancelled !== true : true;
        const preserveAppOverride = override?.active === true && !sourceMatchesOverride;
        const effectiveStatus = preserveAppOverride ? String(old?.status ?? job.status) : job.status;
        const effectiveCancelled = preserveAppOverride ? old?.cancelled === true : job.cancelled;
        const isActiveAssignment = effectiveStatus === "assigned" && !effectiveCancelled && resolvedStaffId !== null;
        const oldStaffId = typeof old?.assignedStaffId === "string" ? old.assignedStaffId : null;
        const oldDateKey = typeof old?.dateKey === "string" ? old.dateKey : "";
        const pendingApplication = old?.applicationUnconfirmed === true &&
          old.status === "assigned" && old.cancelled !== true && Boolean(oldStaffId);
        const sourceConfirmsApplication = isActiveAssignment &&
          oldStaffId === resolvedStaffId && oldDateKey === job.dateKey;
        if (pendingApplication && !effectiveCancelled && !sourceConfirmsApplication) {
          throw new HttpsError("failed-precondition", "アプリ応募とシフト表の担当者・日付が未一致です。応募を保持して取込を停止しました。");
        }
        if (oldStaffId && !oldDateKey) {
          throw new HttpsError("failed-precondition", "既存案件の勤務日を確認できません。勤務枠を保持して取込を停止しました。");
        }
        const oldLockId = oldStaffId ? `${job.companyId}_${oldStaffId}_${oldDateKey}` : null;
        const newLockId = isActiveAssignment ? `${job.companyId}_${resolvedStaffId}_${job.dateKey}` : null;
        const data: Record<string, unknown> = {
          companyId: job.companyId,
          caseId: job.caseId,
          sourceIdentityKey: job.sourceIdentityKey,
          identityFingerprint: job.identityFingerprint,
          sourceOccurrence: job.sourceOccurrence,
          workDate: job.workDate,
          dateKey: job.dateKey,
          clientName: job.clientName,
          rawClientName: job.rawClientName,
          storeName: job.storeName,
          makerName: job.makerName,
          menuName: job.menuName,
          menuConditions: job.menuConditions,
          entryTime: job.entryTime,
          workTime: job.workTime,
          subcontractorName: job.subcontractorName,
          materialStatus: job.materialStatus,
          assignedStaffName: job.assignedStaffName || FieldValue.delete(),
          rawStaffName: job.rawStaffName,
          assignedStaffId: resolvedStaffId ?? FieldValue.delete(),
          assignmentUnresolved:
            effectiveStatus === "assigned" && job.assignedStaffName !== "" && !resolvedStaffId,
          status: effectiveStatus,
          publishable: preserveAppOverride
            ? old?.publishable === true
            : job.publishable,
          recruitmentStopped: preserveAppOverride
            ? old?.recruitmentStopped === true
            : job.recruitmentStopped,
          cancelled: effectiveCancelled,
          cancellationReason: preserveAppOverride
            ? (old?.cancellationReason ?? FieldValue.delete())
            : (job.cancellationReason || FieldValue.delete()),
          basePay: job.basePay,
          financials: job.financials,
          expenses: job.expenses,
          preContact: job.preContact,
          importWarnings: job.importWarnings,
          sheetRef: job.sheetRef,
          source: {
            type: "google_sheets_readonly",
            spreadsheetId: job.sheetRef.spreadsheetId,
            sheetName: job.sheetRef.sheetName,
            row: job.sheetRef.currentRow,
          },
          sync: {
            runId,
            configVersion: "0.2",
            readOnlySource: true,
            lastSeenAt: now,
          },
          sourceMissing: false,
          updatedAt: now,
        };

        if (override?.active === true) {
          data.appOverride = sourceMatchesOverride ? FieldValue.delete() : override;
        }
        if (!old) data.createdAt = now;

        if (pendingApplication && sourceConfirmsApplication) data.applicationUnconfirmed = false;
        return { job, oldStaffId, oldDateKey, oldLockId, newLockId, data, ref };
      });
      const lockIds = [...new Set(plans.flatMap((plan) => [plan.oldLockId, plan.newLockId]).filter((id): id is string => id !== null))];
      const lockRefs = lockIds.map((id) => db.collection("staffDayLocks").doc(id));
      const lockSnaps = lockRefs.length ? await tx.getAll(...lockRefs) : [];
      const locks = new Map(lockIds.map((id, index) => {
        const snapshot = lockSnaps[index];
        if (!snapshot) throw new HttpsError("internal", "勤務枠の読取結果が不足しています。取込を停止しました。");
        return [id, snapshot.data()] as const;
      }));
      const claims = new Map<string, string>();
      // 全検査を終えてから書く。既存の別案件枠や同じ取込内の重複手配は上書きしない。
      for (const plan of plans) {
        if (!plan.newLockId) continue;
        const lock = locks.get(plan.newLockId);
        const claimedBy = claims.get(plan.newLockId);
        const resolvedStaffId = plan.data.assignedStaffId;
        if ((claimedBy && claimedBy !== plan.job.jobId) || (lock && (
          lock.companyId !== plan.job.companyId || lock.staffId !== resolvedStaffId ||
          lock.dateKey !== plan.job.dateKey ||
          (lock.active !== false && (lock.active !== true || lock.jobId !== plan.job.jobId))
        ))) {
          throw new HttpsError("failed-precondition", "同日の勤務枠が競合、または所属を確認できません。案件と勤務枠を保持して取込を停止しました。");
        }
        claims.set(plan.newLockId, plan.job.jobId);
      }
      let committedWrites = 0;
      for (const plan of plans) {
        tx.set(plan.ref, plan.data, { merge: true });
        committedWrites++;
        const oldLock = plan.oldLockId ? locks.get(plan.oldLockId) : undefined;
        if (plan.oldLockId && plan.oldLockId !== plan.newLockId && !claims.has(plan.oldLockId) &&
          oldLock?.active === true && oldLock.jobId === plan.job.jobId &&
          oldLock.companyId === plan.job.companyId && oldLock.staffId === plan.oldStaffId &&
          oldLock.dateKey === plan.oldDateKey) {
          tx.set(db.collection("staffDayLocks").doc(plan.oldLockId), {
            active: false, releasedAt: now, releaseReason: "sheet.import.assignment_changed", jobId: plan.job.jobId,
          }, { merge: true });
          committedWrites++;
        }
        if (plan.newLockId) {
          tx.set(db.collection("staffDayLocks").doc(plan.newLockId), {
            companyId: plan.job.companyId, staffId: plan.data.assignedStaffId,
            dateKey: plan.job.dateKey, jobId: plan.job.jobId, active: true,
            source: "sheet.import", updatedAt: now,
          }, { merge: true });
          committedWrites++;
        }
      }
      return committedWrites;
    });
  }
  return writeCount;
}

async function acquireSyncLock(companyId: string): Promise<{
  ref: FirebaseFirestore.DocumentReference;
  token: string;
}> {
  const ref = db.collection("syncLocks").doc(`${companyId}_shift_import`);
  const token = db.collection("_ids").doc().id;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Timestamp.now();
    const currentLease = snap.data()?.leaseUntil as Timestamp | undefined;
    if (currentLease && currentLease.toMillis() > now.toMillis()) {
      throw new HttpsError(
        "already-exists",
        "別のスプシ同期が実行中です。"
      );
    }
    // 最大実行時間540秒より長く保持し、再試行時点から期限を計算する。
    const leaseUntil = Timestamp.fromMillis(now.toMillis() + 10 * 60 * 1000);
    tx.set(ref, {
      companyId,
      token,
      acquiredAt: now,
      leaseUntil,
    });
  });

  return { ref, token };
}

async function releaseSyncLock(lock: {
  ref: FirebaseFirestore.DocumentReference;
  token: string;
}): Promise<void> {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(lock.ref);
    if (snap.data()?.token === lock.token) tx.delete(lock.ref);
  });
}

function summarize(
  summaries: SheetParseSummary[],
  unresolvedStaff: number,
  writes: number
): ImportExecutionResult["totals"] {
  return summaries.reduce((total, summary) => ({
    sheets: total.sheets + 1,
    jobs: total.jobs + summary.jobsFound,
    open: total.open + summary.counts.open,
    assigned: total.assigned + summary.counts.assigned,
    stopped: total.stopped + summary.counts.stopped,
    cancelled: total.cancelled + summary.counts.cancelled,
    draft: total.draft + summary.counts.draft,
    skippedRows: total.skippedRows + summary.skippedRows,
    unresolvedStaff,
    writes,
  }), {
    sheets: 0,
    jobs: 0,
    open: 0,
    assigned: 0,
    stopped: 0,
    cancelled: 0,
    draft: 0,
    skippedRows: 0,
    unresolvedStaff,
    writes,
  });
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").replace(/[\s　]+/g, "").trim();
}

function serializeFirestoreData(
  value: FirebaseFirestore.DocumentData
): FirebaseFirestore.DocumentData {
  const result: FirebaseFirestore.DocumentData = {};
  for (const [key, item] of Object.entries(value)) {
    if (item instanceof Timestamp) {
      result[key] = item.toDate().toISOString();
    } else if (Array.isArray(item)) {
      result[key] = item.map((entry) =>
        entry instanceof Timestamp ? entry.toDate().toISOString() : entry
      );
    } else {
      result[key] = item;
    }
  }
  return result;
}
