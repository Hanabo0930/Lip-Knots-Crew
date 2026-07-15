import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";
import { z } from "zod";
import { google } from "googleapis";
import { db } from "./firebase";
import { companyFromClaims, requireAuth, staffFromClaims } from "./utils";

export const filePreviewGatewayUrl = defineString("FILE_PREVIEW_GATEWAY_URL", { default: "" });

const TimelineSchema = z.object({
  jobId: z.string().min(1),
  type: z.enum(["report", "sales_floor"]),
});
const ComparisonSchema = z.object({ requestId: z.string().min(1) });

type FileView = {
  id: string;
  submissionId: string;
  originalName: string;
  driveName: string;
  contentType: string;
  sequence: number | null;
  purpose: string;
  status: string;
  previewUrl: string | null;
  completedAt: string | null;
  replacesFileId: string | null;
};

export const getSubmissionTimeline = onCall(async (request) => {
  const session = requireAuth(request);
  const input = TimelineSchema.parse(request.data ?? {});
  const companyId = companyFromClaims(session.token);
  await assertJobAccess(input.jobId, companyId, session.token.role, staffFromClaimsSafe(session.token));

  const submissions = await db.collection("submissions")
    .where("companyId", "==", companyId)
    .where("jobId", "==", input.jobId)
    .where("type", "==", input.type)
    .limit(100)
    .get();

  const sorted = submissions.docs.sort((a,b) => timestampMillis(b.data().createdAt)-timestampMillis(a.data().createdAt));
  const groups=[];
  for (const submission of sorted) {
    const files=await submission.ref.collection("files").orderBy("createdAt","asc").limit(30).get();
    const views=[] as FileView[];
    for (const file of files.docs) views.push(await fileView(companyId, session.uid, submission.id, file.id, file.data()));
    groups.push({
      id: submission.id,
      type: submission.data().type,
      purpose: submission.data().purpose,
      status: submission.data().status,
      createdAt: iso(submission.data().createdAt),
      completedAt: iso(submission.data().completedAt),
      files: views,
    });
  }
  return { submissions: groups };
});

export const getResubmissionComparison = onCall(async (request) => {
  const session = requireAuth(request);
  const input = ComparisonSchema.parse(request.data ?? {});
  const companyId = companyFromClaims(session.token);
  const ref=db.collection("resubmissionRequests").doc(input.requestId);
  const snap=await ref.get();
  if(!snap.exists || snap.data()?.companyId!==companyId) throw new HttpsError("not-found","再提出依頼が見つかりません。");
  const data=snap.data()!;
  const staffId=staffFromClaimsSafe(session.token);
  if(session.token.role!=="admin" && data.staffId!==staffId) throw new HttpsError("permission-denied","この再提出依頼を確認できません。");

  let source: FileView|null=null;
  if(data.sourceSubmissionId && data.sourceFileId){
    const file=await db.collection("submissions").doc(String(data.sourceSubmissionId)).collection("files").doc(String(data.sourceFileId)).get();
    if(file.exists) source=await fileView(companyId,session.uid,String(data.sourceSubmissionId),file.id,file.data()!);
  }
  const replacements:FileView[]=[];
  if(data.replacementSubmissionId){
    const files=await db.collection("submissions").doc(String(data.replacementSubmissionId)).collection("files").orderBy("createdAt","asc").get();
    for(const file of files.docs) replacements.push(await fileView(companyId,session.uid,String(data.replacementSubmissionId),file.id,file.data()));
  }
  return {
    request:{ id:snap.id, jobId:data.jobId, type:data.type, reasons:data.reasons??[], note:data.note??"", status:data.status, createdAt:iso(data.createdAt), submittedAt:iso(data.submittedAt) },
    source,
    replacements,
  };
});

export const driveFilePreview = onRequest(async (request,response)=>{
  try{
    const token=String(request.query.token??"");
    if(!/^[A-Za-z0-9_-]{30,120}$/.test(token)){ response.status(400).send("Invalid preview token"); return; }
    const hash=sha256(token); const snap=await db.collection("filePreviewTokens").doc(hash).get();
    if(!snap.exists){ response.status(404).send("Preview not found"); return; }
    const data=snap.data()!; const expires=data.expiresAt as Timestamp|undefined;
    if(data.active!==true || !expires || expires.toMillis()<Date.now()){ response.status(410).send("Preview expired"); return; }
    const auth=new google.auth.GoogleAuth({scopes:["https://www.googleapis.com/auth/drive.readonly"]});
    const drive=google.drive({version:"v3",auth});
    const result=await drive.files.get({fileId:String(data.driveFileId),alt:"media",supportsAllDrives:true},{responseType:"stream"});
    response.setHeader("Content-Type",String(data.contentType||"application/octet-stream"));
    response.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(String(data.fileName||"file"))}`);
    response.setHeader("Cache-Control","private, max-age=60");
    await snap.ref.set({lastOpenedAt:FieldValue.serverTimestamp(),openCount:FieldValue.increment(1)},{merge:true});
    (result.data as NodeJS.ReadableStream).on("error",()=>{ if(!response.headersSent) response.status(500).end(); else response.end(); }).pipe(response);
  }catch(error){ console.error("driveFilePreview failed",error); if(!response.headersSent) response.status(500).send("Preview error"); }
});

async function fileView(companyId:string,actorUid:string,submissionId:string,fileId:string,data:FirebaseFirestore.DocumentData):Promise<FileView>{
  let previewUrl:string|null=null;
  if(data.status==="completed" && data.driveFileId){
    const raw=randomBytes(32).toString("base64url"); const hash=sha256(raw);
    await db.collection("filePreviewTokens").doc(hash).set({companyId,actorUid,submissionId,fileId,driveFileId:data.driveFileId,fileName:data.driveName??data.originalName,contentType:data.contentType,active:true,expiresAt:Timestamp.fromMillis(Date.now()+15*60*1000),createdAt:FieldValue.serverTimestamp()});
    const base=filePreviewGatewayUrl.value(); previewUrl=base?`${base}?token=${encodeURIComponent(raw)}`:null;
  }
  return {id:fileId,submissionId,originalName:String(data.originalName??""),driveName:String(data.driveName??""),contentType:String(data.contentType??""),sequence:Number.isFinite(Number(data.sequence))?Number(data.sequence):null,purpose:String(data.purpose??""),status:String(data.status??""),previewUrl,completedAt:iso(data.completedAt),replacesFileId:data.replacesFileId?String(data.replacesFileId):null};
}
async function assertJobAccess(jobId:string,companyId:string,role:unknown,staffId:string){ const job=await db.collection("jobs").doc(jobId).get(); if(!job.exists||job.data()?.companyId!==companyId) throw new HttpsError("not-found","案件が見つかりません。"); if(role!=="admin"&&job.data()?.assignedStaffId!==staffId) throw new HttpsError("permission-denied","この案件を確認できません。"); }
function staffFromClaimsSafe(token:Record<string,unknown>):string{ try{return staffFromClaims(token);}catch{return "";} }
function sha256(value:string){return createHash("sha256").update(value,"utf8").digest("hex");}
function timestampMillis(value:unknown):number{return value instanceof Timestamp?value.toMillis():0;}
function iso(value:unknown):string|null{return value instanceof Timestamp?value.toDate().toISOString():null;}
