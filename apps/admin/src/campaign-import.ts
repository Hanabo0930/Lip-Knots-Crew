import {IMPORT_TARGET_LIMIT,importTargets,parseImportTargetsText,appImportSnapshotResult,type ImportTargets,type ImportSnapshotResult} from "./import-snapshot";
import {campaignDigest,verifyMailCampaign,type MailCampaign} from "./campaign-registration";
export type CampaignImportSource={targets:ImportTargets;sourceHash:string|null;sourceCapturedAt:string|null};
export function parseCampaignImportText(text:string,companyId:string):CampaignImportSource{
 if(new TextEncoder().encode(text).byteLength>IMPORT_TARGET_LIMIT)throw new Error("募集対象のファイルは256 KiB以下・100枠までにしてください。");
 let value:unknown;try{value=JSON.parse(text.replace(/^\uFEFF/,""));}catch{return {targets:parseImportTargetsText(text,companyId),sourceHash:null,sourceCapturedAt:null};}
 if(!value||typeof value!=="object"||Array.isArray(value)||(value as Record<string,unknown>).kind!=="recruitment.import-source")
  return {targets:importTargets(value,companyId),sourceHash:null,sourceCapturedAt:null};
 const row=value as Record<string,unknown>,keys=["version","kind","targets","sourceHash","sourceCapturedAt"];
 if(row.version!==1||Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key))||
   typeof row.sourceHash!=="string"||!/^[a-f0-9]{64}$/.test(row.sourceHash)||typeof row.sourceCapturedAt!=="string"||
   !Number.isFinite(Date.parse(row.sourceCapturedAt))||new Date(row.sourceCapturedAt).toISOString()!==row.sourceCapturedAt)
  throw new Error("募集の元記録を確認できません。案件メール側で生成した連携ファイルを選んでください。");
 return {targets:importTargets(row.targets,companyId),sourceHash:row.sourceHash,sourceCapturedAt:row.sourceCapturedAt};
}
export async function campaignFromImport(source:CampaignImportSource,result:ImportSnapshotResult,companyId:string,now=new Date()):Promise<MailCampaign>{
 if(!source.sourceHash)throw new Error("この旧形式には元募集の確認情報がありません。案件メール側で新しい連携ファイルを生成してください。");
 const checkedSource=parseCampaignImportText(JSON.stringify({version:1,kind:"recruitment.import-source",targets:source.targets,sourceHash:source.sourceHash,sourceCapturedAt:source.sourceCapturedAt}),companyId);
 const checked=appImportSnapshotResult({ok:true,...result,dispatch:"disabled"},checkedSource.targets);
 if(!Number.isFinite(now.valueOf()))throw new Error("現在の日付を確認できません。");
 const today=new Date(now.valueOf()+9*60*60*1000).toISOString().slice(0,10);
 if(checkedSource.targets.cases.some(row=>row.workDate<=today))throw new Error("募集対象は翌日以降の案件にしてください。元の募集案を確認してください。");
 const cases=checked.snapshot.records.map(({binding,job})=>({jobId:binding.jobId as string,appCaseId:binding.appCaseId as string,
  fixedCaseId:binding.fixedCaseId as string,spreadsheetId:binding.spreadsheetId as string,workDate:binding.workDate as string,
  bindingRevision:binding.revision as string,jobRevision:String(job.revision)}));
 const body={contractVersion:1 as const,kind:"recruitment.campaign" as const,companyId,policyRevision:checked.snapshot.policy.revision as string,
  sourceOperationId:checkedSource.targets.sourceOperationId,area:checkedSource.targets.area,cases,sourceHash:checkedSource.sourceHash!,dispatch:"disabled" as const};
 return verifyMailCampaign({...body,operationKey:await campaignDigest(["recruitment.campaign",companyId,body.policyRevision,body.sourceOperationId,body.area]),payloadHash:await campaignDigest(body)},companyId);
}
