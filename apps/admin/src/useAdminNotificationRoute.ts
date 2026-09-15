import {useEffect,useRef,useState} from "react";
export function adminNotificationJobId(path:string):string|null {
  const match=/^\/admin\/jobs\/([^/]+)\/?$/.exec(path);
  if(!match)return null;
  try{const id=decodeURIComponent(match[1]);return id.trim().length>0&&id!=="."&&id!==".."&&!/[\/\\\u0000-\u001f\u007f]/.test(id)?id:null;}catch{return null;}
}
export function useAdminNotificationRoute<T>({ready,scope,load,onOpen,parse=adminNotificationJobId}:{ready:boolean;scope:string;load:(id:string)=>Promise<T|null>;onOpen:(job:T)=>void|boolean;parse?:(path:string)=>string|null}){
  const [jobId,setJobId]=useState(()=>parse(window.location.pathname));
  const [status,setStatus]=useState<"idle"|"loading"|"error"|"unavailable"|"paused">("idle");
  const version=useRef(0),pending=useRef(false),liveScope=useRef(scope);liveScope.current=scope;
  function cancel(){version.current++;pending.current=false;setJobId(null);setStatus("idle");if(parse(window.location.pathname))window.history.replaceState(null,"","/"+window.location.search+window.location.hash);}
  async function retry(){
    if(!ready||!jobId||pending.current)return;
    const current=++version.current,owner=scope;pending.current=true;setStatus("loading");
    const isCurrent=()=>current===version.current&&owner===liveScope.current;
    try{const job=await load(jobId);if(!isCurrent())return;if(!job){setStatus("unavailable");return;}if(onOpen(job)===false){setStatus("paused");return;}cancel();}
    catch{if(isCurrent())setStatus("error");}
    finally{if(isCurrent())pending.current=false;}
  }
  useEffect(()=>{version.current++;pending.current=false;setStatus("idle");const current=version.current;if(ready&&jobId)void Promise.resolve().then(()=>{if(current===version.current)void retry();});return()=>{version.current++;pending.current=false;};},[ready,scope,jobId]);
  return {status,retry,cancel};
}
