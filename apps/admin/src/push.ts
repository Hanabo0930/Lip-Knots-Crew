import { deleteToken, getToken, onMessage, MessagePayload } from "firebase/messaging";
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

export function currentPushPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

function assertCurrentPushAction(isCurrent:()=>boolean){if(!isCurrent())throw new Error("アカウントが切り替わったため通知操作を中止しました。");}

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

export async function loadServerPushStatus(functions: Functions): Promise<boolean> {
  const callable = httpsCallable(functions, "getPushStatus");
  const response = await callable({});
  return (response.data as { enabled?: boolean }).enabled === true;
}

export async function requestTestPush(functions: Functions,isCurrent:()=>boolean=()=>true): Promise<void> {
  assertCurrentPushAction(isCurrent);
  const callable = httpsCallable(functions, "sendTestPush");
  await callable({});
  assertCurrentPushAction(isCurrent);
}

export async function listenForForegroundPush(
  handler: (payload: MessagePayload) => void
): Promise<(() => void) | null> {
  const messaging = await getClientMessaging();
  return messaging ? onMessage(messaging, handler) : null;
}
