import { deleteToken, getToken, onMessage, MessagePayload } from "firebase/messaging";
import { Functions, httpsCallable } from "firebase/functions";
import { getClientMessaging } from "./firebase";

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

export async function refreshPushNotifications(
  functions: Functions,
  deviceSessionId = ""
): Promise<PushResult> {
  if (!('serviceWorker' in navigator) || currentPushPermission() !== "granted") {
    return {
      enabled: false,
      permission: currentPushPermission(),
      message: "端末の通知許可を確認してください。",
    };
  }
  const messaging = await getClientMessaging();
  if (!messaging) {
    return { enabled:false, permission:"unsupported", message:"このブラウザでは通知を利用できません。" };
  }
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
  if (!vapidKey) throw new Error("VITE_FIREBASE_VAPID_KEYが未設定です。");
  const registration = await navigator.serviceWorker.ready;
  const previousToken = await getToken(messaging, {
    vapidKey,
    serviceWorkerRegistration: registration,
  });
  if (previousToken) {
    const unregister = httpsCallable(functions, "unregisterPushToken");
    await unregister({ token: previousToken }).catch(() => undefined);
  }
  await deleteToken(messaging);
  return enablePushNotifications(functions, deviceSessionId);
}

export async function loadServerPushStatus(functions: Functions): Promise<boolean> {
  const callable = httpsCallable(functions, "getPushStatus");
  const response = await callable({});
  return (response.data as { enabled?: boolean }).enabled === true;
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
      const code = String((error as { code?: unknown }).code ?? "");
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
  const queueId = String((response.data as { queueId?: string }).queueId ?? "");
  if (!queueId) throw new Error("通知テストの受付結果を確認できません。");
  return queueId;
}

export async function loadTestPushStatus(
  functions: Functions,
  queueId: string
): Promise<PushTestStatus | null> {
  const callable = httpsCallable(functions, "getPushStatus");
  const response = await callable({ queueId });
  return (response.data as { test?: PushTestStatus }).test ?? null;
}

export async function listenForForegroundPush(
  handler: (payload: MessagePayload) => void
): Promise<(() => void) | null> {
  const messaging = await getClientMessaging();
  return messaging ? onMessage(messaging, (payload) => {
    void showForegroundSystemNotification(payload).catch(() => undefined);
    handler(payload);
  }) : null;
}

async function showForegroundSystemNotification(
  payload: MessagePayload
): Promise<void> {
  if (
    currentPushPermission() !== "granted" ||
    !("serviceWorker" in navigator)
  ) return;

  const data = payload.data ?? {};
  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification(data.title || "Lip Knots Crew", {
    body: data.body || "新しいお知らせがあります。",
    icon: "/logo.png",
    badge: "/logo.png",
    tag: data.category || "lkc-notification",
    data: { route: data.route || "/" },
  });
}
