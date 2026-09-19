import assert from 'node:assert/strict';import {fixture} from './case-mail-assignment-harness.mjs';import {clone,companyId} from './case-mail-test-harness.mjs';
const columns={transportation:'AK',purchase8:'AL',purchase10:'AM',netPrintCost:'AO',postageCost:'AP'},index=column=>[...column].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
const results=[];async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.stack});}}
async function setup(){
 const h=await fixture();await h.apply();await h.run();Object.assign(h.records.get(h.paths.mapping).columns,columns);h.records.get(h.paths.mapping).operations['expense.review']={values:Object.keys(columns)};
 h.row[index('AK')]=1000;h.row[index('AL')]=0;h.row[index('AM')]='';h.row[index('AO')]=120;h.row[index('AP')]=430;h.row[index('AN')]='=SUM(AK2:AM2)';h.row[index('AQ')]='=SUM(AO2:AP2)';await h.importRow(columns);
 const original=h.sheets.spreadsheets.values.batchGet;
 h.formulas=new Map();h.formulaReads=0;
 h.sheets.spreadsheets.values.batchGet=async request=>{if(request.valueRenderOption==='FORMULA'){h.formulaReads++;await h.beforeFormula?.();const values=request.ranges.map(range=>{const col=/!([A-Z]+)2$/.exec(range)?.[1];assert.ok(col);return {values:[[h.formulas.get(col)??h.row[index(col)]??'']]};});await h.afterFormula?.();return {data:{valueRanges:h.malformedFormula?values.slice(1):values}};}return original(request);};
 h.api=h.load('./admin-operations');h.read=()=>h.api.getExpenseReview({auth:h.auth,data:{jobId:h.jobId}});
 h.review=()=>h.records.get('expenseReviews/'+h.jobId);h.expenseQueue=()=>h.records.get('sheetSyncQueue/'+h.review()?.queueId);
 h.write=async(complete=true,patch={},auth=h.auth)=>{const read=await h.read();return h.api[complete?'completeExpenseReview':'saveExpenseReviewDraft']({auth,data:{jobId:h.jobId,expectedVersion:read.reviewVersion,values:{transportation:1500,purchase8:0,purchase10:null,netPrintCost:200,postageCost:430},note:'合成経費確認',...patch}});};
 h.runExpense=async()=>h.load('./safe-sheet-writes').processSafeSheetWrite({data:{after:await h.load('./firebase').db.doc('sheetSyncQueue/'+h.review().queueId).get()}});
 h.finalize=async()=>h.api.updateExpenseReviewFromQueue({data:{after:await h.load('./firebase').db.doc('sheetSyncQueue/'+h.review().queueId).get()}});
 return h;
}
await test('received -> assigned -> expense draft -> review -> five columns -> completed -> import',async()=>{
 const h=await setup();const read=await h.read();assert.equal(read.job.receivedMail,true);assert.equal(read.writeBlockedReason,null);assert.equal(read.currentValues.transportation,1000);
 await h.write(false);assert.equal(h.review().status,'draft');await h.write();assert.equal(h.review().status,'queued');assert.equal(h.job().expenses.transportation,1000);
 const before=clone(h.row),count=h.writes.length;await h.runExpense();assert.equal(h.expenseQueue().status,'completed');assert.equal(h.writes.length,count+1);const data=h.writes.at(-1).requestBody;assert.equal(data.valueInputOption,'RAW');assert.equal(data.data.length,5);
 for(let n=0;n<h.row.length;n++)if(!Object.values(columns).some(c=>index(c)===n))assert.equal(h.row[n],before[n]);assert.equal(h.row[index('AK')],1500);assert.equal(h.row[index('AL')],0);assert.equal(h.row[index('AM')],'');
 await h.finalize();assert.equal(h.review().status,'completed');assert.equal(h.job().expenses.transportation,1500);assert.equal(h.job().expenseReviewStatus,'completed');await h.importRow(columns);await h.finalize();assert.equal(h.job().expenses.netPrintCost,200);assert.equal(h.review().status,'completed');
 await h.runExpense();assert.equal(h.writes.length,count+1);
});
const held=[{mailIntakeReviewRequired:true},{pendingSourceWrite:true},{adminEditSheetWrite:{pending:true}},{applicationUnconfirmed:true},{assignmentUnresolved:true},{sourceMissing:true},{appOverride:{active:true}},{status:'draft'},{revision:undefined}];
for(const patch of held)await test('held admission '+JSON.stringify(patch),async()=>{
 const h=await setup();Object.assign(h.job(),patch);const read=await h.read();assert.ok(read.writeBlockedReason);const before=JSON.stringify([...h.records]);for(const complete of [false,true])await assert.rejects(h.write(complete),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);
});
for(const complete of [false,true])for(const change of ['omit-version','mail-hold','conditions','revision','amount','staff','source-row'])await test('displayed version '+complete+' '+change,async()=>{
 const h=await setup(),read=await h.read();if(change==='mail-hold')h.job().mailIntakeReviewRequired=true;if(change==='conditions')h.job().menuConditions=['別条件'];if(change==='revision')h.job().revision++;if(change==='amount')h.job().expenses.transportation=500;if(change==='staff')h.job().assignedStaffId='staff-2';if(change==='source-row')h.job().sheetRef.currentRow=7;
 const before=JSON.stringify([...h.records]);await assert.rejects(h.write(complete,{expectedVersion:change==='omit-version'?undefined:read.reviewVersion}),{code:'failed-precondition'});assert.equal(JSON.stringify([...h.records]),before);
});
for(const mutation of ['hold','condition','money','review','company'])await test('transaction changes '+mutation,async()=>{
 const h=await setup();let changed=false;h.beforeCommit=({writes})=>{if(changed||!writes.some(w=>w.data.operation==='expense.review'))return;changed=true;if(mutation==='hold')h.job().mailIntakeReviewRequired=true;if(mutation==='condition')h.job().menuConditions=['変更'];if(mutation==='money')h.job().expenses.transportation=700;if(mutation==='review')h.records.set('expenseReviews/'+h.jobId,{companyId,jobId:h.jobId,note:'別の確認'});if(mutation==='company')h.job().companyId='other';};await assert.rejects(h.write());assert.equal(h.list('sheetSyncQueue').filter(x=>x.operation==='expense.review').length,0);
});
for(const change of ['hold','conditions','revision','staff','mapping','formula','short-formula','source-time','source-staff','source-money'])await test('queued write stops '+change,async()=>{
 const h=await setup();await h.write();const before=h.writes.length;
 if(change==='hold')h.job().mailIntakeReviewRequired=true;if(change==='conditions')h.job().menuConditions=['変更'];if(change==='revision')h.job().revision++;if(change==='staff')h.job().assignedStaffId='staff-2';if(change==='mapping')h.records.get(h.paths.mapping).columns.transportation='AN';if(change==='formula')h.formulas.set('AK','=SUM(A1:A2)');if(change==='short-formula')h.malformedFormula=true;if(change==='source-time')h.row[14]='11:00-19:00';if(change==='source-staff')h.row[1]='別スタッフ';if(change==='source-money')h.row[index('AK')]=1900;
 await h.runExpense();assert.equal(h.expenseQueue().status,'blocked');assert.equal(h.writes.length,before);await h.finalize();assert.equal(h.review().status,change==='staff'?'queued':'error');assert.equal(h.job().expenses.transportation,1000);
});
for(const moment of ['formula-read','before-write','after-write','completion'])await test('hold during external boundary '+moment,async()=>{
 const h=await setup();await h.write();const before=h.writes.length;
 if(moment==='formula-read')h.afterFormula=()=>{h.job().mailIntakeReviewRequired=true;};if(moment==='before-write')h.afterFormula=()=>{if(h.formulaReads===2)h.job().mailIntakeReviewRequired=true;};if(moment==='after-write')h.afterWrite=()=>{h.job().mailIntakeReviewRequired=true;};
 if(moment==='completion'){let changed=false;h.beforeCommit=({writes})=>{if(!changed&&writes.some(w=>w.data.status==='completed')){changed=true;h.job().mailIntakeReviewRequired=true;}};}
 await h.runExpense();assert.equal(h.expenseQueue().status,'blocked');assert.equal(h.writes.length,before+(['after-write','completion'].includes(moment)?1:0));if(['after-write','completion'].includes(moment))assert.equal(h.expenseQueue().errorType,'verification_required');await h.finalize();assert.equal(h.review().status,'error');assert.equal(h.job().expenses.transportation,1000);
});
await test('formula introduced on second read prevents write',async()=>{const h=await setup();await h.write();const n=h.writes.length;h.beforeFormula=()=>{if(h.formulaReads===2)h.formulas.set('AP','=1+1');};await h.runExpense();assert.equal(h.expenseQueue().status,'blocked');assert.equal(h.writes.length,n);});
for(const change of ['hold','conditions','revision','cancel-policy'])await test('delayed completion does not accept changed job '+change,async()=>{
 const h=await setup();await h.write();await h.runExpense();if(change==='hold')h.job().mailIntakeReviewRequired=true;if(change==='conditions')h.job().menuConditions=['変更'];if(change==='revision')h.job().revision++;if(change==='cancel-policy')h.job().cancellationFinancialTreatment='invoice_only';await h.finalize();assert.equal(h.review().status,'error');assert.equal(h.review().sheetWriteStatus,'completed');assert.equal(h.job().expenses.transportation,1000);assert.notEqual(h.job().expenseReviewStatus,'completed');
});
await test('imported written amounts before finalizer are accepted once',async()=>{const h=await setup();await h.write();await h.runExpense();await h.importRow(columns);await h.finalize();assert.equal(h.review().status,'completed');const saved=JSON.stringify(h.job());h.job().expenses.transportation=9999;await h.finalize();assert.equal(h.job().expenses.transportation,9999);});
await test('actual changed mail freezes existing expense intent',async()=>{const h=await setup();await h.write();const n=h.writes.length;await h.changeMail();await h.runExpense();assert.equal(h.expenseQueue().status,'blocked');assert.equal(h.writes.length,n);assert.equal(h.job().assignedStaffId,'staff-1');});
await test('source-confirmed cancellation can record actual costs',async()=>{const h=await setup();h.row[9]+='（キャンセル）';await h.importRow(columns);assert.equal(h.job().status,'cancelled');assert.equal((await h.read()).writeBlockedReason,null);await h.write();await h.runExpense();assert.equal(h.expenseQueue().status,'completed');await h.finalize();assert.equal(h.review().status,'completed');assert.equal(h.job().expenses.transportation,1500);});
await test('currency formatting uses existing monetary parser',async()=>{const h=await setup();await h.write();h.row[index('AK')]='￥1,000';await h.runExpense();assert.equal(h.expenseQueue().status,'completed');});
for(const auth of [{uid:'other',token:{companyId:'other',role:'admin'}},{uid:'staff-user',token:{companyId,role:'staff',staffId:'staff-1'}}])await test('expense authorization '+auth.token.role+'/'+auth.token.companyId,async()=>{const h=await setup(),before=JSON.stringify([...h.records]);await assert.rejects(h.write(true,{},auth));assert.equal(JSON.stringify([...h.records]),before);});
console.log(JSON.stringify({passed:results.filter(r=>r.passed).length,total:results.length,results,scope:'Actual received-mail creation, publication, assignment, import, expense API, worker and completion; synthetic Firestore/Sheets only, no real reads or writes'},null,2));if(results.some(r=>!r.passed))process.exitCode=1;
