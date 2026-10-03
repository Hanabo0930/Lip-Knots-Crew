import {targetHoldFixture} from "./case-mail-target-hold-harness.mjs";
import {setupChange} from "./case-mail-change-harness.mjs";
export async function targetResolutionFixture({assigned=true,kind="change",ready=true,native=false,legacyHash=false,paid=false,reorderedMap=false}={}) {
 const base=await setupChange(assigned);
 if(paid){base.row[16]="6500";base.row[17]="8000";base.row[37]="1200";base.reimport=async()=>{await new Promise(resolve=>setTimeout(resolve,3));return base.importRow({basePayColumns:["Q"],staffPaymentTotal:"R",purchase8:"AL"});};await base.reimport();}
 if(native){const m=base.job().mailIntake;base.records.delete(base.paths.candidate);base.records.delete(base.paths.receipt);base.records.delete("caseMailJobSources/"+m.sourceKey);base.job().mailIntake=null;
 // 対象メールの出典シードだけを残し、案件は通常取込案件として扱う。
 base.records.set(base.paths.candidate,{source:{partId:"body",rowKey:"row-1",unitIndex:0,sha256:"a".repeat(64)}});}
 base.input.makerName="変更後メーカー";
 const h=await targetHoldFixture(base),api=h.load("./case-mail-review");
 if(legacyHash){
   delete h.records.get("caseMailIntakeReceipts/"+h.targetReceiptId).analysisHash;
   if(reorderedMap){const candidate=h.records.get("caseMailIntakeCandidates/"+h.targetCandidateId);for(const key of ["source","input"])candidate[key]={...Object.fromEntries(Object.entries(candidate[key]).reverse()),unknownSyntheticField:"ignored by existing schema"};}
   delete h.records.get("caseMailIntakeCandidates/"+h.targetCandidateId).targetBinding;
   h.records.delete("auditLogs/"+h.key("case-mail-target",h.auth.token.companyId,h.targetReceiptId,h.targetCandidateId));
   await api.confirmCaseMailTarget({auth:h.auth,data:{...h.targetRequest,reviewVersion:(await h.targetPreview()).reviewVersion,note:"未保存hashの正規対応",confirmed:true}});
   h.holdCommand.reviewVersion=(await h.targetPreview()).reviewVersion;
 }
 await h.hold({...h.holdCommand,kind});
 h.prepareResolution=async()=>{
   if(kind==="cancel"){await h.cancel();h.row[1]="";h.row[2]="TRUE";h.row[3]=h.job().cancellationReason;h.row[9]+="（キャンセル）";await h.reimport();}
   else{await h.edit({makerName:h.input.makerName});await h.runEdit();await h.reimport();}
 };
 h.resolutionCommand=async()=>({...h.targetRequest,reviewVersion:(await h.targetPreview()).resolution.reviewVersion,note:"原文・原本・担当を照合",confirmed:true});
 h.resolveTarget=async(data,auth=h.auth)=>api.resolveCaseMailTargetHold({auth,data:data??await h.resolutionCommand()});
 if(ready)await h.prepareResolution();
 return h;
}
