const assert=require('node:assert/strict');
const {readFileSync,writeFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
// Reuse the reviewed synthetic harness definitions without executing its suite.
const source=readFileSync(path.join(__dirname,'test-source-io.cjs'),'utf8').replace(/^main\(\)\.catch[^\n]+$/m,'');
const sandbox={require,module:{exports:{}},console,process,__dirname};
vm.runInNewContext(source+'\nmodule.exports={fixture,core,ids,bookId,company,caseId,jobId,str,clone,dbMock,load};',sandbox,{filename:path.join(__dirname,'test-source-io.cjs')});
const {fixture,core,bookId,company,caseId,str,clone,dbMock,load}=sandbox.module.exports;
const originalAdapter=require('../../functions/src/case-list-monthly-adapter.cjs');
const monthlyCore=require('../../functions/src/case-list-monthly-controller.cjs');
class HttpsError extends Error {constructor(code,message,details){super(message);this.code=code;this.details=details;}}
const dependencies=['スタッフマスタ','各社見積書','イオンデモ遠方リスト','ケイ_応募日補助'];
function environment(){
 const f=fixture();
 const tables=[
   {id:2026101601,title:'案件リスト',rows:f.rows,width:65},
   {id:2026102605,title:'案件_実績台帳',rows:f.ledger,width:25},
   {id:1773116117,title:'2026.11',rows:[monthlyCore.BUSINESS_HEADERS.concat('連絡_固定案件ID').map(str),Array.from({length:55},()=>({}))],width:55},
   {id:434431224,title:'2026.12',rows:[monthlyCore.BUSINESS_HEADERS.concat('','連絡_固定案件ID').map(str),Array.from({length:56},()=>({}))],width:56},
   ...dependencies.map((title,i)=>({id:100+i,title,rows:[[str('合成参照見出し')],[{userEnteredValue:{numberValue:1000+i},effectiveValue:{numberValue:1000+i}}]],width:1})),
 ];
 const db=dbMock({['sheetImportConfigs/'+company]:{companyId:company,spreadsheetId:bookId,caseListEnabled:true}});
 const calls=[],hooks={metadata:null,full:null,dependency:null};
 const google={spreadsheets:{get:async request=>{
   calls.push(clone(request));assert.equal(request.spreadsheetId,bookId);
   const wanted=request.ranges?tables.filter(t=>request.ranges.some(r=>r.startsWith("'"+t.title+"'!"))):tables;
   const result={data:{spreadsheetId:bookId,properties:{timeZone:'Asia/Tokyo'},sheets:wanted.map(t=>({properties:{sheetId:t.id,title:t.title,gridProperties:{rowCount:t.rows.length,columnCount:t.width}},...(request.includeGridData?{data:[{startRow:0,startColumn:0,rowData:t.rows.map(values=>({values:clone(values)}))}]}:{})}))}};
   const hook=!request.ranges?hooks.metadata:request.ranges.some(r=>r.startsWith("'案件リスト'!"))?hooks.full:hooks.dependency;
   if(hook)hook(result);return result;
 }}};
 const reader=load('case-list-monthly-reader.ts',{'./firebase':{db:db.db},'./sheet-reader':{createReadOnlySheetsClient:async()=>google},'firebase-functions/v2/https':{HttpsError},'./case-list-source-core':core,'./case-list-monthly-adapter.cjs':originalAdapter},['readCaseListMonthlySnapshot']);
 return {f,tables,db,calls,hooks,reader};
}
const results=[];async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.stack});}}
async function rejects(fn){await assert.rejects(fn,error=>error.code==='failed-precondition');}
async function main(){
 await test('default reader invokes real snapshot parser with bounded full65/25/55/56 reads and zero writes',async()=>{const e=environment(),out=await e.reader.readCaseListMonthlySnapshot(company,caseId);assert.equal(e.calls.length,2);assert.equal(e.db.writes.length,0);assert.equal(out.source.headers.length,65);assert.equal(out.rawRows.length,2);assert.equal(out.rawLedgerRows.length,4);assert.equal(out.months.length,2);assert.equal(out.months[0].headers.length,55);assert.equal(out.months[1].headers.length,56);assert.equal(out.catalog.sourceRevision,core.inspectCaseList(e.f.rows,e.f.ledger,'2026-10-27T00:00:00.000Z',bookId).jobs[0].source.sourceRevision);assert.equal(out.dependencyHash,core.hashCaseList(null));assert.deepEqual(Array.from(e.calls[1].ranges),["'案件リスト'!A1:BM2","'案件_実績台帳'!A1:Y4","'2026.11'!A1:BC2","'2026.12'!A1:BD2"]);for(const key of ['userEnteredValue','effectiveValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'])assert.ok(e.calls[1].fields.includes(key));});
 await test('worker dependency read uses bounded UEV/eV and changes hash on reference value changes',async()=>{const e=environment();const a=await e.reader.readCaseListMonthlySnapshot(company,caseId,{includeDependencies:true});assert.equal(e.calls.length,3);assert.equal(e.calls[2].ranges.length,4);assert.ok(e.calls[2].fields.includes('userEnteredValue,effectiveValue'));assert.equal(e.calls[2].fields.includes('userEnteredFormat'),false);e.tables[4].rows[1][0]={userEnteredValue:{numberValue:2000},effectiveValue:{numberValue:2000}};const b=await e.reader.readCaseListMonthlySnapshot(company,caseId,{includeDependencies:true});assert.notEqual(a.dependencyHash,b.dependencyHash);assert.equal(e.db.writes.length,0);});
 await test('unknown staffing stays unverified; trusted resolver supplies verified same identity',async()=>{const e=environment();e.f.rows[1][2]=str('合成担当');e.tables[2].rows[1][1]=str('合成担当');const unknown=await e.reader.readCaseListMonthlySnapshot(company,caseId);assert.equal(unknown.source.rows[0].staffIdentityVerified,false);assert.equal(unknown.months[0].rows[0].staffIdentityVerified,false);const known=await e.reader.readCaseListMonthlySnapshot(company,caseId,{resolveStaff:name=>name==='合成担当'?{staffId:'verified-staff',identityVerified:true}:null});assert.equal(known.source.rows[0].staffId,'verified-staff');assert.equal(known.months[0].rows[0].staffIdentityVerified,true);});
 await test('December BC value survives reader and fixed ID remains BD',async()=>{const e=environment();e.tables[3].rows[1][54]=str('保持するBC手入力');e.tables[3].rows[1][55]=str('December-fixed');const out=await e.reader.readCaseListMonthlySnapshot(company,caseId);assert.equal(out.months[1].rows[0].cells[54].userEnteredValue.stringValue,'保持するBC手入力');assert.equal(out.months[1].rows[0].fixedId,'December-fixed');assert.equal(e.db.writes.length,0);});
 await test('malformed configured book stops before Google request',async()=>{const e=environment();e.db.state.get('sheetImportConfigs/'+company).spreadsheetId='wrong';await rejects(()=>e.reader.readCaseListMonthlySnapshot(company,caseId));assert.equal(e.calls.length,0);});
 await test('disabled configuration stops before Google request',async()=>{const e=environment();e.db.state.get('sheetImportConfigs/'+company).caseListEnabled=false;await rejects(()=>e.reader.readCaseListMonthlySnapshot(company,caseId));assert.equal(e.calls.length,0);});
 for(const [name,change] of [['response book',r=>r.data.spreadsheetId='wrong'],['timezone',r=>r.data.properties.timeZone='UTC'],['November fixed sheet ID',r=>r.data.sheets.find(s=>s.properties.title==='2026.11').properties.sheetId=2],['December width',r=>r.data.sheets.find(s=>s.properties.title==='2026.12').properties.gridProperties.columnCount=55]])await test('metadata '+name+' mismatch blocks full read',async()=>{const e=environment();e.hooks.metadata=change;await rejects(()=>e.reader.readCaseListMonthlySnapshot(company,caseId));assert.equal(e.calls.length,1);});
 await test('missing reference tab blocks worker dependency read but permits capability read',async()=>{const e=environment();e.tables.pop();await rejects(()=>e.reader.readCaseListMonthlySnapshot(company,caseId,{includeDependencies:true}));assert.equal(e.calls.length,1);const out=await e.reader.readCaseListMonthlySnapshot(company,caseId);assert.equal(out.months.length,2);});
 await test('source structure changed between metadata and grid rejects snapshot',async()=>{const e=environment();e.hooks.full=r=>r.data.sheets[0].properties.gridProperties.rowCount++;await rejects(()=>e.reader.readCaseListMonthlySnapshot(company,caseId));assert.equal(e.db.writes.length,0);});
 await test('grid offset outside bound rejects snapshot',async()=>{const e=environment();e.hooks.full=r=>r.data.sheets[0].data[0].startRow=-1;await rejects(()=>e.reader.readCaseListMonthlySnapshot(company,caseId));assert.equal(e.db.writes.length,0);});
 await test('ledger edit changes returned authority hash with Source C unchanged',async()=>{const e=environment();const before=await e.reader.readCaseListMonthlySnapshot(company,caseId);e.f.ledger[3][9]=str('新しい担当');const after=await e.reader.readCaseListMonthlySnapshot(company,caseId);assert.notEqual(before.catalog.sourceRevision,after.catalog.sourceRevision);assert.notEqual(before.catalog.ledgerRevision,after.catalog.ledgerRevision);assert.equal(before.catalog.rowRevision,after.catalog.rowRevision);});
 const report={status:results.every(r=>r.passed)?'PASS':'FAIL',tests:results.length,passed:results.filter(r=>r.passed).length,scope:'ACTUAL_TYPESCRIPT_READER_AND_CJS_SNAPSHOT_PARSER_WITH_MOCKED_GOOGLE_DB_ONLY',nativeGoogle:false,nativeFirestore:false,externalWrites:0,results};console.log(JSON.stringify(report,null,2));if(report.status!=='PASS')process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
