'use strict';
// Executes the actual TS worker/Core with fully synthetic fixtures and mocked I/O.
// Uses Node built-in TypeScript syntax stripping; it performs no cloud calls.
// This is not a TypeScript semantic build or a real Firebase/Google acceptance.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {stripTypeScriptTypes,createRequire}=require('node:module');
const gasOriginal=require('./fixtures/crew-external-gas-reference.cjs');
const repoRoot=path.resolve(__dirname,'..');
const evidenceDir=process.env.LKC_TEST_SYNTHETIC_EVIDENCE_DIR||path.join(repoRoot,'release-evidence');
const src=path.join(repoRoot,'functions/src');
const clientRequire=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||repoRoot,'package.json'));
const serverRequire=createRequire(path.join(process.env.LKC_TEST_SERVER_DEPENDENCY_ROOT||repoRoot,'package.json'));

const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
class Stamp{constructor(ms){this.ms=ms;}get seconds(){return Math.floor(this.ms/1000);}get nanoseconds(){return Math.round((this.ms-this.seconds*1000)*1_000_000);}toMillis(){return this.ms;}toDate(){return new Date(this.ms);}static now(){return new Stamp(Date.now());}static fromMillis(ms){return new Stamp(ms);}static fromDate(date){return Stamp.fromMillis(date.getTime());}}
const DELETE={delete:true},FieldValue={serverTimestamp:()=>Stamp.now(),delete:()=>DELETE,increment:n=>({__increment:n})};
function copy(x){if(x instanceof Stamp)return new Stamp(x.ms);if(Array.isArray(x))return x.map(copy);if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,copy(v)]));return x;}
let clockOffset=0;class Clock extends Date{static now(){return Date.now()+clockOffset;}}
let beforeTransaction=null,archiveReadHook=null,gasReadHook=null;
let concurrentStopAtCommit=null,controlConflicts=0;
let googleReadHandler=null;let operational=true,nativeCalls=0,documents=new Map(),writes=0,readerProvider=null,nativeHandler=null,txTail=Promise.resolve(),afterCommit=null,generated=0;
const documentReads=[],documentWrites=[];
class Doc{constructor(p){this.path=p;this.id=p.split('/').pop();}async get(){documentReads.push(this.path);const data=documents.get(this.path);return {exists:data!==undefined,ref:this,id:this.id,data:()=>copy(data)};}collection(n){return new Query(this.path+'/'+n);}}
class Query{constructor(p,filters=[],max=Infinity,after=null){this.path=p;this.filters=filters;this.max=max;this.after=after;}doc(id){return new Doc(this.path+'/'+(id??('generated_fixture_'+(++generated))));}where(k,op,v){assert(['==','in','>=','<='].includes(op));return new Query(this.path,[...this.filters,[k,v,op]],this.max,this.after);}limit(n){return new Query(this.path,this.filters,n,this.after);}orderBy(field){assert(['__name__','updatedAt'].includes(field));return this;}startAfter(id){return new Query(this.path,this.filters,this.max,id);}async get(){documentReads.push(this.path+'/*');const found=[...documents].filter(([p,v])=>p.startsWith(this.path+'/')&&!p.slice(this.path.length+1).includes('/')&&this.filters.every(([k,w,op])=>op==='in'?w.includes(v[k]):op==='>='?v[k]>=w:op==='<='?v[k]<=w:v[k]===w)&&(!this.after||p.split('/').pop()>this.after)).sort(([a],[b])=>a<b?-1:a>b?1:0).slice(0,this.max);const docs=found.map(([p,data])=>({id:p.split('/').pop(),ref:new Doc(p),data:()=>copy(data)}));return {docs,size:docs.length};}}

const db={collection:n=>new Query(n),async runTransaction(fn){
 const previous=txTail;let release;txTail=new Promise(r=>release=r);await previous;
 try{
  if(beforeTransaction){const hook=beforeTransaction;beforeTransaction=null;hook();}
  for(let retry=0;retry<3;retry++){
   const pending=[],controlReads=new Map();
   const tx={
    async get(r){
     const snap=await r.get();
     if(r.path.startsWith("productionControls/"))controlReads.set(r.path,JSON.stringify(snap.data()));
     return snap;
    },
    set:(r,v,o)=>pending.push(["set",r,v,o]),update:(r,v)=>pending.push(["set",r,v,{merge:true}]),
    create:(r,v)=>{assert(!documents.has(r.path));pending.push(["set",r,v,{}]);},delete:r=>pending.push(["delete",r])
   };
   const out=await fn(tx);
   if(concurrentStopAtCommit&&pending.some(write=>concurrentStopAtCommit(write))){
    concurrentStopAtCommit=null;
    documents.set("productionControls/"+COMPANY,{productionEnabled:true,emergencyLock:true,generation:2});
   }
   if([...controlReads].some(([ref,snapshot])=>JSON.stringify(documents.get(ref))!==snapshot)){controlConflicts++;continue;}
   for(const [kind,r,v,o]of pending){
    writes++;documentWrites.push(r.path);if(kind==="delete"){documents.delete(r.path);continue;}
    const data=o?.merge?copy(documents.get(r.path)||{}):{};
    for(const [k,val]of Object.entries(v)){if(val===DELETE)delete data[k];else if(val?.__increment!==undefined)data[k]=Number(data[k]??0)+val.__increment;else data[k]=copy(val);}
    documents.set(r.path,data);
   }
   if(afterCommit)afterCommit();
   return out;
  }
  throw Error("SYNTHETIC_RETRY_LIMIT");
 }finally{release();}
}};
db.getAll=async(...refs)=>Promise.all(refs.map(ref=>ref.get()));
let bindingReadTransactions=0;
const runTransaction=db.runTransaction;
db.runTransaction=(fn,options)=>options?.readOnly===true?runTransaction(tx=>{
 bindingReadTransactions++;
 const forbidden=()=>assert.fail('Read-only binding attempted a document mutation');
 return fn({...tx,getAll:(...refs)=>Promise.all(refs.map(ref=>tx.get(ref))),set:forbidden,update:forbidden,create:forbidden,delete:forbidden});
}):runTransaction(fn);
const cache=new Map();
const runtimeEnvironment={APP_ENVIRONMENT:'staging',EXECUTIVE_APPROVER_EMAILS:'owner@example.invalid',LKC_CASE_LIST_EXTERNAL_MODE:'enabled'};
function load(name){const file=path.join(src,name+'.ts');if(cache.has(file))return cache.get(file);const source=fs.readFileSync(file,'utf8');const ts=clientRequire('typescript');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const context={Buffer,process:{env:runtimeEnvironment},Error,Date:Clock,fetch:()=>{throw Error('EXTERNAL_NETWORK_FORBIDDEN');},module:{exports:{}},exports:{},console,require:specifier=>{
  if(specifier==='node:crypto'||specifier==='node:buffer')return require(specifier);
  if(specifier==='firebase-functions/v2/https')return {onCall:(...args)=>args.at(-1),HttpsError:class extends Error{constructor(code,message,details){super(message);this.code=code;this.details=details;}}};
  if(specifier==='firebase-functions/v2/firestore')return {onDocumentWritten:(...args)=>args.at(-1),onDocumentCreated:(...args)=>args.at(-1)};
  if(specifier==='firebase-functions/v2/scheduler')return {onSchedule:(...args)=>args.at(-1)};
  if(specifier==='firebase-functions/v2/storage')return {onObjectFinalized:(...args)=>args.at(-1)};
  if(specifier==='node:path')return require(specifier);
  if(specifier==='firebase-admin/firestore')return {Timestamp:Stamp,FieldValue,FieldPath:{documentId:()=>"__name__"}};
  if(specifier==='googleapis')return {google:{auth:{GoogleAuth:class{}},sheets:()=>({spreadsheets:{get:async request=>{if(!googleReadHandler)throw Error('GOOGLE_READ_NOT_BOUND');return {data:await googleReadHandler(request)};},batchUpdate:async(body,options)=>{nativeCalls++;if(!nativeHandler)throw Error('GOOGLE_WRITE_FORBIDDEN');return nativeHandler(body,options);}}})}};
  if(specifier==='./case-list-firebase-owner')return {withFirebaseOwnerCallable:async(request,session,operation)=>{
    const actual=load('case-list-firebase-owner'),at=Clock.now(),sec=Math.floor(at/1000),project='lip-knots-crew-staging',subject='100000000000000001',authorization='Bearer AAA.BBB.CCC';
    // This fixture's `auth` models the native verified context, never request.data.
    // Mirror it in the decoded-token port so negative identities remain negative.
    const native=session.token,claims={aud:project,iss:'https://securetoken.google.com/'+project,uid:native.uid??session.uid,sub:native.sub??native.uid??session.uid,email:native.email,email_verified:native.email_verified,role:native.role,companyId:native.companyId,iat:sec-1,exp:sec+3500,auth_time:sec-10,firebase:{sign_in_provider:'google.com',identities:{'google.com':[subject]}}};
    const user={uid:OWNER,email:'owner@example.invalid',emailVerified:true,disabled:false,tenantId:null,providerData:[{providerId:'google.com',uid:subject}],customClaims:{role:'admin',companyId:COMPANY},mfaState:'NONE',validSinceMs:at-60000};
    const verifiedRequest={...request,rawRequest:{headers:{authorization},rawHeaders:['Authorization',authorization]}};
    return actual.withFirebaseOwnerCallable(verifiedRequest,session,operation,{projectId:project,actualProjectId:project,companyId:COMPANY,ownerUid:OWNER,executiveEmails:['owner@example.invalid']},
      {now:()=>Clock.now(),verifyFirebaseIdentity:async(token,revoked)=>{assert.equal(token,'AAA.BBB.CCC');assert.equal(revoked,true);return copy(claims);},readFirebaseUserByGoogleSubject:async googleSubject=>{assert.equal(googleSubject,subject);return {...copy(user),observedAt:Clock.now()};}});
  }};
  if(specifier==='./firebase')return {db};
  if(specifier==='zod')return serverRequire('zod');
  if(specifier==='./utils')return load('utils');
  if(specifier==='./automation-intake')return {readMailApplicationForAssignment:async()=>assert.fail('Cancellation fixture cannot read mail applications')};
  if(specifier==='./case-mail-publication')return {readMailPublication:async()=>assert.fail('Cancellation fixture cannot read mail publication')};
  if(specifier==='./case-list-source')return load('case-list-source');
  if(specifier==='./system-safety')return {getProductionOperationalState:async(companyId,reader)=>runtimeEnvironment.APP_ENVIRONMENT==='production'?load('system-safety').getProductionOperationalState(companyId,reader):{operational},assertProductionOperational:async()=>{if(!operational)throw Object.assign(new Error('stopped'),{code:'failed-precondition'});}};
  if(specifier==='./case-list-monthly-reader')return load('case-list-monthly-reader');
  // These downstream I/O ports must remain unreachable in backend refusal tests.
  if(specifier==='./google-drive-client')return {getWritableDriveClient:()=>assert.fail('Drive transport forbidden')};
  if(specifier==='./drive-transfer')return Object.fromEntries(['assertTransferCheckpoint','assertTransferSource','transferSource','transferWithStableId'].map(k=>[k,()=>assert.fail('Transfer boundary forbidden: '+k)]));
  if(specifier==='./drive-folder-cache')return {ensureSubmissionFolder:()=>assert.fail('Folder lookup or write forbidden')};
  if(specifier==='./resubmissions')return {markResubmissionReplacementFile:()=>assert.fail('Replacement write forbidden'),markResubmissionSubmitted:()=>assert.fail('Resubmission write forbidden')};
  if(specifier.endsWith('.cjs'))return require(path.resolve(path.dirname(file),specifier));
  if(specifier.startsWith('./'))return load(specifier.slice(2));
  throw Error('Unexpected import '+specifier);
}};context.exports=context.module.exports;vm.runInNewContext(js,context,{filename:file});cache.set(file,context.module.exports);return context.module.exports;}

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
 runtimeEnvironment.APP_ENVIRONMENT='staging';concurrentStopAtCommit=null;controlConflicts=0;
 runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='enabled';clockOffset=0;documents=new Map();writes=0;generated=0;nativeCalls=0;requests=[];documentReads.length=0;documentWrites.length=0;afterCommit=null;afterRead=null;beforeTransaction=null;archiveReadHook=null;gasReadHook=null;txTail=Promise.resolve();
 delete runtimeEnvironment.LKC_SHEET_WRITE_MODE;
 runtimeEnvironment.DEFAULT_COMPANY_ID=COMPANY;
 documents.set('staffNgMaintenance/'+COMPANY,{schema:'LK_STAFF_NG_MAINTENANCE_V1',companyId:COMPANY,state:'OPEN',generation:0});
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
 const ng=load('staff-ng'),ngHeader=Array(11).fill('');ngHeader[10]='NG会社';
 const knownBlankNg=staffId=>ng.mergeStaffNg([{sourceRef:{spreadsheetId:'synthetic-staff-master',sheetName:'マスターデータ'},ngCompanyObservation:ng.observeStaffNgCell('マスターデータ',ngHeader,[],19)}],COMPANY,staffId);
 documents.set('staffProfiles/'+STAFF,{companyId:COMPANY,displayName:NAME,active:true,ngCompanies:knownBlankNg(STAFF)});
 documents.set('authIdentities/'+staffAuth.auth.uid,{companyId:COMPANY,staffId:STAFF,active:true});
 documents.set('staffProfiles/other_synthetic_staff',{companyId:COMPANY,displayName:'OTHER_SYNTHETIC_STAFF',active:true,ngCompanies:knownBlankNg('other_synthetic_staff')});
 googleReadHandler=googleRead;
 nativeHandler=async body=>{
  assert.equal(body.spreadsheetId,BOOK);const writes=body.requestBody.requests;assert.equal(writes.length,1);
  const edit=writes[0].updateCells;assert.equal(edit.range.sheetId,2026101601);assert.equal(edit.range.startColumnIndex,2);assert.equal(edit.fields,'userEnteredValue');
  cells[2].userEnteredValue=copy(edit.rows[0].values[0].userEnteredValue);cells[2].effectiveValue=copy(cells[2].userEnteredValue);cells[6].effectiveValue=copy(cells[2].effectiveValue);return {};
 };
 jobId=ids.createJobIdFromPersistedCaseId(COMPANY,CASE);
 return {cells,ledger};
}
async function start(manual=false,modern=false,configure=()=>{},prepareOnly=false){
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
 if(prepareOnly)return {...f,request};
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
async function submissionPreflight(job,selectedId=jobId,displayed={}){
 const files=[{name:'synthetic.pdf',size:10}],messages=[],context={files,submissionConfirmed:true,isSubmissionActionPending:()=>false,
  draftCleanup:null,draftKey:'synthetic',MAX_SUBMISSION_FILE_SIZE:50*1024*1024,selectedJob:{...job,...displayed,id:selectedId},myJobs:[{...job,id:jobId}],
  hasValidDateKey:list.hasValidDateKey,setSubmissionConfirmed:value=>{context.submissionConfirmed=value;},
  requestId:'',resubmissionDetail:null,submissionType:'report',showSubmissionMessage:m=>messages.push(m)};
 vm.runInNewContext(uploadPreflight+'\nthis.invoke=uploadSubmission;',context);
 const out=await context.invoke();assert.equal(context.files,files);assert.equal(files.length,1);assert.equal(files[0].name,'synthetic.pdf');
 return {out,messages,confirmed:context.submissionConfirmed};
}
const binding=async f=>{const out=await admin.acknowledgeSheetWriteIssue({...owner,data:{queueId:f.queueId,action:'read-case-list-gas-binding'}});assert.equal(out.status,'EXTERNAL_BINDING_READ');assert.equal(out.sourceWrites,0);assert.equal(out.monthlyWrites,0);return out.binding;};
const assignmentQueueCount=()=>[...documents].filter(([p,v])=>p.startsWith('sheetSyncQueue/')&&v.operation==='case_list.assign').length;
function protectedState(){return helpers.canonical([...documents]);}
async function bindingHasNoSideEffects(fn){const before=protectedState(),w=writes,n=requests.length,priorNative=nativeCalls;const out=await fn();assert.equal(protectedState(),before);assert.equal(writes,w);assert.equal(requests.length,n);assert.equal(nativeCalls,priorNative);return out;}
async function pendingSubmissionBackend(cancelled=false,staffRevoked=false){
 const job=documents.get('jobs/'+jobId),w=writes,n=requests.length;
 const denied=e=>staffRevoked?e.code==='permission-denied':e.code==='failed-precondition'&&(cancelled?/キャンセル/.test(e.message):e.details?.reason==='assignment_sheet_confirmation_pending');
 await assert.rejects(()=>load('precontact').submitPreContact({...staffAuth,data:{jobId,dateKey:job.dateKey,expectedRevision:job.revision,temperature:36.5,arrivalTime:'09:00'}}),denied);
 await assert.rejects(()=>load('uploads').createUploadSession({...staffAuth,data:{jobId,type:'report',files:[{originalName:'synthetic.pdf',contentType:'application/pdf',size:10}]}}),denied);
 assert.equal(writes,w);assert.equal(requests.length,n);assert(![...documents.keys()].some(p=>p.startsWith('submissions/')));
 const loadTasks=()=>load('staff-tasks').getMyTasks(staffAuth);
 if(staffRevoked)await assert.rejects(loadTasks,{code:'permission-denied'});
 else assert(!(await loadTasks()).tasks.some(t=>t.jobId===jobId));
}
function preArchiveMonthlyRow(f){
 const source=sheetsData.get(2026101601),ledger=copy(sheetsData.get(2026102605).get(4));
 archiveFixture(f);
 sheetsData.set(2026101601,source);sheetsData.get(2026102605).set(4,ledger);
 return sheetsData.get(434431224);
}
async function requestPreArchiveBoundary(f){
 const now=()=>Clock.now(),epoch=Math.floor(now()/1000),subject='100000000000000001',
  audience='123456789-synthetic.apps.googleusercontent.com',email='owner@example.invalid';
 const auth={now,config:{projectId:'lip-knots-crew-staging',actualProjectId:'lip-knots-crew-staging',companyId:COMPANY,audience,executiveEmails:[email]},
  verifyGoogleIdentity:async()=>({iss:'https://accounts.google.com',aud:audience,sub:subject,email,email_verified:true,iat:epoch-1,exp:epoch+600,auth_time:epoch-5}),
  readFirebaseUserByGoogleSubject:async()=>({uid:OWNER,email,emailVerified:true,disabled:false,tenantId:null,mfaState:'NONE',
   customClaims:{role:'admin',companyId:COMPANY},providerData:[{providerId:'google.com',uid:subject}],validSinceMs:(epoch-60)*1000,observedAt:now()}),
 };
 const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'synthetic'})).toString('base64url');
 const original=load('case-list-external-transfer');
 const actor={uid:OWNER,companyId:COMPANY,role:'admin',email,email_verified:true};
 const saved=await original.readExternalOriginalForGasHandoff(db.collection('sheetSyncQueue').doc(f.queueId),OWNER,actor);
 const identity=require(path.join(src,'case-list-external-core.cjs')).originalIdentity(saved);
 const ports=load('case-list-gas-crew-ports').createCrewSyncPorts({auth,authorization:'Bearer '+header+'.e30.synthetic',
  now,readFormal:()=>assert.fail('Previously protected assignment must not rebuild formal selection'),
  reads:{now,hash:shaValue,readMonthly:(companyId,id)=>load('case-list-monthly-reader').readCaseListMonthlySnapshot(companyId,id,{includeDependencies:true})},
 });
 const state={deadlineAt:now()+90_000,items:[{caseId:CASE,queueId:f.queueId,eligible:{jobId,originalIdentity:identity}}]};
 return ports.currentBoundary(state,actor,'BEFORE_SOURCE_ARCHIVE',[CASE]);
}
(async()=>{
 for(const manual of [false,true])await test('before Source archive / verified month while original stays present '+manual,async()=>{
  const f=await start(manual,true);preArchiveMonthlyRow(f);
  const before=protectedState(),sheetsWrites=nativeCalls,docWrites=writes;
  assert.equal(await requestPreArchiveBoundary(f),true);
  assert.equal(protectedState(),before);assert.equal(nativeCalls,sheetsWrites);assert.equal(writes,docWrites);
  await pendingSubmissionBackend();
 });
 for(const [name,mutate] of [
  ['missing monthly row',null],
  ['wrong person',month=>{month.get(3)[1]=literal('different-synthetic-staff');}],
  ['different work date',month=>{month.get(3)[0]=literal(serial('2026-12-07'));}],
  ['amount differs',month=>{month.get(3)[36]=literal(999);}],
  ['missing matching business row',month=>{month.get(3)[55]=literal('LKCASE_00000000-0000-0000-0000-000000000099');}],
 ])await test('before Source archive / holds '+name,async()=>{
  const f=await start(false,true);if(mutate)mutate(preArchiveMonthlyRow(f));
  const before=protectedState(),sheetsWrites=nativeCalls,docWrites=writes;
  await assert.rejects(()=>requestPreArchiveBoundary(f),{code:'HANDOFF_MONTH_ARCHIVE_UNVERIFIED'});
  assert.equal(protectedState(),before);assert.equal(nativeCalls,sheetsWrites);assert.equal(writes,docWrites);
  assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);
 });
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
  const f=await start(false,true);change(f);await bindingHasNoSideEffects(async()=>assert.rejects(()=>binding(f)));assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);assert.equal(assignmentQueueCount(),1);await pendingSubmissionBackend(false,['inactive staff','revoked original identity'].includes(name));
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
   await bindingHasNoSideEffects(async()=>assert.rejects(()=>admin.acknowledgeSheetWriteIssue({auth:{uid,token:{...owner.auth.token,uid}},data:{queueId:f.queueId,action:'read-case-list-gas-binding'}}),e=>e.details?.code==='FIREBASE_OWNER_CALLABLE_SCOPE_CHANGED'));
   await bindingHasNoSideEffects(async()=>assert.rejects(()=>load('case-list-external-transfer').readExternalCaseListSelectionBinding(db.collection('sheetSyncQueue').doc(f.queueId),uid,{...owner.auth.token,uid}),/PROTECTED_SELECTION_MISMATCH/));
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
  await bindingHasNoSideEffects(async()=>assert.rejects(()=>binding(f),/EXTERNAL_ACTOR_IDENTITY_REVOKED/));await pendingSubmissionBackend(false,!manual);assert.equal(assignmentQueueCount(),1);
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
 function activeControl(){
  runtimeEnvironment.APP_ENVIRONMENT='production';
  documents.set('productionControls/'+COMPANY,{productionEnabled:true,emergencyLock:false,generation:1});
 }
 await test('emergency stop / holds the manual registration if the stop commits first',async()=>{
  await assert.rejects(()=>start(true,true,()=>{
   activeControl();concurrentStopAtCommit=([,ref,value])=>ref.path.startsWith('caseListMonthlyOperations/')&&value?.externalManualRequested===true;
  }),/GLOBAL_OPERATION_STOPPED_BEFORE_MANUAL_COMMIT/);
  assert.equal(controlConflicts,1);
  assert.equal(documents.get('caseListManualObservations/'+jobId).selected,false);
  assert(!documents.get('jobs/'+jobId).assignmentSheetWrite);
  assert(![...documents.keys()].some(ref=>ref.startsWith('sheetSyncQueue/')));
  assert.equal(nativeCalls,0);
 });
 await test('emergency stop / holds the protected selection if the stop commits first',async()=>{
  await assert.rejects(()=>start(false,true,()=>{
   activeControl();concurrentStopAtCommit=([,ref,value])=>ref.path.startsWith('caseListMonthlyOperations/')&&!!value?.externalSelection;
  }),/GLOBAL_OPERATION_STOPPED_BEFORE_EXTERNAL_COMMIT/);
  assert.equal(controlConflicts,1);
  const {assignmentSheetWrite,applicationUnconfirmed}=documents.get('jobs/'+jobId);
  assert.equal(applicationUnconfirmed,true);
  assert(!documents.get('caseListMonthlyOperations/'+sha(COMPANY+'|'+assignmentSheetWrite.queueId)).externalSelection);
  assert(!documents.has('caseListSyncLocks/'+COMPANY));
  assert.equal(nativeCalls,1);
 });
 await test('emergency stop / holds the final receipt if the stop commits first, then reads the same receipt after resume',async()=>{
  const f=await start(false,true),identity='caseListMonthlyOperations/'+sha(COMPANY+'|'+f.queueId),record=archiveFixture(f);
  const original=copy(documents.get(identity).externalSelection),before=nativeCalls;
  activeControl();concurrentStopAtCommit=([,ref,value])=>ref.path===identity&&!!value?.externalAcceptance;
  await assert.rejects(()=>reconcile(f),/GLOBAL_OPERATION_STOPPED_BEFORE_EXTERNAL_COMMIT/);
  assert.equal(controlConflicts,1);
  assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,true);
  assert(!documents.has('caseListSheetRefs/'+jobId));
  assert(!documents.get(identity).externalAcceptance);
  assert.deepEqual(documents.get(identity).externalSelection,original);
  assert(!documents.has('caseListSyncLocks/'+COMPANY));
  documents.set('productionControls/'+COMPANY,{productionEnabled:true,emergencyLock:false,generation:3});
  const accepted=await reconcile(f);
  assert.equal(accepted.status,'EXTERNAL_READBACK_VERIFIED');
  assert.equal(accepted.queueId,f.queueId);
  assert.equal(documents.get(identity).externalAcceptance.receiptHash,record.receipt.receiptHash);
  assert.equal(nativeCalls,before);
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
  vm.runInNewContext(fs.readFileSync(coreFile,'utf8')+'\nmodule.exports={...module.exports,checkDefaults:assertOperationalDefaults};',{module,require:s=>s==='./case-list-monthly-controller.cjs'?Native:s==='./case-list-assignment-observation.cjs'?require(path.join(src,'case-list-assignment-observation.cjs')):require(s),Date,Buffer});
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
  const accepted=documents.get('jobs/'+jobId);
  for(const mismatch of [{dateKey:'2026-02-30'},{dateKey:'2026-12-31'},{revision:(accepted.revision??0)+1}]){
   state=await submissionPreflight(accepted,jobId,mismatch);
   assert.equal(state.out,undefined);
   assert.equal(state.confirmed,false);
   assert.match(state.messages[0],/勤務日・版/u);
  }
 });
 await test('actual App submission preflight retains files for Source, owner and mail review holds',async()=>{
  const f=await start(false);archiveFixture(f);await reconcile(f);const j=documents.get('jobs/'+jobId);
  for(const patch of [{sourceMissing:true},{assignmentUnresolved:true},{mailIntakeReviewRequired:true},{applicationUnconfirmed:true}]){
   const state=await submissionPreflight({...j,...patch});assert.equal(state.out,undefined);assert(state.messages[0].includes('保持'));
  }
 });
 for(const manual of [false,true])await test((manual?'manual name':'actual applyToJob')+' accepted external receipt alone cannot release legacy financial consumer or create an observation',async()=>{
  const f=await start(manual);archiveFixture(f);await reconcile(f);const before=writes;
  await assert.rejects(()=>priv.resolveCaseListPrivateFinancialJob(COMPANY,jobId,documents.get('jobs/'+jobId)),e=>e.details?.reason==='case_list_external_finance_observation_required');
  assert.equal(writes,before);assert(!documents.has('caseListMonthlyObservations/'+jobId));
 });
 async function acceptedExpenseFixture(manual=false,columns={transportation:'AK',purchase8:'AL',purchase10:'AM',netPrintCost:'AO',postageCost:'AP'}){
  const f=await start(manual,false,()=>{documents.get('sheetImportConfigs/'+COMPANY).columns=columns;});archiveFixture(f);
  assert.equal((await reconcile(f)).status,'EXTERNAL_READBACK_VERIFIED');
  const month=sheetsData.get(434431224),row=month.get(3);
  assert.equal(cellValue(row[55]),CASE);
  row[36]=literal(700);row[37]={};row[38]=literal(0);row[40]=literal(50);row[41]=literal(90);
  return {f,month,row,read:()=>admin.getExpenseReview({...owner,data:{jobId}})};
 }
 for(const manual of [false,true])await test('external expense readback / '+(manual?'manual':'application')+' private amounts and fresh version',async()=>{
  const {read,row}=await acceptedExpenseFixture(manual);
  const before=writes,beforeNative=nativeCalls,shared=JSON.stringify(documents.get('jobs/'+jobId));
  const result=await read();
  assert.deepEqual(copy(result.currentValues),{transportation:700,purchase8:null,purchase10:0,netPrintCost:50,postageCost:90});
  assert.match(result.reviewVersion,/^[a-f0-9]{64}$/);
  assert.equal((await read()).reviewVersion,result.reviewVersion);
  row[36]=literal(701);
  const refreshed=await read();assert.equal(refreshed.currentValues.transportation,701);
  assert.notEqual(refreshed.reviewVersion,result.reviewVersion);
  assert.ok(refreshed.writeBlockedReason);
  await assert.rejects(()=>admin.completeExpenseReview({...owner,data:{jobId,values:{transportation:701},expectedVersion:refreshed.reviewVersion}}),
   e=>e.code==='failed-precondition');
  assert.equal(writes,before);assert.equal(nativeCalls,beforeNative);
  assert.equal(JSON.stringify(documents.get('jobs/'+jobId)),shared);
  assert(!documents.has('expenseReviews/'+jobId));
 });
 await test('external expense readback / moved row resolves the fixed ID and updates the reviewed version',async()=>{
  const {read,row,month}=await acceptedExpenseFixture(),first=await read();
  month.set(4,row);month.delete(3);
  const moved=await read();
  assert.equal(moved.currentValues.transportation,700);
  assert.match(moved.job.sheetUrl,/range=A4:BB4(?:$|&)/);
  assert.notEqual(moved.reviewVersion,first.reviewVersion);
 });
 for(const [name,mutate] of [
  ['different staff',({row})=>{row[1]=literal('OTHER_SYNTHETIC_STAFF');}],
  ['different work date',({row})=>{row[0]=literal(serial('2026-12-07'));}],
  ['different case ID',({row})=>{row[55]=literal(OTHER);}],
  ['duplicated case ID',({row,month})=>{month.set(4,copy(row));}],
  ['formula result unobserved',({row})=>{row[36]={userEnteredValue:{formulaValue:'=1'}};}],
  ['amount outside the allowed range',({row})=>{row[36]=literal(-1);}],
  ['text cannot become a yen amount',({row})=>{row[36]=literal('700');}],
  ['different company on the staff document',()=>{documents.get('staffProfiles/'+STAFF).companyId='foreign_synthetic';}],
  ['job revision changes during the monthly read',()=>{archiveReadHook=()=>{documents.get('jobs/'+jobId).revision++;};}],
  ['stale archive read',()=>{archiveReadHook=()=>{clockOffset=61_000;};}],
 ]) await test('external expense readback / rejects '+name,async()=>{
  const input=await acceptedExpenseFixture();const before=writes,beforeNative=nativeCalls;
  mutate(input);
  await assert.rejects(input.read,e=>e.code==='failed-precondition'&&e.details?.reason==='case_list_external_expense_readback_unverified');
  assert.equal(writes,before);assert.equal(nativeCalls,beforeNative);
 });
 await test('external expense readback / staff and a foreign admin cannot query the row',async()=>{
  await acceptedExpenseFixture();const before=requests.length;
  await assert.rejects(()=>admin.getExpenseReview({...staffAuth,data:{jobId}}),e=>e.code==='permission-denied');
  await assert.rejects(()=>admin.getExpenseReview({auth:{...owner.auth,token:{...owner.auth.token,companyId:'foreign_synthetic'}},data:{jobId}}),e=>e.code==='not-found');
  assert.equal(requests.length,before);
 });
 await test('external expense readback / rejects a different configured expense column after valid acceptance',async()=>{
  const {read}=await acceptedExpenseFixture(false,{transportation:'AN'}),before=writes;
  await assert.rejects(read,e=>e.details?.reason==='case_list_external_expense_readback_unverified');
  assert.equal(writes,before);
 });
 await test('external expense readback / confirmation compares exact editable cells and preserves formulas with the same value',async()=>{
  const {read,row}=await acceptedExpenseFixture();
  row[40]={userEnteredValue:{formulaValue:'=50'},effectiveValue:{numberValue:50}};
  const transfer=load('case-list-external-transfer'),before=writes,beforeNative=nativeCalls;
  const privateObservation=await transfer.readExternalCaseListExpenses(COMPANY,jobId,documents.get('jobs/'+jobId));
  const shown=await read(),values={...shown.currentValues,transportation:null,purchase8:0};
  assert(!Object.hasOwn(shown,'expenseCells'));
  assert.deepEqual(copy(transfer.planExternalExpenseConfirmation(privateObservation,values)),[
   {column:'AK',index:36,expected:{numberValue:700},value:{}},
   {column:'AL',index:37,expected:{},value:{numberValue:0}},
  ]);
  const complete=(expectedVersion,reviewValues)=>admin.completeExpenseReview({...owner,data:{jobId,values:reviewValues,expectedVersion}});
  await assert.rejects(()=>complete(shown.reviewVersion,values),e=>e.details?.reason==='case_list_private_expense_completion_held');
  await assert.rejects(()=>complete(shown.reviewVersion,{...values,netPrintCost:51}),e=>e.details?.reason==='case_list_external_expense_cell_protected');
  row[40].userEnteredValue.formulaValue='=25*2';
  const refreshed=await read();
  assert.equal(refreshed.currentValues.netPrintCost,50);
  assert.notEqual(refreshed.reviewVersion,shown.reviewVersion);
  await assert.rejects(()=>complete(shown.reviewVersion,values),e=>e.code==='failed-precondition'&&!e.details);
  assert.equal(writes,before);assert.equal(nativeCalls,beforeNative);
 });
 await test('external expense readback / save and re-read a versioned admin-only draft',async()=>{
  const {read,row}=await acceptedExpenseFixture();
  const initial=await read();
  assert.equal(initial.draftAllowedWhileHeld,true);
  const shared=JSON.stringify(documents.get('jobs/'+jobId)),beforeNative=nativeCalls;
  const draftReq={...owner,data:{jobId,values:{transportation:850,purchase8:null,purchase10:0},note:'合成メモ'}};
  await assert.rejects(()=>admin.saveExpenseReviewDraft(draftReq),e=>e.details?.reason==='case_list_private_expense_version_required');
  row[36]=literal(702);
  const stale={...draftReq,data:{...draftReq.data,expectedVersion:initial.reviewVersion}};
  await assert.rejects(()=>admin.saveExpenseReviewDraft(stale),e=>e.code==='failed-precondition');
  assert(!documents.has('expenseReviews/'+jobId));
  const updated=await read();
  const valid={...draftReq,data:{...draftReq.data,expectedVersion:updated.reviewVersion}};
  assert.equal((await admin.saveExpenseReviewDraft(valid)).status,'draft');
  const persisted=await read();
  assert.deepEqual(copy(persisted.draft.values),{transportation:850,purchase8:null,purchase10:0,netPrintCost:null,postageCost:null});
  assert.equal(persisted.draft.note,'合成メモ');
  assert.equal(persisted.currentValues.transportation,702);
  assert.notEqual(persisted.reviewVersion,updated.reviewVersion);
  await assert.rejects(()=>admin.saveExpenseReviewDraft(valid),e=>e.code==='failed-precondition');
  await assert.rejects(()=>admin.completeExpenseReview({...valid,data:{...valid.data,expectedVersion:persisted.reviewVersion}}),e=>e.code==='failed-precondition');
  assert.equal(JSON.stringify(documents.get('jobs/'+jobId)),shared);
  assert.equal(nativeCalls,beforeNative);
  assert(![...documents.values()].some(d=>d.operation==='expense.review'));
  assert(!JSON.stringify(documents.get('expenseReviews/'+jobId)).includes(BOOK));
 });
 async function expenseCompletionFixture(){
  const fixture=await acceptedExpenseFixture(),shown=await fixture.read();
  runtimeEnvironment.LKC_SHEET_WRITE_MODE='active';
  const data={jobId,expectedVersion:shown.reviewVersion,note:'合成・経費確定',
   values:{...shown.currentValues,transportation:850,purchase8:0}};
  return {...fixture,data,beforeWrites:documentWrites.length,beforeNative:nativeCalls,jobBefore:copy(documents.get('jobs/'+jobId))};
 }
 function deferred(){let release;const wait=new Promise(resolve=>{release=resolve;});return {wait,release};}
 function syntheticAtomicWriter(fixture,options={}){
  let tail=Promise.resolve(),dispatches=0,lookups=0,writes=0;
  const receipts=new Map();
  const fenced=action=>{
   const operation=tail.then(action);
   tail=operation.catch(()=>{});
   return operation;
  };
  return {
   gas:fenced,
   get dispatches(){return dispatches;},get lookups(){return lookups;},get writes(){return writes;},
   async compareAndWrite(intent){
    dispatches++;
    if(options.beforeFence)await options.beforeFence();
    await fenced(async()=>{
     if(receipts.has(intent.id))return;
     const transfer=load('case-list-external-transfer');
     let live;
     try { live=await transfer.readExternalCaseListExpenses(COMPANY,jobId,documents.get('jobs/'+jobId)); }
     catch { /* An ambiguous or moved assignment cannot be written. */ }
     const applied=live?.caseListFinancialObservationHash===intent.beforeHash &&
      live.assignedStaffId===intent.staffId && live.assignedStaffName===intent.staffName &&
      live.dateKey===intent.dateKey && live.revision===intent.jobRevision && live.companyId===intent.companyId &&
      live.sheetRef.currentRow===intent.sheetRef.currentRow && Clock.now()<=intent.expiresAtMs;
     if(applied){
      if(options.afterCompare)await options.afterCompare();
      const row=fixture.month.get(intent.sheetRef.currentRow);
      assert.equal(cellValue(row[55]),CASE);
      for(const change of intent.changes){
       assert.deepEqual(copy(row[change.index].userEnteredValue??{}),copy(change.expected));
       row[change.index]=Object.hasOwn(change.value,'numberValue')?literal(change.value.numberValue):{};
      }
      writes++;
     }
     receipts.set(intent.id,{intentId:intent.id,intentHash:shaValue(intent),outcome:applied?'applied':'rejected',recordedAtMs:Clock.now()});
    });
    if(options.afterFence)await options.afterFence();
    if(options.dropAcknowledgement)throw Error('SYNTHETIC_RESPONSE_LOST');
   },
   async readReceipt(id){
    lookups++;
    if(options.hideReceipt)return null;
    const receipt=copy(receipts.get(id)??null);
    return options.receiptOverride?options.receiptOverride(receipt):receipt;
   },
  };
 }
 const completionCall=(f,writer,auth=owner,data=f.data)=>admin.handleCompleteExpenseReview({...auth,data},writer);
 const reviewRecord=()=>documents.get('expenseReviews/'+jobId);
 const attemptRecord=()=>documents.get('externalExpenseCompletionAttempts/'+jobId);
 function assertPrivateExpenseWrites(f){
  assert.equal(nativeCalls,f.beforeNative);
  assert.deepEqual(copy(documents.get('jobs/'+jobId)),f.jobBefore);
  const privateAttempt='externalExpenseCompletionAttempts/'+jobId;
  assert(documentWrites.slice(f.beforeWrites).every(p=>p==='expenseReviews/'+jobId||p===privateAttempt||p.startsWith(privateAttempt+'/history/')));
 }
 await test('external expense completion / deployed callable stays held without a verified writer',async()=>{
  const f=await expenseCompletionFixture();
  await assert.rejects(()=>admin.completeExpenseReview({...owner,data:f.data}),e=>e.details?.reason==='case_list_private_expense_completion_held');
  assert.equal(documentWrites.length,f.beforeWrites);
  assert.equal(attemptRecord(),undefined);
  assertPrivateExpenseWrites(f);
 });
 await test('external expense completion / writes once, reads back and only finalizes private records',async()=>{
  const f=await expenseCompletionFixture(),writer=syntheticAtomicWriter(f);
  assert.equal((await completionCall(f,writer)).status,'completed');
  assert.equal(writer.dispatches,1);assert.equal(writer.writes,1);assert.equal(writer.lookups,1);
  assert.equal(cellValue(f.row[36]),850);assert.equal(cellValue(f.row[37]),0);assert.equal(cellValue(f.row[38]),0);
  const readback=await f.read();
  assert.equal(readback.currentValues.transportation,850);
  assert.equal(readback.draft.status,'completed');
  assert.equal(readback.draft.values.purchase8,0);
  assert.equal(attemptRecord().status,'completed');
  assert.equal(attemptRecord().readbackHash,attemptRecord().intent.afterHash);
  assert(!JSON.stringify(reviewRecord()).includes(BOOK));
  const after=writes;assert.equal((await completionCall(f,writer)).status,'completed');
  assert.equal(writes,after);assert.equal(writer.dispatches,1);assert.equal(writer.lookups,1);
  assertPrivateExpenseWrites(f);
 });
 await test('external expense completion / GAS move before the fenced write rejects the old row',async()=>{
  const f=await expenseCompletionFixture();
  const decoy=copy(f.month.get(2));
  const writer=syntheticAtomicWriter(f,{beforeFence:()=>writer.gas(()=>{
   f.month.set(4,f.row);f.month.set(3,decoy);
  })});
  const result=await completionCall(f,writer);
  assert.equal(result.reason,'writer_rejected');
  assert.equal(writer.writes,0);assert.equal(cellValue(f.month.get(4)[36]),700);
  assert.equal(cellValue(f.month.get(3)[36]),cellValue(decoy[36]));
  assert.equal(reviewRecord().status,'draft');
  assert.equal(attemptRecord().status,'rejected');
  assertPrivateExpenseWrites(f);
 });
 await test('external expense completion / rejected write can be replaced only after a fresh review',async()=>{
  const f=await expenseCompletionFixture(),decoy=copy(f.month.get(2)),options={};
  decoy[55]=literal('LKCASE_00000000-0000-0000-0000-000000000003');
  const writer=syntheticAtomicWriter(f,options);
  options.beforeFence=()=>writer.gas(()=>{f.month.set(4,f.row);f.month.set(3,decoy);});
  assert.equal((await completionCall(f,writer)).reason,'writer_rejected');
  const rejected=copy(attemptRecord());
  assert.equal((await completionCall(f,writer)).reason,'writer_rejected');
  await assert.rejects(()=>completionCall(f,writer,owner,{...f.data,note:'再評価'}),e=>e.code==='failed-precondition');
  assert.equal(writer.dispatches,1);assert.equal(writer.writes,0);
  const refreshed=await f.read();
  options.beforeFence=undefined;
  assert.equal((await completionCall(f,writer,owner,{...f.data,expectedVersion:refreshed.reviewVersion})).status,'completed');
  assert.equal(writer.dispatches,2);assert.equal(writer.writes,1);
  assert.equal(cellValue(f.month.get(4)[36]),850);
  assert.equal(cellValue(f.month.get(3)[36]),cellValue(decoy[36]));
  const history=documents.get('externalExpenseCompletionAttempts/'+jobId+'/history/'+rejected.intent.id);
  assert.deepEqual(copy(history),rejected);
  assertPrivateExpenseWrites(f);
 });
 await test('external expense completion / GAS cannot move the row between compare and write under the shared fence',async()=>{
  const f=await expenseCompletionFixture(),compared=deferred(),resume=deferred(),decoy=copy(f.month.get(2));
  let gasRan=false;
  const writer=syntheticAtomicWriter(f,{afterCompare:()=>{compared.release();return resume.wait;}});
  const call=completionCall(f,writer);
  await Promise.race([compared.wait,call.then(()=>{throw Error('Write did not reach the fence');})]);
  const gas=writer.gas(()=>{
   gasRan=true;
   assert.equal(cellValue(f.month.get(3)[36]),850);
   f.month.set(4,f.row);f.month.set(3,decoy);
  });
  await Promise.resolve();
  assert.equal(gasRan,false);
  resume.release();await gas;
  assert.equal((await call).reason,'readback_required');
  assert.equal(writer.writes,1);assert.equal(cellValue(f.month.get(4)[36]),850);
  assert.equal(cellValue(f.month.get(3)[36]),cellValue(decoy[36]));
  assert.equal(reviewRecord().status,'confirmation_pending');
  assertPrivateExpenseWrites(f);
 });
 await test('external expense completion / lost response looks up the same attempt without another write',async()=>{
  const f=await expenseCompletionFixture(),options={dropAcknowledgement:true,hideReceipt:true};
  const writer=syntheticAtomicWriter(f,options);
  assert.equal((await completionCall(f,writer)).reason,'readback_required');
  assert.equal(writer.writes,1);assert.equal(reviewRecord().status,'confirmation_pending');
  const state=await f.read();
  assert.equal(state.draftAllowedWhileHeld,undefined);
  assert.match(state.writeBlockedReason,/反映結果を照合中/);
  const result=await completionCall(f,writer,owner,{...f.data,note:'別の要求'});
  assert.equal(result.reason,'readback_required');assert.equal(writer.lookups,1);
  await assert.rejects(()=>admin.saveExpenseReviewDraft({...owner,data:f.data}),e=>e.code==='failed-precondition');
  options.hideReceipt=false;
  assert.equal((await completionCall(f,writer)).status,'completed');
  assert.equal(writer.dispatches,1);assert.equal(writer.lookups,2);
  assert.equal((await f.read()).draft.status,'completed');
  assertPrivateExpenseWrites(f);
 });
 await test('external expense completion / a lost reservation acknowledgement never dispatches on retry',async()=>{
  const f=await expenseCompletionFixture(),writer=syntheticAtomicWriter(f);
  afterCommit=()=>{
   if(!attemptRecord())return;
   afterCommit=null;throw Error('SYNTHETIC_RESERVATION_COMMIT_RESPONSE_LOST');
  };
  await assert.rejects(()=>completionCall(f,writer),/RESERVATION_COMMIT_RESPONSE_LOST/);
  assert.equal((await completionCall(f,writer)).reason,'readback_required');
  assert.equal(writer.dispatches,0);assert.equal(writer.lookups,1);assert.equal(reviewRecord().status,'confirmation_pending');
  assertPrivateExpenseWrites(f);
 });
 await test('external expense completion / concurrent confirmations only dispatch one write',async()=>{
  const f=await expenseCompletionFixture(),reached=deferred(),resume=deferred();
  const writer=syntheticAtomicWriter(f,{beforeFence:()=>{reached.release();return resume.wait;}});
  const first=completionCall(f,writer);
  await Promise.race([reached.wait,first.then(()=>{throw Error('Missing first dispatch');})]);
  assert.equal((await completionCall(f,writer)).reason,'readback_required');
  resume.release();assert.equal((await first).status,'completed');
  assert.equal(writer.dispatches,1);assert.equal(writer.writes,1);
  assertPrivateExpenseWrites(f);
 });
 for(const [name,options] of [
  ['different receipt binding',{receiptOverride:receipt=>({...receipt,intentHash:'0'.repeat(64)})}],
  ['cell changed after write',{afterFence:()=>{sheetsData.get(434431224).get(3)[36]=literal(851);}}],
  ['unchanged formula replaced with same value',{afterFence:()=>{sheetsData.get(434431224).get(3)[40]={userEnteredValue:{formulaValue:'=25*2'},effectiveValue:{numberValue:50}};}}],
 ]) await test('external expense completion / requires exact independent readback after '+name,async()=>{
  const f=await expenseCompletionFixture(),writer=syntheticAtomicWriter(f,options);
  assert.equal((await completionCall(f,writer)).reason,'readback_required');
  assert.equal(writer.writes,1);assert.equal(reviewRecord().status,'confirmation_pending');
  assert.equal((await completionCall(f,writer)).reason,'readback_required');
  assert.equal(writer.dispatches,1);
  assertPrivateExpenseWrites(f);
 });
 await test('external expense completion / rejects stale, incomplete or unauthorized approval before dispatch',async()=>{
  const f=await expenseCompletionFixture(),writer=syntheticAtomicWriter(f);
  await assert.rejects(()=>completionCall(f,writer,staffAuth),e=>e.code==='permission-denied');
  await assert.rejects(()=>completionCall(f,writer,{auth:{...owner.auth,token:{...owner.auth.token,companyId:'foreign_synthetic'}}}),e=>e.code==='not-found');
  await assert.rejects(()=>completionCall(f,writer,owner,{...f.data,values:{transportation:850}}),e=>e.code==='invalid-argument');
  f.row[36]=literal(701);
  await assert.rejects(()=>completionCall(f,writer),e=>e.code==='failed-precondition');
  assert.equal(writer.dispatches,0);assert.equal(writer.lookups,0);
  assert.equal(attemptRecord(),undefined);assert.equal(documentWrites.length,f.beforeWrites);
  assertPrivateExpenseWrites(f);
 });
 await test('external expense completion / existing stop settings prevent dispatch but paused mode may reconcile',async()=>{
  const f=await expenseCompletionFixture(),options={hideReceipt:true},writer=syntheticAtomicWriter(f,options);
  runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='read-only';
  assert.equal((await completionCall(f,writer)).reason,'readback_required');
  runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='paused';
  await assert.rejects(()=>completionCall(f,writer),e=>e.code==='failed-precondition');
  runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='enabled';
  runtimeEnvironment.LKC_SHEET_WRITE_MODE='paused';
  await assert.rejects(()=>completionCall(f,writer),e=>e.code==='failed-precondition');
  assert.equal(writer.dispatches,0);assert.equal(attemptRecord(),undefined);
  runtimeEnvironment.LKC_SHEET_WRITE_MODE='active';
  assert.equal((await completionCall(f,writer)).reason,'readback_required');
  runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE='paused';
  runtimeEnvironment.LKC_SHEET_WRITE_MODE='paused';
  options.hideReceipt=false;
  assert.equal((await completionCall(f,writer)).status,'completed');
  assert.equal(writer.dispatches,1);assert.equal(writer.writes,1);
  assertPrivateExpenseWrites(f);
 });
 await test('external expense completion / a legacy completion event cannot publish external amounts',async()=>{
  const f=await expenseCompletionFixture(),core=load('admin-operations-core'),queueId='legacy_synthetic_expense';
  const job=documents.get('jobs/'+jobId),previous=core.normalizeExpenseInput({}).values;
  documents.set('expenseReviews/'+jobId,{
   jobId,companyId:COMPANY,staffId:STAFF,queueId,revision:1,status:'queued',expectedValues:previous,
   values:f.data.values,writeContext:core.expenseSheetWriteContext(job),
  });
  const ref=new Doc('sheetSyncQueue/'+queueId);
  documents.set(ref.path,{
   operation:'expense.review',status:'completed',jobId,companyId:COMPANY,
   idempotencyKey:'expense.review:'+jobId+':1',updates:core.buildExpenseSheetUpdates(f.data.values),
   expected:core.buildExpenseExpected(previous),
  });
  await admin.updateExpenseReviewFromQueue({data:{after:await ref.get()}});
  assert.equal(reviewRecord().status,'queued');
  assert.equal(documentWrites.length,f.beforeWrites);
  assertPrivateExpenseWrites(f);
 });
 const concurrencyMetrics=[];
 function useOptimisticApplicationTransactions({loseWinningReply=false}={}){
  const original=db.runTransaction;
  const stats={conflicts:0,activeTransactions:0,peakTransactions:0,callbacks:0};
  db.runTransaction=async (callback,options)=>{
   if(options?.readOnly)return original(callback,options);
   stats.activeTransactions++;
   stats.peakTransactions=Math.max(stats.peakTransactions,stats.activeTransactions);
   try{
    for(let iteration=0;iteration<5;iteration++){
     stats.callbacks++;
     const reads=new Map(),snapshot=new Map(documents),mutations=[];
     const tx={
      async get(ref){
       assert(mutations.length===0,'transaction reads must precede writes');
       const value=snapshot.get(ref.path);
       reads.set(ref.path,value);
       return {exists:value!==undefined,ref,id:ref.id,data:()=>copy(value)};
      },
      set(ref,value,options){mutations.push({ref,value,merge:options?.merge===true});},
      create(ref,value){
       assert(!snapshot.has(ref.path),'create requires a new path');
       reads.set(ref.path,undefined);
       mutations.push({ref,value,merge:false});
      },
      update(ref,value){assert(snapshot.has(ref.path));mutations.push({ref,value,merge:true});},
     };
     const result=await callback(tx);
     if([...reads].some(([key,value])=>documents.get(key)!==value)){
      stats.conflicts++;
      continue;
     }
     for(const {ref,value,merge} of mutations){
      const current=merge?documents.get(ref.path):undefined;
      documents.set(ref.path,{...copy(current),...copy(value)});
      writes++;documentWrites.push(ref.path);
     }
     if(loseWinningReply&&mutations.some(item=>item.ref.path.startsWith('idempotencyKeys/'))){
      loseWinningReply=false;
      throw Error('SYNTHETIC_COMMITTED_APPLICATION_REPLY_LOST');
     }
     return result;
    }
    throw Error('SYNTHETIC_CONTENTION_RETRIES_EXHAUSTED');
   }finally{stats.activeTransactions--;}
  };
  return {stats,restore:()=>{db.runTransaction=original;}};
 }
 function seedSyntheticStaff(number,companyId=COMPANY){
  const staffId='burst_staff_'+number,uid='burst_uid_'+number;
  const profile=copy(documents.get('staffProfiles/'+STAFF));
  const ng=load('staff-ng'),header=Array(11).fill('');
  header[10]='NG会社';
  const observation=ng.observeStaffNgCell('マスターデータ',header,[],19);
  const ngCompanies=ng.mergeStaffNg([{
   sourceRef:{spreadsheetId:'synthetic-staff-master',sheetName:'マスターデータ'},ngCompanyObservation:observation,
  }],companyId,staffId);
  documents.set('staffProfiles/'+staffId,{...profile,companyId,displayName:'Synthetic Staff '+number,ngCompanies});
  documents.set('authIdentities/'+uid,{companyId,staffId,active:true});
  return {auth:{uid,token:{companyId,role:'staff',staffId}}};
 }
 const myTasks=auth=>load('staff-tasks').getMyTasks({...auth,data:{}});
 await test('staff session and concurrency / inactive, foreign or revoked sessions cannot read tasks',async()=>{
  resetFixture();
  documents.set('jobs/synthetic_own_task',{
   companyId:COMPANY,assignedStaffId:STAFF,status:'assigned',dateKey:DATE,storeName:'synthetic store',
   netPrint:{items:[{number:'synthetic-print'}]},
  });
  const identityPath='authIdentities/'+staffAuth.auth.uid,profilePath='staffProfiles/'+STAFF;
  const profile=copy(documents.get(profilePath)),identity={companyId:COMPANY,staffId:STAFF,active:true};
  for(const [patch,linked] of [[{active:false},identity],[{companyId:'other_company'},identity],[{},
   {...identity,active:false}],[{},{...identity,staffId:'other_staff'}],[{},{...identity,companyId:'other_company'}]]){
   documents.set(profilePath,{...profile,...patch});documents.set(identityPath,linked);
   const before=documentReads.length;
   await assert.rejects(()=>myTasks(staffAuth),error=>error.code==='permission-denied');
   assert(!documentReads.slice(before).some(p=>p.startsWith('jobs/')||p.startsWith('resubmissionRequests/')));
  }
  documents.set(profilePath,profile);documents.set(identityPath,identity);
  await assert.rejects(()=>myTasks({auth:{...staffAuth.auth,token:{...staffAuth.auth.token,role:'admin'}}}),error=>error.code==='permission-denied');
  assert((await myTasks(staffAuth)).tasks.some(task=>task.jobId==='synthetic_own_task'));
  documents.set(identityPath,{...identity,revokedAt:Stamp.fromMillis(100100)});
  await assert.rejects(()=>myTasks({auth:{...staffAuth.auth,token:{...staffAuth.auth.token,auth_time:100}}}),error=>error.code==='permission-denied');
  assert((await myTasks({auth:{...staffAuth.auth,token:{...staffAuth.auth.token,auth_time:101}}})).tasks.some(task=>task.jobId==='synthetic_own_task'));
  documents.delete(identityPath);
  await assert.rejects(()=>myTasks(staffAuth),error=>error.code==='permission-denied');
  documents.set(identityPath,identity);
  assert((await myTasks(staffAuth)).tasks.some(task=>task.jobId==='synthetic_own_task'));
 });
 await test('staff session and concurrency / a revoked token cannot replay an accepted application',async()=>{
  const fixture=await start(false,false,()=>{},true);
  const path='authIdentities/'+staffAuth.auth.uid;
  documents.set(path,{active:true,staffId:STAFF,companyId:COMPANY});
  const input={...staffAuth,data:fixture.request},accepted=await jobs.applyToJob(input),sealedWrites=writes;
  assert.equal(accepted.ok,true);
  assert.deepEqual(copy(await jobs.applyToJob(input)),copy(accepted));
  assert.equal(writes,sealedWrites);
  documents.set(path,{active:false,staffId:STAFF,companyId:COMPANY});
  const reads=documentReads.length;
  await assert.rejects(()=>jobs.applyToJob(input),error=>error.code==='permission-denied');
  assert(!documentReads.slice(reads).some(key=>key.startsWith('idempotencyKeys/')));
  documents.set(path,{active:true,staffId:STAFF,companyId:COMPANY,revokedAt:Stamp.fromMillis(100100)});
  const replayWith=auth_time=>jobs.applyToJob({...input,auth:{...input.auth,token:{...input.auth.token,auth_time}}});
  await assert.rejects(()=>replayWith(100),error=>error.code==='permission-denied');
  assert.deepEqual(copy(await replayWith(101)),copy(accepted));
  assert.equal(writes,sealedWrites);
 });
 for(const count of [50,100,300])await test('staff session and concurrency / '+count+' simultaneous applications reserve exactly one external case',async()=>{
  const fixture=await start(false,false,()=>{},true);
  const principals=Array.from({length:count},(_,i)=>seedSyntheticStaff(i));
  const beforeNative=nativeCalls,optimistic=useOptimisticApplicationTransactions(),durations=[];
  let results;
  try{
   results=await Promise.allSettled(principals.map(async (principal,index)=>{
    const started=performance.now();
    try{return await jobs.applyToJob({...principal,data:{...fixture.request,requestId:'burst_request_'+index}});}
    finally{durations.push(performance.now()-started);}
   }));
  }finally{optimistic.restore();}
  const winners=results.flatMap((result,index)=>result.status==='fulfilled'?[index]:[]);
  assert.equal(winners.length,1,JSON.stringify(results.filter(r=>r.status==='rejected').slice(0,2).map(r=>[r.reason.code,r.reason.message])));
  const winner=principals[winners[0]];
  assert(results.every(r=>r.status==='fulfilled'||r.reason.code==='already-exists'));
  assert.equal(optimistic.stats.peakTransactions,count);
  assert.equal(optimistic.stats.conflicts,count-1);
  const currentJob=documents.get('jobs/'+jobId);
  assert.equal(currentJob.assignedStaffId,winner.auth.token.staffId);
  assert.equal(currentJob.applicationUnconfirmed,true);
  const written=[...documents.entries()];
  const inCollection=collection=>written.filter(([key])=>key.startsWith(collection+'/'));
  assert.equal(inCollection('staffDayLocks').length,1);
  assert.equal(inCollection('sheetSyncQueue').length,1);
  assert.equal(inCollection('idempotencyKeys').length,1);
  assert.equal(inCollection('notificationQueue').length,2);
  const staffNotices=inCollection('notificationQueue').filter(([,record])=>record.targetStaffId);
  assert.equal(staffNotices.length,1);assert.equal(staffNotices[0][1].targetStaffId,winner.auth.token.staffId);
  assert.equal(nativeCalls,beforeNative);
  durations.sort((a,b)=>a-b);
  concurrencyMetrics.push({kind:'application',sessions:count,winners:1,expectedConflicts:count-1,
   peakCallbacks:optimistic.stats.peakTransactions,transactionRetries:optimistic.stats.conflicts,
   localP95Ms:Math.round(durations[Math.ceil(count*0.95)-1])});
 });
 await test('staff session and concurrency / 300 simultaneous requests with the winning reply lost',async()=>{
  const fixture=await start(false,false,()=>{},true);
  const callers=Array.from({length:300},(_,i)=>seedSyntheticStaff(i));
  const requests=callers.map((caller,index)=>({...caller,data:{...fixture.request,requestId:'lost_burst_request_'+index}}));
  const optimistic=useOptimisticApplicationTransactions({loseWinningReply:true});
  let results;
  try{results=await Promise.allSettled(requests.map(request=>jobs.applyToJob(request)));}
  finally{optimistic.restore();}
  const losses=results.flatMap((result,index)=>result.status==='rejected'&&result.reason.message==='SYNTHETIC_COMMITTED_APPLICATION_REPLY_LOST'?[index]:[]);
  assert.equal(losses.length,1);
  const winner=losses[0];
  assert.equal(optimistic.stats.peakTransactions,300);
  assert.equal(optimistic.stats.conflicts,299);
  const beforeWrites=writes,beforeNative=nativeCalls;
  const current=documents.get('jobs/'+jobId);
  assert.equal(current.assignedUid,callers[winner].auth.uid);
  assert.equal(current.applicationUnconfirmed,true);
  for(const [index,outcome] of results.entries()){
   if(index===winner)continue;
   assert.equal(outcome.status,'rejected');
   assert.equal(outcome.reason.code,'already-exists');
   assert.deepEqual(copy(outcome.reason.details),{reason:'case_list_slot_taken',accepted:false,
    jobId,requestId:requests[index].data.requestId,expectedJobRevision:fixture.request.expectedJobRevision,
    expectedSourceRevision:fixture.request.expectedSourceRevision});
   assert.equal(Object.hasOwn(outcome.reason.details,'assignedStaffId'),false);
  }
  const operation=requests[winner].data.requestId;
  const lookup=caller=>load('staff-tasks').getMyTasks({...caller,data:{applicationReceiptLookup:[{jobId,requestId:operation}]}});
  const all=await Promise.all(callers.map(lookup));
  for(const [index,result] of all.entries())assert.deepEqual(JSON.parse(JSON.stringify(result.receipts)),[{jobId,requestId:operation,status:index===winner?'accepted':'not_observed'}]);
  const sealed=await jobs.applyToJob(requests[winner]);
  assert.equal(sealed.ok,true);
  assert.equal(sealed.assignedAt,current.assignedAt.toDate().toISOString());
  assert.equal(writes,beforeWrites);
  assert.equal(nativeCalls,beforeNative);
  const count=prefix=>[...documents.keys()].filter(key=>key.startsWith(prefix+'/')).length;
  assert.equal(count('staffDayLocks'),1);
  assert.equal(count('sheetSyncQueue'),1);
  assert.equal(count('idempotencyKeys'),1);
  assert.equal(count('notificationQueue'),2);
  concurrencyMetrics.push({kind:'application_reply_lost',sessions:300,acceptedReceipts:1,scopedRejections:299,
   falseReceipts:0,duplicateBookings:0,additionalWritesAfterLookupAndReplay:0,nativeWrites:0});
 });
 await test('staff session and concurrency / stale external request cannot reserve a row after source linkage is removed',async()=>{
  const fixture=await start(false,false,()=>{},true);
  const job=documents.get('jobs/'+jobId);
  assert(job.caseListSource);
  delete job.caseListSource;
  const before=writes;
  await assert.rejects(()=>jobs.applyToJob({...staffAuth,data:fixture.request}),error=>
   error.code==='failed-precondition'&&error.details?.reason==='case_list_job_changed'&&error.details?.requestId===fixture.request.requestId);
  assert.equal(writes,before);
 });
 await test('staff session and concurrency / 300 concurrent task reads do not cross staff or company',async()=>{
  resetFixture();
  const principals=Array.from({length:300},(_,i)=>seedSyntheticStaff(i,i%2?COMPANY:'second_synthetic_company'));
  for(const principal of principals){
   const {staffId,companyId}=principal.auth.token;
   const own=staffId+'_task',foreign=staffId+'_foreign';
   const common={assignedStaffId:staffId,status:'assigned',dateKey:DATE,storeName:'synthetic store',netPrint:{items:[{number:'print'}]}};
   documents.set('jobs/'+own,{...common,companyId});
   documents.set('jobs/'+foreign,{...common,companyId:'wrong_synthetic_company'});
  }
  const before=writes;
  const results=await Promise.all(principals.map(myTasks));
  for(const [i,result] of results.entries()){
   const own=principals[i].auth.token.staffId+'_task';
   assert(result.tasks.some(task=>task.kind==='netprint'));
   assert(result.tasks.every(task=>task.jobId===own));
  }
  assert.equal(writes,before);
  concurrencyMetrics.push({kind:'task_read',sessions:300,foreignOrOtherStaffResults:0});
 });
 let monthlyBookFile;
 const savedGasLockSource=process.env.LKC_TEST_GAS_LOCK_SOURCE;
 if(!testPrefix||testPrefix==='external monthly book /'){
  const fileName=process.env.LKC_TEST_EVIDENCE_FILE??'ci-crew-external-normal.json';
  assert.match(fileName,/^[a-z0-9-]+\.json$/);
  fs.mkdirSync(evidenceDir,{recursive:true});
  monthlyBookFile=path.join(evidenceDir,fileName.replace(/\.json$/,'.sqlite'));
  require('./fixtures/expense-monthly-book.cjs').createFile(monthlyBookFile);
 }
 async function monthlyBookScenario(scenario,run){
  const {openScenario,modelGasLock,savedGasLock}=require('./fixtures/expense-monthly-book.cjs');
  const fixture=await expenseCompletionFixture();
  const lock=savedGasLockSource?savedGasLock(savedGasLockSource):modelGasLock();
  let session=openScenario(monthlyBookFile,scenario);
  session.seed(fixture.month);
  sheetsData.set(434431224,session.table);
  const decoy=copy(fixture.month.get(2));
  decoy[55]=literal('LKCASE_00000000-0000-0000-0000-000000000003');
  const readObservation=()=>load('case-list-external-transfer')
    .readExternalCaseListExpenses(COMPANY,jobId,documents.get('jobs/'+jobId));
  const interactions={
   fixture,lock,
   get table(){return session.table;},
   move(actor,from,to){
    const move=()=>session.move(actor,from,to,decoy);
    if(actor==='gas')return lock.run(move);
    move();
   },
   writer(options){return session.makeCrewWriter({readObservation,intentHash:shaValue,now:()=>Clock.now(),options});},
   readReceipt(id){return session.receipt(id);},
   unsafeSetByPosition(position,index,value){session.unsafeSetByPosition('crew',position,index,literal(value));},
   reopen(){
    session.close();
    session=openScenario(monthlyBookFile,scenario);
    sheetsData.set(434431224,session.table);
   },
  };
  try{await run(interactions);}
  finally{session.close();}
 }
 await test('external monthly book / independent manual move defeats a coordinate-only write even under the saved GAS lock',async()=>{
  await monthlyBookScenario('position-only-counterexample',ctx=>{
   const expectedRow=3;
   assert.equal(cellValue(ctx.table.get(expectedRow)[55]),CASE);
   ctx.lock.run(()=>{
    assert.equal(ctx.lock.held,true);
    ctx.move('manual',3,4);
    ctx.unsafeSetByPosition(expectedRow,36,999);
   });
   assert.equal(ctx.lock.held,false);
   assert.equal(cellValue(ctx.table.get(4)[55]),CASE);
   assert.equal(cellValue(ctx.table.get(4)[36]),700);
   assert.notEqual(cellValue(ctx.table.get(3)[55]),CASE);
   assert.equal(cellValue(ctx.table.get(3)[36]),999,'negative control must demonstrate the wrong-row write');
   assertPrivateExpenseWrites(ctx.fixture);
  });
 });
 for(const actor of ['gas','crew','manual'])await test('external monthly book / guarded writer rejects a committed move by '+actor,async()=>{
  await monthlyBookScenario('moved-by-'+actor,async ctx=>{
   const writer=ctx.writer({beforeBegin:()=>ctx.move(actor,3,4)});
   const result=await completionCall(ctx.fixture,writer);
   assert.equal(result.reason,'writer_rejected');
   assert.equal(cellValue(ctx.table.get(4)[55]),CASE);
   assert.equal(cellValue(ctx.table.get(4)[36]),700);
   assert.notEqual(cellValue(ctx.table.get(3)[55]),CASE);
   assert.equal(cellValue(ctx.table.get(3)[36]),'');
   assert.equal(ctx.readReceipt(attemptRecord().intent.id).outcome,'rejected');
   assert.equal(reviewRecord().status,'draft');
   assertPrivateExpenseWrites(ctx.fixture);
  });
 });
 await test('external monthly book / all three independent connections can contend between comparison and commit',async()=>{
  await monthlyBookScenario('concurrent-three-connections',async ctx=>{
   const writers=['gas','crew','manual'];
   const blocked=[];
   const writer=ctx.writer({afterCompare:()=>{
    for(const actor of writers){
     assert.throws(()=>ctx.move(actor,3,4),error=>error.errcode===5);
     blocked.push(actor);
    }
   }});
   const result=await completionCall(ctx.fixture,writer);
   assert.deepEqual(blocked,writers);
   assert.equal(ctx.lock.held,false);
   assert.equal(result.status,'completed');
   assert.equal(cellValue(ctx.table.get(3)[55]),CASE);
   assert.equal(cellValue(ctx.table.get(3)[36]),850);
   assert.equal(cellValue(ctx.table.get(2)[36]),'');
   assert.equal(writer.dispatches,1);
   assertPrivateExpenseWrites(ctx.fixture);
  });
 });
 await test('external monthly book / reopening after a lost response recovers the same receipt without redispatch',async()=>{
  await monthlyBookScenario('lost-response-reopen',async ctx=>{
   const request=ctx.fixture;
   const first=ctx.writer({loseResponse:true,hideReceipt:true});
   assert.equal((await completionCall(request,first)).reason,'readback_required');
   assert.equal(first.dispatches,1);
   const id=attemptRecord().intent.id,hash=attemptRecord().intentHash;
   assert.equal(reviewRecord().status,'confirmation_pending');
   ctx.reopen();
   assert.deepEqual(ctx.readReceipt(id),{intentId:id,intentHash:hash,outcome:'applied',recordedAtMs:ctx.readReceipt(id).recordedAtMs});
   assert.equal(ctx.readReceipt('00000000-0000-0000-0000-000000000000'),null);
   assert.equal(cellValue(ctx.table.get(3)[36]),850);
   const restarted=ctx.writer();
   assert.equal((await completionCall(request,restarted)).status,'completed');
   assert.equal(restarted.dispatches,0);
   assert.equal(reviewRecord().status,'completed');
   assert.equal(attemptRecord().intent.id,id);
   assertPrivateExpenseWrites(request);
  });
 });
 await test('external monthly book / interruption between cells and receipt rolls back both',async()=>{
  await monthlyBookScenario('interrupted-before-receipt',async ctx=>{
   const first=ctx.writer({interruptBeforeReceipt:true});
   assert.equal((await completionCall(ctx.fixture,first)).reason,'readback_required');
   const id=attemptRecord().intent.id;
   ctx.reopen();
   assert.equal(first.dispatches,1);
   assert.equal(ctx.readReceipt(id),null);
   assert.equal(cellValue(ctx.table.get(3)[36]),700);
   assert.equal(cellValue(ctx.table.get(3)[37]),'');
   const reopened=ctx.writer();
   assert.equal((await completionCall(ctx.fixture,reopened)).reason,'readback_required');
   assert.equal(reopened.dispatches,0);
   assert.equal(reviewRecord().status,'confirmation_pending');
   assertPrivateExpenseWrites(ctx.fixture);
  });
 });
 function traceCall(operationId,reader,auth=owner){
  return admin.handleTraceExternalExpense({...auth,data:{jobId,operationId}},reader);
 }
 await test('external monthly book / another same-company admin can trace an unknown result by operation ID after reopening',async()=>{
  await monthlyBookScenario('trace-by-id',async ctx=>{
   const writer=ctx.writer({loseResponse:true,hideReceipt:true});
   assert.equal((await completionCall(ctx.fixture,writer)).reason,'readback_required');
   const id=attemptRecord().intent.id,before=writes;
   assert.equal((await traceCall(id)).status,'readback_required');
   ctx.reopen();
   const reader=ctx.writer(),admin2={auth:{...owner.auth,uid:'second_synthetic_admin'}};
   const traced=await traceCall(id,reader,admin2);
   assert.deepEqual(copy(traced),{operationId:id,status:'verified_pending'});
   assert.equal(reviewRecord().status,'confirmation_pending');
   assert.equal(reader.dispatches,0);
   assert.equal(writes,before);
   assertPrivateExpenseWrites(ctx.fixture);
  });
 });
 await test('external monthly book / trace refuses a mismatched receipt, unknown ID and other company',async()=>{
  await monthlyBookScenario('trace-mismatch',async ctx=>{
   const writer=ctx.writer({loseResponse:true,hideReceipt:true});
   assert.equal((await completionCall(ctx.fixture,writer)).reason,'readback_required');
   const id=attemptRecord().intent.id,before=writes;
   let lookups=0;
   const reader={readReceipt:async operationId=>{
    lookups++;
    return {...ctx.readReceipt(operationId),intentHash:'0'.repeat(64)};
   }};
   await assert.rejects(()=>traceCall(id,reader,staffAuth),error=>error.code==='permission-denied');
   await assert.rejects(()=>traceCall(id,reader,{
    auth:{...owner.auth,token:{...owner.auth.token,companyId:'foreign_synthetic'}},
   }),error=>error.code==='not-found');
   await assert.rejects(()=>traceCall('00000000-0000-0000-0000-000000000000',reader),error=>error.code==='not-found');
   assert.equal(lookups,0);
   assert.equal((await traceCall(id,reader)).status,'readback_required');
   assert.equal(lookups,1);
   assert.equal(writes,before);
   assertPrivateExpenseWrites(ctx.fixture);
  });
 });
 await test('external monthly book / archived rejected and newly completed IDs remain independently traceable',async()=>{
  await monthlyBookScenario('trace-rejected-history',async ctx=>{
   const writer=ctx.writer({beforeBegin:()=>ctx.move('manual',3,4)});
   assert.equal((await completionCall(ctx.fixture,writer)).reason,'writer_rejected');
   const rejectedId=attemptRecord().intent.id;
   assert.equal((await traceCall(rejectedId)).status,'rejected');
   const refreshed=await ctx.fixture.read(),freshWriter=ctx.writer();
   assert.equal((await completionCall(ctx.fixture,freshWriter,owner,{
    ...ctx.fixture.data,expectedVersion:refreshed.reviewVersion,
   })).status,'completed');
   const completedId=attemptRecord().intent.id;
   assert.notEqual(completedId,rejectedId);
   const before=writes;
   assert.equal((await traceCall(rejectedId)).status,'rejected');
   assert.equal((await traceCall(completedId)).status,'completed');
   assert.equal(writes,before);
   assertPrivateExpenseWrites(ctx.fixture);
  });
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
   if(name==='unverified owner'){const bad=copy(owner);bad.auth.token.email_verified=false;await assert.rejects(()=>admin.acknowledgeSheetWriteIssue({...bad,data:{action:'reconcile-case-list',queueId:f.queueId}}),e=>e.details?.code==='FIREBASE_OWNER_CLAIMS_CHANGED');}
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
 if(testPrefix==='external expense completion /'){
  report.scope='Actual Crew completion handler, private records and Sheets reader with synthetic Firestore/Sheets/Auth and a cooperating synthetic GAS writer. The deployed handler has no atomic writer binding.';
  report.previousEvidence='expense-readback-and-confirmation-verified.json';
  report.remaining=['A real writer fenced against all GAS and other monthly-row writers','Durable real writer receipt bound to the same write','Approved rollout and acceptance'];
 }
 if(monthlyBookFile){
  report.monthlyBookLock=savedGasLockSource?'archived-gas-helper':'synthetic-gas-lock';
  report.monthlyBook=path.basename(monthlyBookFile);
 }
 if(testPrefix==='external monthly book /'){
  report.scope='Crew confirmation and read-only tracking over an on-disk synthetic monthly table. SQLite transactions use independent GAS, Crew and manual-model connections. The lock is modeled unless a hash-pinned archived helper was supplied. Google Sheets and real manual editing are not connected.';
  report.previousEvidence=['expense-confirmation-final.json','expense-readback-and-confirmation-verified.json'];
  report.expectedCounterexample='Independent manual row movement defeats coordinate-only writes despite the separate GAS lock.';
  report.remaining=['A Google Sheets writer with enforcement across direct API, GAS and manual editors','Durable receipt tied to the actual Sheets update','Approved pilot execution'];
 }
 if(testPrefix==='staff session and concurrency /'){
  report.scope='Actual application and task callable code over synthetic Auth and Firestore, including an optimistic conflict/retry simulator for applications. No network or external services.';
  report.concurrencyMetrics=concurrencyMetrics;
  report.remaining=['Live Cloud contention, round trips and quotas','Client SDK rules and real device lifecycle','Accepted one-case rollout'];
 }
 fs.mkdirSync(evidenceDir,{recursive:true});fs.writeFileSync(path.join(evidenceDir,process.env.LKC_TEST_EVIDENCE_FILE||'ci-crew-external-normal.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
})();
