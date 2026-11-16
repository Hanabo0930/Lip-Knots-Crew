'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{Module}=require('node:module');
const fixtureFile=path.join(__dirname,'test-crew-external-receipt.cjs'),source=fs.readFileSync(fixtureFile,'utf8'),boundary=source.indexOf('(async()=>{');assert(boundary>0);
const fixture=new Module(fixtureFile,module);fixture.filename=fixtureFile;fixture.paths=module.paths;fixture._compile(source.slice(0,boundary)+"\nmodule.exports={db,Clock,advanceClock:n=>{clockOffset+=n},get documentWrites(){return documentWrites},start,archiveFixture,reconcile,binding,literal,changeReceipt,load,owner,CASE,COMPANY,NAME,feeIndices,helpers,assignmentQueueCount,get documents(){return documents},get jobId(){return jobId},get sheetsData(){return sheetsData},get requests(){return requests},get nativeCalls(){return nativeCalls},set afterRead(x){afterRead=x},get runtimeEnvironment(){return runtimeEnvironment}};",fixtureFile);const h=fixture.exports;
const observation=require('../functions/src/case-list-assignment-observation.cjs');
const results=[];async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.stack});}}
const clone=x=>structuredClone(x),row=cells=>({cells,fullWritable:true,knownColumns:cells.map((_,i)=>i)}),blankIndices=h.feeIndices.map(i=>i+1).filter(i=>![28,29,36].includes(i));
const blanks=f=>{for(const i of blankIndices)f.cells[i]={};};
function pending(){assert.equal(h.documents.get('jobs/'+h.jobId).applicationUnconfirmed,true);assert.equal(h.assignmentQueueCount(),1);assert(![...h.documents].some(([p,v])=>p.startsWith('caseListMonthlyOperations/')&&v.externalAcceptance));}
async function held(f){await assert.rejects(()=>h.reconcile(f));pending();}
(async()=>{
 for(const manual of [false,true]){
 const origin=manual?'manual':'application';
 await test(origin+' observed blanks preserve all 30 optional values through actual A1/A2 and reconciliation',async()=>{const f=await h.start(manual,true,blanks),op=[...h.documents].find(([p])=>p.startsWith('caseListMonthlyOperations/'))[1];assert.equal(op.externalSelection.expectedFees.filter(x=>x==='').length,30);const out=h.archiveFixture(f);assert.equal(out.mapped[19].userEnteredValue,undefined);assert.equal(out.mapped[29].userEnteredValue,undefined);await h.reconcile(f);assert.equal(h.documents.get('jobs/'+h.jobId).applicationUnconfirmed,false);assert.equal(h.assignmentQueueCount(),1);});
 await test(origin+' formula explicitly returning blank stays blank',async()=>{const f=await h.start(manual,true,f=>{blanks(f);f.cells[20]={userEnteredValue:{formulaValue:'=IF(TRUE,"",1)'},effectiveValue:{stringValue:''}};});h.archiveFixture(f);await h.reconcile(f);assert.equal(h.documents.get('jobs/'+h.jobId).applicationUnconfirmed,false);});
 for(const [name,mutate]of [
 ['blank is not zero',m=>{m[19]={userEnteredValue:{numberValue:0},effectiveValue:{numberValue:0}};}],
 ['blank changed to a number',m=>{m[19]={userEnteredValue:{numberValue:625},effectiveValue:{numberValue:625}};}],
 ['monthly formula error',m=>{m[19]={userEnteredValue:{formulaValue:'=BAD()'},effectiveValue:{errorValue:{type:'VALUE',message:'SYNTHETIC'}}};}],
 ['missing formula result',m=>{m[19]={userEnteredValue:{formulaValue:'=IF(TRUE,"",1)'}};}],
 ['required salary missing',m=>{m[27]={};}],
 ['required allowance missing',m=>{m[28]={};}],
 ['required promised pay missing',m=>{m[35]={};}]
 ])await test(origin+' '+name+' holds',async()=>{const f=await h.start(manual,true,blanks),{mapped}=h.archiveFixture(f);mutate(mapped);await held(f);});
 await test(origin+' dependency changed after SENT holds then recovers same receipt without resend',async()=>{const f=await h.start(manual,true,blanks);h.archiveFixture(f);const deps=h.sheetsData.get(901);deps.set(2,[h.literal('SYNTHETIC_CHANGED_QUOTE')]);await held(f);deps.delete(2);const before=h.nativeCalls;await h.reconcile(f);assert.equal(h.documents.get('jobs/'+h.jobId).applicationUnconfirmed,false);await h.reconcile(f);assert.equal(h.nativeCalls,before);assert.equal(h.assignmentQueueCount(),1);});
 await test(origin+' UNKNOWN is held and no replay or acknowledgement is created',async()=>{const f=await h.start(manual,true,blanks);const before=h.nativeCalls;await held(f);assert.equal(h.nativeCalls,before);});
 await test(origin+' wrong company and authority remain blocked',async()=>{const f=await h.start(manual,true,blanks);h.archiveFixture(f);await assert.rejects(()=>h.load('admin-operations').acknowledgeSheetWriteIssue({...h.owner,auth:{...h.owner.auth,token:{...h.owner.auth.token,companyId:'other_synthetic'}},data:{action:'reconcile-case-list',queueId:f.queueId}}));pending();});
 await test(origin+' changed assigned revision holds',async()=>{const f=await h.start(manual,true,blanks);h.archiveFixture(f);h.documents.get('jobs/'+h.jobId).revision++;await held(f);});
 }

 for(const manual of [false,true]){
 const origin=manual?'manual':'application';
 for(const [label,change]of [
 ['complete raw blank read',null],['unread coverage',snap=>{snap.source.rows.find(r=>r.caseId===h.CASE).fullWritable=false;}],['missing columns',snap=>{snap.source.rows.find(r=>r.caseId===h.CASE).knownColumns.pop();}],['unknown cell',snap=>{snap.source.rows.find(r=>r.caseId===h.CASE).cells[20]={$unknown:true};}],['formula result missing',snap=>{snap.source.rows.find(r=>r.caseId===h.CASE).cells[20]={userEnteredValue:{formulaValue:'=X1'}};}],['formula error',snap=>{snap.source.rows.find(r=>r.caseId===h.CASE).cells[20]={effectiveValue:{errorValue:{type:'N_A'}}};}],['nonfinite value',snap=>{snap.source.rows.find(r=>r.caseId===h.CASE).cells[20]={effectiveValue:{numberValue:Infinity}};}],['missing salary',snap=>{snap.source.rows.find(r=>r.caseId===h.CASE).cells[28]={};}],['missing allowance',snap=>{snap.source.rows.find(r=>r.caseId===h.CASE).cells[29]={};}],['missing promised pay',snap=>{snap.source.rows.find(r=>r.caseId===h.CASE).cells[36]={};}],['dependency unread',snap=>{delete snap.dependencyHash;}],['dependency changed',snap=>{snap.dependencyHash='a'.repeat(64);}],['different observed revision',snap=>{snap.catalog.sourceRevision='b'.repeat(64);}]
 ])await test(origin+' actual Source read port '+label,async()=>{
  await h.start(manual,true,blanks);const event=[...h.documents].find(([key])=>key.endsWith('/events/'+(manual?'SOURCE_MANUAL_OBSERVED':'SOURCE_INTENT')))[1],projected=manual?event:[...h.documents].find(([key])=>key.endsWith('/events/SOURCE_PROJECTED'))[1],expected={sourceSnapshot:event.payload.sourceSnapshot??event.payload.expectedSourceAfter,sourceRevision:projected.payload.postCatalog.sourceRevision,dependencyHash:event.payload.dependencyHash};
  const snapshot=await h.load('case-list-monthly-reader').readCaseListMonthlySnapshot(h.COMPANY,h.CASE,{includeDependencies:true});if(change)change(snapshot);
  const reads=h.load('case-list-gas-read-ports').createGasReadPorts({readMonthly:async()=>snapshot,hash:h.helpers.hashCaseList});
  if(change)await assert.rejects(()=>reads.assertSource({companyId:h.COMPANY,uid:h.owner.auth.uid,email:'owner@example.invalid'},h.CASE,expected));else await reads.assertSource({companyId:h.COMPANY,uid:h.owner.auth.uid,email:'owner@example.invalid'},h.CASE,expected);
 });
 await test(origin+' effective formula change requires original Source revision again',async()=>{
  await h.start(manual,true,f=>{blanks(f);f.cells[20]={userEnteredValue:{formulaValue:'=IF(TRUE,"",1)'},effectiveValue:{stringValue:''}};});const event=[...h.documents].find(([key])=>key.endsWith('/events/'+(manual?'SOURCE_MANUAL_OBSERVED':'SOURCE_INTENT')))[1],projected=manual?event:[...h.documents].find(([key])=>key.endsWith('/events/SOURCE_PROJECTED'))[1],expected={sourceSnapshot:event.payload.sourceSnapshot??event.payload.expectedSourceAfter,sourceRevision:projected.payload.postCatalog.sourceRevision,dependencyHash:event.payload.dependencyHash};
  h.sheetsData.get(2026101601).get(2)[20].effectiveValue={numberValue:625};const reads=h.load('case-list-gas-read-ports').createGasReadPorts({readMonthly:()=>h.load('case-list-monthly-reader').readCaseListMonthlySnapshot(h.COMPANY,h.CASE,{includeDependencies:true}),hash:h.helpers.hashCaseList});await assert.rejects(()=>reads.assertSource({companyId:h.COMPANY,uid:h.owner.auth.uid,email:'owner@example.invalid'},h.CASE,expected));
 });
 }

 for(const manual of [false,true])for(const select of [true,false])for(const [label,delay,reason]of [['within 60 seconds',30000,null],['guard exceeds 60 seconds',61000,/EXTERNAL_READBACK_EXPIRED_BEFORE_WRITE/],['lease expires during guard',121000,/EXTERNAL_COMPANY_LEASE_EXPIRED/]])await test((manual?'manual':'application')+' '+(select?'selection':'acceptance')+' async '+label,async()=>{
  const f=await h.start(manual,true,blanks),opPath=[...h.documents].find(([key])=>key.startsWith('caseListMonthlyOperations/')&&!key.includes('/events/'))[0],op=h.documents.get(opPath),q=h.documents.get('sheetSyncQueue/'+f.queueId);
  if(select){delete op.externalSelection;q.status='blocked';q.errorType=manual?'external_transfer_selection_required':'owner_transfer_required';}else h.archiveFixture(f);
  const writesBefore=h.documentWrites.length,queueRef=h.db.collection('sheetSyncQueue').doc(f.queueId),external=h.load('case-list-external-transfer');let guarded=0;
  const guard=async()=>{await Promise.resolve();guarded++;h.advanceClock(delay);};
  const invoke=()=>select?external.selectExternalCaseListMonthlyTransferForHandoff(queueRef,h.owner.auth.uid,h.owner.auth.token,{reviewKey:q.caseListPhase.continuationHash,clientNameUpConfirmed:true},guard):external.reconcileExternalCaseListMonthlyTransferForHandoff(queueRef,h.owner.auth.uid,h.owner.auth.token,guard);
  if(reason){await assert.rejects(invoke,reason);assert.equal(guarded,1);const business=h.documentWrites.slice(writesBefore).filter(key=>!key.startsWith('caseListSyncLocks/'));assert.deepEqual(business,[],'must stop before the first business mutation');assert.equal(h.documents.get('jobs/'+h.jobId).applicationUnconfirmed,true);assert.equal(h.documents.get(opPath).externalAcceptance,undefined);if(select)assert.equal(h.documents.get(opPath).externalSelection,undefined);}
  else{await invoke();assert.equal(guarded,1);const current=h.documents.get(opPath);assert.equal(current.externalSelection.readWindow,undefined);if(!select){assert.equal(h.documents.get('jobs/'+h.jobId).applicationUnconfirmed,false);assert.equal(current.externalAcceptance.readWindow,undefined);}}
 });
 const full=Array.from({length:65},()=>({}));full[28]=h.literal(8000);full[29]=h.literal(2000);full[36]=h.literal(10000);
 for(const [name,mutate]of [
 ['unknown cell',r=>{r.cells[20]={$unknown:true};}],['unread coverage',r=>{r.fullWritable=false;}],['missing column',r=>{r.knownColumns.splice(20,1);}],['duplicate known column',r=>{r.knownColumns[20]=19;}],['hole',r=>{delete r.cells[20];}],['null cell',r=>{r.cells[20]=null;}],['null value',r=>{r.cells[20]={effectiveValue:null};}],['formula error',r=>{r.cells[20]={effectiveValue:{errorValue:{type:'N_A'}}};}],['nonfinite',r=>{r.cells[20]={effectiveValue:{numberValue:Infinity}};}],['NaN',r=>{r.cells[20]={effectiveValue:{numberValue:NaN}};}],['unread formula',r=>{r.cells[20]={userEnteredValue:{formulaValue:'=X1'}};}],['salary blank',r=>{r.cells[28]={};}],['allowance blank',r=>{r.cells[29]={};}],['promised pay blank',r=>{r.cells[36]={};}]
 ])await test('observed boundary rejects '+name,()=>{const r=row(clone(full));mutate(r);assert.throws(()=>observation.sourcePay(r,10000));});
 await test('raw blank, zero and formula blank keep separate values and formulas',()=>{const r=row(clone(full));r.cells[20]={};r.cells[21]=h.literal(0);r.cells[22]={userEnteredValue:{formulaValue:'=IF(TRUE,"",1)'},effectiveValue:{stringValue:''}};const values=observation.sourcePay(r,10000);assert.equal(values[20],'');assert.equal(values[21],0);assert.equal(values[22],'');assert(r.cells[22].userEnteredValue.formulaValue);});
 await test('dependency missing and mismatched hash reject',()=>{assert.throws(()=>observation.dependency(undefined,'a'.repeat(64)));assert.throws(()=>observation.dependency('a'.repeat(64),'b'.repeat(64)));});
 console.log(JSON.stringify({passed:results.filter(x=>x.passed).length,total:results.length,results,actualHandlers:true,sourceSentReceipt:'synthetic readback only',network:false},null,2));if(results.some(x=>!x.passed))process.exitCode=1;
})();
