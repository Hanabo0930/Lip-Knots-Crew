import { createHash } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firebase";
import { createJobIdFromPersistedCaseId } from "./case-id";
import { configuredCaseListSource, caseListBindingHash, canonical, hashCaseList } from "./case-list-source-core";
import { assertCaseListMonthlyAck, publicCaseListMonthlyAck } from "./case-list-monthly-worker";
import { createReadOnlySheetsClient } from "./sheet-reader";

type Data = FirebaseFirestore.DocumentData;
export type CaseListPrivateSheetRef = {
  spreadsheetId: string; sheetId: number; sheetName: string; headerRow: 1;
  currentRow: number; caseId: string; caseIdColumn: "BC" | "BD"; bindingHash: string;
};
type PrivateRecords = { config: Data; privateRef: Data; operation: Data; queue: Data; accepted: Data; intent: Data; sourceIntent: Data };
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const HASH = /^[a-f0-9]{64}$/;
function unavailable(reason: string): never {
  throw new HttpsError("failed-precondition", "原本との対応を確認できません。案件を再読込して確認してください。", { reason });
}
function need(value: unknown, reason: string): asserts value { if (!value) unavailable(reason); }
const object = (value: unknown): Data => value && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const operationId = (companyId: string, queueId: string): string => createHash("sha256").update(companyId + "|" + queueId, "utf8").digest("hex");

/** Server-only hydration. Do not return this private reference in a staff DTO. */
export function assertCaseListPrivateSheetRef(companyId: string, jobId: string, job: Data, records: PrivateRecords): CaseListPrivateSheetRef {
  need(ID.test(companyId) && ID.test(jobId) && job.companyId === companyId && typeof job.caseId === "string" &&
    createJobIdFromPersistedCaseId(companyId, job.caseId) === jobId, "case_list_private_job_mismatch");
  const source = object(job.caseListSource), publicRef = object(job.sheetRef), write = object(job.assignmentSheetWrite), publicAck = object(write.nativeAck);
  const { config, privateRef, operation, queue, accepted, intent, sourceIntent } = records;
  need(config.companyId === companyId, "case_list_private_config_mismatch");
  let bookId: string;
  try { bookId = configuredCaseListSource(config.spreadsheetId).spreadsheetId; } catch { unavailable("case_list_private_book_unavailable"); }
  const sourceBinding = caseListBindingHash(bookId, 2026101601), queueId = write.queueId;
  need(source.version === 1 && source.sheetId === 2026101601 && source.caseId === job.caseId && source.bindingHash === sourceBinding &&
    !Object.hasOwn(source, "spreadsheetId") && !Object.hasOwn(publicRef, "spreadsheetId") && ID.test(queueId ?? ""), "case_list_private_public_binding_mismatch");
  need(queue.companyId === companyId && queue.jobId === jobId && queue.operation === "case_list.assign" && queue.status === "completed" &&
    queue.caseListAssignment?.queueId === queueId && queue.caseListAssignment?.sourceCaseId === job.caseId &&
    operation.schema === "LK_CASE_LIST_MONTHLY_OPERATION_V1" && operation.companyId === companyId && operation.jobId === jobId &&
    operation.queueId === queueId && operation.caseId === job.caseId && operation.status === "completed", "case_list_private_operation_unconfirmed");
  const fullAck = object(accepted.payload?.ack), ackHash = hashCaseList(fullAck), sourceIntentPayload = object(sourceIntent.payload);
  const nativeAssignment = object(sourceIntentPayload.assignment);
  const unhashedSourceIntent: Data = { ...sourceIntentPayload, createdAt: 0 }; delete unhashedSourceIntent.intentHash;
  const before = sourceIntentPayload.sourceBefore, after = sourceIntentPayload.expectedSourceAfter;
  need(sourceIntent.companyId === companyId && sourceIntent.queueId === queueId && sourceIntent.payloadHash === hashCaseList(sourceIntentPayload) &&
    sourceIntentPayload.schema === "LK_SOURCE_ASSIGNMENT_INTENT_V1" && sourceIntentPayload.stage === "SOURCE_INTENT" &&
    sourceIntentPayload.spreadsheetId === bookId && sourceIntentPayload.operationId === queueId && sourceIntentPayload.caseId === job.caseId &&
    HASH.test(sourceIntentPayload.intentHash ?? "") && sourceIntentPayload.intentHash === hashCaseList(unhashedSourceIntent) &&
    Array.isArray(before) && before.length === 65 && Array.isArray(after) && after.length === 65 &&
    before.every(cell => cell && typeof cell === "object" && !Array.isArray(cell) && !Object.hasOwn(cell, "effectiveValue") && cell.$unknown !== true) &&
    after.every(cell => cell && typeof cell === "object" && !Array.isArray(cell) && !Object.hasOwn(cell, "effectiveValue") && cell.$unknown !== true) &&
    sourceIntentPayload.preMonthlyContentHash === queue.caseListAssignment?.preMonthlyContentHash && hashCaseList(before) === sourceIntentPayload.preMonthlyContentHash &&
    canonical(after) === canonical(before.map((cell, index) => index === 2 ? { ...cell, userEnteredValue: { stringValue: nativeAssignment.staffName } } : cell)) &&
    hashCaseList(after) === sourceIntentPayload.expectedPostMonthlyContentHash && sourceIntentPayload.expectedPostMonthlyContentHash === fullAck.postMonthlyContentHash &&
    sourceIntentPayload.expectedPostMonthlyContentHash === intent.payload?.sourceContentHash && canonical(sourceIntentPayload.preCatalog) === canonical(fullAck.preCatalog) &&
    sourceIntentPayload.assignmentHash === hashCaseList(nativeAssignment) && intent.payload?.assignmentHash === sourceIntentPayload.assignmentHash &&
    nativeAssignment.publicPayOffer && typeof nativeAssignment.publicPayOffer === "object" &&
    operation.publicPayOfferHash === hashCaseList(nativeAssignment.publicPayOffer), "case_list_private_source_intent_mismatch");
  need(HASH.test(privateRef.acceptedAckHash ?? "") && privateRef.companyId === companyId && privateRef.jobId === jobId &&
    privateRef.sourceBindingHash === sourceBinding && privateRef.acceptedAckHash === ackHash && operation.acceptedAckHash === ackHash &&
    queue.caseListMonthlyAckHash === ackHash, "case_list_private_ack_hash_mismatch");
  let checked: ReturnType<typeof assertCaseListMonthlyAck>;
  try {
    checked = assertCaseListMonthlyAck(queueId, queue.caseListAssignment, nativeAssignment.publicPayOffer, fullAck, accepted, intent, bookId);
  } catch { unavailable("case_list_private_native_ack_mismatch"); }
  need(canonical(publicAck) === canonical(publicCaseListMonthlyAck(fullAck, bookId)), "case_list_private_public_ack_mismatch");
  const target = checked.target, ref = object(privateRef.sheetRef), monthBinding = caseListBindingHash(bookId, target.sheetId);
  need(ref.spreadsheetId === bookId && ref.sheetId === target.sheetId && ref.sheetName === target.title && ref.caseId === job.caseId &&
    ref.caseIdColumn === checked.caseIdColumn && ref.headerRow === 1 && ref.bindingHash === monthBinding &&
    Number.isSafeInteger(ref.currentRow) && ref.currentRow >= 2 &&
    publicRef.sheetId === ref.sheetId && publicRef.sheetName === ref.sheetName && publicRef.caseId === ref.caseId &&
    publicRef.caseIdColumn === ref.caseIdColumn && publicRef.headerRow === 1 && publicRef.bindingHash === monthBinding &&
    Number.isSafeInteger(publicRef.currentRow) && publicRef.currentRow >= 2, "case_list_private_month_ref_mismatch");
  // currentRow is a hint. It may differ after a verified import or row move;
  // locateCaseListPrivateSheetRow resolves the exact fixed ID before linking.
  return { spreadsheetId: bookId, sheetId: ref.sheetId, sheetName: ref.sheetName, headerRow: 1,
    currentRow: publicRef.currentRow, caseId: job.caseId, caseIdColumn: checked.caseIdColumn, bindingHash: monthBinding };
}

async function readPrivateRecords(companyId: string, jobId: string, job: Data, tx?: FirebaseFirestore.Transaction): Promise<PrivateRecords> {
  need(ID.test(companyId) && ID.test(jobId) && job.companyId === companyId && job.caseListSource, "case_list_private_job_mismatch");
  const queueId = job.assignmentSheetWrite?.queueId;
  need(typeof queueId === "string" && ID.test(queueId), "case_list_private_queue_unavailable");
  const ref = db.collection("caseListMonthlyOperations").doc(operationId(companyId, queueId));
  const get = (document: FirebaseFirestore.DocumentReference) => tx ? tx.get(document) : document.get();
  const [config, privateRef, operation, queue, accepted, intent, sourceIntent] = await Promise.all([
    get(db.collection("sheetImportConfigs").doc(companyId)), get(db.collection("caseListSheetRefs").doc(jobId)),
    get(ref), get(db.collection("sheetSyncQueue").doc(queueId)), get(ref.collection("events").doc("ACCEPTED")), get(ref.collection("events").doc("INTENT")),
    get(ref.collection("events").doc("SOURCE_INTENT")),
  ]);
  need([config, privateRef, operation, queue, accepted, intent, sourceIntent].every(snapshot => snapshot.exists), "case_list_private_ref_unavailable");
  return { config: config.data()!, privateRef: privateRef.data()!, operation: operation.data()!, queue: queue.data()!, accepted: accepted.data()!, intent: intent.data()!, sourceIntent: sourceIntent.data()! };
}

export async function resolveCaseListPrivateSheetRef(companyId: string, jobId: string, job: Data): Promise<CaseListPrivateSheetRef> {
  return assertCaseListPrivateSheetRef(companyId, jobId, job, await readPrivateRecords(companyId, jobId, job));
}

/** Finance stays server-private. Missing or stale observations are a hold;
 * neither a missing amount nor an unobserved cell becomes zero. */
export async function resolveCaseListPrivateFinancialJob(companyId: string, jobId: string, job: Data, tx?: FirebaseFirestore.Transaction): Promise<Data> {
  const observationRef = db.collection("caseListMonthlyObservations").doc(jobId);
  const [records, observationDocument] = await Promise.all([
    readPrivateRecords(companyId, jobId, job, tx), tx ? tx.get(observationRef) : observationRef.get(),
  ]);
  need(observationDocument.exists, "case_list_private_finance_observation_required");
  const ref = assertCaseListPrivateSheetRef(companyId, jobId, job, records), observation = observationDocument.data()!, source = object(job.caseListSource);
  need(job.status === "assigned" && job.cancelled !== true && job.applicationUnconfirmed === false && job.assignmentUnresolved !== true && job.sourceMissing !== true &&
    Number.isSafeInteger(job.revision) && job.revision >= 1 && ID.test(job.assignedStaffId ?? "") && typeof job.assignedStaffName === "string" && job.assignedStaffName.trim() &&
    typeof job.dateKey === "string" && /^20\d\d-\d\d-\d\d$/.test(job.dateKey) && [source.sourceRevision, source.rowRevision, source.ledgerRevision].every(value => typeof value === "string" && HASH.test(value)),
  "case_list_private_finance_assignment_unconfirmed");
  const identity = { schema: "LK_CASE_LIST_MONTHLY_OBSERVATION_ID_V1", companyId, jobId, caseId: job.caseId,
    observedJobRevision: job.revision, sourceRevision: source.sourceRevision, rowRevision: source.rowRevision, ledgerRevision: source.ledgerRevision,
    acceptedAckHash: records.privateRef.acceptedAckHash, assignedStaffId: job.assignedStaffId, assignedStaffName: job.assignedStaffName, dateKey: job.dateKey,
    sourceBindingHash: source.bindingHash, monthBindingHash: ref.bindingHash, publicPayOfferHash: hashCaseList(job.publicPayOffer ?? null) };
  const observedIdentity = Object.fromEntries(Object.keys(identity).map(key => [key, observation[key]]));
  need(observation.matches === true && Object.keys(identity).every(key => Object.hasOwn(observation, key)) && canonical(observedIdentity) === canonical(identity) && observation.observationIdentityHash === hashCaseList(identity) &&
    observation.publicPayOfferHash === records.operation.publicPayOfferHash && Number.isFinite(observation.sourceReadStartedAtMs) && observation.sourceReadStartedAtMs > 0,
  "case_list_private_finance_identity_changed");
  const observedRef = object(observation.sheetRef);
  need(observedRef.spreadsheetId === ref.spreadsheetId && observedRef.sheetId === ref.sheetId && observedRef.sheetName === ref.sheetName &&
    observedRef.caseId === ref.caseId && observedRef.caseIdColumn === ref.caseIdColumn && observedRef.headerRow === 1 && observedRef.currentRow === ref.currentRow,
  "case_list_private_finance_target_changed");
  need(Number.isSafeInteger(observation.basePay) && observation.basePay === job.publicPayOffer?.dailyWageJPY && observation.basePay > 0,
    "case_list_private_finance_pay_unconfirmed");
  const expenses: Data = {}, financials: Data = {};
  for (const key of ["transportation", "purchase8", "purchase10", "netPrintCost", "postageCost"]) {
    const value = observation.expenses?.[key];
    need(Object.hasOwn(object(observation.expenses), key) && (value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000_000), "case_list_private_expense_unobserved");
    expenses[key] = value;
  }
  for (const key of ["clientChargeTotal", "clientChargeAdditionsTotal", "staffPaymentTotal", "subcontractorTotal"]) {
    const value = observation.financials?.[key];
    need(Object.hasOwn(object(observation.financials), key) && (value === null || typeof value === "number" && Number.isFinite(value)), "case_list_private_financial_unobserved");
    financials[key] = value;
  }
  return { ...job, sheetRef: ref, expenses, financials, basePay: observation.basePay,
    caseListFinancialObservationHash: hashCaseList(observation) };
}

/** A native link is for the current fixed-ID row, never the saved row hint. */
export async function locateCaseListPrivateSheetRow(ref: CaseListPrivateSheetRef): Promise<CaseListPrivateSheetRef> {
  const sheets = await createReadOnlySheetsClient();
  try {
    const metadata = await sheets.spreadsheets.get({ spreadsheetId: ref.spreadsheetId,
      fields: "spreadsheetId,properties.timeZone,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))" });
    const matches = metadata.data.sheets?.filter(sheet => sheet.properties?.sheetId === ref.sheetId && sheet.properties.title === ref.sheetName) ?? [];
    const properties = matches.length === 1 ? matches[0]?.properties : undefined, rows = properties?.gridProperties?.rowCount;
    const expectedWidth = ref.caseIdColumn === "BD" ? 56 : 55;
    need(metadata.data.spreadsheetId === ref.spreadsheetId && metadata.data.properties?.timeZone === "Asia/Tokyo" &&
      properties?.gridProperties?.columnCount === expectedWidth && typeof rows === "number" && Number.isInteger(rows) && rows >= 2 && rows <= 10000,
    "case_list_private_native_structure_changed");
    const sheetName = "'" + ref.sheetName.replace(/'/g, "''") + "'";
    const result = await sheets.spreadsheets.values.get({ spreadsheetId: ref.spreadsheetId, range: `${sheetName}!${ref.caseIdColumn}1:${ref.caseIdColumn}${rows}`, valueRenderOption: "UNFORMATTED_VALUE" });
    const values = result.data.values ?? [];
    need(values[0]?.[0] === "連絡_固定案件ID", "case_list_private_native_id_header_changed");
    const found = values.flatMap((row, index) => typeof row[0] === "string" && row[0].toLowerCase() === ref.caseId.toLowerCase() ? [{ row: index + 1, value: row[0] }] : []);
    need(found.length === 1 && found[0]!.row >= 2 && found[0]!.value === ref.caseId, "case_list_private_native_id_unconfirmed");
    return { ...ref, currentRow: found[0]!.row };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    unavailable("case_list_private_native_read_failed");
  }
}
