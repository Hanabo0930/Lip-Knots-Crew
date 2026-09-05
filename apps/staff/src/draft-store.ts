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
  const records: DraftFile[] = files.map((file) => ({
    id: crypto.randomUUID(), name: file.name, type: file.type,
    size: file.size, lastModified: file.lastModified, blob: file,
  }));
  return enqueueDraftMutation(key, async () => {
    const db = await openDb();
    try {
      await tx(db, "readwrite", (store) => store.put(records, key));
    } finally {
      db.close();
    }
  });
}

export async function loadDraft(key: string): Promise<File[]> {
  await waitForDraftMutation(key);
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
  return records.map((record) => new File([record.blob], record.name, {
    type: record.type, lastModified: record.lastModified,
  }));
}

export function clearDraft(key: string): Promise<void> {
  return enqueueDraftMutation(key, async () => {
    const db = await openDb();
    try {
      await tx(db, "readwrite", (store) => store.delete(key));
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
