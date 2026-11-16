/// <reference lib="webworker" />
export function notificationTarget(route:unknown,origin:string):string {
  const home=new URL("/",origin).href;
  if(typeof route!=="string")return home;
  try{const target=new URL(route,origin);return target.origin===origin&&["https:","http:"].includes(target.protocol)&&!target.username&&!target.password?target.href:home;}catch{return home;}
}
export async function openNotificationTarget(clients:Clients,target:string):Promise<void>{
  const url=new URL(target);
  const home=url.pathname==="/"&&!url.search&&!url.hash;
  const windows=await clients.matchAll({type:"window",includeUncontrolled:true}).catch(()=>[]);
  for(const candidate of windows){
    const client=candidate as WindowClient;
    try{
      const current=new URL(client.url);
      if(current.origin!==url.origin||(!home&&current.href!==url.href))continue;
      await client.focus();
      return;
    }catch{ /* The window may have closed. Try another matching window. */ }
  }
  await clients.openWindow(target);
}

const staffNoticeTitle = "Lip Knots Crew";
const staffNoticeBody = "アプリを開いて、対応事項を確認してください。";

export function staffSystemNotification(data?: Record<string, string>) {
  return {
    title: staffNoticeTitle,
    options: {
      body: staffNoticeBody,
      icon: "/logo.png",
      badge: "/logo.png",
      tag: data?.category || "lkc-notification",
      data: { route: data?.route || "/" },
    },
  };
}

export function staffForegroundNotice(
  data: Record<string, string> | undefined,
  scope: { companyId: string; staffId: string; uid: string },
): string | null {
  const { crewAudienceCompanyId: company, crewAudienceStaffId: staff, crewAudienceUid: uid } = data ?? {};
  if (company === undefined && staff === undefined && uid === undefined) return staffNoticeBody;
  if (company !== scope.companyId || (!staff && !uid) ||
      (staff && staff !== scope.staffId) || (uid && uid !== scope.uid)) return null;
  return (data?.title || staffNoticeTitle) + "：" + (data?.body || staffNoticeBody);
}
