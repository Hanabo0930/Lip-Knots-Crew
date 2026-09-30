import { Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { hashText } from "./case-id";
import { normalizeJobInput } from "./job-management-core";
import { requireAdmin, companyFromClaims } from "./utils";
import { assertProductionOperational } from "./system-safety";
import { hasCaseMailCollision } from "./case-mail-collision";
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/), hash=z.string().regex(/^[a-f0-9]{64}$/);
const rev=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER-3);
const text=(max:number)=>z.string().trim().min(1).max(max);
const InputSchema=z.object({workDate:text(20),clientName:text(200),storeName:text(200),makerName:text(200),menuName:text(500),entryTime:text(100),workTime:text(100)}).strict();
const RequestSchema=z.object({expectedCompanyId:id,expectedActorUid:id,receiptId:id,candidateId:id,reviewVersion:hash,
  input:InputSchema,note:text(1000),entireSourceConfirmed:z.literal(true),newSingleCaseConfirmed:z.literal(true)}).strict();
const ReceiptSchema=z.object({version:z.literal(1),companyId:id,messageId:id,revision:rev,status:z.enum(["ready","review","cancelled"]),
  verification:z.literal("verified"),verificationScope:z.literal("registered-server-provider"),structuralComplete:z.boolean(),kind:z.literal("new"),
  sourceFingerprint:hash,analysisHash:hash,ingestedBy:id,producerId:id,principalRevision:id,candidateIds:z.array(id).length(1),
  parts:z.array(z.object({partId:id,sha256:hash})).min(1).max(500),issues:z.array(z.string().max(500)).max(100)});
const CandidateSchema=z.object({version:z.literal(1),companyId:id,receiptId:id,messageId:id,revision:rev,status:z.enum(["review","linked"]),
  importVersion:rev,sourceFingerprint:hash,source:z.object({partId:id,rowKey:text(500),unitIndex:z.literal(0),sha256:hash}),
  input:z.record(z.string(),z.unknown()),sourceValues:z.record(z.string(),z.unknown()),parserSource:z.record(z.string(),z.unknown())});
const SavedSchema=z.object({version:z.literal(1),companyId:id,receiptId:id,candidateId:id,sourceContext:hash,reviewVersion:hash,
  baseCandidateRevision:rev,confirmedCandidateRevision:rev,input:InputSchema,note:text(1000),actorUid:id,confirmedAt:z.unknown(),
  entireSourceConfirmed:z.literal(true),newSingleCaseConfirmed:z.literal(true)});
const canonical=(value:any):string=>JSON.stringify(value===undefined?null:Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):value);
const key=(...values:unknown[])=>hashText(canonical(values),64);
const auditId=(companyId:string,receiptId:string,candidateId:string)=>key("case-mail-draft-review",companyId,receiptId,candidateId);
function fail():never{throw new HttpsError("failed-precondition","受信候補・確認記録が変わっています。最新の内容を読み直してください。");};
export function normalizeCaseMailReviewedInput(raw:unknown){
  const input=InputSchema.parse(raw),normalized=normalizeJobInput({...input,slots:1,basePay:null,publicationMode:"draft",publishAt:null});
  const v=normalized.value,clock=(value:string)=>{const m=/^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.normalize("NFKC").trim());return m?Number(m[1])*60+Number(m[2]):null;};
  const span=/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})(?:\s*\(予定\))?$/.exec(v.workTime.normalize("NFKC").replace(/[～〜~‐‑‒–—―−ー]/g,"-"));
  const arrival=clock(v.entryTime),start=span?clock(span[1]!):null,end=span?clock(span[2]!):null;
  if(normalized.errors.length||v.workDate<"2026-10-01"||arrival===null||start===null||end===null||end<=start||arrival>start||
    [v.clientName,v.storeName,v.makerName,v.menuName].some(value=>/未定|調整中|別途確認/.test(value)))
    throw new HttpsError("invalid-argument","日付・取引先・店舗・業務内容・入店と実施時間を原文で確認してください。");
  return {input:InputSchema.parse(Object.fromEntries(Object.keys(input).map(k=>[k,v[k as keyof typeof v]]))),normalized:v};
}
/** 元の解析結果は保持し、管理者が全資料を照合した記録を別に検証する。 */
export async function readCaseMailDraftReview(tx:FirebaseFirestore.Transaction,companyId:string,receiptId:string,candidateId:string,r:any,c:any){
  const receipt=ReceiptSchema.safeParse(r),candidate=CandidateSchema.safeParse(c),saved=c?.draftReview===undefined?null:SavedSchema.safeParse(c.draftReview);
  const blocked=(issue:string)=>({view:{canConfirm:false,confirmed:false,reviewVersion:null as string|null,issue},input:null as z.infer<typeof InputSchema>|null});
  if(saved&&!saved.success)fail();
  if(!receipt.success||!candidate.success)return blocked("原文を確認する補正は、新規1名・1候補の受信記録が対象です。");
  const a=receipt.data,b=candidate.data,s=saved?.success?saved.data:null;
  if(a.companyId!==companyId||b.companyId!==companyId||b.receiptId!==receiptId||a.messageId!==b.messageId||a.candidateIds[0]!==candidateId||
    a.sourceFingerprint!==b.sourceFingerprint||new Set(a.parts.map(p=>p.partId)).size!==a.parts.length||
    !a.parts.some(p=>p.partId===b.source.partId&&p.sha256===b.source.sha256))fail();
  if(a.status!=="review"||r.heldAnalysisHash||r.heldSourceFingerprint||c.heldChange||c.targetBinding||
    a.issues.some(issue=>["SOURCE_CHANGED","SOURCE_STRUCTURE_CHANGED"].includes(issue)))return blocked("変更・取消や既存案件との対応がある候補は、新規作成できません。");
  if(b.sourceValues.headcount!==undefined&&b.sourceValues.headcount!==null&&b.sourceValues.headcount!==1)
    return blocked("複数名・条件付き人数の依頼は、人数と案件の分け方を先に確認してください。");
  if(!s&&(b.status!=="review"||c.linkedJobId))return blocked("登録済みの候補です。案件一覧で確認してください。");
  const base=s?.baseCandidateRevision??b.revision;
  const sourceContext=key("case-mail-draft-source-v1",receiptId,candidateId,a,{...b,revision:base,status:"review"});
  if(s){
    const audit=(await tx.get(db.collection("auditLogs").doc(auditId(companyId,receiptId,candidateId)))).data();
    if(s.companyId!==companyId||s.receiptId!==receiptId||s.candidateId!==candidateId||s.sourceContext!==sourceContext||
      s.confirmedCandidateRevision!==base+1||b.revision!==s.confirmedCandidateRevision+(b.status==="linked"?1:0)||
      !audit||audit.companyId!==companyId||audit.action!=="caseMail.draft.confirm"||canonical(audit.review)!==canonical(c.draftReview))fail();
    normalizeCaseMailReviewedInput(s.input);
    return {view:{canConfirm:false,confirmed:true,reviewVersion:s.reviewVersion,issue:null},input:s.input};
  }
  const [featureSnap,principalSnap]=await tx.getAll(db.collection("companyFeatureSettings").doc(companyId),
    db.collection("automationIngestPrincipals").doc(hashText(JSON.stringify([companyId,a.ingestedBy]),64)));
  const feature=featureSnap!.data(),principal=principalSnap!.data();
  if(feature?.caseMailJobCreationEnabled!==true||!principal||principal.companyId!==companyId||principal.uid!==a.ingestedBy||principal.active!==true||
    principal.producerId!==a.producerId||principal.revision!==a.principalRevision)return blocked("受信案件の登録と受信実行者の有効状態を確認してください。");
  return {view:{canConfirm:true,confirmed:false,reviewVersion:sourceContext,issue:null},input:null};
}
export const confirmCaseMailDraftReview=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token)),input=RequestSchema.parse(request.data);
  if(input.expectedCompanyId!==companyId||input.expectedActorUid!==session.uid)fail();
  await assertProductionOperational(companyId);
  const reviewed=normalizeCaseMailReviewedInput(input.input).input;
  return db.runTransaction(async tx=>{
    const candidateRef=db.collection("caseMailIntakeCandidates").doc(input.candidateId),auditRef=db.collection("auditLogs").doc(auditId(companyId,input.receiptId,input.candidateId));
    const [receiptSnap,candidateSnap]=await tx.getAll(db.collection("caseMailIntakeReceipts").doc(input.receiptId),candidateRef);
    const r=receiptSnap!.data(),c=candidateSnap!.data();
    if(!r||!c||r.companyId!==companyId||c.companyId!==companyId)fail();
    const current=await readCaseMailDraftReview(tx,companyId,input.receiptId,input.candidateId,r,c);
    if(current.view.confirmed){
      if(current.view.reviewVersion!==input.reviewVersion||c.draftReview.actorUid!==session.uid||c.draftReview.note!==input.note||canonical(current.input)!==canonical(reviewed))fail();
      return {ok:true,confirmed:true,receiptId:input.receiptId,candidateId:input.candidateId,replayed:true};
    }
    if(!current.view.canConfirm||current.view.reviewVersion!==input.reviewVersion)fail();
    if(await hasCaseMailCollision(tx,companyId,input.receiptId,reviewed.workDate,reviewed.storeName))
      throw new HttpsError("failed-precondition","同日・同店の案件または受信候補があります。既存の案件を先に確認してください。");
    if((await tx.get(auditRef)).exists)fail();
    const now=Timestamp.now(),review={version:1,companyId,receiptId:input.receiptId,candidateId:input.candidateId,sourceContext:input.reviewVersion,
      reviewVersion:input.reviewVersion,baseCandidateRevision:c.revision,confirmedCandidateRevision:c.revision+1,input:reviewed,note:input.note,
      actorUid:session.uid,confirmedAt:now,entireSourceConfirmed:true,newSingleCaseConfirmed:true};
    tx.set(candidateRef,{draftReview:review,revision:c.revision+1,workDate:reviewed.workDate,updatedAt:now},{merge:true});
    tx.set(auditRef,{companyId,actorUid:session.uid,action:"caseMail.draft.confirm",review,createdAt:now});
    return {ok:true,confirmed:true,receiptId:input.receiptId,candidateId:input.candidateId,replayed:false};
  });
});
