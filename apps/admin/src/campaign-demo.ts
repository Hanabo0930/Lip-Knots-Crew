import type {CampaignApi} from "./CampaignRegistrationPanel";
import {campaignDigest,verifyMailCampaign,type CampaignRequest,type MailCampaign} from "./campaign-registration";
export async function campaignDemoSample():Promise<MailCampaign>{
  const body={contractVersion:1 as const,kind:"recruitment.campaign" as const,companyId:"demo-company",policyRevision:"demo-policy",sourceOperationId:"demo-source-operation",
    area:"normal" as const,cases:[{jobId:"demo-link-job",appCaseId:"demo-case",fixedCaseId:"demo-fixed",spreadsheetId:"demo-source",workDate:"2099-09-20",bindingRevision:"demo-binding",jobRevision:"0"}],
    sourceHash:"a".repeat(64),dispatch:"disabled" as const};
  return {...body,operationKey:await campaignDigest(["recruitment.campaign",body.companyId,body.policyRevision,body.sourceOperationId,body.area]),payloadHash:await campaignDigest(body)};
}
export function createCampaignDemo():CampaignApi{
  const events=new Map<string,{body:string;outcome:"cancelled"|"committed";result?:unknown}>(),records=new Map<string,{campaign:MailCampaign;result:unknown;evidence:string}>();
  const perform=async(input:CampaignRequest,cancel:boolean)=>{
    await verifyMailCampaign(input.campaign,"demo-company");
    const body=JSON.stringify(input),event=events.get(input.requestId);
    if(event&&event.body!==body)throw new Error("デモの登録内容が異なります。");
    if(event){
      if(cancel)return {ok:true,requestId:input.requestId,campaignKey:input.campaign.operationKey,outcome:event.outcome,result:event.result??null};
      if(event.outcome==="cancelled")throw new Error("この募集登録は中止されています。");return {...event.result as object,duplicate:true};
    }
    if(cancel){events.set(input.requestId,{body,outcome:"cancelled"});return {ok:true,requestId:input.requestId,campaignKey:input.campaign.operationKey,outcome:"cancelled",result:null};}
    const previous=records.get(input.campaign.operationKey);
    if(previous&&previous.campaign.payloadHash!==input.campaign.payloadHash)throw new Error("同じデモ募集に異なる内容があります。");
    const result=previous?{...previous.result as object,duplicate:true}:{ok:true,campaignKey:input.campaign.operationKey,caseCount:input.campaign.cases.length,
      registrationRevision:crypto.randomUUID(),duplicate:false,verificationMethod:"admin-source-confirmation",dispatch:"disabled"};
    if(!previous)records.set(input.campaign.operationKey,{campaign:input.campaign,result,evidence:input.evidenceRecordId});
    events.set(input.requestId,{body,outcome:"committed",result});return result;
  };
  return {preview:async campaign=>{
    await verifyMailCampaign(campaign,"demo-company");const previous=records.get(campaign.operationKey);
    if(previous&&previous.campaign.payloadHash!==campaign.payloadHash)throw new Error("同じデモ募集に異なる内容があります。");
    return {ok:true,campaignKey:campaign.operationKey,payloadHash:campaign.payloadHash,expectedPrincipalRevision:"demo-principal",
      alreadyRegistered:Boolean(previous),registeredResult:previous?{...previous.result as object,duplicate:true}:null,evidenceRecordId:previous?.evidence??null,
      cases:campaign.cases.map(row=>({...row,storeName:previous?null:"連携確認用のデモ店舗"})),dispatch:"disabled"};
  },register:input=>perform(input,false),cancel:input=>perform(input,true)};
}
