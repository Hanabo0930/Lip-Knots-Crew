import { submittedDrafts, receiptKey, isSubmittedDraft } from "./submitted-marker-store";
export { getSubmittedDraftReceipt, markDraftSubmitted } from "./submitted-marker-store";
import type { SubmissionAttempt } from "./submission-attempt-store";

const loadSubmittedBindings = () => import("./submitted-binding-store");
const hasSubmittedBindings = async (key: string) => (await loadSubmittedBindings()).hasSubmittedBindings(key);
const canClearBoundDraft = async (key: string, attempt?: Pick<SubmissionAttempt, "clientRequestId" | "storageKey">) =>
  (await loadSubmittedBindings()).canClearBoundDraft(key, attempt);

export type DraftFile = {
  id: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  blob: Blob;
};

const DB_NAME = "lkc-submission-drafts";
const STORE = "drafts";
const draftMutations = new Map<string, Promise<void>>();
function enqueueDraftMutation(key: string, mutation: () => Promise<void>): Promise<void> {
  const previous = draftMutations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(mutation);
  draftMutations.set(key, current);
  return current.finally(() => {
    if (draftMutations.get(key) === current) draftMutations.delete(key);
  });
}

async function waitForDraftMutation(key: string): Promise<void> {
  await draftMutations.get(key);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function saveDraft(key: string, files: File[]): Promise<void> {
  if (isSubmittedDraft(key)) return Promise.reject(new Error("送信済み下書きの後片付けを先に再試行してください。"));
  const records: DraftFile[] = files.map((file) => ({
    id: crypto.randomUUID(), name: file.name, type: file.type,
    size: file.size, lastModified: file.lastModified, blob: file,
  }));
  return enqueueDraftMutation(key, async () => {
    if (isSubmittedDraft(key) || await hasSubmittedBindings(key)) throw new Error("送信済み下書きは保存し直しません。" );
    const db = await openDb();
    try {
      if (isSubmittedDraft(key) || await hasSubmittedBindings(key)) throw new Error("送信済み下書きは保存し直しません。");
      await tx(db, "readwrite", (store) => store.put(records, key));
    } finally {
      db.close();
    }
  });
}

export async function loadDraft(key: string): Promise<File[]> {
  if (isSubmittedDraft(key)) return [];
  await waitForDraftMutation(key);
  if (isSubmittedDraft(key) || await hasSubmittedBindings(key)) return [];
  const records = await readDraftRecords(key);
  if (isSubmittedDraft(key) || await hasSubmittedBindings(key)) return [];
  return draftFiles(records);
}

// Read the actual IndexedDB records; loadDraft deliberately hides submitted drafts.
export async function hasStoredDraft(key: string): Promise<boolean> {
  await waitForDraftMutation(key);
  const records = await readDraftRecords(key);
  if (!Array.isArray(records)) throw new Error("下書きの保存状態を確認できません。");
  return records.length > 0;
}

export async function confirmDraftCleanupComplete(key: string, isCurrent: () => boolean): Promise<boolean> {
  const version = submittedDrafts.get(key);
  if (!isCurrent() || localStorage.getItem(receiptKey(key)) !== null || await hasStoredDraft(key) || await hasSubmittedBindings(key)) return false;
  if (!isCurrent() || submittedDrafts.get(key) !== version || localStorage.getItem(receiptKey(key)) !== null) return false;
  submittedDrafts.delete(key);
  return true;
}

async function readDraftRecords(key: string): Promise<DraftFile[]> {
  const db = await openDb();
  let records: DraftFile[];
  try {
    records = await new Promise<DraftFile[]>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readonly");
      const request = transaction.objectStore(STORE).get(key);
      // リクエスト成功後でもトランザクションが中断されることがある。
      transaction.oncomplete = () => resolve((request.result as DraftFile[] | undefined) ?? []);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new DOMException("下書きの読み込みが中断されました。", "AbortError"));
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
  return records;
}

function draftFiles(records: DraftFile[]): File[] {
  return records.map((record) => new File([record.blob], record.name, {
    type: record.type, lastModified: record.lastModified,
  }));
}

export function clearDraft(key: string, knownAttempt?: Pick<SubmissionAttempt, "clientRequestId" | "storageKey">, isCurrent: () => boolean = () => true): Promise<void> {
  const receiptVersion = submittedDrafts.get(key);
  return enqueueDraftMutation(key, async () => {
    if (!isCurrent() || !await canClearBoundDraft(key, knownAttempt)) throw new Error("提出記録を照合できないため下書きを保持しています。");
    const retained = isSubmittedDraft(key) ? await readDraftRecords(key) : [];
    const db = await openDb();
    try {
      if (!isCurrent() || !await canClearBoundDraft(key, knownAttempt)) throw new Error("提出記録を照合できないため下書きを保持しています。");
      await tx(db, "readwrite", (store) => store.delete(key));
      if (!isCurrent()) throw new Error("ログイン状態が変わったため後片付けを中止しました。");
      if (submittedDrafts.get(key) === receiptVersion && isSubmittedDraft(key)) {
        // 消去できた後にだけ送信済み印を外す。失敗時は再試行できる状態を保つ。
        try {
          localStorage.removeItem(receiptKey(key));
          if (localStorage.getItem(receiptKey(key)) !== null) throw new Error("送信済み印の削除を確認できません。");
        }
        catch (error) {
          // Preserve the saved draft if removing its durable marker fails.
          if (retained.length && localStorage.getItem(receiptKey(key)) === "1") {
            await tx(db, "readwrite", (store) => store.put(retained, key));
          }
          throw error;
        }
        submittedDrafts.delete(key);
      }
    } finally {
      db.close();
    }
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new DOMException("下書きの保存処理が中断されました。", "AbortError"));
  });
}
