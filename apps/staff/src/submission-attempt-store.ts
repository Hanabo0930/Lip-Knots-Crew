export type SubmissionAttempt = { clientRequestId: string; storageKey: string; contentHashes: string[]; expectedRevision?: number };
const failure = () => new Error("提出の再試行記録を保存できません。端末の保存設定を確認してください。選択ファイルは保持しています。");
async function digest(value: BufferSource): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function prepareSubmissionAttempt(
  draftKey: string, files: File[], contentTypes: string[], isCurrent: () => boolean = () => true, expectedRevision?: number
): Promise<SubmissionAttempt> {
  if (!draftKey || !files.length || files.length > 20 || contentTypes.length !== files.length || !crypto.subtle || !navigator.locks) throw failure();
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw failure();
  const contentHashes: string[] = [];
  for (const file of files) {
    if (!isCurrent()) throw new Error("ログイン状態が変わったため送信を中止しました。");
    if (file.size <= 0 || file.size > 50 * 1024 * 1024) throw failure();
    // 50MBを20個まとめてメモリへ展開しない。
    contentHashes.push(await digest(await file.arrayBuffer()));
  }
  const fingerprint = await digest(new TextEncoder().encode(JSON.stringify([draftKey, files.map((file, index) => [file.name, file.size, contentTypes[index], contentHashes[index]])])));
  const storageKey = "lkc.submissionAttempt.v1:" + fingerprint;
  return navigator.locks.request(storageKey, { mode: "exclusive" }, () => {
    if (!isCurrent()) throw new Error("ログイン状態が変わったため送信を中止しました。");
    try {
      const existing = localStorage.getItem(storageKey);
      const value = existing === null ? { version: 1, clientRequestId: crypto.randomUUID(), ...(expectedRevision !== undefined ? { expectedRevision } : {}) } : JSON.parse(existing);
      if (value?.version !== 1 || typeof value.clientRequestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.clientRequestId)) throw failure();
      if (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)) throw failure();
      const encoded = JSON.stringify(value);
      localStorage.setItem(storageKey, encoded);
      if (localStorage.getItem(storageKey) !== encoded) throw failure();
      return { clientRequestId: value.clientRequestId, storageKey, contentHashes, ...(value.expectedRevision !== undefined ? { expectedRevision: value.expectedRevision } : {}) };
    } catch { throw failure(); }
  });
}
// True means this exact receipt is confirmed absent; a newer valid receipt is preserved.
export async function clearSubmissionAttempt(attempt: SubmissionAttempt, isCurrent: () => boolean = () => true): Promise<boolean> {
  try {
    return await navigator.locks.request(attempt.storageKey, { mode: "exclusive" }, () => {
      if (!isCurrent()) return false;
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
