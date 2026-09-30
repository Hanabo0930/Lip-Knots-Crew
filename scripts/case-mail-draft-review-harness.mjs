import {harness,companyId} from "./case-mail-test-harness.mjs";
export function draftFixture(){
 const h=harness(),r=h.records.get(h.paths.receipt),c=h.records.get(h.paths.candidate);
 Object.assign(r,{status:"review",structuralComplete:false,verificationScope:"registered-server-provider",analysisHash:"d".repeat(64),issues:["SOURCE_REVIEW"]});
 Object.assign(c,{status:"review",sourceValues:{headcount:1},parserSource:{ruleId:"combined-body-review-v1"},input:{...h.input,workDate:"",clientName:""}});
 const scope={expectedCompanyId:companyId,expectedActorUid:h.auth.uid},ids={receiptId:"receipt-1",candidateId:"candidate-1"};
 const api=h.load("./case-mail-draft-review"),reader=h.load("./case-mail-review");
 h.read=()=>reader.getCaseMailReceipt({data:{...scope,receiptId:ids.receiptId},auth:h.auth});
 h.make=async()=>({...scope,...ids,reviewVersion:(await h.read()).candidates[0].draftReview.reviewVersion,
  input:Object.fromEntries(["workDate","clientName","storeName","makerName","menuName","entryTime","workTime"].map(k=>[k,h.input[k]])),note:"合成原文と全資料を確認",entireSourceConfirmed:true,newSingleCaseConfirmed:true});
 h.confirm=(data,auth=h.auth)=>api.confirmCaseMailDraftReview({data,auth});
 h.createReviewed=async()=>{const view=await h.read();return h.create({mailIntake:{...h.command.mailIntake,expectedRevision:view.candidates[0].revision}});};
 return h;
}
