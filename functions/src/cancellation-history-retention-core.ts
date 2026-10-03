import {cancellationSheetWriteIdentity} from "./sheet-write-core";
import {hashText} from "./case-id";
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

type TargetEvidence={audit?:Data;candidate?:Data;receipt?:Data};
const identifier=(value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const digest=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
function millis(value:any):number|null {
  try {const result=value?.toMillis?.();return integer(result)?result:null;}catch{return null;}
}

/** Match the existing resolver's parsed CandidateSchema projection, independent of Firestore map key order. */
function legacyTargetAnalysisHash(receipt:Data|undefined,candidate:Data|undefined):string {
  const source=candidate?.source,input=candidate?.input;
  if(!source||!input||typeof source!=="object"||typeof input!=="object"||Array.isArray(source)||Array.isArray(input)||
    !digest(receipt?.sourceFingerprint)||!identifier(source.partId)||!digest(source.sha256)||
    typeof source.rowKey!=="string"||source.rowKey.length<1||source.rowKey.length>500||
    !integer(source.unitIndex)||source.unitIndex>99||
    ([["workDate",20],["clientName",200],["storeName",200],["makerName",200],["menuName",500],
      ["entryTime",100],["workTime",100]] as const).some(([key,max])=>typeof input[key]!=="string"||input[key].length>max)||
    typeof input.slots!=="number"||!Number.isFinite(input.slots)||
    !(input.basePay===null||(typeof input.basePay==="number"&&Number.isFinite(input.basePay)))||
    !["draft","immediate","scheduled"].includes(input.publicationMode)||
    !(input.publishAt===null||typeof input.publishAt==="string"))refuse();
  return hashText(JSON.stringify([receipt!.sourceFingerprint,
    {partId:source.partId,rowKey:source.rowKey,unitIndex:source.unitIndex,sha256:source.sha256},
    {workDate:input.workDate,clientName:input.clientName,storeName:input.storeName,makerName:input.makerName,
      menuName:input.menuName,entryTime:input.entryTime,workTime:input.workTime,slots:input.slots,basePay:input.basePay,
      publicationMode:input.publicationMode,publishAt:input.publishAt}]),64);
}
function targetResolution(old:Data|undefined,incoming:Data):Data|null {
  const saved=old?.cancellationSheetWrite,review=old?.mailTargetReview,hold=review?.hold,proof=saved?.sourceAckProof;
  if(!old||saved?.identity===cancellationSheetWriteIdentity(old)||old.mailTargetHold!=null||
    old.companyId!==incoming.companyId||old.sourceCancellationClosed!==true||old.cancelled!==true||old.status!=="cancelled"||
    typeof old.rawStaffName!=="string"||old.rawStaffName.trim()||!present(old.assignedStaffId)||
    saved?.sourceAckVersion!==1||saved.sourceAckPending!==false||!proof||review?.version!==1||hold?.version!==1||
    hold.kind!=="cancel"||review.companyId!==incoming.companyId||review.jobId!==incoming.jobId||
    ![review.companyId,review.jobId,review.receiptId,review.candidateId,review.actorUid].every(identifier)||
    !integer(review.receiptRevision)||review.receiptRevision<1||
    ![review.analysisHash,review.bindingVersion,review.reviewVersion].every(digest)||!present(review.note)||
    typeof review.originReviewRequired!=="boolean"||typeof hold.previousReviewRequired!=="boolean"||
    ["companyId","jobId","receiptId","candidateId","receiptRevision","analysisHash","bindingVersion"].some(key=>hold[key]!==review[key])||
    saved.identity!==proof.originalIdentity||saved.identity!==cancellationSheetWriteIdentity({...old,mailTargetHold:hold}))return null;
  return review;
}
/** Exact existing resolution records only; caller batches these reads inside the import transaction. */
export function cancellationHistoricalTargetRead(old:Data|undefined,incoming:Data) {
  const review=targetResolution(old,incoming);
  return review?{receiptId:review.receiptId as string,candidateId:review.candidateId as string,
    auditId:hashText(JSON.stringify(["case-mail-target-resolution",review.companyId,review.receiptId,
      review.candidateId,review.receiptRevision,review.analysisHash]),64)}:null;
}
/** Comparison-only historical context. Never persist this projection or replace the original acknowledgement. */
export function cancellationHistoricalTargetContext(old:Data|undefined,incoming:Data,
  evidence:TargetEvidence|undefined,readStartedAtMs:number):Data|undefined {
  const review=targetResolution(old,incoming);
  if(!review)return old;
  const hold=review.hold,proof=old!.cancellationSheetWrite.sourceAckProof;
  const requested=millis(hold.requestedAt),confirmed=millis(review.confirmedAt);
  const audit=evidence?.audit,candidate=evidence?.candidate,receipt=evidence?.receipt,binding=candidate?.targetBinding;
  const boundAt=millis(binding?.confirmedAt);
  const analysisHash=receipt?.analysisHash??legacyTargetAnalysisHash(receipt,candidate);
  if(requested===null||confirmed===null||!integer(readStartedAtMs)||
    !integer(old!.cancellationSheetWrite.sourceAckRequestedAtMs)||
    !integer(proof.readStartedAtMs)||!integer(proof.confirmedAtMs)||
    !(requested<=old!.cancellationSheetWrite.sourceAckRequestedAtMs&&
      old!.cancellationSheetWrite.sourceAckRequestedAtMs<proof.readStartedAtMs&&
      proof.readStartedAtMs<=proof.confirmedAtMs&&proof.confirmedAtMs<=confirmed&&confirmed<=readStartedAtMs)||
    !audit||audit.companyId!==review.companyId||audit.action!=="caseMail.target.resolve"||
    audit.actorUid!==review.actorUid||!same(audit.createdAt,review.confirmedAt)||!same(audit.resolution,review)||
    !candidate||candidate.version!==1||candidate.companyId!==review.companyId||
    candidate.receiptId!==review.receiptId||candidate.status!=="review"||candidate.linkedJobId||!same(candidate.targetResolution,review)||
    !integer(candidate.revision)||candidate.revision<1||candidate.heldChange!=null||
    !binding||binding.version!==1||binding.reviewVersion!==review.bindingVersion||
    binding.candidateRevision!==candidate.revision||
    ["companyId","jobId","receiptId","candidateId","receiptRevision"].some(key=>binding[key]!==review[key])||
    !identifier(binding.actorUid)||!present(binding.note)||boundAt===null||boundAt>requested||
    !receipt||receipt.version!==1||receipt.companyId!==review.companyId||
    receipt.revision!==review.receiptRevision||analysisHash!==review.analysisHash||
    receipt.heldAnalysisHash!=null||receipt.verification!=="verified"||receipt.structuralComplete!==true||
    receipt.status!=="review"||
    !Array.isArray(receipt.candidateIds)||receipt.candidateIds.filter((id:unknown)=>id===review.candidateId).length!==1||
    candidate.messageId!==receipt.messageId||!digest(receipt.sourceFingerprint)||candidate.sourceFingerprint!==receipt.sourceFingerprint||
    !identifier(candidate.source?.partId)||!digest(candidate.source?.sha256)||
    !Array.isArray(receipt.parts)||!receipt.parts.some((part:Data)=>part?.partId===candidate.source.partId&&part.sha256===candidate.source.sha256))refuse();
  return {...old,mailTargetHold:hold};
}
