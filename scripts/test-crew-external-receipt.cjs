'use strict';
// Executes the actual TS worker/Core with fully synthetic fixtures and mocked I/O.
// Uses Node built-in TypeScript syntax stripping; it performs no cloud calls.
// This is not a TypeScript semantic build or a real Firebase/Google acceptance.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {stripTypeScriptTypes,createRequire}=require('node:module');
const gasOriginal=require('./fixtures/crew-external-gas-reference.cjs');
const repoRoot=path.resolve(__dirname,'..');
const src=path.join(repoRoot,'functions/src');
const clientRequire=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||repoRoot,'package.json'));
const serverRequire=createRequire(path.join(process.env.LKC_TEST_SERVER_DEPENDENCY_ROOT||repoRoot,'package.json'));

const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
class Stamp{constructor(ms){this.ms=ms;}toMillis(){return this.ms;}toDate(){return new Date(this.ms);}static now(){return new Stamp(Date.now());}static fromMillis(ms){return new Stamp(ms);}static fromDate(date){return Stamp.fromMillis(date.getTime());}}
const DELETE={delete:true},FieldValue={serverTimestamp:()=>Stamp.now(),delete:()=>DELETE,increment:n=>({__increment:n})};
function copy(x){if(x instanceof Stamp)return new Stamp(x.ms);if(Array.isArray(x))return x.map(copy);if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,copy(v)]));return x;}
let clockOffset=0;class Clock extends Date{static now(){return Date.now()+clockOffset;}}
let beforeTransaction=null,archiveReadHook=null,gasReadHook=null;
let googleReadHandler=null;let operational=true,nativeCalls=0,documents=new Map(),writes=0,readerProvider=null,nativeHandler=null,txTail=Promise.resolve(),afterCommit=null,generated=0;
const documentReads=[],documentWrites=[];
class Doc{constructor(p){this.path=p;this.id=p.split('/').pop();}async get(){documentReads.push(this.path);const data=documents.get(this.path);return {exists:data!==undefined,ref:this,id:this.id,data:()=>copy(data)};}collection(n){return new Query(this.path+'/'+n);}}
class Query{constructor(p,filters=[],max=Infinity,after=null){this.path=p;this.filters=filters;this.max=max;this.after=after;}doc(id){return new Doc(this.path+'/'+(id??('generated_fixture_'+(++generated))));}where(k,op,v){assert(['==','in','>=','<='].includes(op));return new Query(this.path,[...this.filters,[k,v,op]],this.max,this.after);}limit(n){return new Query(this.path,this.filters,n,this.after);}orderBy(field){assert(['__name__','updatedAt'].includes(field));return this;}startAfter(id){return new Query(this.path,this.filters,this.max,id);}async get(){documentReads.push(this.path+'/*');const found=[...documents].filter(([p,v])=>p.startsWith(this.path+'/')&&!p.slice(this.path.length+1).includes('/')&&this.filters.every(([k,w,op])=>op==='in'?w.includes(v[k]):op==='>='?v[k]>=w:op==='<='?v[k]<=w:v[k]===w)&&(!this.after||p.split('/').pop()>this.after)).sort(([a],[b])=>a<b?-1:a>b?1:0).slice(0,this.max);const docs=found.map(([p,data])=>({id:p.split('/').pop(),ref:new Doc(p),data:()=>copy(data)}));return {docs,size:docs.length};}}

const db={collection:n=>new Query(n),runTransaction:async fn=>{const previous=txTail;let release;txTail=new Promise(r=>release=r);await previous;try{const pending=[];const tx={get:r=>r.get(),set:(r,v,o)=>pending.push(['set',r,v,o]),update:(r,v)=>pending.push(['set',r,v,{merge:true}]),create:(r,v)=>{assert(!documents.has(r.path));pending.push(['set',r,v,{}]);},delete:r=>pending.push(['delete',r])};if(beforeTransaction){const f=beforeTransaction;beforeTransaction=null;f();}const out=await fn(tx);for(const [kind,r,v,o]of pending){writes++;documentWrites.push(r.path);if(kind==='delete'){documents.delete(r.path);continue;}const data=o?.merge?copy(documents.get(r.path)||{}):{};for(const [k,val]of Object.entries(v)){if(val===DELETE)delete data[k];else if(val?.__increment!==undefined)data[k]=Number(data[k]??0)+val.__increment;else data[k]=copy(val);}documents.set(r.path,data);}if(afterCommit)afterCommit();return out;}finally{release();}}};
db.getAll=async(...refs)=>Promise.all(refs.map(ref=>ref.get()));
let bindingReadTransactions=0;
const runTransaction=db.runTransaction;
db.runTransaction=(fn,options)=>options?.readOnly===true?runTransaction(tx=>{
 bindingReadTransactions++;
 const forbidden=()=>assert.fail('Read-only binding attempted a document mutation');
 return fn({...tx,set:forbidden,update:forbidden,create:forbidden,delete:forbidden});
}):runTransaction(fn);
const cache=new Map();
const runtimeEnvironment={APP_ENVIRONMENT:'staging',EXECUTIVE_APPROVER_EMAILS:'owner@example.invalid',LKC_CASE_LIST_EXTERNAL_MODE:'enabled'};
function load(name){const file=path.join(src,name+'.ts');if(cache.has(file))return cache.get(file);const source=fs.readFileSync(file,'utf8');const exports=[...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gm)].map(m=>m[1]);let js=stripTypeScriptTypes(source,{mode:'transform'});js=js.replace(/^import\s+\{([^}]+)\}\s+from\s+"([^"]+)";?$/gm,(_,names,module)=>'const {'+names+'} = require('+JSON.stringify(module)+');').replace(/^export\s+/gm,'');js+='\nmodule.exports={'+exports.join(',')+'};';const context={Buffer,process:{env:runtimeEnvironment},Error,Date:Clock,fetch:()=>{throw Error('EXTERNAL_NETWORK_FORBIDDEN');},module:{exports:{}},console,require:specifier=>{
  if(specifier==='node:crypto')return require(specifier);
  if(specifier==='firebase-functions/v2/https')return {onCall:(...args)=>args.at(-1),HttpsError:class extends Error{constructor(code,message,details){super(message);this.code=code;this.details=details;}}};
  if(specifier==='firebase-functions/v2/firestore')return {onDocumentWritten:(...args)=>args.at(-1),onDocumentCreated:(...args)=>args.at(-1)};
  if(specifier==='firebase-functions/v2/scheduler')return {onSchedule:(...args)=>args.at(-1)};
  if(specifier==='firebase-functions/v2/storage')return {onObjectFinalized:(...args)=>args.at(-1)};
  if(specifier==='node:path')return require(specifier);
  if(specifier==='firebase-admin/firestore')return {Timestamp:Stamp,FieldValue,FieldPath:{documentId:()=>"__name__"}};
  if(specifier==='googleapis')return {google:{auth:{GoogleAuth:class{}},sheets:()=>({spreadsheets:{get:async request=>{if(!googleReadHandler)throw Error('GOOGLE_READ_NOT_BOUND');return {data:await googleReadHandler(request)};},batchUpdate:async(body,options)=>{nativeCalls++;if(!nativeHandler)throw Error('GOOGLE_WRITE_FORBIDDEN');return nativeHandler(body,options);}}})}};
  if(specifier==='./firebase')return {db};
  if(specifier==='zod')return serverRequire('zod');
  if(specifier==='./utils')return load('utils');
  if(specifier==='./automation-intake')return {readMailApplicationForAssignment:async()=>assert.fail('Cancellation fixture cannot read mail applications')};
  if(specifier==='./case-mail-publication')return {readMailPublication:async()=>assert.fail('Cancellation fixture cannot read mail publication')};
  if(specifier==='./case-list-source')return load('case-list-source');
  if(specifier==='./system-safety')return {getProductionOperationalState:async()=>({operational}),assertProductionOperational:async()=>{if(!operational)throw Object.assign(new Error('stopped'),{code:'failed-precondition'});}};
  if(specifier==='./case-list-monthly-reader')return load('case-list-monthly-reader');
  // These downstream I/O ports must remain unreachable in backend refusal tests.
  if(specifier==='./google-drive-client')return {getWritableDriveClient:()=>assert.fail('Drive transport forbidden')};
  if(specifier==='./drive-transfer')return Object.fromEntries(['assertTransferCheckpoint','assertTransferSource','transferSource','transferWithStableId'].map(k=>[k,()=>assert.fail('Transfer boundary forbidden: '+k)]));
  if(specifier==='./drive-folder-cache')return {readCachedFolderId:()=>assert.fail('Folder read forbidden'),writeCachedFolderId:()=>assert.fail('Folder write forbidden')};
  if(specifier==='./resubmissions')return {markResubmissionReplacementFile:()=>assert.fail('Replacement write forbidden'),markResubmissionSubmitted:()=>assert.fail('Resubmission write forbidden')};
  if(specifier.endsWith('.cjs'))return require(path.resolve(path.dirname(file),specifier));
  if(specifier.startsWith('./'))return load(specifier.slice(2));
  throw Error('Unexpected import '+specifier);
}};vm.runInNewContext(js,context,{filename:file});cache.set(file,context.module.exports);return context.module.exports;}

const inputSrc=path.join(src,'case-list-projection.cjs'),Projection=require(inputSrc),Native=require(path.join(src,'case-list-monthly-controller.cjs'));
let lastPreview=null;
const nativeCreate=Native.create;Native.create=services=>{const c=nativeCreate(services);return {...c,preview:async r=>{const out=await c.preview(r);lastPreview=out;return out;}};};
const helpers=load('case-list-source-core'),ids=load('case-id'),jobs=load('jobs'),admin=load('admin-operations'),importer=load('case-list-source'),worker=load('case-list-monthly-worker'),priv=load('case-list-private-ref');
const BOOK='SERVER_BOOK_SYNTHETIC001',CASE='LKCASE_00000000-0000-0000-0000-000000000001',OTHER='LKCASE_00000000-0000-0000-0000-000000000002';
const COMPANY='company_synthetic',STAFF='staff_synthetic',NAME='架空担当',OWNER='owner_synthetic';
const owner={auth:{uid:OWNER,token:{uid:OWNER,companyId:COMPANY,role:'admin',email:'owner@example.invalid',email_verified:true}}};
const staffAuth={auth:{uid:'staff_uid_synthetic',token:{companyId:COMPANY,role:'staff',staffId:STAFF}}};
const BUSINESS=Native.BUSINESS_HEADERS,DATE='2026-12-06',serial=d=>(Date.parse(d+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000;
const literal=v=>{const key=typeof v==='number'?'numberValue':typeof v==='boolean'?'boolValue':'stringValue';return {userEnteredValue:{[key]:v},effectiveValue:{[key]:v}};};
const cellValue=c=>{const v=c?.effectiveValue??c?.userEnteredValue??{};return v.numberValue??v.stringValue??v.boolValue??'';};
const feeIndices=[...Array.from({length:26},(_,i)=>i+18),...Array.from({length:7},(_,i)=>i+47)];
const shaValue=helpers.hashCaseList;
let sheetsData,metadata,requests=[],afterRead=null,jobId,lastGasMonthResponse=null;
const col=s=>[...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
function googleRead(request){
 assert.equal(request.spreadsheetId,BOOK);requests.push(copy(request));if(afterRead){const f=afterRead;afterRead=null;f();}
 if(!request.ranges)return copy(metadata);
 const selected=new Map(),fields=['userEnteredValue','effectiveValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns','effectiveFormat'].filter(k=>new RegExp('\\b'+k+'\\b').test(request.fields??''));
 for(const range of request.ranges){
  const m=/^'((?:[^']|'')+)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);assert(m,'bounded range: '+range);
  const sheet=metadata.sheets.find(s=>s.properties.title===m[1].replace(/''/g,"'"));assert(sheet);
  const start=Number(m[3])-1,end=Number(m[5]),c0=col(m[2]),c1=col(m[4])+1;
  assert(end<=sheet.properties.gridProperties.rowCount&&c1<=sheet.properties.gridProperties.columnCount);
  if(!selected.has(sheet.properties.sheetId))selected.set(sheet.properties.sheetId,{properties:copy(sheet.properties),data:[]});
  const table=sheetsData.get(sheet.properties.sheetId);
  selected.get(sheet.properties.sheetId).data.push({startRow:start,startColumn:c0,rowData:Array.from({length:end-start},(_,i)=>({values:Array.from({length:c1-c0},(_,j)=>{
   const raw=table.get(start+i+1)?.[c0+j]??{};return Object.fromEntries(fields.filter(k=>Object.hasOwn(raw,k)).map(k=>[k,copy(raw[k])]));
  })}))});
 }
 if(archiveReadHook && request.fields?.includes('effectiveFormat') && request.ranges.some(r=>r.startsWith("'案件_実績台帳'!A4:Y4"))){const hook=archiveReadHook;archiveReadHook=null;hook();}
 const response={spreadsheetId:BOOK,properties:{timeZone:'Asia/Tokyo'},sheets:[...selected.values()]};
 if(request.ranges.length===1&&request.ranges[0]==="'2026.12'!A2:O5"){
  const result=gasReadHook?(()=>{const hook=gasReadHook;gasReadHook=null;return hook(response);})():response;
  lastGasMonthResponse=copy(result);return result;
 }return response;
}
function resetFixture(manual=false,modern=false){
 runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='enabled';clockOffset=0;documents=new Map();writes=0;generated=0;nativeCalls=0;requests=[];documentReads.length=0;documentWrites.length=0;afterCommit=null;afterRead=null;beforeTransaction=null;archiveReadHook=null;gasReadHook=null;txTail=Promise.resolve();
 const shapes=[{sheetId:2026101601,title:'案件リスト',gridProperties:{rowCount:20,columnCount:65}},
 {sheetId:2026102605,title:'案件_実績台帳',gridProperties:{rowCount:20,columnCount:25}},
 {sheetId:1773116117,title:'2026.11',gridProperties:{rowCount:5,columnCount:55}},
 {sheetId:434431224,title:'2026.12',gridProperties:{rowCount:5,columnCount:56}},
 ...['スタッフマスタ','各社見積書','イオンデモ遠方リスト','ケイ_応募日補助'].map((title,i)=>({sheetId:900+i,title,gridProperties:{rowCount:2,columnCount:2}}))];
 metadata={spreadsheetId:BOOK,properties:{timeZone:'Asia/Tokyo'},sheets:shapes.map(properties=>({properties}))};
 sheetsData=new Map(shapes.map(s=>[s.sheetId,new Map()]));
 const cells=Array.from({length:65},()=>({}));for(const [i,v]of [[0,false],[1,serial(DATE)],[2,manual?NAME:''],[4,'9:30'],[10,'SYNTHETIC_CLIENT'],[11,'SYNTHETIC_STORE'],[12,'SYNTHETIC_MAKER'],[13,'SYNTHETIC_DEMO'],[14,'9:30'],[15,'10:00～18:00'],[55,'募集中'],[56,'関東'],[58,'単日'],[60,CASE],[61,'synthetic-source'],[62,JSON.stringify({schema:'LKCM1_CASE_META_V1',publicEligible:true,headcountConfirmed:true,issues:[]})],[63,false]])cells[i]=literal(v);
 for(const i of [...Array.from({length:26},(_,i)=>i+19),...Array.from({length:7},(_,i)=>i+48)])cells[i]=literal(0);
 cells[28]=literal(8000);cells[29]=literal(2000);
 cells[5]={userEnteredValue:{formulaValue:'=INDEX($L:$L,ROW())'},effectiveValue:{stringValue:'SYNTHETIC_STORE'}};
 cells[6]={userEnteredValue:{formulaValue:'=INDEX($C:$C,ROW())'},effectiveValue:{stringValue:manual?NAME:''}};
 cells[36]={userEnteredValue:{formulaValue:'=SUM(INDEX($AC:$AC,ROW()),INDEX($AD:$AD,ROW()))'},effectiveValue:{numberValue:10000}};
 cells[44]={userEnteredValue:{formulaValue:'=INDEX($AK:$AK,ROW())'},effectiveValue:{numberValue:10000}};
 sheetsData.get(2026101601).set(1,Projection.HEADERS.map(literal));sheetsData.get(2026101601).set(2,cells);
 const ledger=Array.from({length:25},()=>({}));ledger[0]=literal(CASE);ledger[8]=literal('未手配');ledger[19]=literal(JSON.stringify({schema:'LK_HISTORY_CORE_SNAPSHOT_V1',caseId:CASE,monthly:null}));
 if(modern){ledger[17]=literal(false);ledger[19]=literal(JSON.stringify({schema:'LK_CASE_RESULT_LEDGER_V1',caseId:CASE,sourceMetadata:JSON.parse(cellValue(cells[62])),revision:'synthetic-version',sourceFinancialInputs:{}}));}
 sheetsData.get(2026102605).set(3,helpers.LEDGER_HEADERS.map(literal));sheetsData.get(2026102605).set(4,ledger);
 for(const shape of shapes.filter(s=>/^2026/.test(s.title))){const width=shape.gridProperties.columnCount,table=sheetsData.get(shape.sheetId);table.set(1,[...BUSINESS,...(width===56?['']:[]),'連絡_固定案件ID'].map(literal));}
 const month=sheetsData.get(434431224),other=Array.from({length:56},()=>({}));
 for(const [i,v]of [[0,serial(DATE)],[1,'OTHER_SYNTHETIC_STAFF'],[9,'ANOTHER_CLIENT'],[13,'9:00'],[55,OTHER]])other[i]=literal(v);month.set(2,other);
 const total=Array.from({length:56},()=>({}));total[0]=literal(serial(DATE));total[1]={userEnteredValue:{formulaValue:'="（"&(COUNTIF($A$2:$A$3, A3)-1)&"人）"'},effectiveValue:{stringValue:'（1人）'}};month.set(3,total);
 documents.set('sheetImportConfigs/'+COMPANY,{companyId:COMPANY,spreadsheetId:BOOK,caseListEnabled:true,caseListAssignmentsEnabled:true,caseIdColumnsBySheet:{'2026.11':'BC','2026.12':'BD'}});
 documents.set('staffProfiles/'+STAFF,{companyId:COMPANY,displayName:NAME,active:true});
 documents.set('staffProfiles/other_synthetic_staff',{companyId:COMPANY,displayName:'OTHER_SYNTHETIC_STAFF',active:true});
 googleReadHandler=googleRead;
 nativeHandler=async body=>{
  assert.equal(body.spreadsheetId,BOOK);const writes=body.requestBody.requests;assert.equal(writes.length,1);
  const edit=writes[0].updateCells;assert.equal(edit.range.sheetId,2026101601);assert.equal(edit.range.startColumnIndex,2);assert.equal(edit.fields,'userEnteredValue');
  cells[2].userEnteredValue=copy(edit.rows[0].values[0].userEnteredValue);cells[2].effectiveValue=copy(cells[2].userEnteredValue);cells[6].effectiveValue=copy(cells[2].effectiveValue);return {};
 };
 jobId=ids.createJobIdFromPersistedCaseId(COMPANY,CASE);
 return {cells,ledger};
}
async function start(manual=false,modern=false,configure=()=>{}){
 const f=resetFixture(manual,modern);
 configure(f);
 f.sourceBeforeApplication=copy(f.cells);f.ledgerBeforeTransfer=copy(f.ledger);
 await importer.executeCaseListImport(COMPANY,'commit',OWNER,owner.auth.token);
 if(manual){
  const j=documents.get('jobs/'+jobId),observed=documents.get('caseListManualObservations/'+jobId);assert(observed,'actual importer manual observation');
  const response=await admin.acknowledgeSheetWriteIssue({...owner,data:{action:'select-case-list-manual-gas-monthly',jobId,observationHash:observed.observationHash,expectedJobRevision:j.revision,expectedSourceRevision:j.caseListSource.sourceRevision,clientNameUpConfirmed:true,manualConfirmation:{confirmedFields:{arrival:true,execution:true,headcount:true,dateMode:true,payOffer:true},payOffer:{dailyWageJPY:10000,travelExpenses:'全額支給',communicationExpenses:'全額支給'}}}});
  assertProofMatchesOriginal(response.queueId);
  return {...f,queueId:response.queueId,response};
 }
 const entry=helpers.inspectCaseList([Projection.HEADERS.map(literal),f.cells],[[],[],helpers.LEDGER_HEADERS.map(literal),f.ledger],new Date().toISOString(),BOOK).jobs[0];
 const approval={companyId:COMPANY,jobId,actorUid:OWNER,expectedSourceRevision:entry.source.sourceRevision,confirmedFields:{arrival:true,execution:true,headcount:true,dateMode:true,payOffer:true,vacancy:true},payOffer:{dailyWageJPY:10000,travelExpenses:'全額支給',communicationExpenses:'全額支給'}};
 const candidate=helpers.confirmedCaseListCandidate([Projection.HEADERS.map(literal),f.cells],[[],[],helpers.LEDGER_HEADERS.map(literal),f.ledger],CASE,approval,new Date().toISOString(),OWNER,BOOK);
 const job=documents.get('jobs/'+jobId);Object.assign(job,{status:'open',publishable:true,recruitmentStopped:false,sourceReady:true,applicationUnconfirmed:false,basePay:10000,publicPayOffer:approval.payOffer,caseListPublication:{sourceRevision:entry.source.sourceRevision},...{clientName:candidate.client,storeName:candidate.store,makerName:candidate.manufacturer,menuName:candidate.menu,entryTime:candidate.arrival,workTime:candidate.execution}});
 documents.set('caseListApprovals/'+jobId,approval);
 const request={jobId,requestId:'synthetic_request_001',expectedJobRevision:job.revision,expectedSourceRevision:entry.source.sourceRevision};
 await jobs.applyToJob({...staffAuth,data:request});
 const queueId=documents.get('jobs/'+jobId).assignmentSheetWrite.queueId,queueRef=new Doc('sheetSyncQueue/'+queueId);
 for(let i=0;i<4&&documents.get(queueRef.path).errorType!=='owner_transfer_required';i++)await worker.processCaseListMonthlyAssignment(queueRef);
 assert.equal(documents.get(queueRef.path).errorType,'owner_transfer_required','actual Source phases must reach owner gate: '+documents.get(queueRef.path).caseListMonthlyReason);
 const response=await admin.acknowledgeSheetWriteIssue({...owner,data:{action:'select-case-list-gas-monthly',queueId,reviewKey:documents.get(queueRef.path).caseListPhase.continuationHash,clientNameUpConfirmed:true}});
 assertProofMatchesOriginal(queueId);
 return {...f,queueId,response,request};
}
function originalProofInput(){
 const props=metadata.sheets.find(s=>s.properties.sheetId===434431224).properties;
 const source=[...sheetsData.get(2026101601)].find(([n,c])=>n>1&&cellValue(c[60])===CASE);
 const ledger=[...sheetsData.get(2026102605)].find(([n,c])=>n>3&&cellValue(c[0])===CASE);
 return {book:BOOK,id:CASE,date:DATE,source:{sheetId:2026101601},sourceRow:source[0],sourceCells:source[1],
  ledgerRow:ledger[0],ledgerCells:ledger[1],monthSheet:props,width:props.gridProperties.columnCount,
  rowData:lastGasMonthResponse.sheets[0].data[0].rowData,
  ids:Array.from({length:props.gridProperties.rowCount},(_,i)=>[cellValue(sheetsData.get(434431224).get(i+1)?.[55])])};
}
function assertProofMatchesOriginal(queueId){
 const p=documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+queueId)).externalSelection.gasPreview;
 const original=gasOriginal.inspect(originalProofInput());
 assert.equal(p.approvedProof,original.proof,'expected proof must match actual GAS original assembly');
 assert.equal(p.checkedProof,original.proof);assert.equal(p.sourceHash,original.p.sourceHash);assert.equal(p.ledgerHash,original.p.ledgerHash);
 assert.deepEqual(original.position,{row:3,totalRow:3,insertCount:1,totalRowAfter:4,kind:'EXISTING_DAY_NEW_CLIENT_APPEND',
  totalFormulaBefore:'="（"&(COUNTIF($A$2:$A$3, A3)-1)&"人）"',totalFormulaAfter:null,totalExpectedBefore:1,totalExpectedAfter:2});
 return original;
}
function archiveFixture(f,{formula=true}={}){
 const op=documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+f.queueId)),selection=op.externalSelection,p=selection.gasPreview;
 const mapped=copy(selection.expectedMapped.business),at=new Date().toISOString(),day=Math.floor((Date.parse(at)+9*3600000)/86400000)+25569;
 mapped[8]={...mapped[8],userEnteredValue:formula?{formulaValue:load('case-list-gas-date-formula').expectedStaffDateFormula(3,NAME,day)}:{numberValue:day},effectiveValue:{numberValue:day},userEnteredFormat:{...(mapped[8].userEnteredFormat??{}),numberFormat:{type:'DATE',pattern:'m/d(ddd)'}}};mapped[8].effectiveFormat=copy(mapped[8].userEnteredFormat);
 mapped[17]={...mapped[17],...literal('作成中'),userEnteredFormat:{...(mapped[17].userEnteredFormat??{}),backgroundColorStyle:{rgbColor:{red:244/255,green:162/255,blue:97/255}}}};mapped[17].effectiveFormat=copy(mapped[17].userEnteredFormat);
 // This is an explicitly synthetic final state, not proof of actual GAS execution.
 for(let i=0;i<54;i++)if(![8,17].includes(i))mapped[i].effectiveValue=copy(f.cells[i+1]?.effectiveValue??{});
 mapped.push({},literal(CASE));
 const writable=c=>Object.fromEntries(['userEnteredValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'].filter(k=>Object.hasOwn(c,k)).map(k=>[k,copy(c[k])]));
 const body={schema:'LK_CASE_TRANSFER_SELECTION_READBACK_V1',intentRef:{key:p.intentKey,groupId:null,createdAt:at},target:{book:BOOK,sheetId:434431224,width:56,caseId:CASE,date:DATE,rowHint:3},preimage:{sourceHash:p.sourceHash,ledgerHash:p.ledgerHash,groupHash:null},selection:{preparedFingerprint:p.nameUpExpected,authorizedFingerprint:p.nameUpExpected,actorHash:shaValue('owner@example.invalid'),confirmation:'VERIFIED_NAMEUP_SENT_AT_THIS_CALL',nameUp:{schema:'LK_NAMEUP_TRANSFER_V1',caseId:CASE,expectedFingerprint:p.nameUpExpected,digest:'b'.repeat(64),messageId:'synthetic_message_001',preparedAt:at,authorizedAt:at}},recordedAt:'2026-11-07 12:00:00',
 monthlyReadback:{book:BOOK,sheetId:434431224,caseId:CASE,date:DATE,width:56,businessHash:shaValue(mapped.slice(0,54).map(c=>[c.userEnteredValue??{},c.effectiveValue??{}])),writableHash:shaValue(mapped.map(writable)),financialHash:shaValue(feeIndices.map(i=>cellValue(mapped[i]))),observedAt:at}};
 const receipt={...body,receiptHash:shaValue(body)},ledger=sheetsData.get(2026102605).get(4),prior=JSON.parse(cellValue(ledger[19]));
 const saved={...prior,monthlyTransfer:{kind:'MONTHLY_TRANSFER',book:BOOK,sheetId:434431224,fixedId:CASE,selectionAndReadback:receipt}};
 for(const [i,v]of [[0,CASE],[1,serial(DATE)],[8,'手配確定'],[9,NAME],[10,'月別転記済'],[12,'owner@example.invalid'],[13,receipt.recordedAt],[17,false],[19,JSON.stringify(saved)]])ledger[i]=literal(v);
 const month=sheetsData.get(434431224),total=month.get(3);month.set(3,mapped);month.set(4,total);total[1].userEnteredValue.formulaValue='="（"&(COUNTIF($A$2:$A$4, A4)-1)&"人）"';total[1].effectiveValue.stringValue='（2人）';
 sheetsData.set(2026101601,new Map([[1,Projection.HEADERS.map(literal)]]));
 return {receipt,mapped};
}
const results=[];const testPrefix=process.argv.find(arg=>arg.startsWith('--test-name-prefix='))?.slice('--test-name-prefix='.length);
async function test(name,fn){if(testPrefix&&!name.startsWith(testPrefix))return;lastPreview=null;try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.stack,code:e.code,previewStatus:lastPreview?.status,previewReason:lastPreview?.reason});}}
const reconcile=f=>admin.acknowledgeSheetWriteIssue({...owner,data:{action:'reconcile-case-list',queueId:f.queueId}});
function changeReceipt(fn){const row=sheetsData.get(2026102605).get(4),m=JSON.parse(cellValue(row[19])),r=m.monthlyTransfer.selectionAndReadback;fn(r);const b={...r};delete b.receiptHash;r.receiptHash=shaValue(b);row[19]=literal(JSON.stringify(m));}
function ui(relative,cache=new Map()){
 const file=path.join(repoRoot,'apps/staff/src',relative+'.ts');if(cache.has(file))return cache.get(file);const module={exports:{}};
 const ts=clientRequire('typescript'),code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,require:s=>ui(s.replace('./',''),cache)});cache.set(file,module.exports);return module.exports;
}
const list=ui('job-list'),calendar=ui('monthly-shift-calendar');
const appSource=fs.readFileSync(path.join(repoRoot,'apps/staff/src/App.tsx'),'utf8');
const uploadStart=appSource.indexOf('  async function uploadSubmission(){'),uploadReady=appSource.indexOf('    const typeLabel=',uploadStart);
assert(uploadStart>=0&&uploadReady>uploadStart);
// Actual App upload preflight only: stop at the transport boundary. This is
// not a React mount, file persistence test, actual upload or server acceptance.
const uploadPreflight=appSource.slice(uploadStart,uploadReady)+'    return "READY_FOR_UPLOAD";\n  }';
async function submissionPreflight(job,selectedId=jobId){
 const files=[{name:'synthetic.pdf',size:10}],messages=[],context={files,submissionConfirmed:true,isSubmissionActionPending:()=>false,
  draftCleanup:null,draftKey:'synthetic',MAX_SUBMISSION_FILE_SIZE:50*1024*1024,selectedJob:{id:selectedId},myJobs:[{...job,id:jobId}],
  requestId:'',resubmissionDetail:null,submissionType:'report',showSubmissionMessage:m=>messages.push(m)};
 vm.runInNewContext(uploadPreflight+'\nthis.invoke=uploadSubmission;',context);
 const out=await context.invoke();assert.equal(context.files,files);assert.equal(files.length,1);assert.equal(files[0].name,'synthetic.pdf');
 return {out,messages};
}
const binding=async f=>{const out=await admin.acknowledgeSheetWriteIssue({...owner,data:{queueId:f.queueId,action:'read-case-list-gas-binding'}});assert.equal(out.status,'EXTERNAL_BINDING_READ');assert.equal(out.sourceWrites,0);assert.equal(out.monthlyWrites,0);return out.binding;};
const assignmentQueueCount=()=>[...documents].filter(([p,v])=>p.startsWith('sheetSyncQueue/')&&v.operation==='case_list.assign').length;
function protectedState(){return helpers.canonical([...documents]);}
async function bindingHasNoSideEffects(fn){const before=protectedState(),w=writes,n=requests.length,priorNative=nativeCalls;const out=await fn();assert.equal(protectedState(),before);assert.equal(writes,w);assert.equal(requests.length,n);assert.equal(nativeCalls,priorNative);return out;}
async function pendingSubmissionBackend(cancelled=false){
 const job=documents.get('jobs/'+jobId),w=writes,n=requests.length;
 const denied=e=>e.code==='failed-precondition'&&(cancelled?/キャンセル/.test(e.message):e.details?.reason==='assignment_sheet_confirmation_pending');
 await assert.rejects(()=>load('precontact').submitPreContact({...staffAuth,data:{jobId,dateKey:job.dateKey,expectedRevision:job.revision,temperature:36.5,arrivalTime:'09:00'}}),denied);
 await assert.rejects(()=>load('uploads').createUploadSession({...staffAuth,data:{jobId,type:'report',files:[{originalName:'synthetic.pdf',contentType:'application/pdf',size:10}]}}),denied);
 assert.equal(writes,w);assert.equal(requests.length,n);assert(![...documents.keys()].some(p=>p.startsWith('submissions/')));
 const tasks=await load('staff-tasks').getMyTasks(staffAuth);assert(!tasks.tasks.some(t=>t.jobId===jobId));
}
(async()=>{
 for(const manual of [false,true])await test('binding / '+(manual?'manual':'application')+' reads only protected facts with no service mutation',async()=>{
  const f=await start(manual,true),op=documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+f.queueId)),j=documents.get('jobs/'+jobId),q=documents.get('sheetSyncQueue/'+f.queueId);
  runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='read-only';const count=bindingReadTransactions;
  const out=await bindingHasNoSideEffects(()=>binding(f));
  assert.deepEqual(Object.keys(out).sort(),['queueId','companyId','jobId','caseId','origin','staffId','dateKey','expectedJobRevision','assignedJobRevision','sourceRevision','selectedBy','selectedAt','selectionHash','gas'].sort());
  for(const [k,v]of Object.entries({queueId:f.queueId,caseId:CASE,staffId:STAFF,dateKey:DATE,jobId,companyId:COMPANY,expectedJobRevision:q.caseListAssignment.expectedJobRevision,assignedJobRevision:j.revision,sourceRevision:q.caseListAssignment.sourceRevision,selectionHash:op.externalSelection.selectionHash,selectedAt:op.externalSelection.selectedAt,selectedBy:OWNER,origin:manual?'SOURCE_MANUAL':'CREW_APPLICATION'}))assert.equal(out[k],v,k);
  assert.deepEqual(Object.keys(out.gas).sort(),['book','sheetId','nameUpExpected'].sort());assert.equal(out.gas.nameUpExpected,op.externalSelection.gasPreview.nameUpExpected);
  const repeated=await bindingHasNoSideEffects(()=>binding(f));assert.deepEqual(repeated,out);out.gas.nameUpExpected='caller mutation';assert.equal((await binding(f)).gas.nameUpExpected,repeated.gas.nameUpExpected);
  assert.equal(bindingReadTransactions,count+3);assert.equal(assignmentQueueCount(),1);assert.equal(j.applicationUnconfirmed,true);
 });
 await test('binding / absent original queue cannot create selection or owner evidence',async()=>{
  resetFixture(true,true);await bindingHasNoSideEffects(async()=>assert.rejects(()=>binding({queueId:'missing_original'}),/EXTERNAL_BINDING_QUEUE_REQUIRED/));assert.equal(assignmentQueueCount(),0);
 });
 await test('binding / manual A1 committed without A2 remains held at actual submission handlers',async()=>{
  await assert.rejects(()=>start(true,true,()=>{afterCommit=()=>{const op=[...documents.values()].find(v=>v.externalManualRequested===true);if(op&&!op.externalSelection){afterCommit=null;throw Error('BINDING_A1_RESPONSE_LOST');}};}),/BINDING_A1_RESPONSE_LOST/);
  const f={queueId:documents.get('jobs/'+jobId).assignmentSheetWrite.queueId};await bindingHasNoSideEffects(async()=>assert.rejects(()=>binding(f),/PROTECTED_SELECTION_MISMATCH/));await pendingSubmissionBackend();assert.equal(assignmentQueueCount(),1);
 });
 for(const manual of [false,true])await test('binding / '+(manual?'manual':'application')+' A2 response loss preserves one original binding without replay',async()=>{
  await assert.rejects(()=>start(manual,true,()=>{afterCommit=()=>{const op=[...documents.values()].find(v=>v.externalSelection);if(op){afterCommit=null;throw Error('BINDING_A2_RESPONSE_LOST');}};}),/BINDING_A2_RESPONSE_LOST/);
  const f={queueId:documents.get('jobs/'+jobId).assignmentSheetWrite.queueId},first=await bindingHasNoSideEffects(()=>binding(f)),second=await bindingHasNoSideEffects(()=>binding(f));assert.deepEqual(first,second);assert.equal(assignmentQueueCount(),1);await pendingSubmissionBackend();
 });
 for(const [name,change]of [
  ['fixed ID',f=>{documents.get('jobs/'+jobId).caseId=OTHER;}],
  ['source revision',f=>{documents.get('jobs/'+jobId).caseListSource.sourceRevision='f'.repeat(64);}],
  ['job revision',f=>{documents.get('jobs/'+jobId).revision++;}],
  ['selection hash',f=>{documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+f.queueId)).externalSelection.selectionHash='0'.repeat(64);}],
  ['inactive staff',f=>{documents.get('staffProfiles/'+STAFF).active=false;}],
  ['day ownership',f=>{documents.get('staffDayLocks/'+COMPANY+'_'+STAFF+'_'+DATE).active=false;}],
  ['revoked original identity',f=>{const q=documents.get('sheetSyncQueue/'+f.queueId);documents.set('authIdentities/'+q.actorUid,{companyId:COMPANY,staffId:STAFF,active:false});}],
 ])await test('binding / changed '+name+' refuses without reading Source or writing metadata',async()=>{
  const f=await start(false,true);change(f);await bindingHasNoSideEffects(async()=>assert.rejects(()=>binding(f)));assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);assert.equal(assignmentQueueCount(),1);await pendingSubmissionBackend();
 });
 for(const [name,token,uid]of [
  ['staff role',{...owner.auth.token,role:'staff'},OWNER],
  ['different company',{...owner.auth.token,companyId:'foreign_company'},OWNER],
  ['UID mismatch',{...owner.auth.token,uid:'different_owner'},OWNER],
  ['unverified email',{...owner.auth.token,email_verified:false},OWNER],
 ])await test('binding / '+name+' cannot read a protected selection',async()=>{
  const f=await start(false,true);await bindingHasNoSideEffects(async()=>assert.rejects(()=>admin.acknowledgeSheetWriteIssue({auth:{uid,token},data:{queueId:f.queueId,action:'read-case-list-gas-binding'}})));
 });
 await test('binding / unauthenticated action ignores owner claims supplied in its body',async()=>{
  const f=await start(false,true),reads=documentReads.length;
  await bindingHasNoSideEffects(async()=>assert.rejects(()=>admin.acknowledgeSheetWriteIssue({data:{queueId:f.queueId,action:'read-case-list-gas-binding',token:owner.auth.token}})));
  assert.equal(documentReads.length,reads);
 });
 await test('binding / non-executive admin cannot use the metadata action',async()=>{
  const f=await start(false,true),reads=documentReads.length;
  await bindingHasNoSideEffects(async()=>assert.rejects(()=>admin.acknowledgeSheetWriteIssue({auth:{uid:OWNER,token:{...owner.auth.token,email:'ordinary-admin@example.invalid'}},data:{queueId:f.queueId,action:'read-case-list-gas-binding'}})));
  assert.equal(documentReads.length,reads);
 });
 await test('binding / a different authenticated executive UID cannot inherit the original selection',async()=>{
  const f=await start(false,true),uid='different_executive';
  await bindingHasNoSideEffects(async()=>assert.rejects(()=>admin.acknowledgeSheetWriteIssue({auth:{uid,token:{...owner.auth.token,uid}},data:{queueId:f.queueId,action:'read-case-list-gas-binding'}}),/PROTECTED_SELECTION_MISMATCH/));
 });
 await test('binding / active company lease is observed without takeover',async()=>{
  const f=await start(false,true);documents.set('caseListSyncLocks/'+COMPANY,{companyId:COMPANY,tokenId:'other_operation',activeUntil:Stamp.fromMillis(Clock.now()+60_000)});await bindingHasNoSideEffects(async()=>assert.rejects(()=>binding(f),/OTHER_TRANSFER_IN_PROGRESS/));
 });
 for(const manual of [false,true])await test('binding / '+(manual?'manual':'application')+' archived Source stays pending until original reconciliation',async()=>{
  const f=await start(manual,true),original=await binding(f);archiveFixture(f);const out=await bindingHasNoSideEffects(()=>binding(f));assert.deepEqual(out,original);assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);await pendingSubmissionBackend();
  documents.set('resubmissionRequests/binding_request',{companyId:COMPANY,staffId:STAFF,jobId,status:'open',type:'report',reasons:['synthetic'],createdAt:Stamp.now()});
  assert.equal((await load('staff-tasks').getMyTasks(staffAuth)).tasks.length,0);await reconcile(f);assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,false);
  assert((await load('staff-tasks').getMyTasks(staffAuth)).tasks.some(t=>t.jobId===jobId),'positive control: accepted same-ID task is visible');
  await bindingHasNoSideEffects(async()=>assert.rejects(()=>binding(f),/EXTERNAL_BINDING_PENDING_ONLY/));assert.equal((await reconcile(f)).status,'EXTERNAL_ALREADY_ACCEPTED');assert.equal(assignmentQueueCount(),1);
 });
 for(const manual of [false,true])await test('binding / '+(manual?'manual':'application')+' actual owner cancellation blocks binding and submissions',async()=>{
  const f=await start(manual,true),j=documents.get('jobs/'+jobId);await jobs.adminCancelJob({...owner,data:{jobId,expectedRevision:j.revision,reason:'SYNTHETIC_BINDING_CANCEL'}});await bindingHasNoSideEffects(async()=>assert.rejects(()=>binding(f)));await pendingSubmissionBackend(true);assert.equal(assignmentQueueCount(),1);assert.equal(documents.get('jobs/'+jobId).cancelled,true);
 });
 for(const manual of [false,true])await test('binding / '+(manual?'manual':'application')+' readback cannot refresh expired name-up preparation',async()=>{
  const f=await start(manual,true),original=await binding(f);archiveFixture(f);
  changeReceipt(r=>{r.selection.nameUp.preparedAt=new Date(Date.parse(r.selection.nameUp.authorizedAt)-180000).toISOString();});
  assert.deepEqual(await bindingHasNoSideEffects(()=>binding(f)),original);await assert.rejects(()=>reconcile(f),/NAMEUP_PREPARATION_NOT_CURRENT/);await pendingSubmissionBackend();assert.equal(assignmentQueueCount(),1);
 });
 for(const manual of [false,true])await test('binding / '+(manual?'manual':'application')+' original authenticated identity revocation stays held',async()=>{
  const f=await start(manual,true),q=documents.get('sheetSyncQueue/'+f.queueId);documents.set('authIdentities/'+q.actorUid,{companyId:COMPANY,staffId:STAFF,active:false});
  await bindingHasNoSideEffects(async()=>assert.rejects(()=>binding(f),/EXTERNAL_ACTOR_IDENTITY_REVOKED/));await pendingSubmissionBackend();assert.equal(assignmentQueueCount(),1);
 });

 await test('external mode unset or invalid fails closed; existing native manual selection remains available',async()=>{
  const mode=load('case-list-external-mode');
  for(const value of [undefined,'','ENABLED','invalid','read-only']){if(value===undefined)delete runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE;else runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE=value;
   assert.equal(mode.externalTransferMode(),'read-only');assert.throws(()=>mode.assertExternalIntakeEnabled(),/INTAKE_PAUSED/);}
  const f=resetFixture(true,true);await importer.executeCaseListImport(COMPANY,'commit',OWNER,owner.auth.token);runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='paused';
  const j=documents.get('jobs/'+jobId),o=documents.get('caseListManualObservations/'+jobId);
  const result=await admin.acknowledgeSheetWriteIssue({...owner,data:{action:'select-case-list-manual-monthly',jobId,observationHash:o.observationHash,expectedJobRevision:j.revision,expectedSourceRevision:j.caseListSource.sourceRevision,clientNameUpConfirmed:true,manualConfirmation:{confirmedFields:{arrival:true,execution:true,headcount:true,dateMode:true,payOffer:true},payOffer:{dailyWageJPY:10000,travelExpenses:'全額支給',communicationExpenses:'全額支給'}}}});
  assert.equal(result.status,'OWNER_TRANSFER_SELECTED');assert.equal(documents.get('sheetSyncQueue/'+result.queueId).status,'pending');assert(!documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+result.queueId)).externalManualRequested);
 });
 await test('paused application external intake preserves original queue without a new external selection',async()=>{
  await assert.rejects(()=>start(false,true,()=>{runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='paused';}),/EXTERNAL_TRANSFER_INTAKE_PAUSED/);
  const j=documents.get('jobs/'+jobId),qid=j.assignmentSheetWrite.queueId;assert(qid);assert.equal(j.applicationUnconfirmed,true);
  assert(!documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+qid)).externalSelection);assert(!documents.has('caseListSyncLocks/'+COMPANY));
 });
 await test('paused manual external intake creates no queue, selection, lease or audit write',async()=>{
  resetFixture(true,true);await importer.executeCaseListImport(COMPANY,'commit',OWNER,owner.auth.token);runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='paused';
  const j=documents.get('jobs/'+jobId),o=documents.get('caseListManualObservations/'+jobId),before=writes;
  await assert.rejects(()=>admin.acknowledgeSheetWriteIssue({...owner,data:{action:'select-case-list-manual-gas-monthly',jobId,observationHash:o.observationHash,expectedJobRevision:j.revision,expectedSourceRevision:j.caseListSource.sourceRevision,clientNameUpConfirmed:true,manualConfirmation:{confirmedFields:{arrival:true,execution:true,headcount:true,dateMode:true,payOffer:true},payOffer:{dailyWageJPY:10000,travelExpenses:'全額支給',communicationExpenses:'全額支給'}}}}),/EXTERNAL_TRANSFER_INTAKE_PAUSED/);
  assert.equal(writes,before);assert(![...documents.keys()].some(k=>k.startsWith('sheetSyncQueue/')));
 });
 await test('paused intake still reconciles the exact already-selected original receipt',async()=>{
  const f=await start(false,true),qid=f.queueId;archiveFixture(f);runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='paused';
  assert.equal((await reconcile(f)).status,'EXTERNAL_READBACK_VERIFIED');assert.equal(documents.get('jobs/'+jobId).assignmentSheetWrite.queueId,qid);
 });
 await test('read-only selected receipt stays held with no lease or metadata mutation',async()=>{
  const f=await start(true,true);archiveFixture(f);runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='read-only';
  const q=copy(documents.get('sheetSyncQueue/'+f.queueId)),op=copy(documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+f.queueId))),before=writes,n=requests.length;
  await assert.rejects(()=>reconcile(f),/EXTERNAL_TRANSFER_COMPATIBILITY_HOLD/);assert.equal(writes,before);assert.equal(requests.length,n);
  assert.equal(helpers.canonical(documents.get('sheetSyncQueue/'+f.queueId)),helpers.canonical(q));assert.equal(helpers.canonical(documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+f.queueId))),helpers.canonical(op));assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);
 });
 await test('manual registration response loss before external selection routes to read-only hold without native claim',async()=>{
  await assert.rejects(()=>start(true,true,()=>{afterCommit=()=>{const op=[...documents.values()].find(v=>v.externalManualRequested===true);if(op&&!op.externalSelection){afterCommit=null;throw Error('SYNTHETIC_MANUAL_REGISTRATION_RESPONSE_LOST');}};}),/SYNTHETIC_MANUAL_REGISTRATION_RESPONSE_LOST/);
  const j=documents.get('jobs/'+jobId),qid=j.assignmentSheetWrite.queueId,op=documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+qid));
  const issue=await externalIssue({queueId:qid});assert.equal(issue.errorType,'external_transfer_selection_required');assert.equal(issue.canReconcile,false);assert.equal(issue.canSelectMonthlyTransfer,false);assert.equal(issue.manualTransferPending,false);
  assert.equal(op.externalManualRequested,true);assert(!op.externalSelection);runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='read-only';const before=writes,n=requests.length,old=helpers.canonical(op);
  await assert.rejects(()=>reconcile({queueId:qid}),/EXTERNAL_TRANSFER_COMPATIBILITY_HOLD/);assert.equal(writes,before);assert.equal(requests.length,n);assert.equal(helpers.canonical(op),old);assert.equal(nativeCalls,0);assert.equal(j.applicationUnconfirmed,true);
 });
 await test('read-only completed receipt stays readable and idempotent with no native ACK conversion',async()=>{
  const f=await start(false,true);archiveFixture(f);await reconcile(f);runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='read-only';
  const j=documents.get('jobs/'+jobId),before=writes,n=requests.length,h=j.assignmentSheetWrite.externalAck.acceptanceHash;
  assert.equal((await reconcile(f)).status,'EXTERNAL_ALREADY_ACCEPTED');const ref=await priv.resolveCaseListPrivateSheetRef(COMPANY,jobId,j);assert.equal(ref.caseId,CASE);
  assert.equal(writes,before);assert.equal(requests.length,n);assert.equal(j.assignmentSheetWrite.externalAck.acceptanceHash,h);assert(!j.assignmentSheetWrite.nativeAck);
  await importer.executeCaseListImport(COMPANY,'commit',OWNER,owner.auth.token);assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,false);assert(!documents.get('jobs/'+jobId).assignmentSheetWrite.nativeAck);
 });
 await test('mode stop during selection read is rechecked before selection transaction commit',async()=>{
  await assert.rejects(()=>start(false,true,()=>{gasReadHook=r=>{beforeTransaction=()=>{runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='paused';};return r;};}),/EXTERNAL_TRANSFER_INTAKE_PAUSED/);
  const j=documents.get('jobs/'+jobId);assert.equal(j.applicationUnconfirmed,true);assert(!documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+j.assignmentSheetWrite.queueId)).externalSelection);
 });
 await test('read-only switch during receipt read is rechecked before acceptance transaction commit',async()=>{
  const f=await start(false,true);archiveFixture(f);archiveReadHook=()=>{beforeTransaction=()=>{runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='read-only';};};
  await assert.rejects(()=>reconcile(f),/EXTERNAL_TRANSFER_COMPATIBILITY_HOLD/);assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);assert(!documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+f.queueId)).externalAcceptance);
 });
 for(const manual of [false,true])await test((manual?'manual name':'actual applyToJob')+' REAL proof assembly and batchFingerprint equal original GAS excerpts',async()=>{
  const f=await start(manual);const original=assertProofMatchesOriginal(f.queueId);
  const reader=load('case-list-monthly-reader'),snapshot=await reader.readCaseListMonthlySnapshot(COMPANY,CASE);
  const read=await reader.readGasTransferMonthPlan(snapshot,DATE),r={job:documents.get('jobs/'+jobId),config:documents.get('sheetImportConfigs/'+COMPANY)};
  const actual=load('case-list-gas-proof').expectedGasTransferProof(r,snapshot,read);
  assert.equal(actual.approvedProof,original.proof);assert.equal(actual.checkedProof,original.proof);assert.equal(actual.batchFingerprint,original.batchFingerprint);
  assert.notEqual(actual.batchFingerprint,actual.approvedProof,'batch approval input is not the final checked proof');
  const request=requests.at(-1);assert.equal(JSON.stringify(request.ranges),JSON.stringify(["'2026.12'!A2:O5"]));assert(!/effectiveFormat|userEnteredFormat|formattedValue/.test(request.fields));
 });
 await test('GAS sparse trailing rowData remains unpadded and matches original proof through acceptance',async()=>{
  const f=await start(false,false,()=>{gasReadHook=response=>{response.sheets[0].data[0].rowData.length=2;return response;};});
  assert.equal(lastGasMonthResponse.sheets[0].data[0].rowData.length,2);archiveFixture(f);
  assert.equal((await reconcile(f)).status,'EXTERNAL_READBACK_VERIFIED');
 });
 for(const [name,mutate,reason]of [
  ['read/index drift',r=>{r.sheets[0].data[0].rowData[0].values[13]=literal('10:00');},'GAS_MONTH_INDEX_CHANGED'],
  ['truncated nonempty rows',r=>{r.sheets[0].data[0].rowData.length=0;},'GAS_MONTH_INDEX_CHANGED'],
  ['offset drift',r=>{r.sheets[0].data[0].startRow=2;},'GAS_MONTH_RESPONSE_SCOPE_CHANGED'],
  ['shape drift',r=>{r.sheets[0].properties.gridProperties.rowCount++;},'GAS_MONTH_RESPONSE_SCOPE_CHANGED'],
 ])await test('real GAS selection holds '+name+' and preserves original queue without confirmation',async()=>{
  await assert.rejects(()=>start(false,false,()=>{gasReadHook=r=>{mutate(r);return r;};}),e=>e.details?.reason===reason);
  const job=documents.get('jobs/'+jobId),qid=job.assignmentSheetWrite.queueId;
  assert(qid);assert.equal(job.applicationUnconfirmed,true);assert(!documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+qid)).externalSelection);
 });
 await test('REAL GAS planner preserves production refusal of unverified total range',async()=>{
  const planner=require(path.join(src,'case-list-gas-planner.cjs'));
  const month={title:'2026.12',boundaryRow:null,allowTotalRepair:false,rows:[
   {row:2,date:DATE,staff:'synthetic',client:'CLIENT',arrival:'9:00'},
   {row:3,date:DATE,staff:'（0人）',client:'',totalFormula:'="（"&(COUNTIF($A$3:$A$3, A3)-1)&"人）"'}]};
  assert.throws(()=>planner.choosePosition(month,DATE,{client:'ANOTHER',arrival:'9:30'}),/DAILY_TOTAL_RANGE_UNVERIFIED/);
 });
 await test('real date literal and formula match original for all third-argument types and quoted names',async()=>{
  const actual=load('case-list-gas-date-formula');
  for(const value of [46333,-1,0,true,false,'',null,undefined,'a"b',NaN,Infinity,new Clock('2026-11-07T00:00:00Z')]){
   assert.equal(actual.staffDateLiteral(value),gasOriginal.lkStaffDateLiteral_(value));
   for(const name of [NAME,'A"B','  synthetic　name ',null,'（２人）'])assert.equal(actual.expectedStaffDateFormula(3,name,value),gasOriginal.lkStaffDateFormula_(3,name,value));
  }
 });
 await test('same-name reentry keeps retained date and B:I copy uses relative row references',async()=>{
  const formula=load('case-list-gas-date-formula').expectedStaffDateFormula,day=46333;
  const original=formula(3,NAME,day);assert.equal(formula(3,NAME,day),original);
  assert(original.includes(',"'+NAME+'"),'+day+','));
  assert.equal(formula(17,NAME,day),original.replaceAll('$B3','$B17'));
  assert(formula(17,'A"B',day).includes('"A""B"'));
  assert(formula(17,NAME,day).endsWith("'ケイ_応募日補助'!$A$1)))"));
 });
 await test('original intent Tokyo day boundary and full I/R defaults remain checked',async()=>{
  const coreFile=path.join(src,'case-list-external-core.cjs'),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(coreFile,'utf8')+'\nmodule.exports={...module.exports,checkDefaults:assertOperationalDefaults};',{module,require:s=>s==='./case-list-monthly-controller.cjs'?Native:require(s),Date,Buffer});
  const formula=load('case-list-gas-date-formula').expectedStaffDateFormula;
  for(const [at,day]of [['2026-11-06T14:59:59.999Z',serial('2026-11-06')],['2026-11-06T15:00:00.000Z',serial('2026-11-07')]]){
   const selection={expectedMapped:{business:Array.from({length:54},()=>({}))}},cells=Array.from({length:56},()=>({}));
   cells[8]={userEnteredValue:{formulaValue:formula(3,NAME,day)},effectiveValue:{numberValue:day},userEnteredFormat:{numberFormat:{type:'DATE',pattern:'m/d(ddd)'}}};
   cells[17]={...literal('作成中'),userEnteredFormat:{backgroundColorStyle:{rgbColor:{red:244/255,green:162/255,blue:97/255}}}};
   selection.sourceSnapshot=Array.from({length:65},()=>({}));selection.sourceSnapshot[2]=literal(NAME);
   module.exports.checkDefaults(selection,{intentRef:{createdAt:at}},cells,3,formula);
   cells[8].userEnteredValue.formulaValue=formula(3,NAME,day-1);
   assert.throws(()=>module.exports.checkDefaults(selection,{intentRef:{createdAt:at}},cells,3,formula),/TRANSFER_APPLICATION_DATE_FORMULA_MISMATCH/);
  }
 });
 for(const manual of [false,true])await test((manual?'manual name':'actual applyToJob')+' actual App upload preflight holds before readback and opens only after exact acceptance',async()=>{
  const f=await start(manual);let state=await submissionPreflight(documents.get('jobs/'+jobId));assert.equal(state.out,undefined);assert(state.messages[0].includes('保持'));
  archiveFixture(f);await reconcile(f);state=await submissionPreflight(documents.get('jobs/'+jobId));assert.equal(state.out,'READY_FOR_UPLOAD');
  state=await submissionPreflight(documents.get('jobs/'+jobId),'different_case');assert.equal(state.out,undefined);assert(state.messages.length);
 });
 await test('actual App submission preflight retains files for Source, owner and mail review holds',async()=>{
  const f=await start(false);archiveFixture(f);await reconcile(f);const j=documents.get('jobs/'+jobId);
  for(const patch of [{sourceMissing:true},{assignmentUnresolved:true},{mailIntakeReviewRequired:true},{applicationUnconfirmed:true}]){
   const state=await submissionPreflight({...j,...patch});assert.equal(state.out,undefined);assert(state.messages[0].includes('保持'));
  }
 });
 for(const manual of [false,true])await test((manual?'manual name':'actual applyToJob')+' accepted external receipt alone cannot release financial consumer or create an observation',async()=>{
  const f=await start(manual);archiveFixture(f);await reconcile(f);const before=writes;
  await assert.rejects(()=>priv.resolveCaseListPrivateFinancialJob(COMPANY,jobId,documents.get('jobs/'+jobId)),e=>e.details?.reason==='case_list_external_finance_observation_required');
  assert.equal(writes,before);assert(!documents.has('caseListMonthlyObservations/'+jobId));
 });
 for(const manual of [false,true])await test((manual?'manual name':'actual applyToJob')+' REAL GAS proof/date: actual callable/readback/private/list/calendar and import twice',async()=>{
  const f=await start(manual);archiveFixture(f);
  const out=await reconcile(f);assert.equal(out.status,'EXTERNAL_READBACK_VERIFIED');
  const job=documents.get('jobs/'+jobId);assert.equal(job.applicationUnconfirmed,false);
  const ref=await priv.resolveCaseListPrivateSheetRef(COMPANY,jobId,job);assert.equal(ref.caseId,CASE);
  assert.equal(list.splitAssignedJobs([{id:jobId,...job}],'2026-11-07').upcoming.length,1);assert.equal(calendar.monthCalendar([{id:jobId,...job}],'2026-12').jobs.get(DATE).length,1);
  const before=writes;assert.equal((await reconcile(f)).status,'EXTERNAL_ALREADY_ACCEPTED');assert.equal(documents.get('jobs/'+jobId).assignmentSheetWrite.queueId,f.queueId);
  for(let i=0;i<2;i++){await importer.executeCaseListImport(COMPANY,'commit',OWNER,owner.auth.token);assert.equal(documents.get('jobs/'+jobId).sourceMissing,false);assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,false);}
  assert((documents.get('caseListCatalogs/'+COMPANY).caseIds??[]).includes(CASE));
  await assert.rejects(()=>priv.resolveCaseListPrivateFinancialJob(COMPANY,jobId,documents.get('jobs/'+jobId)),e=>e.code==='failed-precondition');
  assert.equal(nativeCalls,manual?0:1,'only original application Source C projection is mocked as a Google write; external route must never transfer');
 });
 const negatives=[
 ['arbitrary valid-hex prepared fingerprint with recomputed receipt hash',f=>changeReceipt(r=>r.selection.preparedFingerprint='a'.repeat(64)),/NAMEUP_SENT_BINDING_REQUIRED/],
 ['arbitrary valid-hex authorized fingerprint with recomputed receipt hash',f=>changeReceipt(r=>r.selection.authorizedFingerprint='b'.repeat(64)),/NAMEUP_SENT_BINDING_REQUIRED/],
 ['different immutable note plus self-rehashed receipt',f=>{const c=sheetsData.get(434431224).get(3);c[16].note='unapproved synthetic note';changeReceipt(r=>{r.monthlyReadback.writableHash=shaValue(c.map(x=>Object.fromEntries(['userEnteredValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'].filter(k=>Object.hasOwn(x,k)).map(k=>[k,x[k]]))));});},/PROTECTED_EXPECTED_MONTH_CONTENT_MISMATCH/],
 ['different fee plus self-rehashed receipt',f=>{const c=sheetsData.get(434431224).get(3);c[36]=literal(500);changeReceipt(r=>{r.monthlyReadback.financialHash=shaValue(feeIndices.map(i=>cellValue(c[i])));});},/PROTECTED_EXPECTED_MONTH_CONTENT_MISMATCH|PROTECTED_EXPECTED_FINANCIAL_MISMATCH/],
 ['ledger cancellation',f=>sheetsData.get(2026102605).get(4)[17]=literal(true),/LEDGER_SELECTION_OR_CANCEL_MISMATCH/],
 ['duplicate monthly fixed ID',f=>sheetsData.get(434431224).get(2)[55]=literal(CASE),/COMPACT_MONTH_ID_DUPLICATE|ARCHIVED_/],
 ['old completion without receipt',f=>{const r=sheetsData.get(2026102605).get(4),m=JSON.parse(cellValue(r[19]));delete m.monthlyTransfer.selectionAndReadback;r[19]=literal(JSON.stringify(m));},/DURABLE_SELECTION_RECEIPT_REQUIRED/],
 ['native public ACK marker alone',f=>documents.get('jobs/'+jobId).assignmentSheetWrite.nativeAck={status:'MONTHLY_READBACK_VERIFIED'},/EXTERNAL_NATIVE_PROOF_MIXED/],
 ['native root ACK marker alone',f=>documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+f.queueId)).acceptedAckHash='a'.repeat(64),/EXTERNAL_NATIVE_PROOF_MIXED/],
 ['native queue marker present but empty',f=>documents.get('sheetSyncQueue/'+f.queueId).caseListMonthlyAckHash='',/EXTERNAL_NATIVE_PROOF_MIXED/],
 ['native public ACK marker present but null',f=>documents.get('jobs/'+jobId).assignmentSheetWrite.nativeAck=null,/EXTERNAL_NATIVE_PROOF_MIXED/],
 ['unverified owner',f=>{},/CASE_LIST_EXECUTIVE_REQUIRED/],
 ];
 for(const [name,mutate,error]of negatives)await test('whole functions with real GAS domain implementations hold '+name,async()=>{
  const f=await start(false);archiveFixture(f);mutate(f);
  if(name==='unverified owner'){const bad=copy(owner);bad.auth.token.email_verified=false;await assert.rejects(()=>admin.acknowledgeSheetWriteIssue({...bad,data:{action:'reconcile-case-list',queueId:f.queueId}}),error);}
  else await assert.rejects(()=>reconcile(f),e=>error.test(e.message)||error.test(e.details?.reason??''));
  assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);
 });
 await test('whole functions keep Source reappearance fence even at original unchanged revision and after disappearance',async()=>{
  const f=await start(false),original=copy(f.sourceBeforeApplication),originalLedger=copy(f.ledgerBeforeTransfer);archiveFixture(f);await reconcile(f);
  sheetsData.get(2026101601).set(2,original);sheetsData.get(2026102605).set(4,originalLedger);
  const restored=helpers.inspectCaseList([Projection.HEADERS.map(literal),original],[[],[],helpers.LEDGER_HEADERS.map(literal),originalLedger],new Date().toISOString(),BOOK).jobs[0];
  assert.equal(restored.source.sourceRevision,documents.get('jobs/'+jobId).caseListSource.sourceRevision,'test must reproduce unchanged-revision early return');
  await importer.executeCaseListImport(COMPANY,'commit',OWNER,owner.auth.token);
  assert.equal(documents.get('jobs/'+jobId).externalImportReviewRequired,true);
  sheetsData.get(2026101601).delete(2);await importer.executeCaseListImport(COMPANY,'commit',OWNER,owner.auth.token);
  assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);
 });

 await test('archive -> ACTUAL Source import -> reconcile retains same original receipt',async()=>{
  const f=await start(false);archiveFixture(f);
  await importer.executeCaseListImport(COMPANY,'commit',OWNER,owner.auth.token);
  assert.equal(documents.get('jobs/'+jobId).sourceMissing,true);assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);
  assert.equal((await reconcile(f)).status,'EXTERNAL_READBACK_VERIFIED');assert.equal(documents.get('jobs/'+jobId).sourceMissing,false);
 });
 await test('common company lease expiry after read prevents commit',async()=>{
  const f=await start(false);archiveFixture(f);
  archiveReadHook=()=>{beforeTransaction=()=>{clockOffset+=121000;};};
  await assert.rejects(()=>reconcile(f),/EXTERNAL_COMPANY_LEASE_EXPIRED/);assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);
 });
 await test('readback freshness rechecked INSIDE commit transaction',async()=>{
  const f=await start(false);archiveFixture(f);
  archiveReadHook=()=>{beforeTransaction=()=>{clockOffset+=61000;};};
  await assert.rejects(()=>reconcile(f),/READBACK_EXPIRED_BEFORE_COMMIT/);assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);
 });
 await test('foreign company lease is preserved without Sheets reads',async()=>{
  const f=await start(false);archiveFixture(f);
  const key='caseListSyncLocks/'+COMPANY;documents.set(key,{tokenId:'foreign',activeUntil:Stamp.fromMillis(Date.now()+120000)});const n=requests.length;
  await assert.rejects(()=>reconcile(f),/EXTERNAL_COMPANY_LEASE_ACTIVE/);assert.equal(requests.length,n);assert.equal(documents.get(key).tokenId,'foreign');
 });
 await test('lost response AFTER metadata commit recovers same acceptance without new Sheets reads',async()=>{
  const f=await start(false);archiveFixture(f);
  archiveReadHook=()=>{afterCommit=()=>{if(documents.get('jobs/'+jobId).applicationUnconfirmed===false){afterCommit=null;throw Error('SYNTHETIC_COMMIT_RESPONSE_LOST');}};};
  await assert.rejects(()=>reconcile(f),/SYNTHETIC_COMMIT_RESPONSE_LOST/);
  const op='caseListMonthlyOperations/'+sha(COMPANY+'|'+f.queueId),h=documents.get(op).externalAcceptance.acceptanceHash,n=requests.length;
  assert.equal((await reconcile(f)).status,'EXTERNAL_ALREADY_ACCEPTED');assert.equal(requests.length,n);assert.equal(documents.get(op).externalAcceptance.acceptanceHash,h);
 });
 await test('header-only Source after archive is proven empty by actual recorded reader',async()=>{
  const f=await start(false);archiveFixture(f);
  metadata.sheets.find(s=>s.properties.sheetId===2026101601).properties.gridProperties.rowCount=1;
  assert.equal((await reconcile(f)).status,'EXTERNAL_READBACK_VERIFIED');
 });
 await test('actual GAS SHA input wrapper equals Crew canonical digest for actor and receipt data',async()=>{
  const context={Utilities:{DigestAlgorithm:{SHA_256:'sha'},Charset:{UTF_8:'utf8'},computeDigest:(algo,input,charset)=>{assert.equal(algo,'sha');assert.equal(charset,'utf8');return [...crypto.createHash('sha256').update(input,'utf8').digest()].map(b=>b>127?b-256:b);}}};
  vm.runInNewContext("function lkCaseMvpSha_(x){const bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,typeof x==='string'?x:JSON.stringify(x),Utilities.Charset.UTF_8);return bytes.map(b=>((b+256)%256).toString(16).padStart(2,'0')).join('');}",context);
  for(const v of ['owner@example.invalid','日本語の合成文字列',null,[1,false,'x'],{z:2,a:{receipt:'synthetic'}},{}])assert.equal(context.lkCaseMvpSha_(helpers.canonical(v)),helpers.hashCaseList(v));
 });
 await test('verified mixed-case executive email uses the same canonical actor identity',async()=>{
  const original=owner.auth.token.email;owner.auth.token.email='OwNeR@Example.Invalid';
  try {const f=await start(false);archiveFixture(f);assert.equal((await reconcile(f)).status,'EXTERNAL_READBACK_VERIFIED');}
  finally {owner.auth.token.email=original;}
 });
 for(const manual of [false,true])await test('V17 RESULT schema '+(manual?'manual':'application')+' stays bound to the original case through actual entry/import consumers with real GAS domain implementations',async()=>{
  const f=await start(manual,true);archiveFixture(f);assert.equal((await reconcile(f)).status,'EXTERNAL_READBACK_VERIFIED');
  await importer.executeCaseListImport(COMPANY,'commit',OWNER,owner.auth.token);assert.equal(documents.get('jobs/'+jobId).sourceMissing,false);
 });
 await test('V17 RESULT A cancellation cannot be published while legacy A semantics remain separate',async()=>{
  const f=resetFixture(false,true);f.cells[0]=literal(true);
  const rows=[Projection.HEADERS.map(literal),f.cells],ledger=[[],[],helpers.LEDGER_HEADERS.map(literal),f.ledger];
  const entry=helpers.inspectCaseList(rows,ledger,new Date().toISOString(),BOOK).jobs[0];assert(entry.holdReasons.includes('LEDGER_SOURCE_CANCELLATION_REVIEW'));
  assert.throws(()=>helpers.confirmedCaseListCandidate(rows,ledger,CASE,{expectedSourceRevision:entry.source.sourceRevision,confirmedFields:{vacancy:true}},new Date().toISOString(),OWNER,BOOK),/CASE_LIST_ASSIGNMENT_RECONCILIATION_REQUIRED/);
 });

 for(const manual of [false,true])await test('V22 archived row moves by later insertion without trusting its obsolete row hint '+(manual?'manual':'application'),async()=>{
  const f=await start(manual,true);archiveFixture(f);
  const table=sheetsData.get(434431224),current=copy(table.get(3)),total=table.get(4),other=copy(current);
  other[1]=literal('SECOND_SYNTHETIC_STAFF');other[10]=literal('SECOND_SYNTHETIC_STORE');other[13]=literal('9:00');other[55]=literal('LKCASE_00000000-0000-0000-0000-000000000003');
  table.set(3,other);table.set(4,current);table.set(5,total);
  current[8].userEnteredValue.formulaValue=load('case-list-gas-date-formula').expectedStaffDateFormula(4,NAME,cellValue(current[8]));
  total[1].userEnteredValue.formulaValue='="（"&(COUNTIF($A$2:$A$5, A5)-1)&"人）"';total[1].effectiveValue={stringValue:'（3人）'};
  metadata.sheets.find(s=>s.properties.sheetId===434431224).properties.gridProperties.rowCount=6;
  await reconcile(f);assert.equal(documents.get('jobs/'+jobId).sheetRef.currentRow,4);assert.equal(documents.get('jobs/'+jobId).assignmentSheetWrite.queueId,f.queueId);
 });
 for(const [name,mutate]of [
  ['different name-up fingerprint',r=>r.selection.nameUp.expectedFingerprint='a'.repeat(64)],
  ['missing verified message ID',r=>r.selection.nameUp.messageId=''],
  ['legacy owner confirmation substituted for verified send',r=>r.selection.confirmation='OWNER_CONFIRMATION_AT_THIS_CALL'],
  ['legacy approval fields substituted for fingerprint',r=>r.selection.approvedProof='a'.repeat(64)],
  ['preparation predates protected selection',r=>r.selection.nameUp.preparedAt='2020-01-01T00:00:00.000Z'],
  ['name-up confirmation exceeds three-minute window',r=>r.selection.nameUp.preparedAt=new Date(Date.parse(r.selection.nameUp.authorizedAt)-180000).toISOString()],
 ])await test('V22 receipt keeps original pending queue when '+name,async()=>{
  const f=await start(false,true);archiveFixture(f);changeReceipt(mutate);
  await assert.rejects(()=>reconcile(f),/NAMEUP_SENT_BINDING_REQUIRED|NAMEUP_PREPARATION_NOT_CURRENT/);
  assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);assert.equal(documents.get('jobs/'+jobId).assignmentSheetWrite.queueId,f.queueId);assert.equal([...documents.keys()].filter(k=>k.startsWith('sheetSyncQueue/')).length,1);
 });


 async function externalIssue(f,auth=owner){const before=writes,reads=requests.length,result=await admin.getSheetWriteIssues({...auth,data:{limit:25}}),issue=result.issues.find(issue=>issue.id===f.queueId);assert(issue);assert.equal(writes,before,'issue reads never settle the original operation');assert.equal(requests.length,reads,'issue list does not start a Sheets reconciliation');return issue;}
 for(const [mode,allowed]of [['read-only',false],['paused',true]])await test('actual Admin external readback availability follows '+mode+' without writes',async()=>{const f=await start(true,true),prior=runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE;try{runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE=mode;const issue=await externalIssue(f);assert.equal(issue.canReconcile,allowed);assert.equal(issue.canSelectMonthlyTransfer,false);assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);}finally{runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE=prior;}});
 await test('actual Admin external readback is unavailable to a non-executive admin',async()=>{const f=await start(true,true),auth=copy(owner);auth.auth.token.email='other_admin@example.invalid';const issue=await externalIssue(f,auth);assert.equal(issue.canReconcile,false);assert.equal(issue.canSelectMonthlyTransfer,false);});
 const report={scope:'Whole Crew product functions use the REAL single-case planner/proof/fingerprint shared by V17 and V22 and LK_SD 2.0.1 formula, with synthetic Sheets/Firestore/Auth transport only. Archive fixtures still represent GAS output rather than executing real GAS or Sheets formula evaluation.',
 tests:results.length,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results,realApiCalls:0,realDataWrites:0,confirmedJourneyComplete:false,
 realProofProvider:true,realDateProvider:true,domainProviderSubstitutions:0,sdkTransportDoubles:true,actualGasExecution:false,
 originalGASOracle:'Exact monthRows/proof/batch/digest excerpts; planner is the reviewed original port, with independently pinned expected position shape',
 appUploadPreflight:'Extracted actual main App preflight only; no React mount, server acceptance, file persistence or upload',
 remaining:['Supervisor name-up/cancellation contract','Cloud revision routing/drain and producer quiesce','Live formula evaluation/row-copy behavior','Real authenticated acceptance and approved adoption','External finance observation contract/reader and real submission backend acceptance']};
 fs.mkdirSync(path.join(repoRoot,'release-evidence'),{recursive:true});fs.writeFileSync(path.join(repoRoot,'release-evidence/ci-crew-external-normal.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
})();
