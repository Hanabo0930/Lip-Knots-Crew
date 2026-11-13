import {submittedMarkerKey as receiptKey} from "./submission-namespace";
// Shared synchronous marker state for the app and the on-demand IndexedDB store.
export const submittedDrafts = new Map<string, number>();
export {submittedMarkerKey as receiptKey} from "./submission-namespace";

export function getSubmittedDraftReceipt(key: string): { durable: boolean } | null {
  try { if (localStorage.getItem(receiptKey(key)) === "1") return { durable: true }; } catch { /* メモリの記録を確認する。 */ }
  return submittedDrafts.has(key) ? { durable: false } : null;
}

export function isSubmittedDraft(key: string): boolean {
  return getSubmittedDraftReceipt(key) !== null;
}

// IndexedDBの後片付けが失敗しても、送信済みの下書きを自動復元しない。
export function markDraftSubmitted(key: string): boolean {
  submittedDrafts.set(key, (submittedDrafts.get(key) ?? 0) + 1);
  try { localStorage.setItem(receiptKey(key), "1"); return localStorage.getItem(receiptKey(key)) === "1"; } catch { return false; }
}
