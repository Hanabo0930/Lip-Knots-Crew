/// <reference lib="webworker" />
import {notificationTarget,openNotificationTarget,staffSystemNotification} from "./notification-target";
import { initializeApp } from "firebase/app";
import { getMessaging, onBackgroundMessage } from "firebase/messaging/sw";
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, PrecacheController, PrecacheRoute, type PrecacheEntry } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";
import {
  assertFirebaseConfiguration,
  firebaseConfig,
  firebaseConfigured,
} from "./firebase-config";

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<string | PrecacheEntry> };

const manifest=self.__WB_MANIFEST;
const isShell=(entry:string | PrecacheEntry)=>typeof entry!=="string"&&(entry.url==="index.html"||entry.url==="/index.html");
const offlineShell=new PrecacheController({cacheName:"lkc-staff-offline-shell"});
offlineShell.addToCacheList(manifest.filter(isShell));
self.addEventListener("install",event=>{event.waitUntil(offlineShell.install(event));});
self.addEventListener("activate",event=>{event.waitUntil(offlineShell.activate(event));});
const staticAssets = new PrecacheController();
staticAssets.addToCacheList(manifest.filter(entry => !isShell(entry)));
const assetHistoryKey = new URL(".lkc-staff-asset-generations", self.registration.scope).href;

function isHashedAsset(url: URL): boolean {
  return url.origin === self.location.origin && !url.search && !url.hash &&
    /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/u.test(url.pathname);
}

function assetKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(key => typeof key === "string")) return null;
  try {
    return value.every(key => isHashedAsset(new URL(key))) ? value : null;
  } catch {
    return null;
  }
}

async function activateStaticAssets(): Promise<void> {
  const cache = await caches.open(staticAssets.strategy.cacheName);
  const requests = await cache.keys();
  const currentKeys = new Set(staticAssets.getURLsToCacheKeys().values());
  const current = [...currentKeys].filter(key => isHashedAsset(new URL(key))).sort();
  const saved = await (await cache.match(assetHistoryKey))?.json().catch(() => null);
  const last = assetKeys(saved?.current);
  const sameVersion = last?.length === current.length && last.every((key, index) => key === current[index]);
  // An SW-only change must not discard assets that are still used by a tab on the preceding app build.
  const previous = (sameVersion ? assetKeys(saved?.previous) : last) ??
    requests.map(request => request.url).filter(key => isHashedAsset(new URL(key)));
  const retained = previous.filter(key => !currentKeys.has(key)).sort();
  const keep = new Set([...currentKeys, ...retained, assetHistoryKey]);

  // If the history cannot be persisted, leave the existing cache readable.
  await cache.put(assetHistoryKey, new Response(JSON.stringify({ current, previous: retained })));
  for (const request of requests) {
    if (!keep.has(request.url)) await cache.delete(request);
  }
}

self.addEventListener("install", event => { event.waitUntil(staticAssets.install(event)); });
self.addEventListener("activate", event => {
  event.waitUntil(activateStaticAssets().catch(() => {
    console.warn("スタッフ画面の更新時にキャッシュを整理できませんでした。");
  }));
});
registerRoute(new PrecacheRoute(staticAssets));
registerRoute(({ url }) => isHashedAsset(url), async ({ request }) => {
  const cached = await caches.open(staticAssets.strategy.cacheName)
    .then(cache => cache.match(request)).catch(() => undefined);
  return cached ?? fetch(request);
});
cleanupOutdatedCaches();

// Navigation HTML is the same SPA shell for every query. Never persist
// email-link codes or other query values as CacheStorage keys.
self.addEventListener('activate',event=>{event.waitUntil((async()=>{
  const pages=await caches.open('lkc-staff-pages');
  for(const request of await pages.keys()){
    if(new URL(request.url).search)await pages.delete(request);
  }
})());});
const navigation = new NetworkFirst({
  cacheName: "lkc-staff-pages",
  networkTimeoutSeconds: 10,
  fetchOptions:{cache:"no-cache"},
  plugins:[{cacheKeyWillBeUsed:async({request})=>{
    const key=new URL(request.url);key.search='';key.hash='';return key.href;
  }},{handlerDidError:async()=>await offlineShell.matchPrecache("/index.html")??Response.error()}],
});
registerRoute(new NavigationRoute(options => {
  const [response, cacheDone] = navigation.handleAll(options);
  // キャッシュが書き込めなくても、取得できたページはそのまま返す。
  options.event.waitUntil(cacheDone.catch(() => {
    console.warn("ページのオフライン保存に失敗しました。");
  }));
  return response;
}));

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
  const { title, options } = staffSystemNotification(payload.data);
  await self.registration.showNotification(title, { ...options, renotify: true } as NotificationOptions);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target=notificationTarget(event.notification.data?.route,self.location.origin);
  event.waitUntil(openNotificationTarget(self.clients,target));
});
