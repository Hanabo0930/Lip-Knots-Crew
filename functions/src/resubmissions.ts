import { assertSubmissionFileIdentity, assertSubmissionFile, assertSubmissionCounters, assertReplacementRequest } from "./submission-integrity";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db } from "./firebase";
import { enqueueNotification } from "./notification-core";
import { companyFromClaims, requireAdmin, requireAuth, staffFromClaims } from "./utils";
import { assertProductionOperational } from "./system-safety";
const ReasonEnum=z.enum(["手ブレで文字が読めません","画像が暗い・反射しています","一部が切れています","レシート全体が写っていません","金額・日付が確認できません","その他"]);
const CreateSchema=z.object({jobId:z.string().min(1),type:z.enum(["report","sales_floor"]),sourceSubmissionId:z.string().optional(),sourceFileId:z.string().optional(),reasons:z.array(ReasonEnum).min(1).max(6),note:z.string().max(1000).default("")}).refine(v=>!v.sourceFileId||!!v.sourceSubmissionId,{message:"元ファイルの提出IDが必要です"});
const CompleteSchema=z.object({requestId:z.string().min(1)});
export const createResubmissionRequest=onCall(async request=>{const session=requireAdmin(request);const companyId=companyFromClaims(session.token);await assertProductionOperational(companyId);const input=CreateSchema.parse(request.data??{});const job=await db.collection("jobs").doc(input.jobId).get();if(!job.exists||job.data()?.companyId!==companyId)throw new HttpsError("not-found","案件が見つかりません。");const staffId=String(job.data()?.assignedStaffId??"");if(!staffId)throw new HttpsError("failed-precondition","担当スタッフがいません。");let sourceFile:null|Record<string,unknown>=null;if(input.sourceSubmissionId){
 const submission=await db.collection("submissions").doc(input.sourceSubmissionId).get();
 const source=submission.data();
 if(!source||source.companyId!==companyId||source.jobId!==input.jobId||source.type!==input.type)throw new HttpsError("failed-precondition","元の提出と案件の所属情報が一致しません。");
 if(input.sourceFileId){
  const file=await submission.ref.collection("files").doc(input.sourceFileId).get();
  assertSubmissionFileIdentity(source,file.data(),input.sourceSubmissionId);
  if(file.data()?.status!=="completed")throw new HttpsError("failed-precondition","再送対象の画像を確認できません。");
  sourceFile={submissionId:input.sourceSubmissionId,fileId:input.sourceFileId,driveName:file.data()?.driveName??null,sequence:file.data()?.sequence??null,contentType:file.data()?.contentType??null};
 }
}
const ref=db.collection("resubmissionRequests").doc();await ref.set({companyId,staffId,jobId:input.jobId,type:input.type,sourceSubmissionId:input.sourceSubmissionId??null,sourceFileId:input.sourceFileId??null,sourceFile,reasons:input.reasons,note:input.note,status:"open",createdBy:session.uid,createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});await enqueueNotification({companyId,targetStaffId:staffId,title:input.type==="report"?"報告書を再送してください":"売場画像を再送してください",body:[...input.reasons,input.note].filter(Boolean).join(" / "),route:`/resubmissions/${ref.id}`,category:"resubmission_request",dedupeKey:ref.id});return{requestId:ref.id};});
export const getMyResubmissionRequests=onCall(async request=>{const session=requireAuth(request);const companyId=companyFromClaims(session.token);const staffId=staffFromClaims(session.token);const snap=await db.collection("resubmissionRequests").where("companyId","==",companyId).where("staffId","==",staffId).where("status","in",["open","submitted"]).limit(100).get();return{requests:snap.docs.map(doc=>({id:doc.id,...serialize(doc.data())}))};});
export const getAdminResubmissionRequests=onCall(async request=>{const session=requireAdmin(request);const companyId=companyFromClaims(session.token);const snap=await db.collection("resubmissionRequests").where("companyId","==",companyId).where("status","in",["open","submitted"]).limit(200).get();return{requests:snap.docs.map(doc=>({id:doc.id,...serialize(doc.data())}))};});
export const completeResubmissionRequest = onCall(async request => {
 const session = requireAdmin(request); const companyId = companyFromClaims(session.token);
 await assertProductionOperational(companyId);
 const input = CompleteSchema.parse(request.data ?? {});
 const ref = db.collection("resubmissionRequests").doc(input.requestId);
 await db.runTransaction(async tx => {
  const snap = await tx.get(ref); const data = snap.data();
  if (!data || data.companyId !== companyId) throw new HttpsError("not-found", "再提出依頼が見つかりません。");
  if (!["submitted", "completed"].includes(String(data.status)) || !data.replacementSubmissionId) throw new HttpsError("failed-precondition", "再提出済みの依頼だけ完了にできます。");
  const submission = await tx.get(db.collection("submissions").doc(String(data.replacementSubmissionId)));
  if (submission.data()?.resubmissionRequestId !== input.requestId) throw new HttpsError("failed-precondition", "差替提出の依頼先が一致しません。");
  assertCompletedReplacement(data, submission.data(), String(data.replacementSubmissionId));
  if (data.status === "completed") return;
  tx.update(ref, { status:"completed", completedBy:session.uid, completedAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp() });
 });
 return { ok:true };
});

export async function markResubmissionReplacementFile(input:{requestId:string;submissionId:string;fileId:string;driveFileId:string|null;driveName:string;previewContentType:string;submittedAt:Timestamp}) {
 const ref = db.collection("resubmissionRequests").doc(input.requestId);
 const submissionRef = db.collection("submissions").doc(input.submissionId);
 await db.runTransaction(async tx => {
  const [request, submission, file] = await Promise.all([tx.get(ref), tx.get(submissionRef), tx.get(submissionRef.collection("files").doc(input.fileId))]);
  const parent = submission.data(); const data = request.data(); const uploaded = file.data();
  assertSubmissionFile(parent, uploaded, input.submissionId);
  if (parent!.resubmissionRequestId !== input.requestId) throw new HttpsError("failed-precondition", "提出先の再提出依頼が一致しません。");
  assertReplacementRequest(data, parent!, input.submissionId);
  if (!input.driveFileId || uploaded?.driveFileId !== input.driveFileId || uploaded?.status !== "completed") throw new HttpsError("failed-precondition", "差替ファイルの転送完了を確認できません。");
  const entries = (data?.replacementFiles ?? []) as Array<Record<string, unknown>>;
  const existing = entries.find(item => item.fileId === input.fileId);
  if (existing) {
   if (existing.driveFileId !== input.driveFileId) throw new HttpsError("failed-precondition", "差替ファイルの転送先が変更されています。");
   return;
  }
  if (data?.status !== "open") throw new HttpsError("failed-precondition", "確認済みの再提出へファイルを追加できません。");
  tx.update(ref, { replacementSubmissionId:input.submissionId, replacementFiles:[...entries,{fileId:input.fileId,driveFileId:input.driveFileId,driveName:input.driveName,contentType:input.previewContentType,submittedAt:input.submittedAt}], updatedAt:input.submittedAt });
 });
}

function assertCompletedReplacement(request: Record<string, unknown> | undefined, submission: Record<string, unknown> | undefined, submissionId: string): void {
 if (!submission) throw new HttpsError("failed-precondition", "差替提出が見つかりません。");
 assertReplacementRequest(request, submission, submissionId);
 assertSubmissionCounters(submission);
 if (submission.status !== "completed" || submission.completedFiles !== submission.totalFiles || submission.jobStatusApplied !== true) throw new HttpsError("failed-precondition", "差替提出の完了を確認できません。");
}

export async function markResubmissionSubmitted(input:{requestId:string;submissionId:string;submittedAt:Timestamp}) {
 const ref = db.collection("resubmissionRequests").doc(input.requestId);
 await db.runTransaction(async tx => {
  const [snap, submission] = await Promise.all([tx.get(ref), tx.get(db.collection("submissions").doc(input.submissionId))]);
  if (submission.data()?.resubmissionRequestId !== input.requestId) throw new HttpsError("failed-precondition", "提出先の再提出依頼が一致しません。");
  assertCompletedReplacement(snap.data(), submission.data(), input.submissionId);
  if (snap.data()?.status !== "open") return;
  tx.update(ref, {status:"submitted", replacementSubmissionId:input.submissionId, submittedAt:input.submittedAt, updatedAt:input.submittedAt});
 });
}
function serialize(data:FirebaseFirestore.DocumentData):FirebaseFirestore.DocumentData{const result:FirebaseFirestore.DocumentData={};for(const[key,value]of Object.entries(data))result[key]=value instanceof Timestamp?value.toDate().toISOString():value;return result;}
