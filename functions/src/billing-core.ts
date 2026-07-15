export type BillingStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "paused"
  | "cancelled";

export type BillingEventType =
  | "checkout.completed"
  | "subscription.created"
  | "subscription.updated"
  | "subscription.cancelled"
  | "invoice.paid"
  | "invoice.payment_failed";

export type BillingSubscription = {
  tenantId:string;
  planCode:"free"|"light"|"standard"|"pro";
  status:BillingStatus;
  currentPeriodEnd?:string|null;
  trialEnd?:string|null;
  cancelAtPeriodEnd?:boolean;
  failureCount:number;
};

export type BillingDecision = {
  tenantStatus:"trial"|"active"|"grace"|"suspended"|"cancelled";
  readOnly:boolean;
  reason:string;
  graceDays:number;
};

export function mapBillingToTenantStatus(
  subscription:BillingSubscription,
  nowIso:string
):BillingDecision {
  const now=Date.parse(nowIso);
  if(subscription.status==="cancelled"){
    return{tenantStatus:"cancelled",readOnly:true,reason:"契約終了",graceDays:0};
  }
  if(subscription.status==="unpaid"||subscription.status==="paused"){
    return{tenantStatus:"suspended",readOnly:true,reason:"支払停止",graceDays:0};
  }
  if(subscription.status==="past_due"){
    const graceDays=Math.min(14,Math.max(3,3+subscription.failureCount*2));
    return{tenantStatus:"grace",readOnly:false,reason:"支払猶予",graceDays};
  }
  if(subscription.status==="trialing"){
    if(subscription.trialEnd&&Date.parse(subscription.trialEnd)<now){
      return{tenantStatus:"grace",readOnly:false,reason:"体験終了・支払待ち",graceDays:3};
    }
    return{tenantStatus:"trial",readOnly:false,reason:"無料体験",graceDays:0};
  }
  return{tenantStatus:"active",readOnly:false,reason:"契約中",graceDays:0};
}

export function billingEventKey(input:{
  provider:string;
  eventId:string;
  tenantId?:string|null;
}):string{
  const safe=(value:string)=>value.replace(/[^A-Za-z0-9_-]/g,"_").slice(0,120);
  return`${safe(input.provider)}_${safe(input.eventId)}_${safe(input.tenantId??"unknown")}`;
}

export function nextPlanChange(input:{
  currentPlan:string;
  requestedPlan:string;
  effective:"immediate"|"period_end";
  hasUnpaidInvoice:boolean;
}):{allowed:boolean;mode:"upgrade"|"downgrade"|"same";reason:string}{
  const order=["free","light","standard","pro"];
  const current=order.indexOf(input.currentPlan);
  const requested=order.indexOf(input.requestedPlan);
  if(current<0||requested<0)return{allowed:false,mode:"same",reason:"プランが不正です。"};
  if(input.hasUnpaidInvoice)return{allowed:false,mode:"same",reason:"未払い請求があります。"};
  if(current===requested)return{allowed:false,mode:"same",reason:"同じプランです。"};
  const mode=requested>current?"upgrade":"downgrade";
  if(mode==="downgrade"&&input.effective==="immediate"){
    return{allowed:false,mode,reason:"ダウングレードは契約期間末のみです。"};
  }
  return{allowed:true,mode,reason:"変更可能"};
}
