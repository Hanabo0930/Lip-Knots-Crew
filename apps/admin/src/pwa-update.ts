import { registerSW } from "virtual:pwa-register";

const reloadKey = "lkc-admin-sw-reload";

export function registerControlledServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }

  let reloadTriggered = false;

  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      registration?.addEventListener("updatefound", () => {
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
    },
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadTriggered || sessionStorage.getItem(reloadKey)) {
      return;
    }
    reloadTriggered = true;
    sessionStorage.setItem(reloadKey, "1");
    window.location.reload();
  });
}
