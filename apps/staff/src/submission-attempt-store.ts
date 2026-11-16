export type SubmissionAttempt = { clientRequestId: string; storageKey: string; contentHashes: string[]; expectedRevision?: number; expectedDateKey?: string };
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const failure = () => new Error("提出の再試行記録を保存できません。端末の保存設定を確認してください。選択ファイルは保持しています。");
async function digest(value: BufferSource): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function prepareSubmissionAttempt(
  draftKey: string, files: File[], contentTypes: string[], isCurrent: () => boolean = () => true, expectedRevision?: number, expectedDateKey?: string
): Promise<SubmissionAttempt> {
  if (!draftKey || !files.length || files.length > 20 || contentTypes.length !== files.length || !crypto.subtle || !navigator.locks) throw failure();
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw failure();
  if (expectedDateKey !== undefined && !validDate(expectedDateKey)) throw failure();
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
      const value = existing === null ? { version: 1, clientRequestId: crypto.randomUUID(), ...(expectedRevision !== undefined ? { expectedRevision } : {}), ...(expectedDateKey !== undefined ? { expectedDateKey } : {}) } : JSON.parse(existing);
      if (value?.version !== 1 || typeof value.clientRequestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.clientRequestId)) throw failure();
      if (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)) throw failure();
      if (value.expectedDateKey !== undefined && !validDate(value.expectedDateKey)) throw failure();
      const encoded = JSON.stringify(value);
      localStorage.setItem(storageKey, encoded);
      if (localStorage.getItem(storageKey) !== encoded) throw failure();
      return { clientRequestId: value.clientRequestId, storageKey, contentHashes, ...(value.expectedRevision !== undefined ? { expectedRevision: value.expectedRevision } : {}),
        ...(value.expectedDateKey !== undefined ? { expectedDateKey: value.expectedDateKey } : {}) };
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
        (saved.expectedRevision !== undefined && (!Number.isSafeInteger(saved.expectedRevision) || saved.expectedRevision < 0)) ||
        (saved.expectedDateKey !== undefined && !validDate(saved.expectedDateKey))) return false;
      if (saved.clientRequestId !== attempt.clientRequestId) return true;
      if (saved.expectedRevision !== attempt.expectedRevision || saved.expectedDateKey !== attempt.expectedDateKey) return false;
      localStorage.removeItem(attempt.storageKey);
      return localStorage.getItem(attempt.storageKey) === null;
    });
  } catch { return false; }
}

type SubmissionUploadRequest = {
  clientRequestId: string;
  jobId: string;
  type: string;
  purpose: string;
  resubmissionRequestId?: string;
  expectedDateKey: string;
  expectedRevision: number;
  receiptOnly: boolean;
};

type SubmissionUploadReceipt = {
  submissionId: string;
  clientRequestId: string;
  acceptedContext?: { jobId: string; dateKey: string; revision: number };
  files: { fileId: string; storagePath: string; uploadRequired: boolean }[];
};

export function isConfirmedSubmissionRejection(error: unknown, request: SubmissionUploadRequest): boolean {
  const details = (error as {details?: Record<string, unknown>})?.details;
  return !request.receiptOnly && details?.reason === "submission_context_changed" && details.accepted === false &&
    details.clientRequestId === request.clientRequestId && details.jobId === request.jobId &&
    details.type === request.type && details.purpose === request.purpose &&
    details.resubmissionRequestId === (request.resubmissionRequestId ?? null) &&
    details.expectedDateKey === request.expectedDateKey && details.expectedRevision === request.expectedRevision;
}

function invalidUploadTarget() {
  return new Error("送信先を正しく準備できませんでした。選択ファイルは保持しています。");
}

export async function readSubmissionUploadReceipt(
  value: unknown, request: SubmissionUploadRequest, matchesDisplayed: boolean, fileCount: number,
  scope: { companyId: string; staffId: string; uid: string | undefined },
): Promise<SubmissionUploadReceipt> {
  const receipt = value as SubmissionUploadReceipt | null;
  const accepted = receipt?.acceptedContext;
  if (!matchesDisplayed || accepted?.jobId !== request.jobId || accepted.dateKey !== request.expectedDateKey ||
      accepted.revision !== request.expectedRevision) {
    throw new Error("表示中の案件・勤務日・版と提出先を照合できません。ファイルは保持しています。再送せず提出履歴を確認してください。");
  }
  const {companyId, staffId, uid} = scope;
  if (!companyId || !staffId || !uid || !receipt || receipt.clientRequestId !== request.clientRequestId ||
      !Array.isArray(receipt.files) || receipt.files.length !== fileCount) throw invalidUploadTarget();
  const encoder = new TextEncoder();
  // Match the stable IDs generated by createUploadSession, including file order.
  const submissionId = "submission_" + await digest(encoder.encode(JSON.stringify([companyId, staffId, uid, request.clientRequestId])));
  if (receipt.submissionId !== submissionId) throw invalidUploadTarget();
  for (const [index, target] of receipt.files.entries()) {
    const fileId = "file_" + (await digest(encoder.encode(submissionId + "|" + index))).slice(0, 32);
    if (!target || typeof target.uploadRequired !== "boolean" || target.fileId !== fileId ||
        typeof target.storagePath !== "string") throw invalidUploadTarget();
    const [area, company, owner, submission, file, name, ...extra] = target.storagePath.split("/");
    if (area !== "staging" || company !== companyId || owner !== uid || submission !== submissionId ||
        file !== fileId || !name || name === "." || name === ".." || extra.length) throw invalidUploadTarget();
  }
  return receipt;
}

export function interruptedUploadStatuses(current: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(current).map(([key, status]) => [key,
    status === "送信済み" ? status : status === "送信待ち" ? "未送信" : "送信未完了",
  ]));
}

export function interruptedUploadError(): Error {
  return new Error("送信を完了できませんでした。選択ファイルは保持しています。同じ選択ファイルで再度送信すると、受付済みのファイルを確認し、未送信分から続けます。「提出情報を再読み込み」でも履歴を確認できます。");
}
