import {submissionContextLockKey} from "./submission-namespace";
// Local isolated-origin candidate only. Not enabled for any deployed origin.
import {SubmissionContextBusyError} from "./submission-context-error";
export {SubmissionContextBusyError} from "./submission-context-error";
const brand: unique symbol = Symbol("submission-context-lease");
export type SubmissionContextLease = { readonly key: string; readonly [brand]: true };
const active = new WeakMap<SubmissionContextLease, () => boolean>();
export const submissionContextCurrent = (key: string, lease: SubmissionContextLease) => lease.key === key && Boolean(active.get(lease)?.());
export function assertSubmissionContext(key: string, lease?: SubmissionContextLease): asserts lease is SubmissionContextLease {
  if (!lease || lease.key !== key || !active.get(lease)?.()) throw new Error("提出対象またはログイン状態が変わりました。保存内容を確認してください。");
}
export async function withSubmissionContext<T>(
  key: string, isCurrent: () => boolean, action: (lease: SubmissionContextLease) => Promise<T> | T,
  held?: SubmissionContextLease,
): Promise<T> {
  if (held) { assertSubmissionContext(key, held); if (!isCurrent()) throw new Error("ログイン状態が変わりました。"); return action(held); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) throw new Error("この候補は隔離ローカルorigin専用です。");
  if (!key || !crypto.subtle || !navigator.locks) throw new Error("端末の提出ロックを利用できません。");
  // Never queue a user submission that could run later as an unintended new intent.
  // Request synchronously, before any hashing await. The existing context is not newly persisted.
  return navigator.locks.request(submissionContextLockKey(key), {mode:"exclusive", ifAvailable:true}, async lock => {
    if (!lock) throw new SubmissionContextBusyError();
    if (!isCurrent()) throw new Error("ログイン状態が変わりました。");
    const lease: SubmissionContextLease = Object.freeze({key, [brand]: true as const});
    active.set(lease, isCurrent);
    try { return await action(lease); } finally { active.delete(lease); }
  });
}
