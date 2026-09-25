export type NativeKind = "create" | "duplicate";
export type NativeOwner = { companyId: string; uid: string };
export type NativeAttempt = { version: 1; owner: NativeOwner; operationId: string; kind: NativeKind; input: Record<string, unknown> };
export type NativeResult = { nativeCreationReceipt: { version: 1; operationId: string; companyId: string; actorUid: string; kind: NativeKind; status: "committed" | "cancelled" }; jobIds?: string[]; groupId?: string; warning?: string };
export const nativeAttemptEvent = "lkc-native-creation-changed";
export const nativeAttemptKey = (owner: NativeOwner) => "lkc.nativeCreation.v1:" + JSON.stringify([owner.companyId, owner.uid]);
const sameOwner = (a: NativeOwner, b: NativeOwner) => a.companyId === b.companyId && a.uid === b.uid;
export function readNativeAttempt(storage: Pick<Storage, "getItem">, owner: NativeOwner): NativeAttempt | null {
  const raw = storage.getItem(nativeAttemptKey(owner));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as NativeAttempt;
    if (value.version !== 1 || !sameOwner(value.owner, owner) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.operationId) || !["create", "duplicate"].includes(value.kind) || !value.input || Array.isArray(value.input) || typeof value.input !== "object") throw Error();
    return value;
  } catch { throw Error("端末に保存した作成依頼を確認できません。新たに作成せず、管理者に確認してください。"); }
}
export async function executeNativeAttempt(options: {
  owner: NativeOwner; storage: Storage; locks: LockManager; uuid: () => string;
  call: (kind: NativeKind, payload: unknown) => Promise<unknown>;
  current: () => Promise<boolean>; changed: () => void;
  start?: { kind: NativeKind; input: Record<string, unknown> }; cancel?: boolean;
}): Promise<NativeResult | null> {
  const { owner, storage, locks, current } = options;
  if (!locks?.request) throw Error("このブラウザーでは作成依頼を安全に保存できません。対応ブラウザーで開いてください。");
  return locks.request(nativeAttemptKey(owner), { mode: "exclusive", ifAvailable: true }, async lock => {
    if (!lock) throw Error("別の画面で作成結果を確認しています。処理が終わるまでお待ちください。");
    if (!await current()) return null;
    let attempt = readNativeAttempt(storage, owner);
    if (options.start) {
      if (attempt) throw Error("結果が未確認の作成依頼があります。「作成結果を確認」から確認してください。");
      attempt = JSON.parse(JSON.stringify({ version: 1, owner, operationId: options.uuid(), kind: options.start.kind, input: options.start.input })) as NativeAttempt;
      storage.setItem(nativeAttemptKey(owner), JSON.stringify(attempt));
      if (JSON.stringify(readNativeAttempt(storage, owner)) !== JSON.stringify(attempt)) throw Error("作成依頼を端末に保存できませんでした。送信していません。");
      options.changed();
    }
    if (!attempt) throw Error("結果が未確認の作成依頼はありません。");
    if (!await current()) return null;
    const result = await options.call(attempt.kind, { nativeCreation: { operationId: attempt.operationId,
      expectedCompanyId: owner.companyId, expectedActorUid: owner.uid, action: options.cancel ? "cancel" : "create", input: attempt.input } }) as NativeResult;
    if (!await current()) return null;
    const receipt = result?.nativeCreationReceipt;
    if (!receipt || receipt.version !== 1 || receipt.operationId !== attempt.operationId || receipt.companyId !== owner.companyId || receipt.actorUid !== owner.uid || receipt.kind !== attempt.kind || !["committed", "cancelled"].includes(receipt.status) ||
      (receipt.status === "committed" && (!result.groupId || !Array.isArray(result.jobIds) || !result.jobIds.length || result.jobIds.some(id => typeof id !== "string" || !id))))
      throw Error("作成結果を照合できません。依頼を保持しています。「作成結果を確認」から再確認してください。");
    if (readNativeAttempt(storage, owner)?.operationId === attempt.operationId) {
      storage.removeItem(nativeAttemptKey(owner));
      if (storage.getItem(nativeAttemptKey(owner)) !== null) throw Error("作成結果は確認できましたが、端末の確認記録を更新できません。再確認してください。");
      options.changed();
    }
    return result;
  });
}
