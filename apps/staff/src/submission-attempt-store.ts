import {isSubmissionAttemptKey, submissionAttemptPrefix} from "./submission-namespace";
export type SubmissionAttempt = { clientRequestId: string; storageKey: string; contentHashes: string[]; expectedRevision?: number; expectedDateKey?: string };
type StoredAttempt = {version: 1; clientRequestId: string; expectedRevision?: number; expectedDateKey?: string};
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function isStoredSubmissionAttempt(value: unknown): value is StoredAttempt {
  const saved = value as StoredAttempt | null;
  return saved?.version === 1 && typeof saved.clientRequestId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(saved.clientRequestId) &&
    (saved.expectedRevision === undefined || (Number.isSafeInteger(saved.expectedRevision) && saved.expectedRevision >= 0)) &&
    (saved.expectedDateKey === undefined || validDate(saved.expectedDateKey));
}
const failure = () => new Error("提出の再試行記録を保存できません。端末の保存設定を確認してください。選択ファイルは保持しています。");
async function digest(value: BufferSource): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), byte => byte.toString(16).padStart(2, "0")).join("");
}
const pendingFailure = () => new Error("受付結果を確認できない提出が残っています。新しい提出は行わず、元の選択ファイルと提出履歴を確認してください。");
async function attemptScopePrefix(key: string): Promise<string> {
  if (!key || !crypto.subtle) throw failure();
  return submissionAttemptPrefix + await digest(new TextEncoder().encode(key)) + ":";
}
function pendingKeys(prefix: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) {
      if (!isSubmissionAttemptKey(key) || !isStoredSubmissionAttempt(JSON.parse(localStorage.getItem(key) ?? "null"))) throw pendingFailure();
      keys.push(key);
    }
  }
  if (keys.length > 1) throw pendingFailure();
  return keys;
}
export async function hasPendingSubmissionAttempt(key: string): Promise<boolean> {
  return pendingKeys(await attemptScopePrefix(key)).length > 0;
}
export async function assertDraftMatchesPendingAttempt(key: string, files: File[], types: string[], isCurrent: () => boolean): Promise<void> {
  const pending = pendingKeys(await attemptScopePrefix(key));
  if (!pending.length) return;
  if (!files.length || (await fingerprintSubmissionFiles(key, files, types, isCurrent)).storageKey !== pending[0]) throw pendingFailure();
}
export async function fingerprintSubmissionFiles(
  draftKey: string, files: File[], contentTypes: string[], isCurrent: () => boolean = () => true,
): Promise<Pick<SubmissionAttempt, "storageKey" | "contentHashes">> {
  if (!draftKey || !files.length || files.length > 20 || contentTypes.length !== files.length || !crypto.subtle || !navigator.locks) throw failure();
  const contentHashes: string[] = [];
  for (const file of files) {
    if (!isCurrent()) throw new Error("ログイン状態が変わったため送信を中止しました。");
    if (file.size <= 0 || file.size > 50 * 1024 * 1024) throw failure();
    // 50MBを20個まとめてメモリへ展開しない。
    contentHashes.push(await digest(await file.arrayBuffer()));
  }
  const fingerprint = await digest(new TextEncoder().encode(JSON.stringify([draftKey, files.map((file, index) => [file.name, file.size, contentTypes[index], contentHashes[index]])])));
  const storageKey = await attemptScopePrefix(draftKey) + fingerprint;
  return {storageKey, contentHashes};
}
export async function prepareSubmissionAttempt(
  draftKey: string, files: File[], contentTypes: string[], isCurrent: () => boolean = () => true, expectedRevision?: number, expectedDateKey?: string
): Promise<SubmissionAttempt> {
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw failure();
  const {storageKey, contentHashes} = await fingerprintSubmissionFiles(draftKey, files, contentTypes, isCurrent);
  return navigator.locks.request(storageKey, { mode: "exclusive" }, () => {
    if (!isCurrent()) throw new Error("ログイン状態が変わったため送信を中止しました。");
    try {
      if (pendingKeys(storageKey.slice(0, storageKey.lastIndexOf(":") + 1)).some(key => key !== storageKey)) throw pendingFailure();
      const existing = localStorage.getItem(storageKey);
      // Never backfill refreshed context into a receipt whose acceptance is unknown.
      if (existing === null && (expectedRevision === undefined || !validDate(expectedDateKey))) throw failure();
      const value: unknown = existing === null ? {version: 1, clientRequestId: crypto.randomUUID(), expectedRevision, expectedDateKey} : JSON.parse(existing);
      if (!isStoredSubmissionAttempt(value)) throw failure();
      const encoded = JSON.stringify(value);
      localStorage.setItem(storageKey, encoded);
      if (localStorage.getItem(storageKey) !== encoded) throw failure();
      return { clientRequestId: value.clientRequestId, storageKey, contentHashes, ...(value.expectedRevision !== undefined ? { expectedRevision: value.expectedRevision } : {}), ...(value.expectedDateKey !== undefined ? {expectedDateKey: value.expectedDateKey} : {}) };
    } catch { throw failure(); }
  });
}
// True means this exact receipt is confirmed absent; a newer valid receipt is preserved.
export async function clearSubmissionAttempt(attempt: Pick<SubmissionAttempt, "clientRequestId" | "storageKey">, isCurrent: () => boolean = () => true): Promise<boolean> {
  if (!isSubmissionAttemptKey(attempt.storageKey)) return false;
  try {
    return await navigator.locks.request(attempt.storageKey, { mode: "exclusive" }, () => {
      if (!isCurrent()) return false;
      const raw = localStorage.getItem(attempt.storageKey);
      if (raw === null) return true;
      const saved = JSON.parse(raw);
      if (!isStoredSubmissionAttempt(saved)) return false;
      if (saved.clientRequestId !== attempt.clientRequestId) return true;
      localStorage.removeItem(attempt.storageKey);
      return localStorage.getItem(attempt.storageKey) === null;
    });
  } catch { return false; }
}
