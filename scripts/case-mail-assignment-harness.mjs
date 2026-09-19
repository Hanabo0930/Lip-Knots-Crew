import assert from "node:assert/strict";
import { setup } from "./case-mail-publication-harness.mjs";
import { clone, companyId } from "./case-mail-test-harness.mjs";
export async function fixture(){
 const h=await setup();await h.publishNow();
 h.records.set("staffProfiles/staff-1",{companyId,active:true,displayName:"合成スタッフ"});
 h.records.set("staffProfiles/staff-2",{companyId,active:true,displayName:"合成スタッフ2"});
 h.staffAuth={uid:"staff-user",token:{companyId,staffId:"staff-1",role:"staff"}};
 h.commandApply={jobId:h.jobId,requestId:"request-synthetic-1",expectedJobRevision:h.job().revision};
 h.apply=(data=h.commandApply,auth=h.staffAuth)=>h.load("./jobs").applyToJob({data,auth});
 h.confirm=(revision=h.job().revision)=>h.load("./admin-operations").confirmApplication({auth:h.auth,data:{jobId:h.jobId,expectedRevision:revision}});
 h.assignment=()=>h.list("sheetSyncQueue").find(item=>item.operation==="job.assign");
 h.queue=()=>h.records.get(h.assignment().path);
 h.lock=()=>h.records.get("staffDayLocks/"+companyId+"_staff-1_"+h.job().dateKey);
 h.writes=[];h.reads=0;h.cellReads=0;
 const columns={workDate:"A",staffName:"B",clientName:"J",storeName:"K",makerName:"L",menuName:"M",entryTime:"N",workTime:"O"};
 Object.assign(h.records.get(h.paths.mapping),{idColumn:"BC",columns,operations:{"job.assign":{values:["staffName"]}}});
 h.row[25]="=SUM(X2:Y2)";h.row[26]="protected";
 const index=range=>{const match=/!([A-Z]+)2$/.exec(range);assert.ok(match,"unexpected range "+range);return [...match[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;};
 h.sheets={spreadsheets:{values:{
  get:async()=>{h.reads++;return {data:{values:[["caseId"],[h.row[54]]]}};},
  batchGet:async input=>{h.reads++;h.cellReads++;await h.beforeCellRead?.(input);const valueRanges=input.ranges.map(range=>({values:[[h.row[index(range)]??""]]}));await h.afterCellRead?.(input);return {data:{valueRanges}};},
  batchUpdate:async input=>{assert.equal(input.spreadsheetId,"synthetic-sheet");h.writes.push(clone(input));for(const d of input.requestBody.data)h.row[index(d.range)]=d.values[0][0];await h.afterWrite?.();return {data:{}};}
 },batchUpdate:async()=>{throw Error("style mutation refused");}}};
 h.run=async()=>{const ref=h.load("./firebase").db.doc(h.assignment().path);return h.load("./safe-sheet-writes").processSafeSheetWrite({data:{after:await ref.get()}});};
 h.changeMail=async()=>{
  h.records.get(h.paths.feature).caseMailIntakeEnabled=true;
  const analysis={messageId:"message-1",sourceFingerprint:"d".repeat(64),receivedAt:"2026-09-18T01:00:00Z",state:"review",structuralComplete:true,issues:["SOURCE_CHANGED"],parts:[],candidates:[]};
  return h.load("./case-mail-intake").createCaseMailReceiver({companyId,uid:"synthetic-ingester",producerId:"synthetic-producer",principalRevision:"principal-1",mailbox:"info@lipknots.com",startedAt:"2026-09-18T00:00:00Z"},{fetch:async()=>null,parse:()=>analysis})({messageId:"message-1"});
 };
 return h;
}
