import {targetHoldFixture} from "./case-mail-target-hold-harness.mjs";
import {setupChange} from "./case-mail-change-harness.mjs";
export async function targetResolutionFixture({assigned=true,kind="change",ready=true,native=false}={}) {
 const base=await setupChange(assigned);
 if(native){const m=base.job().mailIntake;base.records.delete(base.paths.candidate);base.records.delete(base.paths.receipt);base.records.delete("caseMailJobSources/"+m.sourceKey);base.job().mailIntake=null;
 // 対象メールの出典シードだけを残し、案件は通常取込案件として扱う。
 base.records.set(base.paths.candidate,{source:{partId:"body",rowKey:"row-1",unitIndex:0,sha256:"a".repeat(64)}});}
 base.input.makerName="変更後メーカー";
 const h=await targetHoldFixture(base),api=h.load("./case-mail-review");
 await h.hold({...h.holdCommand,kind});
 h.prepareResolution=async()=>{
   if(kind==="cancel"){await h.cancel();h.row[9]+="（キャンセル）";await h.reimport();}
   else{await h.edit({makerName:h.input.makerName});await h.runEdit();await h.reimport();}
 };
 h.resolutionCommand=async()=>({...h.targetRequest,reviewVersion:(await h.targetPreview()).resolution.reviewVersion,note:"原文・原本・担当を照合",confirmed:true});
 h.resolveTarget=async(data,auth=h.auth)=>api.resolveCaseMailTargetHold({auth,data:data??await h.resolutionCommand()});
 if(ready)await h.prepareResolution();
 return h;
}
