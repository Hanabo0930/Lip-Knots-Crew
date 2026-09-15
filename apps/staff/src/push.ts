import type { MessagePayload } from "firebase/messaging";
const loadMessagingSdk=()=>import("firebase/messaging");
import { Functions, httpsCallable } from "firebase/functions";
import { getClientMessaging } from "./firebase";

async function waitForPushWorker():Promise<ServiceWorkerRegistration>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("通知の準備が時間内に完了しませんでした。ページを再読み込みしてから、もう一度操作してください。")),10000);}),
  ]);}finally{if(timer!==undefined)clearTimeout(timer);}
}
export type PushResult = {
  enabled: boolean;
  permission: NotificationPermission | "unsupported";
  token?: string;
  message: string;
};

export type PushTestStatus = {
  queueId: string;
  status: string;
  finished: boolean;
  successCount: number;
  failureCount: number;
  invalidTokenCount: number;
  failureReason:
    | "none"
    | "invalid_token"
    | "sender_mismatch"
    | "service_auth"
    | "rate_limited"
    | "temporary"
    | "unknown";
};

export function currentPushPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

function assertCurrentPushAction(isCurrent:()=>boolean){
  if(!isCurrent())throw Error("アカウントが切り替わったため通知操作を中止しました。");
}

export async function enablePushNotifications(
  functions: Functions,
  deviceSessionId = "",
  isCurrent:()=>boolean=()=>true
): Promise<PushResult> {
  assertCurrentPushAction(isCurrent);
  if (!("serviceWorker" in navigator) || typeof Notification === "undefined") {
    return { enabled:false, permission:"unsupported", message:"この端末はプッシュ通知に対応していません。" };
  }
  const permission = await Notification.requestPermission();
  assertCurrentPushAction(isCurrent);
  if (permission !== "granted") {
    return { enabled:false, permission, message:"通知が許可されませんでした。端末の設定から変更できます。" };
  }
  const messaging = await getClientMessaging();
  assertCurrentPushAction(isCurrent);
  if (!messaging) {
    return { enabled:false, permission:"unsupported", message:"このブラウザでは通知を利用できません。" };
  }
  const {getToken,deleteToken}=await loadMessagingSdk();
  assertCurrentPushAction(isCurrent);
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  if (!vapidKey) throw new Error("VITE_FIREBASE_VAPID_KEYが未設定です。");
  const registration = await waitForPushWorker();
  assertCurrentPushAction(isCurrent);
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  assertCurrentPushAction(isCurrent);
  if (!token) throw new Error("通知端末の登録に失敗しました。");
  const register = httpsCallable(functions, "registerPushToken");
  await register({
    token,
    deviceSessionId,
    permission,
    userAgent: navigator.userAgent,
    platform: navigator.platform || "",
  });
  assertCurrentPushAction(isCurrent);
  return { enabled:true, permission, token, message:"プッシュ通知を有効にしました。" };
}

export async function disablePushNotifications(
  functions: Functions,
  isCurrent:()=>boolean=()=>true
): Promise<PushResult> {
  assertCurrentPushAction(isCurrent);
  const messaging = await getClientMessaging();
  assertCurrentPushAction(isCurrent);
  if (!messaging) {
    return { enabled:false, permission:"unsupported", message:"通知は無効です。" };
  }
  const {getToken,deleteToken}=await loadMessagingSdk();
  assertCurrentPushAction(isCurrent);
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  const registration = await waitForPushWorker();
  assertCurrentPushAction(isCurrent);
  const token = vapidKey ? await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration }) : "";
  assertCurrentPushAction(isCurrent);
  if (token) {
    const unregister = httpsCallable(functions, "unregisterPushToken");
    await unregister({ token });
    assertCurrentPushAction(isCurrent);
    await deleteToken(messaging);
    assertCurrentPushAction(isCurrent);
  }
  return { enabled:false, permission:currentPushPermission(), message:"この端末の通知を無効にしました。" };
}

export async function refreshPushNotifications(
  functions: Functions,
  deviceSessionId = "",
  isCurrent:()=>boolean=()=>true
): Promise<PushResult> {
  assertCurrentPushAction(isCurrent);
  if (!('serviceWorker' in navigator) || currentPushPermission() !== "granted") {
    return {
      enabled: false,
      permission: currentPushPermission(),
      message: "端末の通知許可を確認してください。",
    };
  }
  const messaging = await getClientMessaging();
  assertCurrentPushAction(isCurrent);
  if (!messaging) {
    return { enabled:false, permission:"unsupported", message:"このブラウザでは通知を利用できません。" };
  }
  const {getToken,deleteToken}=await loadMessagingSdk();
  assertCurrentPushAction(isCurrent);
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  if (!vapidKey) throw new Error("VITE_FIREBASE_VAPID_KEYが未設定です。");
  const registration = await waitForPushWorker();
  assertCurrentPushAction(isCurrent);
  const previousToken = await getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration: registration,
  });
  assertCurrentPushAction(isCurrent);
  if (previousToken) {
    const unregister = httpsCallable(functions, "unregisterPushToken");
    await unregister({ token: previousToken }).catch(() => undefined);
    assertCurrentPushAction(isCurrent);
  }
  await deleteToken(messaging);
  assertCurrentPushAction(isCurrent);
  return enablePushNotifications(functions, deviceSessionId, isCurrent);
}

export async function loadServerPushStatus(functions: Functions): Promise<boolean> {
  const callable = httpsCallable(functions, "getPushStatus");
  const response = await callable({});
  const data=response.data as {enabled?:unknown}|null;
  if(!data||Array.isArray(data)||typeof data.enabled!=="boolean")throw new Error("通知状態の応答を確認できません。もう一度お試しください。");
  return data.enabled;
}

export async function loadServerPushStatusWithRetry(
  functions: Functions,
  attempts = 3
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await loadServerPushStatus(functions);
    } catch (error) {
      lastError = error;
      const code = String((error as { code?: unknown }|null)?.code ?? "");
      const retryable = !/(unauthenticated|permission-denied|invalid-argument)$/u.test(code);
      if (!retryable || attempt === attempts - 1) break;
      await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function requestTestPush(functions: Functions): Promise<string> {
  const callable = httpsCallable(functions, "sendTestPush");
  const response = await callable({});
  const queueId = (response.data as {queueId?:unknown}|null)?.queueId;
  if (typeof queueId!=="string"||!queueId.trim()||queueId.includes("/")) throw new Error("通知テストの受付結果を確認できません。");
  return queueId;
}

export async function loadTestPushStatus(
  functions: Functions,
  queueId: string,
  timeoutMs = 15_000
): Promise<PushTestStatus | null> {
  const callable = httpsCallable(functions, "getPushStatus", {timeout:Math.max(1,Math.min(15_000,timeoutMs))});
  const response = await callable({ queueId });
  const test=(response.data as {test?:PushTestStatus}|null)?.test;
  if(test==null)return null;
  if(typeof test!=="object"||Array.isArray(test)||test.queueId!==queueId||typeof test.status!=="string"||!test.status.trim()||typeof test.finished!=="boolean"||
    [test.successCount,test.failureCount,test.invalidTokenCount].some(value=>!Number.isSafeInteger(value)||value<0)||
    !["none","invalid_token","sender_mismatch","service_auth","rate_limited","temporary","unknown"].includes(test.failureReason)||
    test.finished!==["completed","partial","no_tokens","error","paused_global"].includes(test.status))throw new Error("通知テストの処理結果を確認できません。もう一度お試しください。");
  return test;
}

export async function listenForForegroundPush(
  handler: (payload: MessagePayload) => void
): Promise<(() => void) | null> {
  const messaging = await getClientMessaging();
  if(!messaging)return null;
  const {onMessage}=await loadMessagingSdk();
  return onMessage(messaging, (payload) => {
    void showForegroundSystemNotification(payload).catch(() => undefined);
    handler(payload);
  });
}

async function showForegroundSystemNotification(
  payload: MessagePayload
): Promise<void> {
  if (
    currentPushPermission() !== "granted" ||
    !("serviceWorker" in navigator)
  ) return;

  const data = payload.data ?? {};
  const registration = await waitForPushWorker();
  await registration.showNotification(data.title || "Lip Knots Crew", {
    body: data.body || "新しいお知らせがあります。",
    icon: "/logo.png",
    badge: "/logo.png",
    tag: data.category || "lkc-notification",
    data: { route: data.route || "/" },
  });
}
