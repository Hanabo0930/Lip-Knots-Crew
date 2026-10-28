import { createJobIdFromPersistedCaseId } from "./case-id";
import { canonical, hashCaseList, publicCaseListSource, type CaseListJob, type Cell } from "./case-list-source-core";

type Data = Record<string, unknown>;
export type ManualStaffResolution = { staffId: string; identityVerified: true } | null;
export function sourceHasManualName(row: Cell[]): boolean {
  const cell = row[2];
  return [cell?.userEnteredValue, cell?.effectiveValue].some(value => value && Object.entries(value).some(([key, item]) => key === "formulaValue" || item !== ""));
}

/** Observation only. This is deliberately not SOURCE_PROJECTED, a selection,
 * an assignment, or a continuation token accepted by the monthly worker. */
export function observeCaseListManualOrigin(input: {
  companyId: string; jobId: string; entry: CaseListJob; row: Cell[];
  resolveStaff: (name: string) => ManualStaffResolution;
  staffProfiles: Map<string, Data>; existingJob?: Data;
}): Data | null {
  const { companyId, jobId, entry, row, existingJob } = input;
  if (!sourceHasManualName(row)) return null;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(companyId) || jobId !== createJobIdFromPersistedCaseId(companyId, entry.caseId) || row.length !== 65 || row[60]?.userEnteredValue?.stringValue !== entry.caseId) throw Error("MANUAL_SOURCE_IDENTITY_INVALID");
  const cell = row[2], entered = cell?.userEnteredValue ?? {}, effective = cell?.effectiveValue ?? {};
  const literal = typeof entered.stringValue === "string" && entered.stringValue.trim() && Object.keys(entered).length === 1;
  const staffName = literal ? (entered.stringValue as string) : "";
  const reasons = new Set<string>(["MANUAL_TRANSFER_ADAPTER_NOT_ACTIVATED"]);
  if (!literal || effective.stringValue !== entered.stringValue || Object.keys(effective).length !== 1) reasons.add("MANUAL_SOURCE_NAME_NOT_LITERAL_OR_UNVERIFIED");
  const resolved = staffName ? input.resolveStaff(staffName) : null, profile = resolved ? input.staffProfiles.get(resolved.staffId) : undefined;
  if (!resolved || resolved.identityVerified !== true || !profile || profile.companyId !== companyId || profile.active !== true) reasons.add("MANUAL_SOURCE_STAFF_UNRESOLVED_OR_INACTIVE");
  if (typeof row[0]?.userEnteredValue?.boolValue !== "boolean" || row[0].userEnteredValue.boolValue !== false || row[63]?.userEnteredValue?.boolValue !== false) reasons.add("MANUAL_SOURCE_CANCELLED_OR_UNVERIFIED");
  if (entry.ledgerLinked) reasons.add("EXISTING_MONTHLY_LINK");
  const ownPending = existingJob?.status === "assigned" && existingJob.applicationUnconfirmed === true && existingJob.cancelled !== true && existingJob.assignmentUnresolved !== true && existingJob.sourceMissing !== true && existingJob.caseListManualPending && (existingJob.caseListManualPending as Data).sourceRevision === entry.source.sourceRevision &&
    (existingJob.caseListManualPending as Data).staffId === resolved?.staffId && existingJob.assignedStaffId === resolved?.staffId && existingJob.assignedStaffName === staffName && existingJob.dateKey === entry.fields.dateKey && !existingJob.assignmentSheetWrite;
  if (existingJob && !ownPending && (existingJob.assignedStaffId || existingJob.assignedStaffName || existingJob.applicationUnconfirmed === true || existingJob.assignmentUnresolved === true || existingJob.status === "assigned" || existingJob.status === "cancelled" || existingJob.cancelled === true)) reasons.add("EXISTING_ASSIGNMENT_REQUIRES_RECONCILIATION");
  for (const reason of entry.holdReasons) if (reason !== "ALREADY_ASSIGNED") reasons.add(reason);
  const observation = {
    schema: "LK_CASE_LIST_MANUAL_OBSERVATION_V1", origin: "SOURCE_MANUAL", state: "blocked_requires_owner_review",
    companyId, jobId, caseId: entry.caseId, source: publicCaseListSource(entry.source),
    dateKey: typeof entry.fields.dateKey === "string" ? entry.fields.dateKey : "",
    sourceStaffName: staffName, staffId: resolved?.staffId ?? null,
    canonicalStaffName: profile && typeof profile.displayName === "string" ? profile.displayName : null,
    // This import reads user/effective values, not full writable CellData. The
    // selection adapter must obtain a fresh bounded full-writable snapshot.
    observedValuesHash: hashCaseList(row.map(cell => ({ userEnteredValue: cell.userEnteredValue ?? {}, effectiveValue: cell.effectiveValue ?? {} }))),
    holdReasons: [...reasons].sort(), selected: false, clientNameUpConfirmed: false,
    sourceWritesPlanned: 0, monthlyWritesPlanned: 0,
  };
  return { ...observation, observationHash: hashCaseList(observation) };
}

export function sameManualObservation(previous: Data | undefined, next: Data): boolean {
  return previous?.observationHash === next.observationHash && Object.entries(next).every(([key, value]) => Object.hasOwn(previous ?? {}, key) && canonical(previous?.[key]) === canonical(value));
}

// These holds are exactly the owner confirmations collected by the manual
// selection form. They do not become vacancy approval or monthly authority.
export function manualOwnerReviewCanProceed(reasons: unknown): boolean {
  return Array.isArray(reasons) && reasons.every(reason => ["MANUAL_TRANSFER_ADAPTER_NOT_ACTIVATED", "OWNER_APPROVAL_REQUIRED", "OWNER_FIELD_CONFIRMATIONS_REQUIRED", "PUBLIC_PAY_OFFER_REQUIRED"].includes(reason));
}
export function manualObservationCanBePending(observation: Data, row: Cell[]): boolean {
  const val=(cell?:Cell)=>cell?.effectiveValue?.stringValue ?? cell?.userEnteredValue?.stringValue ?? "";
  return manualOwnerReviewCanProceed(observation.holdReasons) && typeof observation.staffId === "string" &&
    typeof observation.dateKey === "string" && /^2026-(?:11|12)-\d{2}$/.test(observation.dateKey) &&
    ["単日","SINGLE"].includes(String(val(row[58]))) && !val(row[59]) &&
    !/研修|OJT|ラウンダー|出口調査|グレイス|グレース/i.test([val(row[10]),val(row[13]),val(row[16])].join(" "));
}

export function manualPendingAssignmentFields(observation: Data): Data {
  if (!manualOwnerReviewCanProceed(observation.holdReasons) || typeof observation.staffId !== "string" || typeof observation.canonicalStaffName !== "string") throw Error("MANUAL_PENDING_NOT_RESOLVED");
  const source=observation.source as Data;
  return { status: "assigned", assignedStaffId: observation.staffId, assignedStaffName: observation.sourceStaffName, assignedUid: null,
    applicationUnconfirmed: true, assignmentUnresolved: false, sourceReady: false,
    caseListManualPending: { observationHash: observation.observationHash, sourceRevision: source.sourceRevision, staffId: observation.staffId, dateKey: observation.dateKey, canonicalStaffName: observation.canonicalStaffName } };
}
