import {registryId} from "./automation-registry-attempt";
export type ImportTargets={version:1;kind:"recruitment.import-targets";companyId:string;sourceOperationId:string;area:"normal"|"tohoku";cases:{fixedCaseId:string;workDate:string}[]};
export type AppImportSnapshot={version:1;companyId:string;capturedAt:string;policy:Record<string,unknown>;records:{binding:Record<string,unknown>;job:Record<string,unknown>;owner:Record<string,unknown>}[]};
export type ImportSnapshotResult={snapshot:AppImportSnapshot;summary:{fixedCaseId:string;workDate:string;jobId:string;appCaseId:string;storeName:string|null}[]};
export const IMPORT_TARGET_LIMIT=262144;
const fail=()=>new Error("募集対象とアプリの照合データが一致しません。元の対象ファイルと連携台帳を確認してください。");
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=="object"||Array.isArray(value))throw fail();return value as Record<string,unknown>;};
function keys(row:Record<string,unknown>,allowed:string[],required=allowed){if(Object.keys(row).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(row,key)))throw fail();}
function day(value:unknown):value is string{if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+"T00:00:00Z");return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value;}
export function importTargets(value:unknown,companyId:string):ImportTargets{
 const row=object(value);keys(row,["version","kind","companyId","sourceOperationId","area","cases"]);
 if(row.version!==1||row.kind!=="recruitment.import-targets"||row.companyId!==companyId||!registryId(row.companyId)||!registryId(row.sourceOperationId)||
   (row.area!=="normal"&&row.area!=="tohoku")||!Array.isArray(row.cases)||row.cases.length<1||row.cases.length>100)throw fail();
 const cases=row.cases.map(value=>{const target=object(value);keys(target,["fixedCaseId","workDate"]);if(!registryId(target.fixedCaseId)||!day(target.workDate))throw fail();return {fixedCaseId:target.fixedCaseId,workDate:target.workDate};});
 if(new Set(cases.map(row=>row.fixedCaseId)).size!==cases.length)throw fail();
 return {version:1,kind:"recruitment.import-targets",companyId,sourceOperationId:row.sourceOperationId,area:row.area,cases};
}
export function parseImportTargetsText(text:string,companyId:string){
 if(new TextEncoder().encode(text).byteLength>IMPORT_TARGET_LIMIT)throw new Error("募集対象のファイルは256 KiB以下・100枠までにしてください。");
 let value:unknown;try{value=JSON.parse(text.replace(/^\uFEFF/,""));}catch{throw new Error("対象ファイルをJSONとして読み取れません。連携用のtargets.jsonを選んでください。");}
 return importTargets(value,companyId);
}
export function appImportSnapshotResult(value:unknown,targets:ImportTargets):ImportSnapshotResult{
 const row=object(value);if(row.ok!==true||row.dispatch!=="disabled")throw fail();
 const source=object(row.snapshot);keys(source,["version","companyId","capturedAt","policy","records"]);
 if(source.version!==1||source.companyId!==targets.companyId||typeof source.capturedAt!=="string"||
  !Number.isFinite(new Date(source.capturedAt).valueOf())||new Date(source.capturedAt).toISOString()!==source.capturedAt||
  !Array.isArray(source.records)||source.records.length!==targets.cases.length||!Array.isArray(row.summary)||row.summary.length!==targets.cases.length)throw fail();
 const policy=object(source.policy);keys(policy,["version","companyId","revision","phase","noticeOwner"]);
 if(policy.version!==1||policy.companyId!==targets.companyId||!registryId(policy.revision)||policy.phase!=="mail_bridge"||policy.noticeOwner!=="notice_control")throw fail();
 const records:AppImportSnapshot["records"]=source.records.map((value,index)=>{
  const item=object(value);keys(item,["binding","job","owner"]);const binding=object(item.binding),job=object(item.job),owner=object(item.owner),target=targets.cases[index]!;
  keys(binding,["version","companyId","jobId","appCaseId","spreadsheetId","fixedCaseId","workDate","revision","assignment"]);
  if(binding.version!==1||binding.companyId!==targets.companyId||binding.fixedCaseId!==target.fixedCaseId||binding.workDate!==target.workDate||binding.assignment!==null)throw fail();
  for(const key of ["jobId","appCaseId","spreadsheetId","revision"])if(!registryId(binding[key]))throw fail();
  keys(owner,["companyId","jobId","spreadsheetId","fixedCaseId","revision"]);
  for(const key of ["companyId","jobId","spreadsheetId","fixedCaseId","revision"])if(owner[key]!==binding[key])throw fail();
  const required=["id","companyId","caseId","dateKey","status","assignedStaffId","publishable","revision","sheetRef"],flags=["cancelled","recruitmentStopped","sourceMissing","assignmentUnresolved","applicationUnconfirmed"];
  keys(job,[...required,...flags],required);
  if(job.id!==binding.jobId||job.companyId!==targets.companyId||job.caseId!==binding.appCaseId||job.dateKey!==target.workDate||
    job.status!=="open"||job.assignedStaffId!==null||job.publishable!==true||!Number.isSafeInteger(job.revision)||(job.revision as number)<0)throw fail();
  for(const flag of flags)if(job[flag]!==undefined&&job[flag]!==false)throw fail();
  const sheet=object(job.sheetRef);keys(sheet,["spreadsheetId"]);if(sheet.spreadsheetId!==binding.spreadsheetId)throw fail();
  return {binding:{...binding},job:{...job,sheetRef:{...sheet}},owner:{...owner}};
 });
 if(new Set(records.map(record=>record.job.id)).size!==records.length)throw fail();
 const summary=row.summary.map((value,index)=>{
  const item=object(value);keys(item,["fixedCaseId","workDate","jobId","appCaseId","storeName"]);const target=targets.cases[index]!,record=records[index]!;
  if(item.fixedCaseId!==target.fixedCaseId||item.workDate!==target.workDate||item.jobId!==record.job.id||item.appCaseId!==record.job.caseId||
    (item.storeName!==null&&(typeof item.storeName!=="string"||item.storeName.length>200)))throw fail();
  return {fixedCaseId:target.fixedCaseId,workDate:target.workDate,jobId:item.jobId as string,appCaseId:item.appCaseId as string,storeName:item.storeName as string|null};
 });
 return {snapshot:{version:1,companyId:targets.companyId,capturedAt:source.capturedAt,policy:{...policy},records},summary};
}
