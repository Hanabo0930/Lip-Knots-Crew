export type SubmissionAttempt = { clientRequestId: string; storageKey: string; contentHashes: string[]; expectedRevision?: number };
const failure = () => new Error("提出の再試行記録を保存できません。端末の保存設定を確認してください。選択ファイルは保持しています。");
async function digest(value: BufferSource): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function identifySubmissionAttempt(
  draftKey: string, files: File[], contentTypes: string[], isCurrent: () => boolean
): Promise<{ storageKey: string; contentHashes: string[] }> {
  if (!draftKey || !files.length || files.length > 20 || contentTypes.length !== files.length || !crypto.subtle || !navigator.locks) throw failure();
  const contentHashes: string[] = [];
  for (const file of files) {
    if (!isCurrent()) throw new Error("ログイン状態が変わったため送信を中止しました。");
    if (file.size <= 0 || file.size > 50 * 1024 * 1024) throw failure();
    // 50MBを20個まとめてメモリへ展開しない。
    contentHashes.push(await digest(await file.arrayBuffer()));
  }
  const fingerprint = await digest(new TextEncoder().encode(JSON.stringify([draftKey, files.map((file, index) => [file.name, file.size, contentTypes[index], contentHashes[index]])])));
  const storageKey = "lkc.submissionAttempt.v1:" + fingerprint;
  return { storageKey, contentHashes };
}
function readAttempt(raw: string, storageKey: string, contentHashes: string[]): SubmissionAttempt {
  const value = JSON.parse(raw);
  if (value?.version !== 1 || typeof value.clientRequestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.clientRequestId)) throw failure();
  if (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)) throw failure();
  return { clientRequestId: value.clientRequestId, storageKey, contentHashes, ...(value.expectedRevision !== undefined ? { expectedRevision: value.expectedRevision } : {}) };
}
// Recover only an existing receipt for the exact saved draft; never reserve a new intent.
export async function findSubmissionAttempt(
  draftKey: string, files: File[], contentTypes: string[], isCurrent: () => boolean = () => true
): Promise<SubmissionAttempt | null> {
  const { storageKey, contentHashes } = await identifySubmissionAttempt(draftKey, files, contentTypes, isCurrent);
  return navigator.locks.request(storageKey, { mode: "exclusive" }, () => {
    if (!isCurrent()) throw failure();
    try {
      const raw = localStorage.getItem(storageKey);
      return raw === null ? null : readAttempt(raw, storageKey, contentHashes);
    } catch { throw failure(); }
  });
}
export async function prepareSubmissionAttempt(
  draftKey: string, files: File[], contentTypes: string[], isCurrent: () => boolean = () => true, expectedRevision?: number
): Promise<SubmissionAttempt> {
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw failure();
  const { storageKey, contentHashes } = await identifySubmissionAttempt(draftKey, files, contentTypes, isCurrent);
  return navigator.locks.request(storageKey, { mode: "exclusive" }, () => {
    if (!isCurrent()) throw new Error("ログイン状態が変わったため送信を中止しました。");
    try {
      const existing = localStorage.getItem(storageKey);
      const value = existing === null ? { version: 1, clientRequestId: crypto.randomUUID(), ...(expectedRevision !== undefined ? { expectedRevision } : {}) } : JSON.parse(existing);
      const encoded = JSON.stringify(value);
      const attempt = readAttempt(encoded, storageKey, contentHashes);
      localStorage.setItem(storageKey, encoded);
      if (localStorage.getItem(storageKey) !== encoded) throw failure();
      return attempt;
    } catch { throw failure(); }
  });
}
// True means this exact receipt is confirmed absent; a newer valid receipt is preserved.
export async function clearSubmissionAttempt(attempt: SubmissionAttempt): Promise<boolean> {
  try {
    return await navigator.locks.request(attempt.storageKey, { mode: "exclusive" }, () => {
      const raw = localStorage.getItem(attempt.storageKey);
      if (raw === null) return true;
      const saved = JSON.parse(raw);
      if (saved?.version !== 1 || typeof saved.clientRequestId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(saved.clientRequestId) ||
        (saved.expectedRevision !== undefined && (!Number.isSafeInteger(saved.expectedRevision) || saved.expectedRevision < 0))) return false;
      if (saved.clientRequestId !== attempt.clientRequestId) return true;
      localStorage.removeItem(attempt.storageKey);
      return localStorage.getItem(attempt.storageKey) === null;
    });
  } catch { return false; }
}
