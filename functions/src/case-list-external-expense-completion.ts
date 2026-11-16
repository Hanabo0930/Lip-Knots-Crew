import { randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firebase";
import { hashCaseList } from "./case-list-source-core";
import { externalTransferMode } from "./case-list-external-mode";
import { sheetWriteExecutionPaused } from "./sheet-write-control";
import { assertProductionOperational } from "./system-safety";
import {
  assertExternalExpenseBinding,
  expectedExternalExpenseObservationHash,
  planExternalExpenseConfirmation,
  readExternalCaseListExpenses,
} from "./case-list-external-transfer";

type Data = FirebaseFirestore.DocumentData;
type Snapshot = FirebaseFirestore.DocumentSnapshot;
type Values = Record<string, number | null>;
type CellValue = Record<string, number>;
type Change = { column: string; index: number; expected: CellValue; value: CellValue };

export type ExternalExpenseIntent = Readonly<{
  id: string;
  companyId: string;
  jobId: string;
  staffId: string;
  staffName: string;
  dateKey: string;
  jobRevision: number;
  acceptanceHash: string;
  sheetRef: Data;
  beforeHash: string;
  afterHash: string;
  changes: Change[];
  createdAtMs: number;
  expiresAtMs: number;
}>;

export type ExternalExpenseWriteReceipt = Readonly<{
  intentId: string;
  intentHash: string;
  outcome: "applied" | "rejected";
  // For a batch receipt, this is the trusted adapter's submission timestamp.
  recordedAtMs: number;
  observedAtMs?: number;
}>;

/**
 * The writer must share its fence with every producer that can move or edit the
 * monthly row. Under that fence it checks the live assignment, unique fixed ID,
 * row, before hash and deadline, writes the exact changes once, and durably
 * binds the applied receipt to that write. Rejected is a durable no-write result.
 * A read followed by a Sheets range update is insufficient for this contract.
 */
export type ExternalExpenseDispatchCheck = () => Promise<() => void>;

export interface ExternalExpenseAtomicWriter {
  assertWriteAccess?(companyId: string): Promise<void | string>;
  readObservation?: typeof readExternalCaseListExpenses;
  stageReservation?(tx: FirebaseFirestore.Transaction, intent: ExternalExpenseIntent): Promise<void>;
  compareAndWrite(intent: ExternalExpenseIntent, beforeBatch?: ExternalExpenseDispatchCheck): Promise<void>;
  recordUnissuedExpiry?(intent: ExternalExpenseIntent): Promise<void>;
  readReceipt(intentId: string): Promise<ExternalExpenseWriteReceipt | null>;
  stageVerifiedReceipt?(tx: FirebaseFirestore.Transaction, intent: ExternalExpenseIntent, receipt: ExternalExpenseWriteReceipt): Promise<void>;
}
type ReceiptReader = Pick<ExternalExpenseAtomicWriter, "readReceipt">;

type Attempt = {
  intent: ExternalExpenseIntent;
  requestHash: string;
  requestVersion?: string;
  intentHash: string;
  pendingReviewHash: string;
  status: "pending" | "completed" | "rejected";
  receipt?: ExternalExpenseWriteReceipt;
  readbackHash?: string;
};

type Request = {
  companyId: string;
  jobId: string;
  job: Data;
  actorUid: string;
  operationId?: string;
  reconciliationOnly?: true;
  version: string;
  values: Values;
  note: string;
  assertReview: (job: Snapshot, review: Snapshot, observation: Data) => void;
};

type Result =
  | { status: "completed" }
  | { status: "held"; reason: "no_changes" | "readback_required" | "writer_rejected" };

const attempts = "externalExpenseCompletionAttempts";
const held = (reason: Extract<Result, { status: "held" }>["reason"]): Result => ({status:"held",reason});
export const canStartExternalExpenseWrite = () => externalTransferMode()==="enabled" && !sheetWriteExecutionPaused();

function matchesAttemptScope(item: Attempt, companyId: string, jobId: string): boolean {
  return item.intent?.companyId===companyId && item.intent.jobId===jobId &&
    hashCaseList(item.intent)===item.intentHash;
}

export function validExternalExpenseReceiptTime(receipt: ExternalExpenseWriteReceipt, createdAtMs: number): boolean {
  const now=Date.now();
  return Number.isSafeInteger(receipt.recordedAtMs) && receipt.recordedAtMs>=createdAtMs && receipt.recordedAtMs<=now &&
    (receipt.observedAtMs===undefined || (Number.isSafeInteger(receipt.observedAtMs) &&
      receipt.observedAtMs>=receipt.recordedAtMs && receipt.observedAtMs<=now));
}

function receiptMatches(attempt: Attempt, receipt: ExternalExpenseWriteReceipt | null | undefined): receipt is ExternalExpenseWriteReceipt {
  return Boolean(receipt && receipt.intentId===attempt.intent.id && receipt.intentHash===attempt.intentHash &&
    validExternalExpenseReceiptTime(receipt,attempt.intent.createdAtMs));
}

async function lookupReceipt(attempt: Attempt, reader: ReceiptReader): Promise<ExternalExpenseWriteReceipt | null> {
  try {
    const receipt=await reader.readReceipt(attempt.intent.id);
    return receiptMatches(attempt,receipt)?receipt:null;
  } catch {
    return null;
  }
}

async function matchingReadback(companyId: string, jobId: string, job: Data, attempt: Attempt, receipt: ExternalExpenseWriteReceipt,
  readObservation = readExternalCaseListExpenses): Promise<Data | null> {
  if (receipt.outcome!=="applied" || receipt.recordedAtMs>attempt.intent.expiresAtMs) return null;
  try {
    const readback=await readObservation(companyId,jobId,job);
    return readback.expenseReadStartedAt>=(receipt.observedAtMs??receipt.recordedAtMs) &&
      readback.caseListFinancialObservationHash===attempt.intent.afterHash ? readback : null;
  } catch {
    return null;
  }
}

/** Read the current operation, or look up a specific ID including retained rejections. */
export async function traceExternalExpense(companyId: string, jobId: string, job: Data, operationId?: string, reader?: ReceiptReader,
  matchesApprovedScope?: (intent: ExternalExpenseIntent) => boolean, readObservation = readExternalCaseListExpenses) {
  const ref=db.collection(attempts).doc(jobId);
  const current=await ref.get();
  if (operationId===undefined && !current.exists) return null;
  const latest=current.data() as Attempt | undefined;
  const attempt=operationId && latest?.intent?.id!==operationId
    ? (await ref.collection("history").doc(operationId).get()).data() as Attempt | undefined
    : latest;
  const id=attempt?.intent?.id;
  if (!attempt || typeof id!=="string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ||
      (operationId!==undefined && operationId!==id) || !matchesAttemptScope(attempt,companyId,jobId) ||
      (matchesApprovedScope && !matchesApprovedScope(attempt.intent))) {
    throw new HttpsError("not-found","対象の経費操作が見つかりません。");
  }
  if (receiptMatches(attempt,attempt.receipt)) {
    if (attempt.status==="completed" && attempt.receipt.outcome==="applied" &&
        attempt.receipt.recordedAtMs<=attempt.intent.expiresAtMs && attempt.readbackHash===attempt.intent.afterHash) {
      return {operationId:id,status:"completed" as const};
    }
    if (attempt.status==="rejected" && attempt.receipt.outcome==="rejected") return {operationId:id,status:"rejected" as const};
  }
  if (attempt.status==="pending" && reader && externalTransferMode()!=="read-only") {
    const receipt=await lookupReceipt(attempt,reader);
    if (receipt?.outcome==="rejected") return {operationId:id,status:"rejected" as const};
    if (receipt && await matchingReadback(companyId,jobId,job,attempt,receipt,readObservation)) {
      return {operationId:id,status:"verified_pending" as const};
    }
  }
  return {operationId:id,status:"readback_required" as const};
}

function pendingReviewHash(review: Data): string {
  return hashCaseList({
    companyId:review.companyId,jobId:review.jobId,staffId:review.staffId,status:review.status,
    externalCompletionId:review.externalCompletionId,values:review.values,note:review.note,
    confirmationRequestedBy:review.confirmationRequestedBy,
  });
}

export async function completeExternalExpense(request: Request, writer: ExternalExpenseAtomicWriter): Promise<Result> {
  const {companyId,jobId,job,actorUid,operationId,reconciliationOnly,version,values,note,assertReview}=request;
  if (operationId!==undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(operationId)) {
    throw new HttpsError("invalid-argument","経費の操作IDが不正です。");
  }
  if (externalTransferMode()==="read-only") return held("readback_required");
  const readObservation = writer.readObservation?.bind(writer) ?? readExternalCaseListExpenses;
  const attemptRef=db.collection(attempts).doc(jobId);
  const jobRef=db.collection("jobs").doc(jobId);
  const reviewRef=db.collection("expenseReviews").doc(jobId);
  const requestHash=hashCaseList({companyId,jobId,actorUid,version,values,note});
  const existing=(await attemptRef.get()).data() as Attempt | undefined;
  const matchesScope=(item: Attempt) => matchesAttemptScope(item,companyId,jobId);
  const canReplace=(item: Attempt) => item.status==="rejected" && item.requestHash!==requestHash &&
    (operationId===undefined || operationId!==item.intent.id) && matchesScope(item);
  let attempt=existing;
  let canDispatch=false;

  if (reconciliationOnly && (!attempt || attempt.intent?.id!==operationId)) return held("readback_required");
  if (!reconciliationOnly && (!attempt || canReplace(attempt))) {
    if (!canStartExternalExpenseWrite()) throw new HttpsError("failed-precondition","経費の書込みは停止中です。");
    await writer.assertWriteAccess?.(companyId);
    const observation=await readObservation(companyId,jobId,job);
    const changes=planExternalExpenseConfirmation(observation,values) as Change[];
    const reservation=await db.runTransaction(async tx=>{
      const [prior,currentJob,review]=await Promise.all([tx.get(attemptRef),tx.get(jobRef),tx.get(reviewRef)]);
      const previous=prior.data() as Attempt | undefined;
      if (previous && !canReplace(previous)) return {attempt:previous,canDispatch:false};
      await assertExternalExpenseBinding(companyId,jobId,job,observation,tx);
      assertReview(currentJob,review,observation);
      if (review.exists && review.data()?.status!=="draft") {
        throw new HttpsError("failed-precondition","確定済みまたは処理中の経費です。現在の状態を確認してください。");
      }
      if (changes.length===0) return null;

      const intent: ExternalExpenseIntent={
        id:operationId??randomUUID(),companyId,jobId,staffId:observation.assignedStaffId,staffName:observation.assignedStaffName,
        dateKey:observation.dateKey,jobRevision:observation.revision,acceptanceHash:observation.expenseAcceptanceHash,
        sheetRef:observation.sheetRef,beforeHash:observation.caseListFinancialObservationHash,
        afterHash:expectedExternalExpenseObservationHash(observation,values),changes,
        createdAtMs:Date.now(),expiresAtMs:observation.expenseReadStartedAt+60_000,
      };
      const now=Timestamp.now();
      const pending={
        companyId,jobId,staffId:intent.staffId,values,note,status:"confirmation_pending",
        externalCompletionId:intent.id,confirmationRequestedBy:actorUid,updatedAt:now,
        createdAt:review.data()?.createdAt??now,
      };
      const reserved: Attempt={
        intent,intentHash:hashCaseList(intent),requestHash,...(operationId?{requestVersion:version}:{}),
        pendingReviewHash:pendingReviewHash(pending),status:"pending",
      };
      await writer.stageReservation?.(tx,intent);
      if (previous) {
        tx.create(attemptRef.collection("history").doc(previous.intent.id),previous);
        tx.set(attemptRef,reserved);
      } else {
        tx.create(attemptRef,reserved);
      }
      tx.set(reviewRef,pending);
      return {attempt:reserved,canDispatch:true};
    });
    if (!reservation) return held("no_changes");
    ({attempt,canDispatch}=reservation);
  }

  if (!attempt || attempt.requestHash!==requestHash || !matchesScope(attempt) ||
      (operationId!==undefined && attempt.intent.id!==operationId)) {
    return held("readback_required");
  }
  if (attempt.status==="completed") return {status:"completed"};
  if (attempt.status==="rejected") return held("writer_rejected");
  if (attempt.status!=="pending") return held("readback_required");

  // Only the call that committed the reservation may issue the write. If the
  // call disappears after reserving, all later calls reconcile by reading.
  if (canDispatch && Date.now()<=attempt.intent.expiresAtMs) {
    try {
      await assertProductionOperational(companyId);
      if (canStartExternalExpenseWrite()) await writer.compareAndWrite(attempt.intent);
    }
    catch { /* The result of the write is unknown until receipt and readback agree. */ }
  }

  if (Date.now()>attempt.intent.expiresAtMs) {
    try { await writer.recordUnissuedExpiry?.(attempt.intent); }
    catch { /* The saved operation and the writer receipt remain authoritative. */ }
  }
  const receipt=await lookupReceipt(attempt,writer);
  if (!receipt) return held("readback_required");
  if (receipt.outcome==="rejected") {
    try {
      return await db.runTransaction(async tx=>{
        const [current,review,currentJob]=await Promise.all([tx.get(attemptRef),tx.get(reviewRef),tx.get(jobRef)]);
        const saved=current.data() as Attempt | undefined;
        if (!saved || saved.requestHash!==requestHash || saved.intentHash!==receipt.intentHash || !matchesScope(saved)) {
          return held("readback_required");
        }
        if (saved.status==="rejected") return held("writer_rejected");
        const jobData=currentJob.data();
        if (saved.status!=="pending" || !review.exists || pendingReviewHash(review.data()!)!==saved.pendingReviewHash ||
            jobData?.companyId!==companyId || jobData.assignedStaffId!==saved.intent.staffId ||
            jobData.dateKey!==saved.intent.dateKey || jobData.revision!==saved.intent.jobRevision ||
            jobData.assignmentSheetWrite?.externalAck?.acceptanceHash!==saved.intent.acceptanceHash) {
          return held("readback_required");
        }
        await writer.stageVerifiedReceipt?.(tx,saved.intent,receipt);
        const now=Timestamp.now();
        tx.update(reviewRef,{
          status:"draft",lastRejectedExternalCompletionId:saved.intent.id,
          externalCompletionId:FieldValue.delete(),confirmationRequestedBy:FieldValue.delete(),updatedAt:now,
        });
        tx.update(attemptRef,{status:"rejected",verifiedAt:now,receipt});
        return held("writer_rejected");
      });
    } catch {
      return held("readback_required");
    }
  }
  const readback=await matchingReadback(companyId,jobId,job,attempt,receipt,readObservation);
  if (!readback) return held("readback_required");

  try {
    return await db.runTransaction(async tx=>{
      const [current,review]=await Promise.all([tx.get(attemptRef),tx.get(reviewRef)]);
      const saved=current.data() as Attempt | undefined;
      if (!saved || saved.requestHash!==requestHash || saved.intentHash!==receipt.intentHash ||
          saved.intent.id!==receipt.intentId || !matchesScope(saved)) return held("readback_required");
      if (saved.status==="completed") return {status:"completed"};
      if (saved.status!=="pending" || !review.exists || pendingReviewHash(review.data()!)!==saved.pendingReviewHash) {
        return held("readback_required");
      }
      await assertExternalExpenseBinding(companyId,jobId,job,readback,tx);
      await writer.stageVerifiedReceipt?.(tx,saved.intent,receipt);
      const now=Timestamp.now();
      tx.update(reviewRef,{
        status:"completed",completedBy:review.data()!.confirmationRequestedBy,
        finalizedAt:now,updatedAt:now,
      });
      tx.update(attemptRef,{status:"completed",verifiedAt:now,receipt,readbackHash:readback.caseListFinancialObservationHash});
      return {status:"completed"};
    });
  } catch {
    return held("readback_required");
  }
}

/** Resume only the previously recorded operation. This path cannot reserve or dispatch. */
export async function reconcileAuthorizedExpense(
  companyId: string, jobId: string, job: Data, actorUid: string, operationId: string,
  matchesApprovedScope: (intent: ExternalExpenseIntent) => boolean, writer: ExternalExpenseAtomicWriter,
): Promise<Result> {
  const [operation, review] = await Promise.all([
    db.collection(attempts).doc(jobId).get(), db.collection("expenseReviews").doc(jobId).get(),
  ]);
  const saved = operation.data() as Attempt | undefined;
  if (!saved || saved.intent?.id !== operationId || !matchesAttemptScope(saved, companyId, jobId) ||
      !matchesApprovedScope(saved.intent)) throw new HttpsError("not-found", "対象の経費操作が見つかりません。");
  if (saved.status === "completed") return { status: "completed" };
  if (saved.status === "rejected") return held("writer_rejected");
  const pending = review.data();
  if (saved.status !== "pending" || !saved.requestVersion || !pending || pending.confirmationRequestedBy !== actorUid ||
      pendingReviewHash(pending) !== saved.pendingReviewHash) return held("readback_required");
  return completeExternalExpense({
    companyId, jobId, job, actorUid, operationId, reconciliationOnly: true,
    version: saved.requestVersion, values: pending.values, note: pending.note,
    assertReview() { throw new HttpsError("failed-precondition", "経費の再送は行えません。"); },
  }, writer);
}
