import { registerSW } from "virtual:pwa-register";

const reloadKey = "lkc-admin-sw-reload";
const RELOAD_GUARD_MS = 15_000;

function activateWaitingWorker(registration: ServiceWorkerRegistration) {
  if (registration.waiting && navigator.serviceWorker.controller) {
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  }
}

export function registerControlledServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }

  let reloadTriggered = false;

  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      activateWaitingWorker(registration);
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", () => {
          if (
            installing.state === "installed"
            && navigator.serviceWorker.controller
          ) {
            installing.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
      const checkForUpdates = () => {
        if (document.visibilityState === "visible") {
          void registration.update().catch(() => undefined);
        }
      };
      document.addEventListener("visibilitychange", checkForUpdates);
      void registration.update().catch(() => undefined);
    },
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const lastReloadAt = Number(sessionStorage.getItem(reloadKey) ?? "0");
    if (
      reloadTriggered
      || (Number.isFinite(lastReloadAt) && Date.now() - lastReloadAt < RELOAD_GUARD_MS)
    ) {
      return;
    }
    reloadTriggered = true;
    sessionStorage.setItem(reloadKey, String(Date.now()));
    window.location.reload();
  });
}
