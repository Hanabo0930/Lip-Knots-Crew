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
type DraftBinding = { key: string; storageKey: string; recordIds: string[] };
const savedDraftSelections = new WeakMap<File[], DraftBinding | null>();
const submittedSelections = new WeakSet<File[]>();
const currentDraftKey = (key: string) => "lkc-draft:" + key;
const legacyReceiptKey = (key: string) => "lkc-submitted-draft:" + key;

function bindDraftSelection(files: File[], key: string, storageKey: string, records: DraftFile[]) {
  savedDraftSelections.set(files, { key, storageKey, recordIds: records.map(record => record.id) });
}

function matchesDraft(binding: DraftBinding | null | undefined, storageKey: string, records: DraftFile[]): boolean {
  return binding?.storageKey === storageKey && Array.isArray(records) && records.length === binding.recordIds.length &&
    records.every((record, index) => typeof record?.id === "string" && record.id === binding.recordIds[index]);
}

export function markDraftSelectionEdited(files: File[]): File[] {
  savedDraftSelections.set(files, null);
  return files;
}

export function draftReloadBlocked(key: string, files: File[]): boolean {
  const savedDraft = savedDraftSelections.get(files);
  return draftMutations.size > 0 || ((files.length > 0 || savedDraft !== undefined) && savedDraft?.key !== key);
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
  await draftMutations.get(key);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    let stopped = false;
    const stopWaiting = (error: DOMException) => {
      stopped = true;
      clearTimeout(timer);
      reject(error);
    };
    // An open can also wait behind another tab's IndexedDB request without emitting blocked.
    const timer = setTimeout(() => {
      stopWaiting(new DOMException("下書きの保存領域を開けませんでした。", "TimeoutError"));
    }, 10_000);
    request.onblocked = () => {
      stopWaiting(new DOMException("別の画面が下書きの保存領域を使用しています。", "InvalidStateError"));
    };
    request.onupgradeneeded = () => {
      if (stopped) {
        request.transaction?.abort();
        return;
      }
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      if (stopped) db.close();
      else resolve(db);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  });
}

export function saveDraft(key: string, files: File[]): Promise<void> {
  if (submittedSelections.has(files)) return Promise.resolve();
  const records: DraftFile[] = files.map((file) => ({
    id: crypto.randomUUID(), name: file.name, type: file.type,
    size: file.size, lastModified: file.lastModified, blob: file,
  }));
  return enqueueDraftMutation(key, async () => {
    if (submittedSelections.has(files)) return;
    const db = await openDb();
    try {
      const storageKey = currentDraftKey(key);
      await tx(db, "readwrite", store => store.put(records, storageKey));
      bindDraftSelection(files, key, storageKey, records);
    } finally {
      db.close();
    }
  });
}

export async function loadDraftState(key: string): Promise<{ files: File[]; legacySubmitted: boolean }> {
  await waitForDraftMutation(key);
  const db = await openDb();
  const currentKey = currentDraftKey(key);
  let current: DraftFile[] | undefined, legacy: DraftFile[] | undefined;
  try {
    [current, legacy] = await new Promise<[DraftFile[] | undefined, DraftFile[] | undefined]>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readonly");
      const store = transaction.objectStore(STORE);
      const active = store.get(currentKey), previous = store.get(key);
      // 要求のエラーが先に伝わることがあるため、取引の完了か中断を待つ。
      transaction.oncomplete = () => resolve([active.result, previous.result]);
      transaction.onabort = () => reject(transaction.error ?? new DOMException("下書きの読み込みが中断されました。", "AbortError"));
    });
  } finally {
    db.close();
  }
  if (current === undefined && legacy?.length && localStorage.getItem(legacyReceiptKey(key)) === "1") {
    return { files: [], legacySubmitted: true };
  }
  const records = current ?? legacy ?? [];
  const files = draftFiles(records);
  bindDraftSelection(files, key, current === undefined ? key : currentKey, records);
  return { files, legacySubmitted: false };
}

// 既存の下書きの読み取り経路にも同じ版選択を適用する。
export async function loadDraft(key: string): Promise<File[]> {
  return (await loadDraftState(key)).files;
}

function draftFiles(records: DraftFile[]): File[] {
  return records.map((record) => new File([record.blob], record.name, {
    type: record.type, lastModified: record.lastModified,
  }));
}

export function clearDraft(key: string): Promise<void> {
  return enqueueDraftMutation(key, async () => {
    const db = await openDb();
    try {
      // 旧版を残したまま、新版では古い下書きが再表示されないようにする。
      await tx(db, "readwrite", store => store.put([], currentDraftKey(key)));
    } finally {
      db.close();
    }
  });
}

// 版の比較と現在版の片付けは、同じトランザクションで完了させる。
export async function clearSubmittedDraft(
  key: string, files: File[], isCurrent: () => boolean,
): Promise<"cleared" | "preserved"> {
  submittedSelections.add(files);
  let result: "cleared" | "preserved" = "preserved";
  await enqueueDraftMutation(key, async () => {
    const binding = savedDraftSelections.get(files);
    const currentKey = currentDraftKey(key);
    const db = await openDb();
    try {
      result = await new Promise<"cleared" | "preserved">((resolve, reject) => {
        const transaction = db.transaction(STORE, "readwrite");
        transaction.onabort = () => reject(transaction.error ?? new DOMException("下書きの照合が中断されました。", "AbortError"));
        const store = transaction.objectStore(STORE);
        let outcome: "cleared" | "preserved" = "preserved";
        transaction.oncomplete = () => resolve(outcome);
        const active = store.get(currentKey);
        active.onsuccess = () => {
          if (!isCurrent()) return;
          const records = active.result as DraftFile[] | undefined;
          if (records !== undefined) {
            if (matchesDraft(binding, currentKey, records)) {
              store.put([], currentKey);
              outcome = "cleared";
            } else if (Array.isArray(records) && records.length === 0 && binding?.storageKey !== key) {
              outcome = "cleared";
            }
            return;
          }
          const legacy = store.get(key);
          legacy.onsuccess = () => {
            if (!isCurrent()) return;
            const previous = legacy.result as DraftFile[] | undefined;
            if (previous === undefined || (Array.isArray(previous) && previous.length === 0)) {
              outcome = binding?.storageKey === key ? "preserved" : "cleared";
            } else if (matchesDraft(binding, key, previous)) {
              store.put([], currentKey);
              // 旧版が同じファイルを保持している場合に備え、提出IDは残す。
            }
          };
        };
      });
    } finally {
      db.close();
    }
  });
  return result;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new DOMException("下書きの保存処理が中断されました。", "AbortError"));
  });
}
