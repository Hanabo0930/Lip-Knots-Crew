import "./pwa-update-prompt.css";

type PromptState={registration?:ServiceWorkerRegistration;active:boolean;button:HTMLButtonElement;error:HTMLParagraphElement;pending?:{worker:ServiceWorker;resolve:()=>void};busy:boolean;reloading:boolean};
let state:PromptState|undefined;

export function showUpdatePrompt(registration?:ServiceWorkerRegistration,active=false){
  if(!state){
    const notice=document.createElement("aside");notice.className="pwa-update-notice";notice.setAttribute("role","status");notice.setAttribute("aria-label","アプリの更新");
    const copy=document.createElement("div"),title=document.createElement("strong"),text=document.createElement("p"),error=document.createElement("p"),button=document.createElement("button");
    title.textContent="新しいバージョンを利用できます";text.textContent="入力の保存や送信を終えてから更新してください。";
    error.setAttribute("role","alert");error.className="pwa-update-error";button.type="button";button.textContent="画面を更新";
    copy.append(title,text,error);notice.append(copy,button);document.body.prepend(notice);
    state={registration,active,button,error,busy:false,reloading:false};
    button.addEventListener("click",()=>{void applyUpdate(state!);});
  }
  state.registration=registration??state.registration;state.active ||= active;
  if(active&&state.pending?.worker===navigator.serviceWorker.controller)state.pending.resolve();
}

async function applyUpdate(current:PromptState){
  if(current.busy||current.reloading)return;
  current.busy=true;current.button.setAttribute("aria-disabled","true");current.button.textContent="更新を準備中…";current.error.textContent="";
  try{
    const waiting=current.registration?.waiting;
    if(waiting){
      await new Promise<void>((resolve,reject)=>{
        const timer=window.setTimeout(()=>{current.pending=undefined;reject(new Error("activation timeout"));},15_000);
        current.pending={worker:waiting,resolve:()=>{window.clearTimeout(timer);current.pending=undefined;resolve();}};
        try{waiting.postMessage({type:"SKIP_WAITING"});}
        catch(error){window.clearTimeout(timer);current.pending=undefined;reject(error);}
      });
    }else if(!current.active){throw new Error("worker not ready");}
    current.reloading=true;current.button.textContent="画面を更新中…";
    // beforeunloadで更新を取り消した場合も、同じボタンから再試行できるようにする。
    window.setTimeout(()=>{current.reloading=false;current.button.removeAttribute("aria-disabled");current.button.textContent="画面を更新";},1500);
    window.location.reload();
  }catch{
    current.reloading=false;current.error.textContent="更新の準備を確認できませんでした。時間をおいて、もう一度お試しください。";
  }finally{
    current.busy=false;
    if(!current.reloading){current.button.removeAttribute("aria-disabled");current.button.textContent="画面を更新";}
  }
}