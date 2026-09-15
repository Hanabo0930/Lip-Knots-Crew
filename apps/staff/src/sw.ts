/// <reference lib="webworker" />
import {notificationTarget,openNotificationTarget} from "./notification-target";
import { initializeApp } from "firebase/app";
import { getMessaging, onBackgroundMessage } from "firebase/messaging/sw";
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, precacheAndRoute, PrecacheController } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";
import {
  assertFirebaseConfiguration,
  firebaseConfig,
  firebaseConfigured,
} from "./firebase-config";

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{url:string;revision?:string|null}> };

const manifest=self.__WB_MANIFEST;
const isShell=(entry:{url:string})=>entry.url==="index.html"||entry.url==="/index.html";
const offlineShell=new PrecacheController({cacheName:"lkc-staff-offline-shell"});
offlineShell.addToCacheList(manifest.filter(isShell));
self.addEventListener("install",event=>{event.waitUntil(offlineShell.install(event));});
self.addEventListener("activate",event=>{event.waitUntil(offlineShell.activate(event));});
precacheAndRoute(manifest.filter(entry=>!isShell(entry)));
cleanupOutdatedCaches();

registerRoute(new NavigationRoute(new NetworkFirst({
  cacheName: "lkc-staff-pages",
  networkTimeoutSeconds: 10,
  fetchOptions:{cache:"no-cache"},
  plugins:[{handlerDidError:async()=>await offlineShell.matchPrecache("/index.html")??Response.error()}],
})));

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    void clientsClaim();
  }
});

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
  const target=notificationTarget(event.notification.data?.route,self.location.origin);
  event.waitUntil(openNotificationTarget(self.clients,target));
});
