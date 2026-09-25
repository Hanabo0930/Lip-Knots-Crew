import { httpsCallable } from "firebase/functions";
import { auth, functions } from "./firebase";
import { executeNativeAttempt, nativeAttemptEvent, NativeKind, NativeOwner } from "./native-creation-retry";

export async function submitNativeCreation(start: { kind: NativeKind; input: Record<string, unknown> } | undefined,
  isCurrent: () => boolean, cancel = false, expectedOwner?: NativeOwner) {
  const user = auth?.currentUser;
  if (!user || !functions || !isCurrent()) return null;
  const token = await user.getIdTokenResult();
  const owner = { companyId: String(token.claims.companyId ?? ""), uid: user.uid };
  if (token.claims.role !== "admin" || !owner.companyId || (expectedOwner && (expectedOwner.uid !== owner.uid || expectedOwner.companyId !== owner.companyId))) throw Error("元の会社・管理者でログインして作成結果を確認してください。");
  const current = async () => {
    if (!isCurrent() || auth?.currentUser !== user) return false;
    const latest = await user.getIdTokenResult();
    return isCurrent() && auth?.currentUser === user && latest.claims.role === "admin" && latest.claims.companyId === owner.companyId;
  };
  // flat形式へのフォールバックはしない。旧APIは入れ子の依頼を保存前に拒否する。
  return executeNativeAttempt({ owner, start, cancel, current,
    storage: window.localStorage, locks: navigator.locks, uuid: () => crypto.randomUUID(),
    changed: () => window.dispatchEvent(new Event(nativeAttemptEvent)),
    call: async (kind, payload) => (await (kind === "create"
      ? httpsCallable(functions!, "createAdminJobGroup")(payload)
      : httpsCallable(functions!, "duplicateAdminJob")(payload))).data,
  });
}
