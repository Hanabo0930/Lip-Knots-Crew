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

export async function saveDraft(key: string, files: File[]): Promise<void> {
  const db = await openDb();
  const records: DraftFile[] = files.map((file) => ({
    id: crypto.randomUUID(), name: file.name, type: file.type,
    size: file.size, lastModified: file.lastModified, blob: file,
  }));
  await tx(db, "readwrite", (store) => store.put(records, key));
  db.close();
}

export async function loadDraft(key: string): Promise<File[]> {
  const db = await openDb();
  const records = await new Promise<DraftFile[]>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    request.onsuccess = () => resolve((request.result as DraftFile[] | undefined) ?? []);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return records.map((record) => new File([record.blob], record.name, {
    type: record.type, lastModified: record.lastModified,
  }));
}

export async function clearDraft(key: string): Promise<void> {
  const db = await openDb();
  await tx(db, "readwrite", (store) => store.delete(key));
  db.close();
}

function tx(db: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
