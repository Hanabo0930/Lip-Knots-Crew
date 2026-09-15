/// <reference lib="webworker" />
export function notificationTarget(route:unknown,origin:string):string {
  const home=new URL("/",origin).href;
  if(typeof route!=="string")return home;
  try{const target=new URL(route,origin);return target.origin===origin&&["https:","http:"].includes(target.protocol)&&!target.username&&!target.password?target.href:home;}catch{return home;}
}
export async function openNotificationTarget(clients:Clients,target:string):Promise<void>{
  const windows=await clients.matchAll({type:"window",includeUncontrolled:true}).catch(()=>[]);
  for(const candidate of windows){
    const client=candidate as WindowClient;
    try{
      const navigated=await client.navigate(target);
      if(!navigated)continue;
      await navigated.focus().catch(()=>{});
      return;
    }catch{ /* 閉じられた画面などへの移動に失敗した場合は次を試す。 */ }
  }
  await clients.openWindow(target);
}
