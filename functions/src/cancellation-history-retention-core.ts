import {cancellationSheetWriteIdentity} from "./sheet-write-core";
type Data=Record<string,any>;
const present=(value:unknown):value is string=>typeof value==="string"&&value.trim().length>0;
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
function refuse():never{throw new Error("取消の履歴担当と原本確認記録を照合できません。担当履歴と勤務枠を保持して停止しました。");}

/** Logical historical assignee only; never use this to occupy a cancelled day or fill a physical name cell. */
export function retainedCancellationAssignment(old:Data|undefined,incoming:Data,freshlyConfirmed:boolean){
  if(!old||old.sourceCancellationClosed!==true||old.status!=="cancelled"||old.cancelled!==true||
    incoming.status!=="cancelled"||incoming.cancelled!==true||!present(old.assignedStaffId))return null;
  const saved=old.cancellationSheetWrite,sheet=old.sheetRef,next=incoming.sheetRef;
  if(!present(old.assignedStaffName)||!saved||saved.sourceAckVersion!==1||
    ![true,false].includes(saved.sourceAckPending)||!integer(saved.sourceAckRequestedAtMs)||
    !integer(saved.sourceAckJobRevision)||!integer(old.revision)||saved.sourceAckJobRevision>old.revision||
    !present(saved.queueId)||!["job.cancel","job.cancel.v2"].includes(saved.operation)||
    saved.identity!==cancellationSheetWriteIdentity(old)||old.companyId!==incoming.companyId||
    !present(old.caseId)||old.caseId!==incoming.caseId||old.dateKey!==incoming.dateKey||old.workDate!==incoming.workDate||
    typeof incoming.rawStaffName!=="string"||incoming.rawStaffName.trim()||!sheet||!next||
    sheet.spreadsheetId!==next.spreadsheetId||sheet.sheetId!==next.sheetId||sheet.sheetName!==next.sheetName||
    sheet.caseIdColumn!==next.caseIdColumn||(sheet.caseIdColumn===undefined&&sheet.currentRow!==next.currentRow))refuse();
  // Blank/unmapped source text is not a cancellation correction. A conflicting nonblank reason needs review.
  if(present(incoming.cancellationReason)&&
    (!present(old.cancellationReason)||incoming.cancellationReason.trim()!==old.cancellationReason.trim()))refuse();
  if(freshlyConfirmed){
    if(saved.sourceAckPending!==true||saved.sourceAckJobRevision!==old.revision)refuse();
  }else{
    const proof=saved.sourceAckProof;
    if(saved.sourceAckPending!==false||!proof||proof.staffId!==old.assignedStaffId||proof.dateKey!==old.dateKey||
      proof.originalIdentity!==saved.identity||proof.originalRevision!==saved.sourceAckJobRevision||
      !integer(proof.readStartedAtMs)||proof.readStartedAtMs<=saved.sourceAckRequestedAtMs||
      !integer(proof.confirmedAtMs)||proof.confirmedAtMs<proof.readStartedAtMs||!present(proof.runId))refuse();
  }
  return {staffId:old.assignedStaffId as string,staffName:old.assignedStaffName as string};
}

/** The current restore queue does not write a cleared name back. Stop until explicit re-assignment is implemented. */
export function assertCancelledAssignmentCanRestore(job:Data){
  if(job.sourceCancellationClosed===true&&job.cancelled===true&&
    typeof job.rawStaffName==="string"&&!job.rawStaffName.trim()&&present(job.assignedStaffId)){
    throw new Error("取消後に氏名消去を確認済みです。履歴担当を再手配せず、明示的な再手配と氏名反映を確認してください。");
  }
}

/** Exact replay is handled before this guard. Keep the original proof intact until correction has an immutable history path. */
export function assertAcknowledgedCancellationCanChange(job:Data){
  if(job.sourceCancellationClosed===true&&job.cancelled===true&&job.status==="cancelled"&&
    typeof job.rawStaffName==="string"&&!job.rawStaffName.trim()&&present(job.assignedStaffId)){
    throw new Error("氏名消去確認済みの取消履歴は上書きできません。元の確認記録を保持して変更を停止しました。");
  }
}

/** Supplying even the same assignee currently writes the name/reoccupies the day; hold those edit paths too. */
export function assertCancelledHistoricalAssignmentCanEdit(job:Data,fields:Record<string,unknown>){
  if(["assignedStaffId","workDate","dateKey"].some(key=>Object.hasOwn(fields,key))){
    assertAcknowledgedCancellationCanChange(job);
  }
}
