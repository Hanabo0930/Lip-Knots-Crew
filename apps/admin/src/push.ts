import { deleteToken, getToken, onMessage, MessagePayload } from "firebase/messaging";
import { Functions, httpsCallable } from "firebase/functions";
import { getClientMessaging } from "./firebase";

export type PushResult = {
  enabled: boolean;
  permission: NotificationPermission | "unsupported";
  token?: string;
  message: string;
};

export function currentPushPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export async function enablePushNotifications(
  functions: Functions,
  deviceSessionId = ""
): Promise<PushResult> {
  if (!("serviceWorker" in navigator) || typeof Notification === "undefined") {
    return { enabled:false, permission:"unsupported", message:"この端末はプッシュ通知に対応していません。" };
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { enabled:false, permission, message:"通知が許可されませんでした。端末の設定から変更できます。" };
  }
  const messaging = await getClientMessaging();
  if (!messaging) {
    return { enabled:false, permission:"unsupported", message:"このブラウザでは通知を利用できません。" };
  }
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  if (!vapidKey) throw new Error("VITE_FIREBASE_VAPID_KEYが未設定です。");
  const registration = await navigator.serviceWorker.ready;
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new Error("通知端末の登録に失敗しました。");
  const register = httpsCallable(functions, "registerPushToken");
  await register({
    token,
    deviceSessionId,
    permission,
    userAgent: navigator.userAgent,
    platform: navigator.platform || "",
  });
  return { enabled:true, permission, token, message:"プッシュ通知を有効にしました。" };
}

export async function disablePushNotifications(
  functions: Functions
): Promise<PushResult> {
  const messaging = await getClientMessaging();
  if (!messaging) {
    return { enabled:false, permission:"unsupported", message:"通知は無効です。" };
  }
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  const registration = await navigator.serviceWorker.ready;
  const token = vapidKey ? await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration }) : "";
  if (token) {
    const unregister = httpsCallable(functions, "unregisterPushToken");
    await unregister({ token });
    await deleteToken(messaging);
  }
  return { enabled:false, permission:currentPushPermission(), message:"この端末の通知を無効にしました。" };
}

export async function loadServerPushStatus(functions: Functions): Promise<boolean> {
  const callable = httpsCallable(functions, "getPushStatus");
  const response = await callable({});
  return (response.data as { enabled?: boolean }).enabled === true;
}

export async function requestTestPush(functions: Functions): Promise<void> {
  const callable = httpsCallable(functions, "sendTestPush");
  await callable({});
}

export async function listenForForegroundPush(
  handler: (payload: MessagePayload) => void
): Promise<(() => void) | null> {
  const messaging = await getClientMessaging();
  return messaging ? onMessage(messaging, handler) : null;
}
