import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firebase";
import { hashCaseList } from "./case-list-source-core";
import { validExternalExpenseReceiptTime } from "./case-list-external-expense-completion";
import type {
  ExternalExpenseAtomicWriter, ExternalExpenseDispatchCheck,
  ExternalExpenseIntent,
  ExternalExpenseWriteReceipt,
} from "./case-list-external-expense-completion";

type NativeReceiptReader = Pick<ExternalExpenseAtomicWriter, "readReceipt">;
type NativeWriter = NativeReceiptReader & {
  compareAndWrite(intent: ExternalExpenseIntent, beforeBatch?: ExternalExpenseDispatchCheck): Promise<void | "not_issued">;
};
type Scope = { companyId: string; spreadsheetId: string };
type Phase = "reserved" | "dispatched" | "unissued_rejected" | "verified";
type BookOperation = {
  companyId: string;
  bookKey: string;
  intentHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  phase: Phase;
  receipt?: ExternalExpenseWriteReceipt;
};
type Tx = FirebaseFirestore.Transaction;

const operationIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const bookPattern = /^[A-Za-z0-9_-]{1,256}$/;
const scopeFailure = () => new HttpsError("failed-precondition", "月別表の処理記録を確認できません。操作IDで照会してください。");
const conflictFailure = () => new HttpsError("aborted", "この月別表では結果確認中の操作があります。先にその操作IDを照会してください。");

function validReceipt(op: BookOperation, id: string, receipt: ExternalExpenseWriteReceipt | null | undefined): receipt is ExternalExpenseWriteReceipt {
  return Boolean(receipt && receipt.intentId === id && receipt.intentHash === op.intentHash &&
    validExternalExpenseReceiptTime(receipt, op.createdAtMs) && (receipt.outcome === "rejected" ||
      (receipt.outcome === "applied" && receipt.recordedAtMs <= op.expiresAtMs)));
}

function bookRecords({ companyId, spreadsheetId }: Scope) {
  if (!companyId || !bookPattern.test(spreadsheetId)) throw scopeFailure();
  // Movement/sort affects the whole spreadsheet, even across tenants or tabs.
  const bookKey = hashCaseList({ scope: "external_monthly_book", spreadsheetId });
  return { bookKey, opRef: (id: string) => db.collection("externalExpenseBookOperations").doc(id) };
}

function bindReceiptReader(companyId: string, { bookKey, opRef }: ReturnType<typeof bookRecords>, native: NativeReceiptReader) {
  return async (id: string): Promise<ExternalExpenseWriteReceipt | null> => {
    if (!operationIdPattern.test(id)) return null;
    const op = (await opRef(id).get()).data() as BookOperation | undefined;
    if (op?.bookKey !== bookKey || op.companyId !== companyId) return null;
    if (op.phase !== "dispatched" && op.phase !== "verified" &&
        (op.phase !== "unissued_rejected" || op.receipt?.outcome !== "rejected")) return null;
    const receipt = op.phase === "dispatched" ? await native.readReceipt(id) : op.receipt;
    return validReceipt(op, id, receipt) ? receipt : null;
  };
}

export function createExternalExpenseBookReceiptReader(scope: Scope, native: NativeReceiptReader): NativeReceiptReader {
  return { readReceipt: bindReceiptReader(scope.companyId, bookRecords(scope), native) };
}

/**
 * Server-only adapter for a transport that persists each receipt atomically
 * with its write. Every editor of the book must use the same fence. A dispatched
 * operation keeps the fence through crashes/timeouts, without a lease or TTL.
 */
export function createExternalExpenseBookWriter(scope: Scope, native: NativeWriter): ExternalExpenseAtomicWriter {
  const { companyId, spreadsheetId } = scope;
  const records = bookRecords(scope);
  const { bookKey, opRef } = records;
  const bookRef = db.collection("externalExpenseBookFences").doc(bookKey);

  function assertIntent(intent: ExternalExpenseIntent) {
    if (!operationIdPattern.test(intent.id) || intent.companyId !== companyId ||
        intent.sheetRef?.spreadsheetId !== spreadsheetId ||
        !Number.isSafeInteger(intent.createdAtMs) || !Number.isSafeInteger(intent.expiresAtMs) ||
        intent.expiresAtMs < intent.createdAtMs) throw scopeFailure();
  }

  async function readHeld(tx: Tx, intent: ExternalExpenseIntent): Promise<BookOperation> {
    assertIntent(intent);
    const [book, operation] = await Promise.all([tx.get(bookRef), tx.get(opRef(intent.id))]);
    const held = book.data(), op = operation.data() as BookOperation | undefined;
    const intentHash = hashCaseList(intent);
    if (held?.state !== "held" || held.operationId !== intent.id || held.intentHash !== intentHash ||
        op?.bookKey !== bookKey || op.companyId !== companyId || op.intentHash !== intentHash ||
        op.createdAtMs !== intent.createdAtMs || op.expiresAtMs !== intent.expiresAtMs) throw scopeFailure();
    return op;
  }

  function recordUnissuedRejection(tx: Tx, intent: ExternalExpenseIntent, op: BookOperation, now: number) {
    const receipt: ExternalExpenseWriteReceipt = {
      intentId: intent.id, intentHash: op.intentHash, outcome: "rejected", recordedAtMs: now,
    };
    tx.update(opRef(intent.id), { phase: "unissued_rejected", receipt });
  }

  return {
    async stageReservation(tx, intent) {
      assertIntent(intent);
      const [book, operation] = await Promise.all([tx.get(bookRef), tx.get(opRef(intent.id))]);
      if (operation.exists || (book.exists && book.data()?.state !== "idle")) throw conflictFailure();
      const intentHash = hashCaseList(intent);
      tx.set(bookRef, { state: "held", operationId: intent.id, intentHash });
      tx.create(opRef(intent.id), {
        companyId, bookKey, intentHash, createdAtMs: intent.createdAtMs, expiresAtMs: intent.expiresAtMs, phase: "reserved",
      } satisfies BookOperation);
    },

    async compareAndWrite(intent, beforeBatch) {
      await db.runTransaction(async tx => {
        const op = await readHeld(tx, intent);
        if (op.phase !== "reserved" || Date.now() > op.expiresAtMs) throw conflictFailure();
        tx.update(opRef(intent.id), { phase: "dispatched" });
      });
      if (await native.compareAndWrite(intent, beforeBatch) !== "not_issued") return;
      await db.runTransaction(async tx => {
        const op = await readHeld(tx, intent);
        if (op.phase !== "dispatched") throw scopeFailure();
        recordUnissuedRejection(tx, intent, op, Date.now());
      });
    },

    async recordUnissuedExpiry(intent) {
      await db.runTransaction(async tx => {
        const op = await readHeld(tx, intent);
        const now = Date.now();
        // A late dispatcher first needs this same still-reserved operation.
        if (op.phase !== "reserved" || now <= op.expiresAtMs) return;
        recordUnissuedRejection(tx, intent, op, now);
      });
    },

    readReceipt: bindReceiptReader(companyId, records, native),

    async stageVerifiedReceipt(tx, intent, receipt) {
      const op = await readHeld(tx, intent);
      if (!validReceipt(op, intent.id, receipt) ||
          (op.phase !== "dispatched" && (op.phase !== "unissued_rejected" ||
            !op.receipt || hashCaseList(op.receipt) !== hashCaseList(receipt)))) throw scopeFailure();
      tx.update(opRef(intent.id), { phase: "verified", receipt });
      tx.set(bookRef, { state: "idle" });
    },
  };
}
