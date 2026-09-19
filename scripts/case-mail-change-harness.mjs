import assert from 'node:assert/strict';
import {fixture} from './case-mail-assignment-harness.mjs';
import {clone,companyId} from './case-mail-test-harness.mjs';
export async function setupChange(assigned=true){
 const h=await fixture();if(assigned){await h.apply();await h.run();await h.importRow();}
 const candidate=h.records.get(h.paths.candidate),cid=h.key('case-mail-candidate',companyId,'message-1',candidate.source.partId,candidate.source.rowKey,candidate.source.unitIndex);
 h.records.delete(h.paths.candidate);h.paths.candidate='caseMailIntakeCandidates/'+cid;h.records.set(h.paths.candidate,candidate);h.job().mailIntake.candidateId=cid;h.records.get(h.paths.receipt).candidateIds=[cid];h.records.get('caseMailJobSources/'+h.job().mailIntake.sourceKey).candidateId=cid;
 h.records.get(h.paths.feature).caseMailIntakeEnabled=true;
 Object.assign(h.records.get(h.paths.mapping).operations,{'job.admin_edit':{values:['clientName','storeName','makerName','menuName','entryTime','workTime']}});
 const proposed={...candidate.input,storeName:'変更後の店舗'};
 let serial=0;
 h.receiveChange=async(patch={})=>{serial++;const analysis={messageId:'message-1',sourceFingerprint:(serial%2?'d':'e').repeat(64),receivedAt:'2026-09-18T01:00:00Z',state:'ready',structuralComplete:true,issues:[],parts:[candidate.source],candidates:[{source:candidate.source,input:proposed,sourceValues:{},parserSource:{}}],...patch};analysis.parts=analysis.parts.map(part=>({partId:part.partId,sha256:part.sha256}));return h.load('./case-mail-intake').createCaseMailReceiver({companyId,uid:'synthetic-ingester',producerId:'synthetic-producer',principalRevision:'principal-1',mailbox:'info@lipknots.com',startedAt:'2026-09-18T00:00:00Z'},{fetch:async()=>null,parse:()=>analysis})({messageId:'message-1'});};
 h.scope={expectedCompanyId:companyId,expectedActorUid:h.auth.uid};h.review=h.load('./case-mail-review');
 h.readChange=async()=>{const detail=await h.review.getCaseMailReceipt({auth:h.auth,data:{...h.scope,receiptId:h.job().mailIntake.receiptId}});return detail.candidates[0].changeReview;};
 h.commandChange=async()=>({...h.scope,receiptId:h.job().mailIntake.receiptId,candidateId:cid,jobId:h.jobId,reviewVersion:(await h.readChange()).reviewVersion,confirmed:true,note:'原文・担当・原本を合成確認'});
 h.resolveChange=async(data,auth=h.auth)=>h.load('./case-mail-resolution').confirmCaseMailReview({auth,data:data??await h.commandChange()});
 h.edit=fields=>h.load('./job-management').adminEditJobInputs({auth:h.auth,data:{jobId:h.jobId,revision:h.job().revision,fields}});
 h.runEdit=()=>h.load('./safe-sheet-writes').processSafeSheetWrite({data:{after:{exists:true,id:h.job().adminEditSheetWrite.queueId,ref:h.load('./firebase').db.doc('sheetSyncQueue/'+h.job().adminEditSheetWrite.queueId),data:()=>clone(h.records.get('sheetSyncQueue/'+h.job().adminEditSheetWrite.queueId))}}});
 h.cancel=()=>h.load('./analytics').adminSetJobCancellation({auth:h.auth,data:{jobId:h.jobId,expectedRevision:h.job().revision,reasonCategory:'maker',reasonNote:'受信取消の合成確認',financialTreatment:'pay_only'}});
 h.reimport=async()=>{await new Promise(resolve=>setTimeout(resolve,3));await h.importRow();};
 h.applyChange=async()=>{await h.edit({storeName:proposed.storeName});await h.runEdit();assert.equal(h.records.get('sheetSyncQueue/'+h.job().adminEditSheetWrite.queueId).status,'completed');await h.reimport();};
 return h;
}
