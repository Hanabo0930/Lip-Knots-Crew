import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { assertProductionOperational } from "./system-safety";
import { requireAdmin, companyFromClaims } from "./utils";
import { caseMailRecordKey } from "./case-mail-job-creation";
import { normalizeJobInput } from "./job-management-core";
import { caseMailTargetReader } from "./case-mail-collision";
import { caseMailTargetHoldPatch } from "./case-mail-target-hold";
import { readCaseMailResolution } from "./case-mail-resolution";
import { caseMailReviewAccepted, caseMailResolutionIssue } from "./case-mail-resolution-core";
import { assignmentPreparationPatch } from "./assignment-preparation-core";
import { adminEditValueMatches, type EditSourceSnapshot } from "./admin-edit-state-core";
import { splitMenuConditions } from "./shift-parser";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const ScopeSchema = z.object({ expectedCompanyId: id, expectedActorUid: id });
const ListSchema = ScopeSchema.extend({ cursor: id.optional() }).strict();
const DetailSchema = ScopeSchema.extend({ receiptId: id }).strict();
const ReceiptSchema = z.object({
  version: z.literal(1), companyId: id, messageId: id, revision,
  status: z.enum(["ready", "review", "cancelled"]), receivedAt: z.string().max(50).optional(),
  candidateIds: z.array(id).max(200), issues: z.array(z.string().max(500)).max(100).default([]),
  verification: z.string(), structuralComplete: z.boolean(), kind: z.string(),
  sourceFingerprint: hash, ingestedBy: id, producerId: id, principalRevision: id,
  parts: z.array(z.object({ partId: id, sha256: hash })).max(500),
});
const CandidateSchema = z.object({
  version: z.literal(1), companyId: id, receiptId: id, messageId: id, revision,
  status: z.enum(["ready", "review", "linked", "cancelled"]), sourceFingerprint: hash,
  source: z.object({ partId: id, rowKey: z.string().min(1).max(500), unitIndex: z.number().int().min(0).max(99), sha256: hash }),
  input: z.object({ workDate: z.string().max(20), clientName: z.string().max(200), storeName: z.string().max(200),
    makerName: z.string().max(200), menuName: z.string().max(500), entryTime: z.string().max(100),
    workTime: z.string().max(100), slots: z.number(), basePay: z.number().nullable(), publicationMode: z.enum(["draft", "immediate", "scheduled"]),
    publishAt: z.string().nullable() }),
  linkedJobId: id.optional(),
});
function fail(): never { throw new HttpsError("failed-precondition", "受信記録の状態が変わったか、照合できない項目があります。最新の内容を確認してください。"); }
function scope(input: z.infer<typeof ScopeSchema>, companyId: string, uid: string) {
  if (input.expectedCompanyId !== companyId || input.expectedActorUid !== uid) {
    throw new HttpsError("failed-precondition", "ログイン情報が変更されています。画面を開き直してください。");
  }
}
function receipt(raw: unknown, companyId: string) {
  const parsed = ReceiptSchema.safeParse(raw);
  if (!parsed.success || parsed.data.companyId !== companyId ||
      new Set(parsed.data.candidateIds).size !== parsed.data.candidateIds.length ||
      new Set(parsed.data.parts.map(part => part.partId)).size !== parsed.data.parts.length) fail();
  return parsed.data;
}
function summary(receiptId: string, record: z.infer<typeof ReceiptSchema>) {
  return { receiptId, revision: record.revision, status: record.status, receivedAt: record.receivedAt ?? null,
    candidateCount: record.candidateIds.length, issues: record.issues };
}
export const listCaseMailReceipts = onCall(async request => {
  const session = requireAdmin(request), companyId = id.parse(companyFromClaims(session.token));
  const input = ListSchema.parse(request.data); scope(input, companyId, session.uid);
  let query = db.collection("caseMailIntakeReceipts").where("companyId", "==", companyId)
    .orderBy(FieldPath.documentId()).limit(26);
  if (input.cursor) query = query.startAfter(input.cursor);
  return db.runTransaction(async tx => {
    const page = await tx.get(query);
    const items = page.docs.slice(0, 25).map(doc => summary(doc.id, receipt(doc.data(), companyId)));
    return { ok: true, items, nextCursor: page.docs.length > 25 ? items.at(-1)!.receiptId : null };
  });
});
export const getCaseMailReceipt = onCall(async request => {
  const session = requireAdmin(request), companyId = id.parse(companyFromClaims(session.token));
  const input = DetailSchema.parse(request.data); scope(input, companyId, session.uid);
  return db.runTransaction(async tx => {
    const snap = await tx.get(db.collection("caseMailIntakeReceipts").doc(input.receiptId));
    // 別会社と存在しないIDを同じ応答で扱う。
    if (!snap.exists || snap.data()?.companyId !== companyId) throw new HttpsError("not-found", "受信候補を確認できません。");
    const record = receipt(snap.data(), companyId);
    const [feature, principal, ...candidateSnaps] = await Promise.all([
      tx.get(db.collection("companyFeatureSettings").doc(companyId)),
      tx.get(db.collection("automationIngestPrincipals").doc(caseMailRecordKey(companyId, record.ingestedBy))),
      ...record.candidateIds.map(candidateId => tx.get(db.collection("caseMailIntakeCandidates").doc(candidateId))),
    ]);
    const producer = principal!.data();
    const creationEnabled = feature!.data()?.caseMailJobCreationEnabled === true;
    const producerReady = producer?.companyId === companyId && producer.uid === record.ingestedBy &&
      producer.active === true && producer.producerId === record.producerId && producer.revision === record.principalRevision;
    const candidates = [];
    const readTargets = caseMailTargetReader(tx, companyId, input.receiptId);
    for (const candidateSnap of candidateSnaps) {
      const parsed = CandidateSchema.safeParse(candidateSnap.data());
      if (!parsed.success) fail();
      const candidate = parsed.data;
      if (candidate.companyId !== companyId || candidate.receiptId !== input.receiptId || candidate.messageId !== record.messageId ||
          candidate.sourceFingerprint !== record.sourceFingerprint ||
          !record.parts.some(part => part.partId === candidate.source.partId && part.sha256 === candidate.source.sha256)) fail();
      const normalized = normalizeJobInput(candidate.input);
      const value = normalized.value;
      const validDay = new Date(value.workDate + "T00:00:00Z");
      const creatable = candidateSnap.data()?.targetBinding === undefined && creationEnabled && producerReady && record.status === "ready" && record.verification === "verified" &&
        record.structuralComplete && record.kind === "new" && candidate.status === "ready" && !normalized.errors.length &&
        value.slots === 1 && value.basePay === null && value.publicationMode === "draft" && value.publishAt === null &&
        value.workDate >= "2026-10-01" && Number.isFinite(validDay.valueOf()) && validDay.toISOString().slice(0, 10) === value.workDate;
      let linkedJobId: string | null = null;
      if (candidate.status === "linked") {
        if (!candidate.linkedJobId) fail();
        const job = (await tx.get(db.collection("jobs").doc(candidate.linkedJobId))).data();
        if (!job || job.companyId !== companyId || job.mailIntake?.receiptId !== input.receiptId ||
            job.mailIntake?.candidateId !== candidateSnap.id) fail();
        linkedJobId = candidate.linkedJobId;
      }
      const changeReview = candidate.status === "linked" && record.status === "review" && record.issues.includes("SOURCE_CHANGED")
        ? (await readCaseMailResolution(tx, companyId, input.receiptId, candidateSnap.id)).view : undefined;
      const targetCandidates = record.status === "review" && !candidate.linkedJobId && candidate.status !== "linked"
        ? await readTargets(value.workDate, value.storeName) : undefined;
      const savedTarget = candidateSnap.data()?.targetBinding;
      if (savedTarget !== undefined && (!TargetBindingSchema.safeParse(savedTarget).success || savedTarget.companyId !== companyId || savedTarget.receiptId !== input.receiptId || savedTarget.candidateId !== candidateSnap.id)) fail();
      candidates.push({ ...(savedTarget ? { targetBinding: { jobId: savedTarget.jobId } } : {}), ...(targetCandidates ? { targetCandidates } : {}), ...(changeReview ? { changeReview } : {}), candidateId: candidateSnap.id, revision: candidate.revision, status: candidate.status, creatable, linkedJobId,
        input: { workDate: value.workDate, clientName: value.clientName, storeName: value.storeName,
          makerName: value.makerName, menuName: value.menuName, entryTime: value.entryTime, workTime: value.workTime },
        source: { partId: candidate.source.partId, rowKey: candidate.source.rowKey, unitIndex: candidate.source.unitIndex } });
    }
    return { ok: true, ...summary(input.receiptId, record), creationEnabled, producerReady, candidates };
  });
});

const TargetPreviewSchema = ScopeSchema.extend({receiptId:id,candidateId:id,jobId:id}).strict();
const TargetConfirmSchema = TargetPreviewSchema.extend({reviewVersion:hash,note:z.string().trim().min(1).max(1000),confirmed:z.literal(true)}).strict();
const TargetBindingSchema = z.object({version:z.literal(1),companyId:id,receiptId:id,candidateId:id,jobId:id,
  receiptRevision:revision,candidateRevision:revision,reviewVersion:hash,note:z.string().min(1).max(1000),actorUid:id,confirmedAt:z.unknown()});
const targetAuditId = (companyId:string, receiptId:string, candidateId:string) => caseMailRecordKey("case-mail-target",companyId,receiptId,candidateId);

async function readTargetContext(tx:FirebaseFirestore.Transaction, companyId:string, input:z.infer<typeof TargetPreviewSchema>) {
  const candidateRef=db.collection("caseMailIntakeCandidates").doc(input.candidateId);
  const [receiptSnap,candidateSnap,jobSnap,featureSnap]=await tx.getAll(
    db.collection("caseMailIntakeReceipts").doc(input.receiptId),candidateRef,db.collection("jobs").doc(input.jobId),
    db.collection("companyFeatureSettings").doc(companyId));
  const rawReceipt=receiptSnap!.data(),rawCandidate=candidateSnap!.data(),job=jobSnap!.data();
  if(!rawReceipt||!rawCandidate||!job||rawReceipt.companyId!==companyId||rawCandidate.companyId!==companyId||job.companyId!==companyId) fail();
  const record=receipt(rawReceipt,companyId),parsed=CandidateSchema.safeParse(rawCandidate);
  if(!parsed.success)fail();
  const candidate=parsed.data;
  if(!record.candidateIds.includes(input.candidateId)||candidate.receiptId!==input.receiptId||candidate.messageId!==record.messageId||
    candidate.sourceFingerprint!==record.sourceFingerprint||!record.parts.some(p=>p.partId===candidate.source.partId&&p.sha256===candidate.source.sha256)||
    candidate.linkedJobId||candidate.status!=="review"||record.status!=="review"||
    !Number.isSafeInteger(job.revision)||job.revision<0||job.revision>=Number.MAX_SAFE_INTEGER)fail();
  const auditRef=db.collection("auditLogs").doc(targetAuditId(companyId,input.receiptId,input.candidateId));
  const [principalSnap,auditSnap,...siblings]=await tx.getAll(
    db.collection("automationIngestPrincipals").doc(caseMailRecordKey(companyId,record.ingestedBy)),auditRef,
    ...record.candidateIds.filter(value=>value!==input.candidateId).map(value=>db.collection("caseMailIntakeCandidates").doc(value)));
  const principal=principalSnap!.data(),feature=featureSnap!.data(),audit=auditSnap!.data();
  const savedResult=rawCandidate.targetBinding===undefined?null:TargetBindingSchema.safeParse(rawCandidate.targetBinding);
  if(savedResult&&!savedResult.success)fail();
  const saved=savedResult?.success?savedResult.data:null;
  if(saved&&(saved.companyId!==companyId||saved.receiptId!==input.receiptId||saved.candidateId!==input.candidateId||saved.jobId!==input.jobId||
    !audit||audit.companyId!==companyId||audit.action!=="caseMail.target.confirm"||JSON.stringify(audit.binding)!==JSON.stringify(rawCandidate.targetBinding)))fail();
  if(!saved&&audit)fail();
  const peers=siblings.map(snap=>{
    const row=snap.data(),parsed=CandidateSchema.safeParse(row);
    if(!parsed.success||parsed.data.companyId!==companyId||parsed.data.receiptId!==input.receiptId||parsed.data.messageId!==record.messageId)fail();
    const binding=row!.targetBinding===undefined?null:TargetBindingSchema.parse(row!.targetBinding);
    if(binding&&(binding.companyId!==companyId||binding.receiptId!==input.receiptId||binding.candidateId!==snap.id))fail();
    return {candidateId:snap.id,linkedJobId:parsed.data.linkedJobId??null,targetJobId:binding?.jobId??null};
  });
  // 元の案件作成元を上書きせず、元受信・候補・所有記録の往復が一致することを確認する。
  let origin:{owner:FirebaseFirestore.DocumentData;receipt:FirebaseFirestore.DocumentData;candidate:FirebaseFirestore.DocumentData}|null=null;
  if(job.mailIntake!=null){
    const originIds=z.object({receiptId:id,candidateId:id,sourceKey:hash}).safeParse(job.mailIntake);
    if(!originIds.success||originIds.data.receiptId===input.receiptId)fail();
    const m=originIds.data;
    const [ownerSnap,originReceiptSnap,originCandidateSnap]=await tx.getAll(
      db.collection("caseMailJobSources").doc(m.sourceKey),db.collection("caseMailIntakeReceipts").doc(m.receiptId),
      db.collection("caseMailIntakeCandidates").doc(m.candidateId));
    const owner=ownerSnap!.data(),originReceipt=originReceiptSnap!.data(),originCandidate=originCandidateSnap!.data();
    if(!owner||!originReceipt||!originCandidate||owner.companyId!==companyId||originReceipt.companyId!==companyId||originCandidate.companyId!==companyId||
      owner.receiptId!==m.receiptId||owner.candidateId!==m.candidateId||owner.jobId!==input.jobId||owner.caseId!==job.caseId||
      originCandidate.status!=="linked"||originCandidate.linkedJobId!==input.jobId||originCandidate.receiptId!==m.receiptId||
      originCandidate.messageId!==originReceipt.messageId||!Array.isArray(originReceipt.candidateIds)||!originReceipt.candidateIds.includes(m.candidateId)||
      owner.completedCandidateRevision!==originCandidate.revision)fail();
    origin={owner,receipt:originReceipt,candidate:originCandidate};
  }
  const normalized=normalizeJobInput(candidate.input).value;
  const targets=await caseMailTargetReader(tx,companyId,input.receiptId)(normalized.workDate,normalized.storeName);
  let issue:string|null=null;
  if(record.verification!=="verified"||!record.structuralComplete||rawReceipt.heldAnalysisHash||record.issues.includes("SOURCE_CHANGED"))
    issue="受信内容が未検証・不完全、または再解析されています。対応を確定できません。";
  else if(feature?.caseMailIntakeEnabled!==true||!principal||principal.companyId!==companyId||principal.uid!==record.ingestedBy||principal.active!==true||
    principal.producerId!==record.producerId||principal.revision!==record.principalRevision)issue="受信処理の有効状態を確認してください。";
  else if(!targets.items.some(item=>item.jobId===input.jobId))issue="現在の表示候補に含まれていません。日付・店舗を再確認してください。";
  else if(peers.some(peer=>peer.linkedJobId===input.jobId||peer.targetJobId===input.jobId))issue="同じメール内の別候補が、この案件に対応済みです。";
  const {targetBinding:_binding,...candidateProof}=rawCandidate;
  const reviewVersion=caseMailRecordKey("case-mail-target-v1",input.receiptId,input.candidateId,input.jobId,rawReceipt,candidateProof,job,origin,principal??null,feature?.caseMailIntakeEnabled===true);
  const analysisHash=rawReceipt.heldAnalysisHash??rawReceipt.analysisHash??caseMailRecordKey(record.sourceFingerprint,candidate.source,candidate.input);
  let held=false;
  if(saved&&job.mailTargetHold!=null){
    const hold=job.mailTargetHold;
    const holdAudit=(await tx.get(db.collection("auditLogs").doc(caseMailRecordKey("case-mail-target-hold",companyId,input.receiptId,input.candidateId)))).data();
    held=hold.version===1&&hold.companyId===companyId&&hold.receiptId===input.receiptId&&hold.candidateId===input.candidateId&&
      hold.jobId===input.jobId&&hold.bindingVersion===saved.reviewVersion&&hold.receiptRevision===record.revision&&hold.analysisHash===analysisHash&&
      ["change","cancel"].includes(hold.kind)&&job.mailIntakeReviewRequired===true&&job.publishable===false&&job.recruitmentStopped===true&&
      holdAudit?.companyId===companyId&&holdAudit.action==="caseMail.target.hold"&&holdAudit.jobId===input.jobId&&holdAudit.reviewVersion===saved.reviewVersion&&holdAudit.kind===hold.kind;
  }
  const state=held?"held":saved?(saved.reviewVersion===reviewVersion&&!issue?"confirmed":"stale"):issue?"blocked":"available";
  const text=(key:string)=>typeof job[key]==="string"?job[key].slice(0,500):"";
  return {rawReceipt,rawCandidate,origin,principal,feature,candidateRef,auditRef,saved,record,candidate,job,jobRef:jobSnap!.ref,analysisHash,reviewVersion,view:{ok:true,receiptId:input.receiptId,candidateId:input.candidateId,jobId:input.jobId,
    reviewVersion,state,issue:state==="held"?null:state==="stale"?"対応記録後に受信内容・案件・登録状態が変わっています。対応記録は履歴として残り、変更処理には使用できません。":issue,
    current:{workDate:text("workDate"),storeName:text("storeName"),clientName:text("clientName"),makerName:text("makerName"),menuName:text("menuName"),
      entryTime:text("entryTime"),workTime:text("workTime"),cancelled:job.cancelled===true||job.status==="cancelled"}}};
}

export const getCaseMailTargetPreview=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token)),input=TargetPreviewSchema.parse(request.data);
  scope(input,companyId,session.uid);
  return db.runTransaction(async tx=>{
    const current=await readTargetContext(tx,companyId,input),resolution=await readTargetResolution(tx,companyId,input,current);
    return {...current.view,...(resolution?{resolution:resolution.view}:{}),...(resolution?.view.resolved?{state:"resolved",issue:null}:{})};
  });
});
export const confirmCaseMailTarget=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token)),input=TargetConfirmSchema.parse(request.data);
  scope(input,companyId,session.uid);await assertProductionOperational(companyId);
  return db.runTransaction(async tx=>{
    const current=await readTargetContext(tx,companyId,input);
    if(current.saved){
      if(current.saved.reviewVersion!==input.reviewVersion||current.saved.note!==input.note||current.saved.actorUid!==session.uid)fail();
      return {ok:true,saved:true,replayed:true,jobId:input.jobId};
    }
    if(current.view.state!=="available"||current.reviewVersion!==input.reviewVersion)fail();
    const binding={version:1,companyId,receiptId:input.receiptId,candidateId:input.candidateId,jobId:input.jobId,
      receiptRevision:current.record.revision,candidateRevision:current.candidate.revision,reviewVersion:input.reviewVersion,
      note:input.note,actorUid:session.uid,confirmedAt:Timestamp.now()};
    // 原案件・所有記録・業務キューには書かない。対応記録と監査だけを一括保存する。
    tx.set(current.candidateRef,{targetBinding:binding},{merge:true});
    tx.set(current.auditRef,{companyId,actorUid:session.uid,action:"caseMail.target.confirm",binding,createdAt:binding.confirmedAt});
    return {ok:true,saved:true,replayed:false,jobId:input.jobId};
  });
});

const TargetHoldSchema=TargetPreviewSchema.extend({reviewVersion:hash,kind:z.enum(["change","cancel"]),confirmed:z.literal(true)}).strict();
export const holdCaseMailTarget=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token)),input=TargetHoldSchema.parse(request.data);
  scope(input,companyId,session.uid);await assertProductionOperational(companyId);
  return db.runTransaction(async tx=>{
    const current=await readTargetContext(tx,companyId,input);
    const auditRef=db.collection("auditLogs").doc(caseMailRecordKey("case-mail-target-hold",companyId,input.receiptId,input.candidateId));
    const audit=(await tx.get(auditRef)).data();
    if(audit){
      if(current.view.state!=="held"||audit.companyId!==companyId||audit.jobId!==input.jobId||audit.reviewVersion!==input.reviewVersion||audit.kind!==input.kind)fail();
      return {ok:true,held:true,replayed:true,jobId:input.jobId};
    }
    if(current.view.state!=="confirmed"||current.reviewVersion!==input.reviewVersion||!current.saved||current.job.mailTargetHold!=null)fail();
    const now=Timestamp.now(),hold={version:1,companyId,receiptId:input.receiptId,candidateId:input.candidateId,jobId:input.jobId,
      receiptRevision:current.record.revision,analysisHash:current.analysisHash,bindingVersion:current.saved.reviewVersion,kind:input.kind,previousReviewRequired:current.job.mailIntakeReviewRequired===true,requestedAt:now};
    tx.set(current.jobRef,caseMailTargetHoldPatch(current.job,hold,now),{merge:true});
    tx.set(auditRef,{companyId,actorUid:session.uid,action:"caseMail.target.hold",receiptId:input.receiptId,candidateId:input.candidateId,
      jobId:input.jobId,reviewVersion:input.reviewVersion,kind:input.kind,createdAt:now});
    return {ok:true,held:true,replayed:false,jobId:input.jobId};
  });
});

async function readTargetResolution(tx:FirebaseFirestore.Transaction,companyId:string,input:z.infer<typeof TargetPreviewSchema>,current:Awaited<ReturnType<typeof readTargetContext>>) {
  const {job,rawCandidate,rawReceipt,record,saved,analysisHash,principal,feature,origin}=current;
  if(!saved)return null;
  const auditRef=db.collection("auditLogs").doc(caseMailRecordKey("case-mail-target-resolution",companyId,input.receiptId,input.candidateId,record.revision,analysisHash));
  const [sourceSnap,auditSnap]=await tx.getAll(db.collection("adminJobEditSources").doc(input.jobId),auditRef);
  const source=sourceSnap!.data(),audit=auditSnap!.data(),resolved=rawCandidate.targetResolution;
  if(audit){
    if(!resolved||resolved.version!==1||resolved.companyId!==companyId||resolved.receiptId!==input.receiptId||resolved.candidateId!==input.candidateId||
      resolved.jobId!==input.jobId||resolved.receiptRevision!==record.revision||resolved.analysisHash!==analysisHash||resolved.bindingVersion!==saved.reviewVersion||
      audit.companyId!==companyId||audit.action!=="caseMail.target.resolve"||JSON.stringify(audit.resolution)!==JSON.stringify(resolved))fail();
    return {auditRef,saved:resolved,view:{reviewVersion:resolved.reviewVersion as string,canResolve:false,resolved:true,issue:null,
      originReviewRequired:resolved.originReviewRequired as boolean,kind:resolved.hold.kind as "change"|"cancel",proposed:null}};
  }
  if(current.view.state!=="held")return null;
  const hold=job.mailTargetHold;
  let issue=caseMailResolutionIssue(input.jobId,job,source as EditSourceSnapshot|undefined,hold.requestedAt?.toMillis?.());
  let originReviewRequired=hold.previousReviewRequired===true;
  if(typeof hold.previousReviewRequired!=="boolean")issue="保留前の確認状態が不明です。元の受信記録を確認してください。";
  if(record.verification!=="verified"||!record.structuralComplete||feature?.caseMailIntakeEnabled!==true||
    !principal||principal.companyId!==companyId||principal.uid!==record.ingestedBy||principal.active!==true||
    principal.producerId!==record.producerId||principal.revision!==record.principalRevision)issue="受信元の検証・有効状態を確認してください。";
  const changed=rawReceipt.heldAnalysisHash!=null;
  const proposed=changed?rawCandidate.heldChange?.input:current.candidate.input;
  if(changed&&(rawCandidate.heldChange?.revision!==record.revision||rawCandidate.heldChange?.analysisHash!==analysisHash||
    rawReceipt.heldStructuralComplete!==true))issue="再解析後の受信内容・構造を確認してください。";
  if(hold.kind==="change"){
    const parsed=proposed?normalizeJobInput(proposed):null,value=parsed?.value;
    if(!value||parsed!.errors.length||value.slots!==1||value.basePay!==null||value.publicationMode!=="draft"||value.publishAt!==null||
      (changed&&rawCandidate.heldChange?.valid!==true)||record.issues.includes("SOURCE_STRUCTURE_CHANGED"))
      issue="変更後の依頼内容を照合できません。原文と対象の確認が必要です。";
    else{
      const menu=splitMenuConditions(value.menuName.normalize("NFKC").trim());
      if(job.cancelled===true||job.status==="cancelled"||
        ["workDate","clientName","storeName","makerName","entryTime","workTime"].some(key=>!adminEditValueMatches(key,(value as unknown as Record<string,unknown>)[key],job[key]))||
        !adminEditValueMatches("menuName",menu.name,job.menuName)||JSON.stringify(menu.conditions)!==JSON.stringify(job.menuConditions??[]))
        issue="受信した変更内容と現在の案件が一致しません。既存の編集・原本反映を確認してください。";
    }
  }else if(job.cancelled!==true||job.status!=="cancelled"||!["invoice_and_pay","invoice_only","pay_only","neither"].includes(job.cancellationFinancialTreatment))
    issue="既存の取消処理と請求・支払の扱いを確認してください。";
  let lock:FirebaseFirestore.DocumentData|undefined;
  if(job.assignedStaffId){
    lock=(await tx.get(db.collection("staffDayLocks").doc(companyId+"_"+job.assignedStaffId+"_"+job.dateKey))).data();
    if(job.cancelled!==true&&(!lock||lock.companyId!==companyId||lock.staffId!==job.assignedStaffId||lock.dateKey!==job.dateKey||lock.jobId!==input.jobId||lock.active!==true))
      issue="担当者の勤務枠を確認してください。";
    if(job.cancelled===true&&lock?.active===true&&lock.jobId===input.jobId)issue="取消後の勤務枠解除を確認してください。";
  }
  if(origin){
    const original=origin.receipt,candidate=origin.candidate,m=job.mailIntake;
    if(original.verification!=="verified"||!original.structuralComplete||candidate.sourceFingerprint!==original.sourceFingerprint||
      !Array.isArray(original.parts)||!original.parts.some((p:any)=>p.partId===candidate.source?.partId&&p.sha256===candidate.source?.sha256))
      issue="元メールの出典を確認してください。";
    if(original.status==="review"){
      // 別メールによる共通フラグを除いた状態で、元メール自身の確認記録だけを照合する。
      originReviewRequired=!caseMailReviewAccepted(m.receiptId,original,m.candidateId,{...job,mailIntakeReviewRequired:false});
    }else if(original.status!=="ready")issue="元メールの状態を確認してください。";
  }else if(job.mailIntakeHold!=null)issue="元メールの所有関係を確認してください。";
  const reviewVersion=caseMailRecordKey("case-mail-target-resolution-v1",current.reviewVersion,source??null,lock??null,hold,originReviewRequired);
  return {auditRef,saved:null,view:{reviewVersion,canResolve:!issue,resolved:false,issue,originReviewRequired,kind:hold.kind as "change"|"cancel",proposed:proposed?Object.fromEntries(["workDate","clientName","storeName","makerName","menuName","entryTime","workTime"].map(key=>[key,String(proposed[key]??"").slice(0,500)])):null}};
}

export const resolveCaseMailTargetHold=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token)),input=TargetConfirmSchema.parse(request.data);
  scope(input,companyId,session.uid);await assertProductionOperational(companyId);
  return db.runTransaction(async tx=>{
    const current=await readTargetContext(tx,companyId,input),resolution=await readTargetResolution(tx,companyId,input,current);
    if(!resolution)fail();
    if(resolution.saved){
      if(resolution.saved.reviewVersion!==input.reviewVersion||resolution.saved.note!==input.note||resolution.saved.actorUid!==session.uid)fail();
      return {ok:true,resolved:true,replayed:true,jobId:input.jobId};
    }
    if(!resolution.view.canResolve||resolution.view.reviewVersion!==input.reviewVersion)fail();
    const now=Timestamp.now(),job=current.job;
    const saved={version:1,companyId,receiptId:input.receiptId,candidateId:input.candidateId,jobId:input.jobId,
      receiptRevision:current.record.revision,analysisHash:current.analysisHash,bindingVersion:current.saved!.reviewVersion,
      reviewVersion:input.reviewVersion,note:input.note,actorUid:session.uid,confirmedAt:now,hold:job.mailTargetHold,
      originReviewRequired:resolution.view.originReviewRequired};
    const next={...job,mailTargetHold:null,mailIntakeReviewRequired:saved.originReviewRequired,revision:job.revision+1};
    tx.set(current.jobRef,{...assignmentPreparationPatch(job,next),mailTargetHold:FieldValue.delete(),mailIntakeReviewRequired:saved.originReviewRequired,
      mailTargetReview:saved,revision:next.revision,publishable:false,recruitmentStopped:true,
      scheduledPublishAt:FieldValue.delete(),mailPublication:FieldValue.delete(),updatedAt:now},{merge:true});
    tx.set(current.candidateRef,{targetResolution:saved},{merge:true});
    tx.set(resolution.auditRef,{companyId,actorUid:session.uid,action:"caseMail.target.resolve",resolution:saved,createdAt:now});
    return {ok:true,resolved:true,replayed:false,jobId:input.jobId};
  });
});
