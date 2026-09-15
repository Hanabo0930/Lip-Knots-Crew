import {createHash} from "node:crypto";
import {z} from "zod";
import {prepareCaseMailCampaign} from "./automation-bridge-module.mjs";
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const instant=z.string().refine(value=>{const date=new Date(value);return Number.isFinite(date.valueOf())&&date.toISOString()===value;});
const row=z.record(z.unknown()),day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{const date=new Date(value+"T00:00:00Z");return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value;});
const draft=z.object({state:z.literal("PREVIEW"),operationId:id,area:z.enum(["normal","tohoku"]),cases:z.array(row).min(1).max(100),
 snapshot:z.string().max(4*1024*1024),addresses:row,subject:z.string().refine(value=>Boolean(value.trim())&&!/[\r\n]/.test(value)),body:z.string().refine(value=>Boolean(value.trim())),
 template:z.object({verified:z.literal(true),source:z.string().min(1)}).passthrough()}).passthrough();
const SourceSchema=z.object({version:z.literal(1),companyId:id,capturedAt:instant,draft,rows:z.array(row).max(10000),staff:z.array(row).max(10000)}).strict();
const AppSchema=z.object({version:z.literal(1),companyId:id,capturedAt:instant,policy:row,
 records:z.array(z.object({binding:row,job:row,owner:row}).strict()).min(1).max(100)}).strict();
const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class CaseMailImportError extends Error{
 constructor(code,message){super(message);this.name="CaseMailImportError";this.code=code;}
}
const fail=(code,message)=>{throw new CaseMailImportError(code,message);};
/** 読取済みスナップショットの照合。本人認証や実原本の取得・登録・配信は行わない。 */
function checkedSource(source,runtime,now){
 if(!Number.isFinite(now.valueOf()))fail("invalid_clock","現在の日付を確認できません。");
 const parsedSource=SourceSchema.safeParse(source);
 if(!parsedSource.success)fail("source_shape","外部募集の受け渡し形式を確認してください。確認済み書式のPREVIEW状態・100枠までが対象です。");
 const src=parsedSource.data;
 const today=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
 let sourceState;
 try{sourceState=runtime.validateDraft({draft:src.draft,rows:src.rows,staff:src.staff,today});}
 catch{fail("source_validation","外部の最新変換コードで募集を照合できません。元の募集と読み取ったデータを確認してください。");}
 if(sourceState==="inconsistent")fail("draft_inconsistent","募集案の案件・宛先と保存された確認内容が一致しません。元の募集案を確認してください。");
 if(sourceState!=="valid")fail("source_changed","募集案の作成後に案件・宛先・確認待ち条件が変わっています。原文を保持し、案件メール側で再照合してください。");
 return {src,today};
}
const canonicalSource=value=>Array.isArray(value)?"["+value.map(canonicalSource).join(",")+"]":value!==null&&typeof value==="object"?"{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonicalSource(value[key])).join(",")+"}":JSON.stringify(value);
export function prepareCaseMailTargets({source,runtime,now=new Date()}){
 const {src}=checkedSource(source,runtime,now);
 const cases=src.draft.cases.map(row=>{
  if(!id.safeParse(row.id).success||!day.safeParse(row.day).success)fail("target_shape","募集対象の固定IDと勤務日を確認してください。");
  return {fixedCaseId:row.id,workDate:row.day};
 });
 if(new Set(cases.map(row=>row.fixedCaseId)).size!==cases.length)fail("target_shape","同じ固定IDが複数の募集枠に含まれています。");
 const targets={version:1,kind:"recruitment.import-targets",companyId:src.companyId,sourceOperationId:src.draft.operationId,area:src.draft.area,cases};
 return {targets,importSource:{version:1,kind:"recruitment.import-source",targets,sourceHash:createHash("sha256").update(canonicalSource(src.draft)).digest("hex"),sourceCapturedAt:src.capturedAt},
  review:{version:1,kind:"recruitment.targets-review",companyId:src.companyId,createdAt:now.toISOString(),sourceCapturedAt:src.capturedAt,
   sourceSnapshotHash:digest(source),externalCodeVersions:{...runtime.versions},checkMethod:"local-snapshot-comparison",
   sourceAuthenticationVerified:false,registrationRequired:true,dispatch:"disabled"}};
}
export function prepareCaseMailImport({source,app,runtime,now=new Date()}){
 const {src,today}=checkedSource(source,runtime,now),parsedApp=AppSchema.safeParse(app);
 if(!parsedApp.success)fail("app_shape","アプリの受付設定・案件・固定ID所有記録のスナップショットを確認してください。");
 const local=parsedApp.data;
 if(src.companyId!==local.companyId)fail("company_mismatch","外部募集とアプリの所属が一致しません。");

 const records=local.records.map(record=>{
  const {binding,job,owner}=record;
  if(binding.companyId!==local.companyId||job.companyId!==local.companyId||owner.companyId!==local.companyId)
   fail("company_mismatch","スナップショットに別の所属の記録が含まれています。");
  if(owner.jobId!==binding.jobId||owner.spreadsheetId!==binding.spreadsheetId||owner.fixedCaseId!==binding.fixedCaseId||owner.revision!==binding.revision)
   fail("binding_owner","固定IDと案件の所有記録が一致しません。");
  if(!Number.isSafeInteger(job.revision??0)||(job.revision??0)<0)fail("job_revision","案件の現在版を確認できません。");
  return {binding,job,revision:String(job.revision??0)};
 });
 let campaign;
 try{campaign=prepareCaseMailCampaign({companyId:local.companyId,policy:local.policy,draft:src.draft,records,sourceValidation:{ok:true,reasons:[]}});}
 catch{fail("app_mismatch","募集とアプリの案件・固定ID・勤務日・受付版が一致しないか、現在は募集できません。");}
 for(const target of campaign.cases)if(!day.safeParse(target.workDate).success||target.workDate<=today)
  fail("work_date","募集対象の勤務日を確認してください。案件メール側の翌日以降の条件に合わせます。");
 const text=JSON.stringify(campaign,null,2)+"\n";
 if(Buffer.byteLength(text)>262144)fail("output_size","募集の取込用データが256 KiBを超えています。元の募集の分割方針を確認してください。");
 return {campaign,review:{version:1,kind:"recruitment.import-review",companyId:local.companyId,createdAt:now.toISOString(),
   sourceCapturedAt:src.capturedAt,appCapturedAt:local.capturedAt,sourceSnapshotHash:digest(source),appSnapshotHash:digest(app),
   externalCodeVersions:{...runtime.versions},sourceOperationId:campaign.sourceOperationId,area:campaign.area,
   campaignKey:campaign.operationKey,payloadHash:campaign.payloadHash,caseCount:campaign.cases.length,
   checkMethod:"local-snapshot-comparison",registrationRequired:true,sourceAuthenticationVerified:false,dispatch:"disabled"},
  campaignText:text};
}
