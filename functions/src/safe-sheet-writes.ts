import { caseMailSubmissionContext } from "./submission-integrity";
import { caseMailPreparationHeld } from "./case-mail-preparation-core";
import { createHash, randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { google } from "googleapis";
import { db } from "./firebase";
import { cancellationSheetWriteIdentity, submissionSheetWriteIdentity, columnToNumber, expectedMatches, validateMutation, valuesEquivalent, ExpectedValue } from "./sheet-write-core";
import { applicationConfirmationIdentity, mailPreparationContext } from "./assignment-preparation-core";
import { parseDateKey, splitMenuConditions } from "./shift-parser";
import { assertAdminEditCurrent, adminEditValueMatches, editSourceIdentity } from "./admin-edit-state-core";
import { cancellationReasonLabels, cancellationTreatmentLabels } from "./analytics-core";
import { buildExpenseExpected, buildExpenseSheetUpdates, expenseSheetWriteContext, expenseMailHoldReason, normalizeExpenseInput } from "./admin-operations-core";
import { getProductionOperationalState } from "./system-safety";
import { incrementProductionMetrics } from "./production-metrics";

type Queue = {
  companyId: string; jobId: string; operation: string; dateKey?: string;
  updates?: Record<string, unknown>; styles?: Record<string, { background?: string }>;
  expected?: Record<string, ExpectedValue>; idempotencyKey?: string; attempts?: number;
  status?: string; actorUid?: string; actorStaffId?: string; claimToken?: string;
};
type Mapping = {
  enabled?: boolean; spreadsheetId: string; idColumn?: string; allowVerifiedFallbackRow?: boolean;
  columns: Record<string, string>; identityColumns?: { workDate: string; clientName: string; storeName: string; workTime: string };
  operations: Record<string, { values: string[]; styles?: string[] }>;
  valueInputOption?: "RAW" | "USER_ENTERED"; maxAttempts?: number;
};

export const processSafeSheetWrite = onDocumentWritten("sheetSyncQueue/{queueId}", async event => {
  const after = event.data?.after;
  if (!after?.exists || after.data()?.status !== "pending") return;
  // 遅延イベントの本文ではなく、transactionで獲得した最新の依頼を使う。
  const queue = await claim(after.ref);
  if (!queue) return;
  try {
    const state = await getProductionOperationalState(queue.companyId);
    if (!state.operational) {
      await finishOwned(after.ref, queue, { status: "paused_global", pauseReason: state.reason, updatedAt: FieldValue.serverTimestamp() });
      return;
    }
    await incrementProductionMetrics(queue.companyId, { sheetWriteAttempts: 1 }, "safe_sheet_write");
    await execute(after.ref, queue);
  } catch (error) {
    // 計測の障害で、処理中の依頼を回復不能のまま残さない。
    try {
      await incrementProductionMetrics(queue.companyId, {
        sheetWriteFailures: 1, ...(error instanceof ConflictError ? { dataMismatchCount: 1 } : {}),
      }, "safe_sheet_write_failed");
    } catch { /* 業務キューの失敗記録を優先する。 */ }
    await fail(after.ref, queue, error);
  }
});

export const retrySafeSheetWrites = onSchedule({ schedule: "every 5 minutes", timeZone: "Asia/Tokyo", timeoutSeconds: 300 }, async () => {
  const now = Timestamp.now();
  const snap = await db.collection("sheetSyncQueue").where("status", "==", "retry_wait").where("retryAt", "<=", now).limit(100).get();
  // status/retryAtの既存索引を使う。中断した処理を再書込せず、管理者の確認対象へ移す。
  const expired = await db.collection("sheetSyncQueue").where("status", "==", "processing").where("retryAt", "<=", now).limit(100).get();
  for (const doc of expired.docs) await db.runTransaction(async tx => {
    const current = await tx.get(doc.ref), data = current.data();
    if (data?.status !== "processing" || !(data.retryAt instanceof Timestamp) || data.retryAt.toMillis() > now.toMillis()) return;
    tx.set(doc.ref, {
      status: "blocked", errorType: "verification_required", writeVerificationRequired: true,
      errorMessage: "処理が期限内に完了しませんでした。シフト表と依頼を確認してください。自動再書込は行いません。",
      retryAt: null, failedAt: now, updatedAt: now,
    }, { merge: true });
  });
  // 読込後に状態が変わった依頼をpendingへ戻さない。確認待ちは自動再試行しない。
  for (const doc of snap.docs) await db.runTransaction(async tx => {
    const current = await tx.get(doc.ref), data = current.data();
    if (data?.status !== "retry_wait" || !(data.retryAt instanceof Timestamp) || data.retryAt.toMillis() > now.toMillis()) return;
    tx.set(doc.ref, requiresWriteVerification(data) ? verificationHold(data, now) : { status: "pending", updatedAt: now }, { merge: true });
  });
});

function requiresWriteVerification(data: FirebaseFirestore.DocumentData): boolean {
  return data.errorType === "verification_required" ||
    (data.writeVerificationRequired !== undefined && data.writeVerificationRequired !== false);
}
function verificationHold(data: FirebaseFirestore.DocumentData, now = Timestamp.now()): FirebaseFirestore.DocumentData {
  return {
    status: "blocked", errorType: "verification_required", writeVerificationRequired: true,
    errorMessage: typeof data.errorMessage === "string" && data.errorMessage.trim() ? data.errorMessage
      : "以前の書込結果を確認できません。シフト表と依頼の照合が必要です。自動再書込は行いません。",
    retryAt: null, failedAt: data.failedAt instanceof Timestamp ? data.failedAt : now, updatedAt: now,
  };
}

async function claim(ref: FirebaseFirestore.DocumentReference): Promise<Queue | null> {
  const token = randomUUID();
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref), data = snap.data();
    if (!snap.exists || data?.status !== "pending") return null;
    // 状態だけが待機へ戻った旧依頼も、結果未確認なら試行回数を増やさず保持する。
    if (requiresWriteVerification(data)) { tx.set(ref, verificationHold(data), { merge: true }); return null; }
    const attempts = Number(data.attempts ?? 0) + 1;
    const retryAt = Timestamp.fromMillis(Date.now() + 10 * 60_000);
    tx.set(ref, { status: "processing", claimToken: token, processingStartedAt: FieldValue.serverTimestamp(), retryAt, attempts }, { merge: true });
    return { ...data, status: "processing", claimToken: token, attempts } as Queue;
  });
}
function assertOwned(current: FirebaseFirestore.DocumentData | undefined, queue: Queue): void {
  if (!current || current.status !== "processing" || current.claimToken !== queue.claimToken) throw new BlockedError("依頼の処理担当が変更されています。");
  if (requiresWriteVerification(current)) throw new VerificationRequiredError("書込結果の確認待ちに変わりました。シフト表と依頼の照合が必要です。");
  if (!(current.retryAt instanceof Timestamp) || current.retryAt.toMillis() <= Timestamp.now().toMillis()) throw new BlockedError("書込処理の期限が切れました。状態を確認してください。");
  if (queueFingerprint(current as Queue) !== queueFingerprint(queue)) throw new ConflictError("処理中に依頼の内容が変更されました。");
}
function queueFingerprint(queue: Queue): string {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])) : value;
  return JSON.stringify(sort({
    companyId: queue.companyId, jobId: queue.jobId, operation: queue.operation, dateKey: queue.dateKey,
    updates: queue.updates, styles: queue.styles, expected: queue.expected, idempotencyKey: queue.idempotencyKey,
    actorUid: queue.actorUid, actorStaffId: queue.actorStaffId,
  }));
}
async function finishOwned(ref: FirebaseFirestore.DocumentReference, queue: Queue, data: FirebaseFirestore.DocumentData) {
  await db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (!current || current.claimToken !== queue.claimToken || current.status !== "processing") return;
    // 失敗・重複完了・運用停止の保存でも、並行して付いた結果未確認を解除しない。
    tx.set(ref, requiresWriteVerification(current) ? verificationHold(current) : data, { merge: true });
  });
}

function assertPreContact(ref: FirebaseFirestore.DocumentReference, queue: Queue, job: FirebaseFirestore.DocumentData, mapping: Mapping): void {
  if (queue.operation !== "precontact.submit") return;
  const saved = job.preContact, updates = queue.updates ?? {};
  if (caseMailPreparationHeld(job) || (job.mailIntake && saved?.caseMailContext !== mailPreparationContext(job))) {
    throw new BlockedError("受信内容・勤務条件が変わっています。事前連絡を再確認してください。");
  }
  if (job.status !== "assigned" || job.cancelled === true || job.sourceMissing === true ||
      job.assignmentUnresolved === true || job.applicationUnconfirmed === true || job.preContactNeedsReview === true) {
    throw new BlockedError("現在の手配と事前連絡の本人確認が完了していません。");
  }
  if (!queue.actorStaffId || queue.actorStaffId !== job.assignedStaffId || !queue.dateKey ||
      queue.dateKey !== job.dateKey || parseDateKey(queue.dateKey, "") !== queue.dateKey ||
      saved?.source !== "app" || saved.staffId !== queue.actorStaffId || saved.dateKey !== queue.dateKey ||
      saved.operationId !== ref.id || !(saved.submittedAt instanceof Timestamp) ||
      queue.idempotencyKey !== `precontact:${queue.jobId}:${ref.id}`) {
    throw new BlockedError("担当・勤務日・事前連絡の保存履歴が現在の依頼と一致しません。");
  }
  if (Object.keys(updates).sort().join(",") !== "arrivalTime,temperature" || Object.keys(queue.styles ?? {}).length ||
      typeof updates.temperature !== "number" || !Number.isFinite(updates.temperature) || updates.temperature < 34 || updates.temperature > 42 ||
      typeof updates.arrivalTime !== "string" || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(updates.arrivalTime) ||
      saved.temperature !== updates.temperature || !matchesValue(queue, "arrivalTime", saved.arrivalTime, updates.arrivalTime)) {
    throw new BlockedError("事前連絡の内容が最新の保存値と一致しません。");
  }
  if (!job.sheetRef?.spreadsheetId || job.sheetRef.spreadsheetId !== mapping.spreadsheetId ||
      !String(job.assignedStaffName ?? "").trim() || !mapping.columns.staffName || !(mapping.columns.workDate || mapping.identityColumns?.workDate)) {
    throw new BlockedError("事前連絡の元シフト表・担当氏名・勤務日の照合設定が不足しています。");
  }
}
function assertAssignment(ref: FirebaseFirestore.DocumentReference, queue: Queue, job: FirebaseFirestore.DocumentData,
  mapping: Mapping, staff: FirebaseFirestore.DocumentData | undefined, lock: FirebaseFirestore.DocumentData | undefined): void {
  if (queue.operation !== "job.assign") return;
  const saved = job.assignmentSheetWrite;
  if (job.mailIntake && (job.mailIntakeReviewRequired === true || job.pendingSourceWrite === true || job.adminEditSheetWrite?.pending === true ||
      saved?.confirmation !== applicationConfirmationIdentity(job))) {
    throw new ConflictError("応募後に受信内容・勤務条件が変わっています。担当と原本を再確認してください。");
  }
  if (job.status !== "assigned" || job.cancelled === true || job.sourceMissing === true || job.assignmentUnresolved === true ||
      !queue.actorStaffId || queue.actorStaffId !== job.assignedStaffId || !queue.dateKey || queue.dateKey !== job.dateKey ||
      parseDateKey(queue.dateKey, "") !== queue.dateKey || !queue.actorUid || queue.actorUid !== job.assignedUid ||
      saved?.queueId !== ref.id || saved.identity !== cancellationSheetWriteIdentity(job) ||
      queue.idempotencyKey !== `job.assign:${queue.jobId}:${ref.id}`) {
    throw new ConflictError("応募時の担当・勤務日・操作が現在の確定内容と一致しません。");
  }
  if (!staff || staff.companyId !== queue.companyId || staff.active !== true ||
      typeof staff.displayName !== "string" || !staff.displayName.trim() || staff.displayName !== job.assignedStaffName ||
      !lock || lock.companyId !== queue.companyId || lock.jobId !== queue.jobId || lock.staffId !== queue.actorStaffId || lock.dateKey !== queue.dateKey || lock.active !== true) {
    throw new ConflictError("応募者の利用状態・氏名または当日の勤務枠が変更されています。");
  }
  if (!job.sheetRef?.spreadsheetId || job.sheetRef.spreadsheetId !== mapping.spreadsheetId ||
      !mapping.columns.staffName || !(mapping.columns.workDate || mapping.identityColumns?.workDate) ||
      stableJson(queue.updates) !== stableJson({ staffName: staff.displayName }) || Object.keys(queue.styles ?? {}).length ||
      stableJson(queue.expected) !== stableJson({ staffName: { mode: "blank" } })) {
    throw new ConflictError("応募の書込対象・確認条件が最新の手配と一致しません。");
  }
}

function assertAdminEdit(ref: FirebaseFirestore.DocumentReference, queue: Queue, job: FirebaseFirestore.DocumentData, mapping: Mapping): void {
  try { assertAdminEditCurrent(ref.id, queue, job, mapping); }
  catch (error) { throw new ConflictError(error instanceof Error ? error.message : "管理者編集の確認が必要です。"); }
}
function assertCancellation(ref: FirebaseFirestore.DocumentReference, queue: Queue, job: FirebaseFirestore.DocumentData): void {
  if (!["job.cancel", "job.cancel.v2", "job.restore"].includes(queue.operation)) return;
  const saved = job.cancellationSheetWrite, restore = queue.operation === "job.restore";
  if (saved?.queueId !== ref.id || saved.operation !== queue.operation || saved.identity !== cancellationSheetWriteIdentity(job) ||
      queue.idempotencyKey !== `${queue.operation}:${queue.jobId}:${ref.id}` || job.sourceMissing === true ||
      (restore ? job.cancelled !== false || !["open", "assigned"].includes(job.status) : job.cancelled !== true || job.status !== "cancelled")) {
    throw new ConflictError("取消・復帰の操作が更新されたか、担当・勤務日・元シフト表が変更されています。最新の案件を確認してください。");
  }
  const expected: Record<string, unknown> = restore
    ? { cancelled: false, cancellationReason: "", cancellationReasonCategory: "", cancellationFinancialTreatment: "" }
    : { cancelled: true, cancellationReason: job.cancellationReason };
  if (!restore && (typeof job.cancellationReason !== "string" || !job.cancellationReason.trim())) throw new ConflictError("現在の取消理由を確認できません。");
  if (queue.operation === "job.cancel.v2") {
    const reason = job.cancellationReasonCategory as keyof typeof cancellationReasonLabels;
    const treatment = job.cancellationFinancialTreatment as keyof typeof cancellationTreatmentLabels;
    if (!Object.hasOwn(cancellationReasonLabels, reason) || !Object.hasOwn(cancellationTreatmentLabels, treatment)) throw new ConflictError("現在の取消区分・金額の扱いを確認できません。");
    expected.cancellationReasonCategory = cancellationReasonLabels[reason];
    expected.cancellationFinancialTreatment = cancellationTreatmentLabels[treatment];
  }
  if (Object.keys(queue.styles ?? {}).length || stableJson(queue.updates ?? {}) !== stableJson(expected)) {
    throw new ConflictError("取消・復帰の書込内容が最新の案件と一致しません。");
  }
}

function assertNetPrint(ref: FirebaseFirestore.DocumentReference, queue: Queue, job: FirebaseFirestore.DocumentData): void {
  if (!["netprint.update", "netprint.printed"].includes(queue.operation)) return;
  if (caseMailPreparationHeld(job)) throw new ConflictError("受信内容・勤務条件を確認中のため資料反映を停止しました。");
  const saved = job.netPrint, items = saved?.items, identity = cancellationSheetWriteIdentity(job);
  if (job.sourceMissing === true || job.assignmentUnresolved === true || !Array.isArray(items) || items.length > 3 ||
      items.some((item, index) => !item || typeof item.id !== "string" || !item.id || typeof item.number !== "string" || !item.number.trim() || item.position !== index + 1) ||
      new Set(items.map(item => item.id)).size !== items.length) throw new ConflictError("現在の資料と担当・元シフト表を確認できません。");
  const printed = (item: FirebaseFirestore.DocumentData) => (!job.mailIntake || item.caseMailContext === caseMailSubmissionContext(job)) && item.printed === true && item.printedAt instanceof Timestamp && item.printedContext === identity &&
    item.printedByStaffId === job.assignedStaffId && item.printedForDate === job.dateKey && typeof item.printOperationId === "string";
  if (queue.operation === "netprint.update") {
    const updates = Object.fromEntries([1,2,3].map(position => [`netPrint${position}`, items[position - 1]?.number ?? ""]));
    const styles = Object.fromEntries([1,2,3].map(position => [`netPrint${position}`, { background: items[position - 1] && printed(items[position - 1]) ? "#fff2cc" : "#ffffff" }]));
    if ((job.mailIntake && saved.caseMailContext !== caseMailSubmissionContext(job)) || saved.writeOperationId !== ref.id || saved.writeIdentity !== identity ||
        queue.idempotencyKey !== `netprint.update:${queue.jobId}:${ref.id}` || stableJson(queue.updates) !== stableJson(updates) ||
        stableJson(queue.styles) !== stableJson(saved.writeStyles) || stableJson(queue.styles) !== stableJson(styles) ||
        stableJson(queue.expected) !== stableJson(saved.writeExpected)) throw new ConflictError("資料番号か印刷状態が更新されています。最新の内容で番号登録を確認し直してください。");
    return;
  }
  const targets = items.filter(item => item.printOperationId === ref.id);
  const target = targets[0], key = `netPrint${target?.position}`;
  if (job.status !== "assigned" || job.cancelled === true || job.applicationUnconfirmed === true ||
      !queue.actorStaffId || queue.actorStaffId !== job.assignedStaffId || !queue.dateKey || queue.dateKey !== job.dateKey ||
      parseDateKey(queue.dateKey, "") !== queue.dateKey || targets.length !== 1 || !printed(target) ||
      !(target.printedAt instanceof Timestamp) || queue.idempotencyKey !== `netprint.printed:${queue.jobId}:${ref.id}` ||
      Object.keys(queue.updates ?? {}).length || stableJson(queue.styles) !== stableJson({ [key]: { background: "#fff2cc" } }) ||
      stableJson(queue.expected) !== stableJson({ [key]: { mode: "exact", value: target.number } })) {
    throw new ConflictError("印刷済みの担当・勤務日・資料・操作番号が現在の依頼と一致しません。");
  }
}

function assertSubmissionState(ref: FirebaseFirestore.DocumentReference, queue: Queue, job: FirebaseFirestore.DocumentData, mapping: Mapping): void {
  if (!["submission.report", "submission.sales_floor"].includes(queue.operation)) return;
  if (caseMailPreparationHeld(job)) throw new ConflictError("受信内容・勤務条件を確認中のため提出反映を停止しました。");
  const report = queue.operation === "submission.report", state = job.submissionStatus?.[report ? "report" : "salesFloor"], saved = state?.sheetWrite;
  const updates = report ? { reportSubmitted: state?.lateFirstSubmission === true ? "遅延" : "提出済" }
    : { salesFloorSubmitted: state?.clientSubmitted === true && state?.lipKnotsSubmitted === true ? "直＋リップ" : state?.clientSubmitted === true ? "直" : state?.lipKnotsSubmitted === true ? "リップ" : "" };
  if (job.status !== "assigned" || job.cancelled === true || job.sourceMissing === true || job.applicationUnconfirmed === true || job.assignmentUnresolved === true ||
      !queue.actorStaffId || queue.actorStaffId !== job.assignedStaffId || !queue.actorUid || !queue.dateKey || queue.dateKey !== job.dateKey || parseDateKey(queue.dateKey, "") !== queue.dateKey ||
      !Number.isSafeInteger(job.revision ?? 0) || Number(job.revision ?? 0) < 0 || mapping.columns.staffName !== "B" ||
      saved?.operationId !== ref.id || saved.identity !== submissionSheetWriteIdentity(job) || (job.mailIntake && saved.caseMailContext !== caseMailSubmissionContext(job)) || saved.pending !== true ||
      queue.idempotencyKey !== queue.operation + ":" + queue.jobId + ":" + ref.id || Object.keys(queue.styles ?? {}).length ||
      (report && (state?.completed !== true || state?.lipKnotsSubmitted !== true)) ||
      stableJson(queue.updates) !== stableJson(updates)) throw new ConflictError("提出状態の操作番号・担当・勤務日・元シフト表が現在の記録と一致しません。最新の提出状態を確認してください。");
}

function assertExpenseReview(ref: FirebaseFirestore.DocumentReference, queue: Queue, job: FirebaseFirestore.DocumentData, review: FirebaseFirestore.DocumentData | undefined): void {
  if (queue.operation !== "expense.review") return;
  if (expenseMailHoldReason(job)) throw new ConflictError("受信案件の担当・勤務条件・原本を確認中のため、経費反映を停止しました。");
  if (!review || review.companyId !== queue.companyId || review.jobId !== queue.jobId || review.queueId !== ref.id ||
      !["queued", "error"].includes(String(review.status)) ||
      (review.staffId ?? null) !== (job.assignedStaffId ?? null) || job.sourceMissing === true ||
      job.assignmentUnresolved === true || review.writeContext !== expenseSheetWriteContext(job) ||
      !Number.isSafeInteger(review.revision) || review.revision < 1 ||
      queue.idempotencyKey !== `expense.review:${queue.jobId}:${review.revision}`) {
    throw new ConflictError("経費の確認番号・担当・勤務日・書込先が現在の依頼と一致しません。最新の案件から確認し直してください。");
  }
  if (!review.values || typeof review.values !== "object" || Array.isArray(review.values)) {
    throw new ConflictError("経費の保存内容を確認できません。");
  }
  // 受付後の再試行でも、確認時の旧金額と同じ条件だけを許可する。
  if (!review.expectedValues || typeof review.expectedValues !== "object" || Array.isArray(review.expectedValues)) {
    throw new ConflictError("変更前の経費の確認記録がありません。最新の案件から確認し直してください。");
  }
  const before = normalizeExpenseInput(review.expectedValues);
  const current = normalizeExpenseInput(job.expenses ?? {});
  if (before.errors.length || current.errors.length ||
      stableJson(before.values) !== stableJson(review.expectedValues) ||
      stableJson(before.values) !== stableJson(current.values) ||
      stableJson(buildExpenseExpected(before.values)) !== stableJson(queue.expected ?? {})) {
    throw new ConflictError("変更前の経費または照合条件が変わっています。最新の案件から確認し直してください。");
  }
  const values = normalizeExpenseInput(review.values);
  if (values.errors.length || Object.keys(queue.styles ?? {}).length ||
      stableJson(buildExpenseSheetUpdates(values.values)) !== stableJson(queue.updates ?? {})) {
    throw new ConflictError("書き戻す経費が最新の確認内容と一致しません。");
  }
}

function matchesValue(queue: Queue, key: string, actual: unknown, expected: unknown): boolean {
  if (queue.operation === "expense.review") {
    const left = normalizeExpenseInput({ [key]: actual }), right = normalizeExpenseInput({ [key]: expected });
    return !left.errors.length && !right.errors.length && Object.hasOwn(left.values, key) &&
      left.values[key as keyof typeof left.values] === right.values[key as keyof typeof right.values];
  }
  if (queue.operation === "job.admin_edit") return adminEditValueMatches(key, actual, expected);
  if (queue.operation === "precontact.submit" && key === "temperature") {
    const number = (value: unknown) => {
      const text = typeof value === "string" ? value.normalize("NFKC").trim() : "";
      const parsed = typeof value === "number" ? value : /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
      return Number.isFinite(parsed) && parsed >= 34 && parsed <= 42 ? parsed : null;
    };
    const a = number(actual), b = number(expected);
    return a !== null && a === b;
  }
  if (queue.operation === "precontact.submit" && key === "arrivalTime") {
    const normalize = (value: unknown) => typeof value === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(value.trim().normalize("NFKC"))
      ? value.trim().normalize("NFKC").padStart(5, "0") : null;
    const a = normalize(actual), b = normalize(expected);
    return a !== null && a === b;
  }
  return valuesEquivalent(actual, expected);
}

async function execute(ref: FirebaseFirestore.DocumentReference, queue: Queue) {
  let mutationAttempted = false;
  try {
    const jobRef = db.collection("jobs").doc(queue.jobId);
    const mapRef = db.doc(`companies/${queue.companyId}/sheetMappings/shift`);
    const reviewRef = queue.operation === "expense.review" ? db.collection("expenseReviews").doc(queue.jobId) : null;
    const adminStaffEdit = queue.operation === "job.admin_edit" && Boolean(queue.updates?.staffName);
    const editSourceRef = queue.operation === "job.admin_edit" ? db.collection("adminJobEditSources").doc(queue.jobId) : null;
    const staffRef = (queue.operation === "job.assign" || adminStaffEdit) && queue.actorStaffId ? db.collection("staffProfiles").doc(queue.actorStaffId) : null;
    const lockRef = staffRef && queue.dateKey ? db.collection("staffDayLocks").doc(`${queue.companyId}_${queue.actorStaffId}_${queue.dateKey}`) : null;
    const verifyAssignment = async (currentJob: FirebaseFirestore.DocumentData, mapping: Mapping, tx?: FirebaseFirestore.Transaction) => {
      if (queue.operation !== "job.assign" && !adminStaffEdit) return;
      const [staff, lock] = await Promise.all([
        staffRef ? (tx ? tx.get(staffRef) : staffRef.get()) : null,
        lockRef ? (tx ? tx.get(lockRef) : lockRef.get()) : null,
      ]);
      if (queue.operation === "job.assign") assertAssignment(ref, queue, currentJob, mapping, staff?.data(), lock?.data());
      else {
        const person = staff?.data(), currentLock = lock?.data();
        if (person?.companyId !== queue.companyId || person.active !== true || person.displayName !== currentJob.assignedStaffName ||
            currentLock?.companyId !== queue.companyId || currentLock.jobId !== queue.jobId || currentLock.staffId !== queue.actorStaffId || currentLock.dateKey !== queue.dateKey || currentLock.active !== true) {
          throw new ConflictError("管理者が選択したスタッフの利用状態・勤務枠が変更されています。");
        }
      }
    };
    const verifyEditSource = async (currentJob: FirebaseFirestore.DocumentData, tx?: FirebaseFirestore.Transaction) => {
      if (!editSourceRef) return null;
      const source = (await (tx ? tx.get(editSourceRef) : editSourceRef.get())).data();
      if (!source || source.version !== 1 || source.companyId !== queue.companyId || source.jobId !== queue.jobId ||
          source.identity !== editSourceIdentity(currentJob) || Object.keys(queue.updates ?? {}).some(key =>
            source.columns?.[key] !== currentJob.adminEditSheetWrite?.columns?.[key] ||
            !Object.hasOwn(source.values ?? {}, key) ||
            (!adminEditValueMatches(key, source.values[key], queue.expected?.[key]?.value) &&
             !adminEditValueMatches(key, source.values[key], queue.updates?.[key])))) {
        throw new ConflictError("編集前の原本確認値を確認できません。再取込と変更履歴を確認してください。");
      }
      return source;
    };
    const [jobSnap, mapSnap] = await Promise.all([jobRef.get(), mapRef.get()]);
    if (!jobSnap.exists || !mapSnap.exists) throw new BlockedError("案件または列マッピングが見つかりません。");
    const job = jobSnap.data()!, mapping = mapSnap.data() as Mapping;
    if (mapping.enabled !== true) throw new BlockedError("安全書込がまだ有効化されていません。");
    if (job.companyId !== queue.companyId) throw new BlockedError("会社情報が一致しません。");
    if (job.sheetRef?.spreadsheetId && job.sheetRef.spreadsheetId !== mapping.spreadsheetId) throw new BlockedError("元のシフト表が一致しません。");
    await verifyAssignment(job, mapping);
    assertAdminEdit(ref, queue, job, mapping);
    await verifyEditSource(job);
    assertPreContact(ref, queue, job, mapping);
    assertCancellation(ref, queue, job);
    assertNetPrint(ref, queue, job);
    assertSubmissionState(ref, queue, job, mapping);
    if (reviewRef) assertExpenseReview(ref, queue, job, (await reviewRef.get()).data());
    const styleOnly = Object.keys(queue.styles ?? {}).filter(key => !Object.hasOwn(queue.updates ?? {}, key));
    for (const key of styleOnly) {
      const expected = queue.expected?.[key];
      if (!expected || !["exact", "blank"].includes(expected.mode) ||
          (expected.mode === "exact" && expected.value === undefined)) {
        throw new BlockedError("書式だけを変更する対象セルの確認条件がありません。");
      }
    }
    const matchesExpected = (key: string, value: unknown, expected: ExpectedValue) =>
      expected.mode === "exact" ? matchesValue(queue, key, value, expected.value) : expectedMatches(value, expected);
    const errors = validateMutation(mapping, queue.operation, queue.updates ?? {}, queue.styles ?? {});
    if (errors.length) throw new BlockedError(errors.join(" / "));
    if (Object.keys(queue.styles ?? {}).length) {
      if (!Number.isInteger(job.sheetRef?.sheetId) || job.sheetRef.sheetId < 0) throw new BlockedError("書式変更にはsheetIdが必要です。");
      for (const [key, style] of Object.entries(queue.styles ?? {})) {
        if (!/^[A-Z]{1,3}$/i.test(mapping.columns[key] ?? "") || !style || typeof style !== "object" ||
            Array.isArray(style) || Object.keys(style).some(key => key !== "background") ||
            typeof style.background !== "string" || !/^#?[a-f\d]{6}$/i.test(style.background)) {
          throw new BlockedError("書式変更の列または背景色を確認できません。");
        }
      }
    }
    const sheetName = String(job.sheetRef?.sheetName ?? "");
    if (!sheetName) throw new BlockedError("対象月タブが不明です。");

    if (queue.idempotencyKey) {
      const dedupe = await db.collection("sheetWriteIdempotency").doc(hashKey(queue.companyId, queue.idempotencyKey)).get();
      if (dedupe.exists && dedupe.data()?.status === "completed" && dedupe.data()?.queueId !== ref.id) {
        if (dedupe.data()?.companyId !== queue.companyId) throw new BlockedError("書込済み記録の会社が一致しません。");
        await finishOwned(ref, queue, { status: "completed", duplicateOf: dedupe.data()?.queueId, completedAt: FieldValue.serverTimestamp() });
        return;
      }
    }
    const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    const row = await locateAndVerify(sheets, mapping, job, sheetName);
    const keys = [...new Set([...Object.keys(queue.updates ?? {}), ...Object.keys(queue.styles ?? {})])];
    const cell = (column: string) => {
      if (!/^[A-Z]{1,3}$/i.test(column)) throw new BlockedError("列マッピングが不正です。");
      return `'${sheetName.replace(/'/g, "''")}'!${column}${row}`;
    };
    const ranges = keys.map(key => cell(mapping.columns[key]!));
    if ((["precontact.submit", "job.assign", "submission.report", "submission.sales_floor"].includes(queue.operation) || (job.mailIntake && ["netprint.printed", "netprint.update"].includes(queue.operation)))) await verifyPreContactRow(sheets, mapping, job, queue, sheetName, row, queue.operation === "job.assign");
    if (queue.operation === "job.admin_edit") await verifyPreContactRow(sheets, mapping, job, queue, sheetName, row, !job.assignedStaffId, Object.hasOwn(queue.updates ?? {}, "staffName"));
    await verifyMailExpenseRow(sheets, mapping, job, queue, sheetName, row);
    const currentResp = await sheets.spreadsheets.values.batchGet({ spreadsheetId: mapping.spreadsheetId, ranges, valueRenderOption: "FORMATTED_VALUE" });
    const before: Record<string, unknown> = {};
    keys.forEach((key, i) => before[key] = currentResp.data.valueRanges?.[i]?.values?.[0]?.[0] ?? "");
    const allAlready = Object.entries(queue.updates ?? {}).every(([key, value]) => matchesValue(queue, key, before[key], value));
    for (const [key, expected] of Object.entries(queue.expected ?? {})) {
      // 値が全て反映済みでも、色だけを付ける別セルの照合は省略しない。
      if (allAlready && !styleOnly.includes(key)) continue;
      if (!matchesExpected(key, before[key], expected)) throw new ConflictError(`${key}はシフト表側で変更されています。内容を確認してください。`);
    }
    // 外部読取を待つ間の担当変更・新入力・キューの再獲得を再検査する。
    const ensureCurrent = async () => {
    const [latestJob, latestQueue, latestMapping] = await Promise.all([jobRef.get(), ref.get(), mapRef.get()]);
    assertOwned(latestQueue.data(), queue);
    if (latestJob.data()?.companyId !== queue.companyId) throw new BlockedError("案件の会社が変更されています。");
    await verifyAssignment(latestJob.data()!, mapping);
    assertAdminEdit(ref, queue, latestJob.data()!, mapping);
    await verifyEditSource(latestJob.data()!);
    assertPreContact(ref, queue, latestJob.data()!, mapping);
    assertCancellation(ref, queue, latestJob.data()!);
    assertNetPrint(ref, queue, latestJob.data()!);
    assertSubmissionState(ref, queue, latestJob.data()!, mapping);
    if (reviewRef) assertExpenseReview(ref, queue, latestJob.data()!, (await reviewRef.get()).data());
    if (jobReference(latestJob.data()) !== jobReference(job) || stableJson(latestMapping.data()) !== stableJson(mapping)) throw new ConflictError("案件の参照先・担当・書込設定が変更されています。");
    if (!(await getProductionOperationalState(queue.companyId)).operational) throw new BlockedError("書込前に運用が停止されました。");
    };
    await ensureCurrent();

    if (["job.assign", "submission.report", "submission.sales_floor"].includes(queue.operation) || (job.mailIntake && ["netprint.printed", "netprint.update"].includes(queue.operation))) {
      await verifyPreContactRow(sheets, mapping, job, queue, sheetName, row, queue.operation === "job.assign");
      await ensureCurrent();
    }
    if (queue.operation === "job.admin_edit") {
      await verifyPreContactRow(sheets, mapping, job, queue, sheetName, row, !job.assignedStaffId, Object.hasOwn(queue.updates ?? {}, "staffName"));
      await ensureCurrent();
    }
    await verifyMailExpenseRow(sheets, mapping, job, queue, sheetName, row);
    if (queue.operation === "expense.review" && job.mailIntake) await ensureCurrent();
    if (!allAlready) {
      const data = Object.entries(queue.updates ?? {}).map(([key, value]) => ({ range: cell(mapping.columns[key]!), values: [[value ?? ""]] }));
      if (data.length) {
        mutationAttempted = true;
        await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: mapping.spreadsheetId, requestBody: { valueInputOption: (["job.assign", "job.admin_edit"].includes(queue.operation) || (queue.operation === "expense.review" && job.mailIntake)) ? "RAW" : mapping.valueInputOption ?? "USER_ENTERED", data } });
      }
    }
    const styleRequests = Object.entries(queue.styles ?? {}).map(([key, style]) => {
      const column = mapping.columns[key];
      if (!column) throw new BlockedError("書式の列マッピングがありません。");
      return { repeatCell: { range: { sheetId: Number(job.sheetRef?.sheetId ?? 0), startRowIndex: row - 1, endRowIndex: row, startColumnIndex: columnToNumber(column) - 1, endColumnIndex: columnToNumber(column) }, cell: { userEnteredFormat: { backgroundColor: hexToRgb(style.background ?? "#ffffff") } }, fields: "userEnteredFormat.backgroundColor" } };
    });
    if (styleRequests.length) {
      if (mutationAttempted) await ensureCurrent();
      if (styleOnly.length) {
        const current = await sheets.spreadsheets.values.batchGet({ spreadsheetId: mapping.spreadsheetId, ranges: styleOnly.map(key => cell(mapping.columns[key]!)), valueRenderOption: "FORMATTED_VALUE" });
        for (const [index, key] of styleOnly.entries()) {
          if (!matchesExpected(key, current.data.valueRanges?.[index]?.values?.[0]?.[0] ?? "", queue.expected![key]!)) {
            throw new ConflictError("書式変更の直前に対象セルの内容が変わりました。");
          }
        }
        await ensureCurrent();
      }
      if (!Number.isInteger(job.sheetRef?.sheetId) || job.sheetRef.sheetId < 0) throw new BlockedError("書式変更にはsheetIdが必要です。");
      mutationAttempted = true;
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: mapping.spreadsheetId, requestBody: { requests: styleRequests } });
    }
    const verify = [...new Set([...Object.keys(queue.updates ?? {}), ...styleOnly])], afterValues: Record<string, unknown> = {};
    if (verify.length) {
      const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId: mapping.spreadsheetId, ranges: verify.map(key => cell(mapping.columns[key]!)), valueRenderOption: "FORMATTED_VALUE" });
      verify.forEach((key, i) => afterValues[key] = response.data.valueRanges?.[i]?.values?.[0]?.[0] ?? "");
      for (const [key, value] of Object.entries(queue.updates ?? {})) if (!matchesValue(queue, key, afterValues[key], value)) throw new Error("書込後の値を確認できません。");
      for (const key of styleOnly) if (!matchesExpected(key, afterValues[key], queue.expected![key]!)) throw new Error("書式変更後の対象セルを確認できません。");
    }
    if ((["precontact.submit", "job.assign", "submission.report", "submission.sales_floor"].includes(queue.operation) || (job.mailIntake && ["netprint.printed", "netprint.update"].includes(queue.operation)))) await verifyPreContactRow(sheets, mapping, job, queue, sheetName, row);
    if (queue.operation === "job.admin_edit") await verifyPreContactRow(sheets, mapping, job, queue, sheetName, row, !job.assignedStaffId);
    await verifyMailExpenseRow(sheets, mapping, job, queue, sheetName, row);
    const now = Timestamp.now(), auditRef = db.collection("auditLogs").doc();
    await db.runTransaction(async tx => {
      const currentQueue = await tx.get(ref), currentJob = await tx.get(jobRef), currentMapping = await tx.get(mapRef);
      assertOwned(currentQueue.data(), queue);
      if (currentJob.data()?.companyId !== queue.companyId) throw new ConflictError("案件の会社が変更されています。");
      await verifyAssignment(currentJob.data()!, mapping, tx);
      assertAdminEdit(ref, queue, currentJob.data()!, mapping);
      assertPreContact(ref, queue, currentJob.data()!, mapping);
      assertCancellation(ref, queue, currentJob.data()!);
      assertNetPrint(ref, queue, currentJob.data()!);
      assertSubmissionState(ref, queue, currentJob.data()!, mapping);
      if (reviewRef) assertExpenseReview(ref, queue, currentJob.data()!, (await tx.get(reviewRef)).data());
      if (jobReference(currentJob.data()) !== jobReference(job) || stableJson(currentMapping.data()) !== stableJson(mapping)) throw new ConflictError("書込後の案件・設定が変更されています。");
      const editSource = await verifyEditSource(currentJob.data()!, tx);
      if (editSourceRef && (!editSource || editSource.companyId !== queue.companyId || editSource.jobId !== queue.jobId || editSource.identity !== editSourceIdentity(currentJob.data()!))) throw new ConflictError("原本確認値の保存先が変更されています。");
      tx.set(ref, { status: "completed", resolvedRow: row, beforeValues: before, afterValues, completedAt: now, updatedAt: now, retryAt: null }, { merge: true });
      if (queue.operation === "precontact.submit") tx.update(jobRef, { preContactSyncPending: false });
      if (["submission.report", "submission.sales_floor"].includes(queue.operation)) tx.update(jobRef, { ["submissionStatus." + (queue.operation === "submission.report" ? "report" : "salesFloor") + ".sheetWrite.pending"]: false });
      if (queue.operation === "netprint.update") tx.update(jobRef, { "netPrint.syncPending": false });
      if (editSourceRef && editSource) {
        tx.set(editSourceRef, { ...editSource, values: { ...editSource.values, ...Object.fromEntries(Object.entries(afterValues).map(([key,value]) => [key,String(value ?? "")])) }, observedAt: now });
        tx.update(jobRef, { adminEditSheetWrite: { ...currentJob.data()!.adminEditSheetWrite, pending: false, confirmedAtMs: now.toMillis() }, pendingSourceWrite: false, pendingSourceFields: [] });
      }
      tx.set(auditRef, { companyId: queue.companyId, jobId: queue.jobId, actorUid: queue.actorUid ?? null, actorStaffId: queue.actorStaffId ?? null, action: `sheet.${queue.operation}`, queueId: ref.id, before, after: queue.updates ?? {}, styles: queue.styles ?? {}, sheetName, row, createdAt: now });
      if (queue.idempotencyKey) tx.set(db.collection("sheetWriteIdempotency").doc(hashKey(queue.companyId, queue.idempotencyKey)), { companyId: queue.companyId, queueId: ref.id, status: "completed", completedAt: now }, { merge: true });
    });
  } catch (error) {
    if (mutationAttempted) throw new VerificationRequiredError("書込を開始した後の結果を確定できません。シフト表と依頼の照合が必要です。自動再書込は行いません。");
    throw error;
  }
}

async function locateAndVerify(sheets: ReturnType<typeof google.sheets>, mapping: Mapping, job: FirebaseFirestore.DocumentData, sheetName: string) {
  const firstRow = Number(job.sheetRef?.headerRow ?? 1) + 1;
  if (!Number.isInteger(firstRow) || firstRow < 2) throw new BlockedError("見出し行の設定が不正です。");
  if (mapping.idColumn && job.caseId) {
    if (!/^[A-Z]{1,3}$/i.test(mapping.idColumn)) throw new BlockedError("案件IDの列が不正です。");
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: mapping.spreadsheetId, range: `'${sheetName.replace(/'/g, "''")}'!${mapping.idColumn}:${mapping.idColumn}` });
    const matches = (response.data.values ?? []).flatMap((row, index) => String(row[0] ?? "") === String(job.caseId) ? [index + 1] : []);
    if (matches.length > 1 || (matches.length === 1 && matches[0]! < firstRow)) throw new ConflictError("案件IDが重複しているか、見出し行を参照しています。");
    if (matches.length === 1) return matches[0]!;
  }
  const row = Number(job.sheetRef?.currentRow ?? 0);
  if (!mapping.allowVerifiedFallbackRow || !Number.isInteger(row) || row < firstRow) throw new BlockedError("案件IDで行を特定できません。安全なフォールバックも無効です。");
  const identity = mapping.identityColumns;
  if (!identity) throw new BlockedError("行本人確認用の列設定がありません。");
  const fields: [string, string][] = [[identity.workDate, String(job.workDate ?? job.dateKey ?? "")], [identity.clientName, String(job.clientName ?? "")], [identity.storeName, String(job.storeName ?? "")], [identity.workTime, String(job.workTime ?? "")]];
  if (fields.some(([column, value]) => !/^[A-Z]{1,3}$/i.test(column) || !value.trim())) throw new BlockedError("行照合に必要な情報が不足しています。");
  if (parseDateKey(fields[0]![1], sheetName) === null) throw new BlockedError("行照合の勤務日が不正です。");
  const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId: mapping.spreadsheetId, ranges: fields.map(([column]) => `'${sheetName.replace(/'/g, "''")}'!${column}${row}`), valueRenderOption: "FORMATTED_VALUE" });
  if (fields.some(([, expected], index) => index === 0
    ? parseDateKey(String(response.data.valueRanges?.[index]?.values?.[0]?.[0] ?? ""), sheetName) !== parseDateKey(expected, sheetName)
    : !exactIdentity(response.data.valueRanges?.[index]?.values?.[0]?.[0], expected))) throw new ConflictError("行番号の内容が案件情報と一致しません。");
  return row;
}
function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(value));
}
function jobReference(job: FirebaseFirestore.DocumentData | undefined): string {
  return stableJson([job?.companyId, job?.caseId, job?.sheetRef, job?.dateKey, job?.workDate, job?.clientName,
    job?.storeName, job?.workTime, job?.assignedStaffId, job?.assignedStaffName, job?.status, job?.cancelled, job?.sourceMissing]);
}
async function verifyMailExpenseRow(sheets: ReturnType<typeof google.sheets>, mapping: Mapping, job: FirebaseFirestore.DocumentData, queue: Queue, sheetName: string, row: number): Promise<void> {
  if (queue.operation !== "expense.review" || !job.mailIntake) return;
  const columns = { transportation: "AK", purchase8: "AL", purchase10: "AM", netPrintCost: "AO", postageCost: "AP" };
  if ((mapping.valueInputOption ?? "RAW") !== "RAW" || !mapping.idColumn ||
      Object.entries(columns).some(([key, column]) => mapping.columns[key] !== column) ||
      queue.dateKey !== job.dateKey || typeof queue.dateKey !== "string" || queue.dateKey < "2026-10-01") {
    throw new BlockedError("受信案件の経費列・勤務日・固定IDの設定を確認してください。");
  }
  await verifyPreContactRow(sheets, mapping, job, queue, sheetName, row);
  const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId: mapping.spreadsheetId,
    ranges: Object.values(columns).map(column => "'" + sheetName.replace(/'/g, "''") + "'!" + column + row), valueRenderOption: "FORMULA" });
  const cells = response.data.valueRanges;
  if (!cells || cells.length !== 5 || cells.some(cell => typeof cell.values?.[0]?.[0] === "string" && cell.values[0][0].trim().startsWith("="))) {
    throw new ConflictError("経費の対象セルに数式があるか、確認結果が不足しています。数式は上書きせず、原本を確認してください。");
  }
}

async function verifyPreContactRow(sheets: ReturnType<typeof google.sheets>, mapping: Mapping, job: FirebaseFirestore.DocumentData, queue: Queue, sheetName: string, row: number, allowBlankStaff = false, skipStaff = false) {
  const dateColumn = mapping.columns.workDate || mapping.identityColumns?.workDate;
  const fields: [string, unknown, "name" | "date" | "id" | "value" | "menu"][] = [
    [mapping.columns.staffName!, job.assignedStaffName, "name"], [dateColumn!, queue.dateKey, "date"],
  ];
  if (queue.operation === "expense.review" && job.mailIntake) {
    if (typeof job.rawStaffName !== "string" || typeof job.rawClientName !== "string") throw new BlockedError("経費確認に必要な原本の担当・依頼元を確認できません。");
    fields[0] = [mapping.columns.staffName!, job.rawStaffName, "value"];
  }
  if (skipStaff) fields.shift();
  if (mapping.idColumn) fields.push([mapping.idColumn, job.caseId, "id"]);
  else {
    const identity = mapping.identityColumns;
    if (!identity) throw new BlockedError("行本人確認用の列設定がありません。");
    fields.push([identity.clientName, job.clientName, "name"], [identity.storeName, job.storeName, "name"], [identity.workTime, job.workTime, "name"]);
  }
  if (["job.assign", "precontact.submit", "submission.report", "submission.sales_floor", "netprint.printed", "netprint.update", "expense.review"].includes(queue.operation) && job.mailIntake) {
    const columns = { clientName: "J", storeName: "K", makerName: "L", menuName: "M", entryTime: "N", workTime: "O" };
    if (mapping.columns.staffName !== "B" || Object.entries(columns).some(([key, column]) => mapping.columns[key] !== column)) {
      throw new BlockedError("受信案件の原本照合列が一致しません。");
    }
    for (const [key, column] of Object.entries(columns)) fields.push([column, key === "clientName" && queue.operation === "expense.review" ? job.rawClientName : job[key] ?? "", key === "menuName" ? "menu" : "value"]);
  }
  if (fields.some(([column]) => !/^[A-Z]{1,3}$/i.test(column))) throw new BlockedError("行照合の列が不正です。");
  const response = await sheets.spreadsheets.values.batchGet({ spreadsheetId: mapping.spreadsheetId, ranges: fields.map(([column]) => `'${sheetName.replace(/'/g, "''")}'!${column}${row}`), valueRenderOption: "FORMATTED_VALUE" });
  if (fields.some(([, expected, kind], index) => {
    const actual = response.data.valueRanges?.[index]?.values?.[0]?.[0];
    if (kind === "value") return !adminEditValueMatches("source", actual ?? "", expected);
    if (kind === "menu") {
      const menu = splitMenuConditions(String(actual ?? "").normalize("NFKC").trim());
      return !adminEditValueMatches("menuName", menu.name, expected) || JSON.stringify(menu.conditions) !== JSON.stringify(job.menuConditions ?? []);
    }
    if (kind === "date") return parseDateKey(String(actual ?? ""), sheetName) !== expected;
    if (kind === "id") return !expected || String(actual ?? "") !== String(expected);
    if (allowBlankStaff && fields[index]?.[0] === mapping.columns.staffName && (job.mailIntake && queue.operation === "job.assign" ? actual === "" : String(actual ?? "").trim() === "")) return false;
    return !exactIdentity(actual, expected);
  })) throw new ConflictError("シフト表の案件・担当・勤務日を一致確認できません。");
}
async function fail(ref: FirebaseFirestore.DocumentReference, queue: Queue, error: unknown) {
  const attempts = Number(queue.attempts ?? 1);
  const verification = error instanceof VerificationRequiredError;
  const blocked = error instanceof BlockedError || error instanceof ConflictError;
  const retryable = !verification && !blocked && attempts < 5;
  await finishOwned(ref, queue, {
    status: verification || blocked ? "blocked" : retryable ? "retry_wait" : "dead_letter",
    writeVerificationRequired: verification,
    errorType: verification ? "verification_required" : error instanceof ConflictError ? "conflict" : blocked ? "blocked" : "system",
    errorMessage: error instanceof Error ? error.message : String(error),
    retryAt: retryable ? Timestamp.fromMillis(Date.now() + Math.min(30, 2 ** attempts) * 60_000) : null,
    failedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
}
function exactIdentity(a: unknown, b: unknown) {
  const normalize = (v: unknown) => String(v ?? "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
  const left = normalize(a), right = normalize(b);
  return left.length > 0 && left === right;
}
function hexToRgb(hex: string) { const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); return m ? { red: parseInt(m[1]!, 16) / 255, green: parseInt(m[2]!, 16) / 255, blue: parseInt(m[3]!, 16) / 255 } : { red: 1, green: 1, blue: 1 }; }
function hashKey(companyId: string, key: string) { return createHash("sha256").update(`${companyId}|${key}`, "utf8").digest("hex"); }
class BlockedError extends Error {}
class ConflictError extends Error {}
class VerificationRequiredError extends Error {}
