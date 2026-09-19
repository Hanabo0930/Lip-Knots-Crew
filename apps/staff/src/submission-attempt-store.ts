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
export async function clearSubmissionAttempt(attempt: SubmissionAttempt): Promise<void> {
  try {
    await navigator.locks.request(attempt.storageKey, { mode: "exclusive" }, () => {
      const saved = JSON.parse(localStorage.getItem(attempt.storageKey) ?? "null");
      if (saved?.clientRequestId === attempt.clientRequestId) localStorage.removeItem(attempt.storageKey);
    });
  } catch { /* 後片付け失敗時は同じ受付を保持し、二重提出よりも履歴の確認を優先する。 */ }
}
