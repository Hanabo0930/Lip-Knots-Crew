export const TEMPLATES=[
{code:"sampling",name:"試食販売",modules:["staff","jobs","billing","payroll"],fields:["検便期限","メーカー","店舗","試食商品"],workflow:["募集","応募","確定","実施","報告","請求"]},
{code:"event",name:"イベント",modules:["staff","jobs","training","billing"],fields:["衣装サイズ","会場"],workflow:["募集","選考","研修","実施"]},
{code:"cleaning",name:"清掃",modules:["staff","jobs","inventory","shipping"],fields:["鍵番号","清掃種別"],workflow:["依頼","割当","作業","写真","承認"]},
{code:"logistics",name:"物流",modules:["staff","jobs","inventory","shipping","analytics"],fields:["温度帯","配送会社"],workflow:["受注","入庫","ピッキング","発送","完了"]},
];
export function cloneIndustryTemplate(code:string,tenantId:string){
 const t=TEMPLATES.find(x=>x.code===code);if(!t)throw new Error("template not found");
 return{tenantId,templateCode:code,modules:[...t.modules],fields:[...t.fields],workflow:[...t.workflow]};
}
