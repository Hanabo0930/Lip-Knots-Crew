/// <reference lib="webworker" />
import { initializeApp } from "firebase/app";
import { getMessaging, onBackgroundMessage } from "firebase/messaging/sw";
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import {
  assertFirebaseConfiguration,
  firebaseConfig,
  firebaseConfigured,
} from "./firebase-config";

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<unknown> };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
self.skipWaiting();
clientsClaim();

assertFirebaseConfiguration();
const app = firebaseConfigured ? initializeApp(firebaseConfig) : null;
const messaging = app ? getMessaging(app) : null;

if (messaging) onBackgroundMessage(messaging, async (payload) => {
  const data = payload.data ?? {};
  const title = data.title || "Lip Knots Crew";
  await self.registration.showNotification(title, {
    body: data.body || "新しいお知らせがあります。",
    icon: "/logo.png",
    badge: "/logo.png",
    tag: data.category || "lkc-notification",
    data: { route: data.route || "/" },
    renotify: true,
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const route = String(event.notification.data?.route ?? "/");
  const target = new URL(route, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type:"window", includeUncontrolled:true });
    for (const client of windows) {
      if ("focus" in client) {
        await (client as WindowClient).focus();
        (client as WindowClient).navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
