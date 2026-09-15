import { registerSW } from "virtual:pwa-register";

let started=false;
export function registerControlledServiceWorker() {
  if(started||!import.meta.env.PROD||!("serviceWorker" in navigator))return;
  started=true;
  let registration:ServiceWorkerRegistration|undefined;
  let previousController=navigator.serviceWorker.controller,activated=false;
  let prompt:Promise<typeof import("./pwa-update-prompt")>|undefined;
  const offerUpdate=(active=false)=>{
    activated ||= active;
    prompt ??= import("./pwa-update-prompt");
    void prompt.then(module=>module.showUpdatePrompt(registration,activated)).catch(()=>{prompt=undefined;});
  };
  registerSW({
    immediate:true,
    onNeedReload:()=>offerUpdate(true),
    onRegisteredSW(_swUrl,current){
      if(!current)return;
      registration=current;
      const offerWaiting=()=>{if(current.waiting&&navigator.serviceWorker.controller)offerUpdate();};
      offerWaiting();
      current.addEventListener("updatefound",()=>{
        const installing=current.installing;
        installing?.addEventListener("statechange",()=>{
          if(installing.state==="installed"&&navigator.serviceWorker.controller)offerUpdate();
        });
      });
      let updateCheckPending=false;
      const checkForUpdates=async()=>{
        if(document.visibilityState!=="visible"||updateCheckPending)return;
        updateCheckPending=true;
        try{await current.update();}
        catch{ /* 通信復旧後の画面復帰で再試行する。 */ }
        finally{updateCheckPending=false;offerWaiting();if(activated)offerUpdate(true);}
      };
      document.addEventListener("visibilitychange",checkForUpdates);
      void checkForUpdates();
    },
  });
  navigator.serviceWorker.addEventListener("controllerchange",()=>{
    const controller=navigator.serviceWorker.controller;
    if(!controller||controller===previousController)return;
    const wasControlled=!!previousController;
    previousController=controller;
    if(wasControlled)offerUpdate(true);
  });
}