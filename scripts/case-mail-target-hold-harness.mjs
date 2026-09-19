import {harness,clone,companyId,Timestamp} from "./case-mail-test-harness.mjs";
export async function targetHoldFixture(existing=null,initial={}) {
 const h=existing??harness();h.records.get(h.paths.feature).caseMailIntakeEnabled=true;
 const jobId=h.jobId??"target-1";
 if(!existing)h.records.set("jobs/"+jobId,{companyId,...clone(h.input),dateKey:h.input.workDate,caseId:"case-1",revision:1,status:"open",publishable:true,recruitmentStopped:false,sourceReady:true,...initial});
 const job=h.records.get("jobs/"+jobId),source=clone(h.records.get(h.paths.candidate).source),messageId="target-message-2";
 const receiptId=h.key("case-mail-receipt",companyId,messageId),candidateId=h.key("case-mail-candidate",companyId,messageId,source.partId,source.rowKey,source.unitIndex);
 const input={...clone(h.input),workDate:job.workDate,storeName:job.storeName};
 const analysis={messageId,sourceFingerprint:"f".repeat(64),receivedAt:"2026-09-18T03:00:00Z",state:"review",structuralComplete:true,issues:["SOURCE_REVIEW"],parts:[{partId:source.partId,sha256:source.sha256}],candidates:[{source,input,sourceValues:{},parserSource:{}}]};
 const receipt={version:1,companyId,messageId,revision:1,status:"review",verification:"verified",structuralComplete:true,kind:"new",sourceFingerprint:analysis.sourceFingerprint,analysisHash:h.key(analysis),ingestedBy:"synthetic-ingester",producerId:"synthetic-producer",principalRevision:"principal-1",candidateIds:[candidateId],parts:analysis.parts,issues:analysis.issues};
 h.records.set("caseMailIntakeReceipts/"+receiptId,receipt);
 h.records.set("caseMailIntakeCandidates/"+candidateId,{version:1,companyId,receiptId,messageId,revision:1,status:"review",sourceFingerprint:analysis.sourceFingerprint,source,input,importVersion:1});
 const api=h.load("./case-mail-review"),request={expectedCompanyId:companyId,expectedActorUid:h.auth.uid,receiptId,candidateId,jobId};
 const preview=()=>api.getCaseMailTargetPreview({auth:h.auth,data:request});
 const shown=await preview();await api.confirmCaseMailTarget({auth:h.auth,data:{...request,reviewVersion:shown.reviewVersion,note:"別メールの対象を照合",confirmed:true}});
 const holdCommand={...request,reviewVersion:(await preview()).reviewVersion,kind:"change",confirmed:true};
 return Object.assign(h,{targetJobId:jobId,targetReceiptId:receiptId,targetCandidateId:candidateId,targetRequest:request,targetPreview:preview,holdCommand,
  hold:(data=holdCommand,auth=h.auth)=>api.holdCaseMailTarget({auth,data}),targetJob:()=>h.records.get("jobs/"+jobId),
  receiveTarget:patch=>h.load("./case-mail-intake").createCaseMailReceiver({companyId,uid:"synthetic-ingester",producerId:"synthetic-producer",principalRevision:"principal-1",mailbox:"info@lipknots.com",startedAt:"2026-09-18T00:00:00Z"},{fetch:async()=>null,parse:()=>({...clone(analysis),...patch})})({messageId})});
}
