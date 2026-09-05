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
const submittedDrafts = new Map<string, number>();
const receiptKey = (key: string) => `lkc-submitted-draft:${key}`;

function isSubmittedDraft(key: string): boolean {
  if (submittedDrafts.has(key)) return true;
  try { return localStorage.getItem(receiptKey(key)) === "1"; } catch { return false; }
}

// IndexedDBの後片付けが失敗しても、送信済みの下書きを自動復元しない。
export function markDraftSubmitted(key: string): boolean {
  submittedDrafts.set(key, (submittedDrafts.get(key) ?? 0) + 1);
  try { localStorage.setItem(receiptKey(key), "1"); return true; } catch { return false; }
}

function enqueueDraftMutation(key: string, mutation: () => Promise<void>): Promise<void> {
  const previous = draftMutations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(mutation);
  draftMutations.set(key, current);
  return current.finally(() => {
    if (draftMutations.get(key) === current) draftMutations.delete(key);
  });
}

async function waitForDraftMutation(key: string): Promise<void> {
  await draftMutations.get(key)?.catch(() => undefined);
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
    if (isSubmittedDraft(key)) throw new Error("送信済み下書きは保存し直しません。" );
    const db = await openDb();
    try {
      await tx(db, "readwrite", (store) => store.put(records, key));
    } finally {
      db.close();
    }
  });
}

export async function loadDraft(key: string): Promise<File[]> {
  if (isSubmittedDraft(key)) return [];
  await waitForDraftMutation(key);
  if (isSubmittedDraft(key)) return [];
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
  if (isSubmittedDraft(key)) return [];
  return records.map((record) => new File([record.blob], record.name, {
    type: record.type, lastModified: record.lastModified,
  }));
}

export function clearDraft(key: string): Promise<void> {
  const receiptVersion = submittedDrafts.get(key);
  return enqueueDraftMutation(key, async () => {
    const db = await openDb();
    try {
      await tx(db, "readwrite", (store) => store.delete(key));
      if (submittedDrafts.get(key) === receiptVersion && isSubmittedDraft(key)) {
        // 消去できた後にだけ送信済み印を外す。失敗時は再試行できる状態を保つ。
        localStorage.removeItem(receiptKey(key));
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
