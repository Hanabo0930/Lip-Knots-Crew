import type {ImportTargets} from "./import-snapshot";
import type {ImportSnapshotApi} from "./ImportSnapshotPanel";
export const importSnapshotDemoTargets:ImportTargets={version:1,kind:"recruitment.import-targets",companyId:"demo-company",sourceOperationId:"demo-source-operation",area:"normal",cases:[{fixedCaseId:"demo-fixed",workDate:"2099-09-20"}]};
export function createImportSnapshotDemo():ImportSnapshotApi{
 return {read:async targets=>{
  if(targets.companyId!=="demo-company")throw new Error("デモの所属が一致しません。");
  const records=targets.cases.map((target,index)=>{
   const jobId="demo-job-"+index,appCaseId="demo-case-"+index,spreadsheetId="demo-source";
   return {binding:{version:1,companyId:targets.companyId,jobId,appCaseId,spreadsheetId,fixedCaseId:target.fixedCaseId,workDate:target.workDate,revision:"demo-binding",assignment:null},
    job:{id:jobId,companyId:targets.companyId,caseId:appCaseId,dateKey:target.workDate,status:"open",assignedStaffId:null,publishable:true,revision:0,sheetRef:{spreadsheetId}},
    owner:{companyId:targets.companyId,jobId,spreadsheetId,fixedCaseId:target.fixedCaseId,revision:"demo-binding"}};
  });
  return {ok:true,snapshot:{version:1,companyId:targets.companyId,capturedAt:new Date().toISOString(),policy:{version:1,companyId:targets.companyId,revision:"demo-policy",phase:"mail_bridge",noticeOwner:"notice_control"},records},
   summary:records.map(record=>({fixedCaseId:record.binding.fixedCaseId,workDate:record.binding.workDate,jobId:record.job.id,appCaseId:record.job.caseId,storeName:"照合用のデモ店舗"})),dispatch:"disabled"};
 }};
}
