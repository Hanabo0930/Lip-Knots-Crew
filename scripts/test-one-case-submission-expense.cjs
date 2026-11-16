'use strict';
// Executes the actual TS worker/Core with fully synthetic fixtures and mocked I/O.
// Uses Node built-in TypeScript syntax stripping; it performs no cloud calls.
// This is not a TypeScript semantic build or a real Firebase/Google acceptance.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {stripTypeScriptTypes,createRequire}=require('node:module');
const gasOriginal=require('./one-case-fixtures/crew-external-gas-reference.cjs');
const repoRoot=path.resolve(__dirname,'..');
const evidenceDir=process.env.LKC_TEST_SYNTHETIC_EVIDENCE_DIR || path.join(repoRoot,'release-evidence');
const src=path.join(repoRoot,'functions/src');
const clientRequire=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||repoRoot,'package.json'));
const serverRequire=createRequire(path.join(process.env.LKC_TEST_SERVER_DEPENDENCY_ROOT||repoRoot,'package.json'));
const integrationPrefix='external one-case /';
const migrationPrefix='external device handover /';
const integrated=[integrationPrefix,migrationPrefix].some(prefix=>process.argv.includes('--test-name-prefix='+prefix));

const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const Stamp=integrated ? new Proxy(clientRequire('firebase-admin/firestore').Timestamp,{
 get:(target,key,receiver)=>key==='now'?()=>target.fromMillis(Clock.now()):Reflect.get(target,key,receiver),
}) : class Stamp{constructor(ms){this.ms=ms;}toMillis(){return this.ms;}toDate(){return new Date(this.ms);}static now(){return new Stamp(Date.now());}static fromMillis(ms){return new Stamp(ms);}static fromDate(date){return Stamp.fromMillis(date.getTime());}};
const DELETE={delete:true},FieldValue={serverTimestamp:()=>Stamp.now(),delete:()=>DELETE,increment:n=>({__increment:n}),arrayUnion:(...values)=>values};
function copy(x){if(x instanceof Stamp)return integrated?x:new Stamp(x.ms);if(Array.isArray(x))return x.map(copy);if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,copy(v)]));return x;}
let clockOffset=0,journeyTime;
class Clock extends Date{
 constructor(...args){super(...(args.length?args:[Clock.now()]));}
 static now(){return journeyTime??Date.now()+clockOffset;}
}
const loginJourneyEmail='staff-journey@example.invalid';
const journeyClaims=[],journeySends=[],journeyMail=[],issuedDeviceClaims=[];
const fixtureDocumentVersions=new Map();let fixtureVersion=0;
let beforeTransaction=null,archiveReadHook=null,gasReadHook=null;
let pilotEntry=null;
let googleReadHandler=null;let operational=true,nativeCalls=0,documents=new Map(),writes=0,readerProvider=null,nativeHandler=null,txTail=Promise.resolve(),afterCommit=null,generated=0;
const documentReads=[],documentWrites=[];
class Doc{constructor(p){this.path=p;this.id=p.split('/').pop();}async get(){documentReads.push(this.path);const data=documents.get(this.path);if(!fixtureDocumentVersions.has(this.path))fixtureDocumentVersions.set(this.path,++fixtureVersion);return {exists:data!==undefined,ref:this,id:this.id,updateTime:Stamp.fromMillis(fixtureDocumentVersions.get(this.path)),data:()=>copy(data)};}async set(value,options){return db.runTransaction(tx=>tx.set(this,value,options));}collection(n){return new Query(this.path+'/'+n);}}
class Query{constructor(p,filters=[],max=Infinity,after=null){this.path=p;this.filters=filters;this.max=max;this.after=after;}doc(id){return new Doc(this.path+'/'+(id??('generated_fixture_'+(++generated))));}where(k,op,v){assert(['==','in','>=','<='].includes(op));return new Query(this.path,[...this.filters,[k,v,op]],this.max,this.after);}limit(n){return new Query(this.path,this.filters,n,this.after);}orderBy(field){assert(['__name__','updatedAt','dateKey'].includes(field));return this;}startAfter(id){return new Query(this.path,this.filters,this.max,id);}async get(){documentReads.push(this.path+'/*');const found=[...documents].filter(([p,v])=>p.startsWith(this.path+'/')&&!p.slice(this.path.length+1).includes('/')&&this.filters.every(([k,w,op])=>op==='in'?w.includes(v[k]):op==='>='?v[k]>=w:op==='<='?v[k]<=w:v[k]===w)&&(!this.after||p.split('/').pop()>this.after)).sort(([a],[b])=>a<b?-1:a>b?1:0).slice(0,this.max);const docs=found.map(([p,data])=>({id:p.split('/').pop(),ref:new Doc(p),data:()=>copy(data)}));return {docs,size:docs.length};}}

const db={collection:n=>new Query(n),runTransaction:async fn=>{const previous=txTail;let release;txTail=new Promise(r=>release=r);await previous;try{const pending=[];const tx={get:r=>r.get(),getAll:(...refs)=>Promise.all(refs.map(ref=>ref.get())),set:(r,v,o)=>pending.push(['set',r,v,o]),update:(r,v)=>pending.push(['set',r,v,{merge:true}]),create:(r,v)=>{assert(!documents.has(r.path));pending.push(['set',r,v,{}]);},delete:r=>pending.push(['delete',r])};if(beforeTransaction){const f=beforeTransaction;beforeTransaction=null;f();}const out=await fn(tx);for(const [kind,r,v,o]of pending){writes++;documentWrites.push(r.path);fixtureDocumentVersions.set(r.path,++fixtureVersion);if(kind==='delete'){documents.delete(r.path);continue;}const data=o?.merge?copy(documents.get(r.path)||{}):{};for(const [k,val]of Object.entries(v)){if(val===DELETE)delete data[k];else if(val?.__increment!==undefined)data[k]=Number(data[k]??0)+val.__increment;else data[k]=copy(val);}documents.set(r.path,data);}if(afterCommit)afterCommit();return out;}finally{release();}}};
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
function load(name){const file=path.join(src,name+'.ts');if(cache.has(file))return cache.get(file);const source=fs.readFileSync(file,'utf8');const ts=clientRequire('typescript');const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const context={Buffer,URL,process:{env:runtimeEnvironment},Error,Date:Clock,fetch:()=>{throw Error('EXTERNAL_NETWORK_FORBIDDEN');},module:{exports:{}},exports:{},console,require:specifier=>{
  if(specifier==='node:crypto'||specifier==='node:util')return require(specifier);
  if(specifier==='firebase-functions/v2/https')return {onCall:(...args)=>args.at(-1),onRequest:(...args)=>args.at(-1),HttpsError:class extends Error{constructor(code,message,details){super(message);this.code=code;this.details=details;}}};
  if(specifier==='firebase-functions/v2/firestore')return {onDocumentWritten:(...args)=>args.at(-1),onDocumentCreated:(...args)=>args.at(-1)};
  if(specifier==='firebase-functions/v2/scheduler')return {onSchedule:(...args)=>args.at(-1)};
  if(specifier==='firebase-functions/params')return {defineString:()=>({value:()=>''})};
  if(specifier==='./production-metrics'&&integrated)return {incrementProductionMetrics:async companyId=>assert.equal(companyId,COMPANY)};
  if(specifier==='firebase-functions/v2/storage')return {onObjectFinalized:(...args)=>args.at(-1)};
  if(specifier==='node:path')return require(specifier);
  if(specifier==='firebase-admin/firestore')return {Timestamp:Stamp,FieldValue,FieldPath:{documentId:()=>"__name__"}};
  if(specifier==='googleapis')return {google:{auth:{GoogleAuth:class{},OAuth2:class {
    constructor(options){
     assert.ok(options.eagerRefreshThresholdMillis===0 || options.forceRefreshOnFailure===false);
     assert.ok(pilotEntry);
     pilotEntry.auth=this;
    }
    async getTokenInfo(token){
     assert.equal(token,pilotEntry.token);
     pilotEntry.connections.push('token-info');
     if(pilotEntry.tokenInfoError)throw Error('synthetic introspection failed');
     return pilotEntry.tokenInfo;
    }
    setCredentials(credentials){
     assert.equal(this.eagerRefreshThresholdMillis ?? 0,0);
     assert.deepEqual(Object.keys(credentials).sort(),['access_token','expiry_date']);
     assert.equal(credentials.access_token,pilotEntry.token);
     this.credentials=credentials;
    }
   }},
   drive:({auth})=>{
    assert.equal(auth,pilotEntry.auth);
    pilotEntry.connections.push('drive');
    return pilotEntry.drive;
   },
   sheets:({auth})=>({spreadsheets:{get:async (request,settings)=>{
    if(pilotEntry){
     assert.equal(auth,pilotEntry.auth);
     assert.equal(auth.credentials.access_token,pilotEntry.token);
     assert.equal(request.spreadsheetId,BOOK);
     assert.equal(settings.retry,false);
     if(request.fields.includes('developerMetadata')){
      pilotEntry.connections.push('metadata-get');
      assert.equal(request.ranges,undefined);
      assert.equal(request.includeGridData,undefined);
      return {data:{spreadsheetId:BOOK,sheets:pilotEntry.receiptSheets}};
     }
     pilotEntry.connections.push('financial-get');
    }
    if(!googleReadHandler)throw Error('GOOGLE_READ_NOT_BOUND');
    return {data:await googleReadHandler(request)};
   },batchUpdate:async(body,options)=>{
    nativeCalls++;
    if(pilotEntry?.exerciseBatch){
     assert.equal(auth,pilotEntry.auth);assert.equal(auth.credentials.access_token,pilotEntry.token);
     assert.equal(body.spreadsheetId,BOOK);pilotEntry.connections.push('financial-batch');
     return pilotEntry.exerciseBatch(body,options);
    }
    if(!nativeHandler)throw Error('GOOGLE_WRITE_FORBIDDEN');return nativeHandler(body,options);
   },
    get developerMetadata() {
     if (!pilotEntry || auth!==pilotEntry.auth) assert.fail('Pilot lookup must use the bound test credential');
     pilotEntry.connections.push('metadata');
     return pilotEntry.metadata;
    },
   }})}};
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
  if(specifier==='./mail-sender'&&integrated)return {gmailServiceAccountJson:{},mailFrom:{value:()=> 'synthetic@example.invalid'},
   publicLoginGatewayUrl:{value:()=> 'https://synthetic.invalid/gateway'},staffAppUrl:{value:()=> 'https://synthetic.invalid'},
   sendWorkspaceMail:async message=>{journeyMail.push(message);return {messageId:'synthetic-workspace'};}};
  if(specifier==='./firebase')return {db,messaging:{sendEachForMulticast:async input=>{
   assert.equal(integrated,true,'synthetic notification outside one-case test');
   journeySends.push({tokens:Array.from(input.tokens),data:copy(input.data)});
   return {successCount:input.tokens.length,failureCount:0,responses:input.tokens.map(()=>({success:true}))};
  }},auth:{
   getUser:async uid=>{assert.equal(integrated,true);if(uid===OWNER)return {uid,emailVerified:true,disabled:false,customClaims:{role:'admin',companyId:COMPANY}};
    assert.equal(uid,staffAuth.auth.uid);return {uid,email:loginJourneyEmail,emailVerified:true,disabled:false,customClaims:journeyClaims[0]?.claims};},
   getUserByEmail:async email=>{assert.equal(email,loginJourneyEmail);return {uid:staffAuth.auth.uid,email,emailVerified:true,disabled:false,customClaims:journeyClaims[0]?.claims};},
   generateSignInWithEmailLink:async email=>{assert.equal(email,loginJourneyEmail);return 'https://synthetic.invalid/auth';},
   createCustomToken:async (uid,claims)=>{assert.equal(uid,staffAuth.auth.uid);issuedDeviceClaims.push({uid,claims:copy(claims)});return 'synthetic.device.jwt';},
   setCustomUserClaims:async(uid,claims)=>{assert.equal(integrated,true);assert.equal(uid,staffAuth.auth.uid);journeyClaims.push({uid,claims:copy(claims)});},
   app:{options:{get projectId(){return pilotEntry?.projectId;}}},
   verifyIdToken:(token, revoked)=>pilotEntry.verifyIdToken(token, revoked),
  }};
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
 requests.push(copy(request));assert.equal(request.spreadsheetId,BOOK);if(afterRead){const f=afterRead;afterRead=null;f();}
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

let applicationRecovery;
async function recoverApplicationInReopenedStaffUI(job, request){
 const dir=path.join(repoRoot,'apps/staff/src');
 const app=fs.readFileSync(path.join(dir,'App.tsx'),'utf8');
 const attemptSource=fs.readFileSync(path.join(dir,'application-attempt-store.ts'),'utf8');
 const handlers=app.slice(app.indexOf('  async function readAcceptedApplicationReceipts('),app.indexOf('  function resetPreContactInput()'));
 assert.match(handlers,/async function apply\(job:Job\)/u);
 const ts=clientRequire('typescript');
 const compile=source=>ts.transpileModule(source,{compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,
 }}).outputText;
 const storage=new Map(),calls=[],messages=[];
 let beforeLookup,storedBeforeLookup;
 function tab(){
  const stamp={exports:{},navigator:{locks:{request:async(name,_options,run)=>run({name})}},
   localStorage:{get length(){return storage.size;},key:idx=>[...storage.keys()][idx]??null,
    getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)}};
  vm.runInNewContext(compile(attemptSource),stamp);
  const attemptStore=stamp.exports;
  const {uid,token}=staffAuth.auth,owner=attemptStore.applicationAttemptOwner(token.companyId,token.staffId,uid);
  const attempts=attemptStore.loadSavedApplicationAttempts(owner);
  const ctx={...attemptStore,companyId:token.companyId,staffId:token.staffId,user:{uid},
   authLoadVersionRef:{current:1},navigationVersionRef:{current:1},applicationResultFocusRef:{current:null},
   applicationAttemptsRef:{current:attempts},Date:Clock,crypto:{randomUUID:()=>request.requestId},
   firebaseConfigured:true,functions:{},isPending:()=>false,refreshApplicationAttempts(){},
   setPendingApplicationJobId(){},setAcceptedApplicationJobId:id=>assert.equal(id,request.jobId),setOpenJobs(){},
   setExpandedOpenJobId(){},loadTaskJob:async id=>id===request.jobId,loadOpenJobs:async()=>true,
   setMessage:value=>messages.push(value),
   run:async(_key,action,options)=>{try{await action();}catch(error){options.setMessage(error.message);throw error;}},
   httpsCallable:(_app,name)=>async data=>{
    calls.push({name,payload:copy(data)});
    if(name==='applyToJob'){
     assert.deepEqual(copy(data),request);
     const outcome=await jobs.applyToJob({...staffAuth,data});
     assert.equal(outcome.ok,true);
     throw Error('SYNTHETIC_REPLY_LOST_AFTER_APPLICATION_COMMIT');
    }
    assert.equal(name,'getMyTasks');
    assert.equal(JSON.stringify(data.applicationReceiptLookup),JSON.stringify([{jobId:request.jobId,requestId:request.requestId}]));
    return {data:await load('staff-tasks').getMyTasks({...staffAuth,data})};
   },
  };
  return {attempts,...vm.runInNewContext(compile(handlers)+'\n({apply,checkApplicationReceipts});',ctx)};
 }
 const first=tab();
 assert.equal(await first.apply({...job,id:request.jobId}),false);
 assert.match(messages.at(-1),/SYNTHETIC_REPLY_LOST_AFTER_APPLICATION_COMMIT/);
 assert.equal(documents.get('jobs/'+request.jobId).applicationUnconfirmed,true);
 assert.equal(assignmentQueueCount(),1);
 beforeLookup={writes,nativeCalls,requestCount:requests.length,records:protectedState()};
 const reopened=tab();
 storedBeforeLookup=reopened.attempts.get(request.jobId);
 assert.equal(storedBeforeLookup.requestId,request.requestId);
 if(process.argv.includes('--test-name-prefix='+integrationPrefix)){assert.equal(await reopened.apply({...job,id:request.jobId}),true);}
 else await reopened.checkApplicationReceipts();
 assert.equal(reopened.attempts.size,0);
 assert.equal(tab().attempts.size,0);
 assert.match(messages.at(-1),/応募(?:1件の受付を確認|を受け付けました)/u);
 assert.deepEqual({writes,nativeCalls,requestCount:requests.length,records:protectedState()},beforeLookup);
 assert.deepEqual(calls.map(row=>row.name),['applyToJob','getMyTasks']);
 assert.equal(assignmentQueueCount(),1);
 applicationRecovery={
  caseJobId:request.jobId,requestId:storedBeforeLookup.requestId,receiptReadFromReopenedUI:true,
  applicationCalls:1,lookupCalls:1,assignmentQueueDocuments:1,databaseWritesDuringLookup:0,sheetsRequestsDuringLookup:0,
 };
}

async function start(manual=false,modern=false,configure=()=>{}){
 const f=resetFixture(manual,modern);
 await configure(f);
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
 if(integrated){
  const available=list.availableOpenJobs([{...job,id:jobId}],DATE);
  assert.equal(available.length,1);
  assert.equal(available[0].id,jobId);
 }
 if(integrated)await recoverApplicationInReopenedStaffUI(job,request);
 else await jobs.applyToJob({...staffAuth,data:request});
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
  const f=await start(manual,false,async()=>{
   documents.get('sheetImportConfigs/'+COMPANY).columns=columns;
   if(integrated)journeyLogin=await signInOneCaseStaff();
  });archiveFixture(f);
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
 async function expenseCompletionFixture(beforeExpense){
  const fixture=await acceptedExpenseFixture();
  if(beforeExpense)await beforeExpense();
  const shown=await fixture.read();
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
 const expenseFencePath=book=> 'externalExpenseBookFences/'+helpers.hashCaseList({scope:'external_monthly_book',spreadsheetId:book});
 const expenseFenceOperation=id=> 'externalExpenseBookOperations/'+id;
 const expenseBookFence=(native,companyId=COMPANY,spreadsheetId=BOOK)=>
  load('case-list-expense-book-fence').createExternalExpenseBookWriter({companyId,spreadsheetId},native);
 function assertPrivateExpenseWrites(f,fencedId){
  assert.equal(nativeCalls,f.beforeNative);
  assert.deepEqual(copy(documents.get('jobs/'+jobId)),f.jobBefore);
  const privateAttempt='externalExpenseCompletionAttempts/'+jobId;
  assert(documentWrites.slice(f.beforeWrites).every(p=>p==='expenseReviews/'+jobId||p===privateAttempt||p.startsWith(privateAttempt+'/history/')||
   (fencedId&&(p===expenseFencePath(BOOK)||p===expenseFenceOperation(fencedId)))));
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
 let monthlyBookFile;
 const sheetsPrefix='external expense sheets /';
 const pilotPrefix='external expense pilot access /';
 const applicationPrefix="external durable application / ";
 async function acceptedApplication(){
  const f=await start(false,true),identity=staffAuth.auth.uid;
  documents.set("authIdentities/"+identity,{companyId:COMPANY,staffId:STAFF,active:true});
  const idempotencyKey="idempotencyKeys/"+identity+"_"+f.request.requestId;
  const receipt=copy(documents.get(idempotencyKey));assert(receipt?.result?.ok);
  return {...f,idempotencyKey,receipt,queuePath:"sheetSyncQueue/"+f.queueId};
 }
 const lookupApplication=async(args,actor=staffAuth)=>(await load("staff-tasks").getMyTasks({
  ...actor,data:{applicationReceiptLookup:args},
 })).receipts.map(row=>row.status);
 await test(applicationPrefix+"reads the same receipt after short-lived record expiry",async()=>{
  const f=await acceptedApplication();
  const query=[{jobId,requestId:f.request.requestId}];
  assert.equal((await lookupApplication(query))[0],"accepted");
  documents.delete(f.idempotencyKey);
  clockOffset+=25*3600*1000;
  try{
   const before={writes,nativeCalls,requests:requests.length,queues:assignmentQueueCount()};
   assert.equal((await lookupApplication(query))[0],"accepted","the immutable queue receipt must settle the original application");
   assert.deepEqual(copy(await jobs.applyToJob({...staffAuth,data:f.request})),f.receipt.result);
   assert.deepEqual({writes,nativeCalls,requests:requests.length,queues:assignmentQueueCount()},before);
   assert(!documents.has(f.idempotencyKey));
  }finally{clockOffset=0;}
 });
 await test(applicationPrefix+"replayed ID cannot register again after the job is reopened",async()=>{
  const f=await acceptedApplication();documents.delete(f.idempotencyKey);
  Object.assign(documents.get("jobs/"+jobId),{status:"open",assignedStaffId:null,assignedUid:null,revision:99});
  const before={writes,nativeCalls,queueRecords:assignmentQueueCount()};
  assert.deepEqual(copy(await jobs.applyToJob({...staffAuth,data:f.request})),f.receipt.result);
  await assert.rejects(()=>jobs.applyToJob({...staffAuth,data:{...f.request,expectedJobRevision:99}}),{code:"failed-precondition"});
  assert.deepEqual({writes,nativeCalls,queueRecords:assignmentQueueCount()},before);
  assert.equal(documents.get("jobs/"+jobId).status,"open");
 });
 await test(applicationPrefix+"a different job or request ID does not observe the original acceptance",async()=>{
  const f=await acceptedApplication();documents.delete(f.idempotencyKey);
  const before=writes;
  assert.deepEqual(Array.from(await lookupApplication([{jobId:"synthetic_other_job",requestId:f.request.requestId},{jobId,requestId:"other_synthetic_id"}])),["not_observed","not_observed"]);
  assert.equal((await lookupApplication([{jobId,requestId:f.request.requestId}]))[0],"accepted");
  assert.equal(writes,before);
 });
 for(const scope of ["owner","company","staff"])await test(applicationPrefix+"does not expose a receipt to another "+scope,async()=>{
  const f=await acceptedApplication();documents.delete(f.idempotencyKey);
  const current=copy(staffAuth),lookup=[{jobId,requestId:f.request.requestId}];
  if(scope==="owner"){
   current.auth.uid="another_synthetic_uid";
   documents.set("authIdentities/"+current.auth.uid,{companyId:COMPANY,staffId:STAFF,active:true});
  }else if(scope==="company"){
   current.auth.token.companyId="other_synthetic_company";
   documents.get("staffProfiles/"+STAFF).companyId=current.auth.token.companyId;
   documents.get("authIdentities/"+current.auth.uid).companyId=current.auth.token.companyId;
  }else{
   current.auth.token.staffId="other_synthetic_staff";
   documents.get("authIdentities/"+current.auth.uid).staffId=current.auth.token.staffId;
  }
  const before=writes;
  assert.equal((await lookupApplication(lookup,current))[0],"not_observed");
  assert.equal(writes,before);
 });
 await test(applicationPrefix+"damaged queue proof remains unconfirmed and never rewrites",async()=>{
  const f=await acceptedApplication();
  assert.equal(documents.get(f.queuePath).staffApplicationReceipt?.requestId,f.request.requestId);
  documents.get(f.queuePath).staffApplicationReceipt.requestId="different_synthetic_request";
  assert.equal((await lookupApplication([{jobId,requestId:f.request.requestId}]))[0],"accepted","the existing short-lived proof is still authoritative");
  documents.delete(f.idempotencyKey);
  const before=writes;
  assert.equal((await lookupApplication([{jobId,requestId:f.request.requestId}]))[0],"not_observed");
  await assert.rejects(()=>jobs.applyToJob({...staffAuth,data:f.request}),{code:"failed-precondition"});
  assert.equal(writes,before);
 });
 const gatewayPrefix='external expense pilot gateway /';
 const gasPrefix='external expense pilot gas /';
 if(testPrefix==='external monthly book /'||[sheetsPrefix,pilotPrefix,gatewayPrefix,gasPrefix].includes(testPrefix)||integrated){
  const fileName=process.env.LKC_TEST_EVIDENCE_FILE??'';
  assert.match(fileName,/^[a-z0-9-]+\.json$/);
  monthlyBookFile=path.join(evidenceDir,fileName.replace(/\.json$/,'.sqlite'));
  require('./one-case-fixtures/expense-monthly-book.cjs').createFile(monthlyBookFile);
 }
 async function monthlyBookScenario(scenario,run,beforeExpense){
  const {openScenario,savedGasLock}=require('./one-case-fixtures/expense-monthly-book.cjs');
  const fixture=await expenseCompletionFixture(beforeExpense);
  const lock=integrated||[sheetsPrefix,pilotPrefix,gatewayPrefix,gasPrefix].includes(testPrefix) ? null : savedGasLock(process.env.LKC_TEST_GAS_LOCK_SOURCE);
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
   sheetsWriter(options, reader, access){
    const api=session.makeSheetsApi({bookId:BOOK,sheetId:434431224,options});
    const {pilotDriveFixture}=require('./one-case-fixtures/expense-pilot-drive.cjs');
    const pilot=access??pilotDriveFixture(BOOK);
    const writer=load('case-list-expense-sheets-writer').createSheetsExternalExpenseWriter({
     companyId:COMPANY,policy:pilot.policy,drive:pilot.drive,sheets:api.client,readObservation:reader,
    });
    return {api,writer,pilot};
   },
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
 const fencePrefix='external expense fence / ';
 function otherFenceIntent(id,extra={}){
  const now=Clock.now();
  return {id,companyId:COMPANY,jobId:'another-synthetic-job',sheetRef:{spreadsheetId:BOOK},
   createdAtMs:now,expiresAtMs:now+60_000,...extra};
 }
 function occupyFence(writer,intent){
  return db.runTransaction(tx=>writer.stageReservation(tx,intent));
 }
 await test(fencePrefix+'contended book reserves no partial Crew attempt',async()=>{
  const f=await expenseCompletionFixture(),native=syntheticAtomicWriter(f),writer=expenseBookFence(native);
  const other=otherFenceIntent('11111111-1111-4111-8111-111111111111');
  await occupyFence(writer,other);
  const before=writes;
  await assert.rejects(()=>completionCall(f,writer),e=>e.code==='aborted');
  assert.equal(attemptRecord(),undefined);
  assert.equal(reviewRecord(),undefined);
  assert.equal(writes,before);
  assert.equal(native.dispatches,0);
  assert.equal(documents.get(expenseFencePath(BOOK)).operationId,other.id);
 });
 await test(fencePrefix+'unknown send survives a caller restart and blocks GAS, Crew and manual-model contenders',async()=>{
  const f=await expenseCompletionFixture(),native=syntheticAtomicWriter(f);
  let queued=null,sent=0,visible=false;
  const first=expenseBookFence({
   async compareAndWrite(intent){sent++;queued=()=>native.compareAndWrite(intent);throw Error('synthetic delayed server response');},
   async readReceipt(id){return visible?native.readReceipt(id):null;},
  });
  assert.equal((await completionCall(f,first)).reason,'readback_required');
  const id=attemptRecord().intent.id, held=copy(documents.get(expenseFencePath(BOOK)));
  assert.equal(documents.get(expenseFenceOperation(id)).phase,'dispatched');
  await queued(); // The first call returned, then the server performed the original update.
  clockOffset+=61_000;
  const restarted=expenseBookFence({
   compareAndWrite:()=>assert.fail('repair must not dispatch'),
   async readReceipt(key){return visible?native.readReceipt(key):null;},
  });
  try{
   assert.equal((await completionCall(f,restarted)).reason,'readback_required');
   const contenders=['gas','crew','manual'].map((label,i)=>otherFenceIntent(
    '20000000-0000-4000-8000-00000000000'+i,{jobId:'synthetic-'+label}));
   for(const intent of contenders){
    await assert.rejects(()=>occupyFence(restarted,intent),e=>e.code==='aborted');
    assert.equal(documents.has(expenseFenceOperation(intent.id)),false);
   }
   assert.equal(reviewRecord().status,'confirmation_pending');
   assert.deepEqual(copy(documents.get(expenseFencePath(BOOK))),held);
   visible=true;
   const beforeTrace=writes;
   assert.equal((await traceCall(id,restarted)).status,'verified_pending');
   assert.equal(writes,beforeTrace);
   assert.deepEqual(copy(documents.get(expenseFencePath(BOOK))),held);
   assert.equal((await completionCall(f,restarted)).status,'completed');
   assert.equal(documents.get(expenseFencePath(BOOK)).state,'idle');
   assert.equal(documents.get(expenseFenceOperation(id)).phase,'verified');
   assert.equal((await restarted.readReceipt(id)).intentId,id);
   assert.equal(native.writes,1);
   assert.equal(sent,1);
   await occupyFence(restarted,contenders[0]);
  }finally{clockOffset=0;}
 });
 await test(fencePrefix+'expired but unsent reservation records no write and rejects a late dispatcher',async()=>{
  const f=await expenseCompletionFixture(),native=syntheticAtomicWriter(f),writer=expenseBookFence(native);
  const beforeNativeSend={...writer,compareAndWrite:async()=>{throw Error('synthetic stop before marking dispatch');}};
  assert.equal((await completionCall(f,beforeNativeSend)).reason,'readback_required');
  const intent=attemptRecord().intent;
  assert.equal(documents.get(expenseFenceOperation(intent.id)).phase,'reserved');
  clockOffset+=61_000;
  try{
   const beforeTrace=writes;
   assert.equal((await traceCall(intent.id,writer)).status,'readback_required');
   assert.equal(writes,beforeTrace);
   assert.equal((await completionCall(f,writer)).reason,'writer_rejected');
   assert.equal(documents.get(expenseFencePath(BOOK)).state,'idle');
   assert.equal(documents.get(expenseFenceOperation(intent.id)).phase,'verified');
   assert.equal((await writer.readReceipt(intent.id)).outcome,'rejected');
   assert.equal(reviewRecord().status,'draft');
   await assert.rejects(()=>writer.compareAndWrite(intent),e=>e.code==='failed-precondition');
   assert.equal(native.dispatches,0);assert.equal(native.writes,0);assert.equal(native.lookups,0);
  }finally{clockOffset=0;}
 });
 await test(fencePrefix+'review and fence release roll back together and settle once on retry',async()=>{
  const f=await expenseCompletionFixture(),native=syntheticAtomicWriter(f),writer=expenseBookFence(native);
  const interrupted={...writer,async stageVerifiedReceipt(...args){
   await writer.stageVerifiedReceipt(...args);throw Error('synthetic failure before Firestore commit');
  }};
  assert.equal((await completionCall(f,interrupted)).reason,'readback_required');
  const id=attemptRecord().intent.id;
  assert.equal(reviewRecord().status,'confirmation_pending');
  assert.equal(documents.get(expenseFencePath(BOOK)).state,'held');
  assert.equal(documents.get(expenseFenceOperation(id)).phase,'dispatched');
  assert.equal((await completionCall(f,writer)).status,'completed');
  assert.equal(reviewRecord().status,'completed');
  assert.equal(documents.get(expenseFencePath(BOOK)).state,'idle');
  assert.equal(documents.get(expenseFenceOperation(id)).phase,'verified');
  assert.equal(native.dispatches,1);assert.equal(native.writes,1);
 });
 await test(fencePrefix+'book identity is shared across tenants and independent across spreadsheets',async()=>{
  const f=await expenseCompletionFixture(),native=syntheticAtomicWriter(f),writer=expenseBookFence(native);
  const first=otherFenceIntent('31111111-1111-4111-8111-111111111111');
  await occupyFence(writer,first);
  const foreign=expenseBookFence(native,'another-synthetic-company');
  const second=otherFenceIntent('32222222-2222-4222-8222-222222222222',{companyId:'another-synthetic-company'});
  await assert.rejects(()=>occupyFence(foreign,second),e=>e.code==='aborted');
  assert.equal(await foreign.readReceipt(first.id),null);
  await assert.rejects(()=>occupyFence(foreign,first),e=>e.code==='failed-precondition');
  const independent=expenseBookFence(native,COMPANY,'other_synthetic_book');
  await occupyFence(independent,{...second,companyId:COMPANY,sheetRef:{spreadsheetId:'other_synthetic_book'}});
  assert.equal(await independent.readReceipt(first.id),null);
  assert.equal(native.lookups,0);assert.equal(native.dispatches,0);
 });
 await test(fencePrefix+'a receipt with the wrong hash or a late applied result cannot settle',async()=>{
  const f=await expenseCompletionFixture(),native=syntheticAtomicWriter(f);
  const writer=expenseBookFence({
   compareAndWrite:intent=>native.compareAndWrite(intent),
   async readReceipt(id){const receipt=await native.readReceipt(id);return {...receipt,intentHash:'0'.repeat(64)};},
  });
  assert.equal((await completionCall(f,writer)).reason,'readback_required');
  const {id,expiresAtMs}=attemptRecord().intent;
  assert.equal(await writer.readReceipt(id),null);
  clockOffset+=61_000;
  try{
   const late=expenseBookFence({
    compareAndWrite:()=>assert.fail('no replay'),
    async readReceipt(key){return {...await native.readReceipt(key),recordedAtMs:expiresAtMs+1};},
   });
   assert.equal((await completionCall(f,late)).reason,'readback_required');
   assert.equal(documents.get(expenseFencePath(BOOK)).state,'held');
   assert.equal(documents.get(expenseFenceOperation(id)).phase,'dispatched');
   assert.equal(reviewRecord().status,'confirmation_pending');
   const good=expenseBookFence(native);
   assert.equal((await completionCall(f,good)).status,'completed');
   assert.equal(native.dispatches,1);
  }finally{clockOffset=0;}
 });
 await test(fencePrefix+'native proof of a rejected comparison frees the book without copying a value',async()=>{
  const f=await expenseCompletionFixture();
  const native=syntheticAtomicWriter(f,{beforeFence:async()=>{f.month.get(3)[36]=literal(701);}});
  const writer=expenseBookFence(native);
  assert.equal((await completionCall(f,writer)).reason,'writer_rejected');
  const {id}=attemptRecord().intent;
  assert.equal((await writer.readReceipt(id)).outcome,'rejected');
  assert.equal(reviewRecord().status,'draft');
  assert.equal(documents.get(expenseFencePath(BOOK)).state,'idle');
  assert.equal(cellValue(f.month.get(3)[36]),701);
  assert.equal(native.dispatches,1);assert.equal(native.writes,0);
 });
 await test(fencePrefix+'a genuine applied receipt cannot free the book when the monthly row differs',async()=>{
  const f=await expenseCompletionFixture();
  const native=syntheticAtomicWriter(f,{afterFence:async()=>{f.month.get(3)[36]=literal(851);}});
  const writer=expenseBookFence(native);
  assert.equal((await completionCall(f,writer)).reason,'readback_required');
  const {id}=attemptRecord().intent;
  assert.equal((await writer.readReceipt(id)).outcome,'applied');
  assert.equal((await traceCall(id,writer)).status,'readback_required');
  assert.equal(reviewRecord().status,'confirmation_pending');
  assert.equal(documents.get(expenseFencePath(BOOK)).state,'held');
  assert.equal(documents.get(expenseFenceOperation(id)).phase,'dispatched');
  assert.equal(native.dispatches,1);
 });
 await test(fencePrefix+'the same reservation lets only one caller pass the dispatch gate',async()=>{
  const f=await expenseCompletionFixture();
  const native={dispatches:0,async compareAndWrite(){this.dispatches++;},async readReceipt(){return null;}};
  const writer=expenseBookFence(native),intent=otherFenceIntent('41111111-1111-4111-8111-111111111111');
  await occupyFence(writer,intent);
  const attempts=await Promise.allSettled([writer.compareAndWrite(intent),writer.compareAndWrite(intent)]);
  assert.equal(attempts.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(attempts.find(item=>item.status==='rejected').reason.code,'aborted');
  assert.equal(native.dispatches,1);
  assert.equal(documents.get(expenseFencePath(BOOK)).state,'held');
  assert.equal(documents.get(expenseFenceOperation(intent.id)).phase,'dispatched');
 });
 await test(sheetsPrefix+'one batch writes only the changed values and keeps blank distinct from zero',async()=>{
  await monthlyBookScenario('google-value-mask',async ctx=>{
   const f=ctx.fixture;
   f.data.values.postageCost=null;
   const otherRow=ctx.table.get(2),untouched=ctx.table.get(3)[39];
   const {api,writer}=ctx.sheetsWriter();
   assert.equal((await completionCall(f,writer)).status,'completed');
   assert.equal(api.batches,1);
   const marker=api.latest.at(-1).createDeveloperMetadata.developerMetadata;
   assert.equal(marker.metadataKey,'LK_CREW_EXPENSE_RECEIPT_V1_'+attemptRecord().intent.id);
   assert.equal(marker.metadataValue.split(':').length,3);
   const updates=api.latest.slice(0,-1).map(item=>item.updateCells);
   assert.deepEqual(updates.map(item=>[item.start.rowIndex,item.start.columnIndex,item.fields]),[
    [2,36,'userEnteredValue'],[2,37,'userEnteredValue'],[2,41,'userEnteredValue'],
   ]);
   assert.deepEqual(updates[1].rows[0].values[0],{userEnteredValue:{numberValue:0}});
   assert.deepEqual(updates[2].rows[0].values[0],{});
   assert.equal(cellValue(ctx.table.get(3)[37]),0);
   assert.equal(cellValue(ctx.table.get(3)[41]),'');
   assert.deepEqual(ctx.table.get(3)[39],untouched);
   assert.deepEqual(ctx.table.get(2),otherRow);
  });
 });
 await test(sheetsPrefix+'a receipt allocation failure rolls back all changed cells',async()=>{
  await monthlyBookScenario('google-rolled-back',async ctx=>{
   const f=ctx.fixture, before=ctx.table.get(3),{api,writer}=ctx.sheetsWriter({failBeforeMarker:true});
   assert.equal((await completionCall(f,writer)).reason,'readback_required');
   assert.equal(api.batches,1);
   assert.equal(await writer.readReceipt(attemptRecord().intent.id),null);
   assert.deepEqual(ctx.table.get(3),before);
   assert.equal(documents.get(expenseFencePath(BOOK)).state,'held');
  });
 });
 await test(sheetsPrefix+'metadata identifier collision refuses the whole batch',async()=>{
  await monthlyBookScenario('google-marker-collision',async ctx=>{
   const f=ctx.fixture,before=ctx.table.get(3);
   const competitor=ctx.sheetsWriter().api.client.spreadsheets;
   const {api,writer}=ctx.sheetsWriter({async beforeBatch(){
    const prior=JSON.parse(JSON.stringify(api.latest.at(-1)));
    const marker=prior.createDeveloperMetadata.developerMetadata;
    marker.metadataKey='SYNTHETIC_OTHER_METADATA';
    marker.metadataValue=marker.metadataValue.replace(':applied:',':rejected:');
    await competitor.batchUpdate({spreadsheetId:BOOK,requestBody:{requests:[prior]}},
     {retry:false,retryConfig:{retry:0,noResponseRetries:0,httpMethodsToRetry:[]}});
   }});
   assert.equal((await completionCall(f,writer)).reason,'readback_required');
   assert.equal(api.batches,1);
   assert.equal(await writer.readReceipt(attemptRecord().intent.id),null);
   assert.deepEqual(ctx.table.get(3),before);
   assert.equal(documents.get(expenseFencePath(BOOK)).state,'held');
  });
 });
 await test(sheetsPrefix+'an identical delayed batch cannot update the row twice',async()=>{
  await monthlyBookScenario('google-duplicate-batch',async ctx=>{
   const f=ctx.fixture,{api,writer}=ctx.sheetsWriter();
   assert.equal((await completionCall(f,writer)).status,'completed');
   const applied=api.latest;
   assert.ok(applied.at(-1).createDeveloperMetadata.developerMetadata.metadataId>0);
   ctx.unsafeSetByPosition(3,36,852);
   await assert.rejects(()=>api.client.spreadsheets.batchUpdate({spreadsheetId:BOOK,requestBody:{requests:applied}},
    {retry:false,retryConfig:{retry:0,noResponseRetries:0,httpMethodsToRetry:[]}}),/UNIQUE constraint failed/);
   assert.equal(cellValue(ctx.table.get(3)[36]),852);
   assert.equal((await writer.readReceipt(attemptRecord().intent.id)).outcome,'applied');
  });
 });
 await test(sheetsPrefix+'an ambiguous receipt is refused and later recovery only searches',async()=>{
  await monthlyBookScenario('google-ambiguous-marker',async ctx=>{
   const f=ctx.fixture;
   const first=ctx.sheetsWriter({loseResponse:true,searchResult:matches=>[...matches,...matches],async beforeBatch(){
    clockOffset+=61_000;
    const other=otherFenceIntent('93333333-3333-4333-8333-333333333333');
    await assert.rejects(()=>occupyFence(first.writer,other),e=>e.code==='aborted');
   }});
   try{
    assert.equal((await completionCall(f,first.writer)).reason,'readback_required');
    assert.equal(first.api.batches,1);
    const {id,expiresAtMs}=attemptRecord().intent;
    assert.equal(documents.get(expenseFencePath(BOOK)).state,'held');
    ctx.reopen();
    const next=ctx.sheetsWriter(),receipt=await next.writer.readReceipt(id);
    assert.equal(receipt.outcome,'applied');
    assert.ok(receipt.recordedAtMs<=expiresAtMs);
    assert.ok(receipt.observedAtMs>expiresAtMs);
    assert.equal((await traceCall(id,next.writer)).status,'verified_pending');
    assert.equal(documents.get(expenseFencePath(BOOK)).state,'held');
    assert.equal((await completionCall(f,next.writer)).status,'completed');
    assert.equal(next.api.batches,0);
    assert.equal(documents.get(expenseFencePath(BOOK)).state,'idle');
   }finally{clockOffset=0;}
  });
 });
 await test(sheetsPrefix+'a moved row produces a rejection marker without a cell request',async()=>{
  await monthlyBookScenario('google-moved-row',async ctx=>{
   const f=ctx.fixture,intended=ctx.table.get(3);
   const {api,writer}=ctx.sheetsWriter({},async intent=>{
    ctx.move('manual',3,4);
    return load('case-list-external-transfer').readExternalCaseListExpenses(COMPANY,jobId,documents.get('jobs/'+jobId));
   });
   assert.equal((await completionCall(f,writer)).reason,'writer_rejected');
   assert.equal(await writer.readReceipt(attemptRecord().intent.id).then(receipt=>receipt.outcome),'rejected');
   assert.equal(api.latest.length,1);
   assert.deepEqual(ctx.table.get(4),intended);
   assert.notEqual(cellValue(ctx.table.get(3)[55]),CASE);
  });
 });
 await test(sheetsPrefix+'a late compare records rejection without sending values',async()=>{
  await monthlyBookScenario('google-deadline',async ctx=>{
   const f=ctx.fixture,before=ctx.table.get(3);
   const {api,writer}=ctx.sheetsWriter({},async()=>{
    const observation=await load('case-list-external-transfer').readExternalCaseListExpenses(COMPANY,jobId,documents.get('jobs/'+jobId));
    clockOffset+=61_000;
    return observation;
   });
   try{
    assert.equal((await completionCall(f,writer)).reason,'writer_rejected');
    assert.equal(api.latest.length,1);
    assert.deepEqual(ctx.table.get(3),before);
    assert.equal((await writer.readReceipt(attemptRecord().intent.id)).outcome,'rejected');
   }finally{clockOffset=0;}
  });
 });
 await test(sheetsPrefix+'altered coordinates and amounts cannot escape the existing observation plan',async()=>{
  for(const [name,modify] of [
   ['column',intent=>{intent.changes[0].index=39;}],
   ['hash',intent=>{intent.afterHash='0'.repeat(64);}],
   ['formula',intent=>{intent.changes[0].value={formulaValue:'=1'};}],
  ]) await monthlyBookScenario('google-bad-'+name,async ctx=>{
   const f=ctx.fixture, before=ctx.table.get(3),transfer=load('case-list-external-transfer');
   const now=Clock.now();
   const live=await transfer.readExternalCaseListExpenses(COMPANY,jobId,documents.get('jobs/'+jobId));
   const intent={...otherFenceIntent('91111111-1111-4111-8111-111111111111'),
    jobId,companyId:COMPANY,staffId:STAFF,staffName:NAME,dateKey:live.dateKey,jobRevision:live.revision,
    createdAtMs:now,sheetRef:live.sheetRef,acceptanceHash:live.expenseAcceptanceHash,
    beforeHash:live.caseListFinancialObservationHash,
    afterHash:transfer.expectedExternalExpenseObservationHash(live,f.data.values),
    changes:copy(transfer.planExternalExpenseConfirmation(live,f.data.values)),
   };
   modify(intent);
   const {api,writer}=ctx.sheetsWriter();
   await occupyFence(writer,intent);
   await assert.rejects(()=>writer.compareAndWrite(intent),/EXPENSE_SHEETS_WRITE_OR_RECEIPT_UNVERIFIED/);
   assert.equal(api.batches,0);
   assert.deepEqual(ctx.table.get(3),before);
  });
 });
 const freshAccess=()=>require('./one-case-fixtures/expense-pilot-drive.cjs').pilotDriveFixture(BOOK);
 await test(pilotPrefix+'checks both published and ordinary permission pages on the one pinned book',async()=>{
  const access=freshAccess(),check=load('case-list-expense-pilot-access').createExpensePilotBookAccess(access.policy,access.drive);
  assert.equal(await check(),'1');
  const reads=access.state.reads;
  assert.deepEqual(reads.filter(r=>r.name==='permissions').map(r=>r.token),[undefined,'second']);
  assert.deepEqual(reads.filter(r=>r.name==='files').map(r=>r.id),['root',BOOK,BOOK]);
  assert.equal(reads.filter(r=>r.name==='about').length,1);
 });
 for(const [scenario,reason,makeUnsafe] of [
  ['foreign credential','expense_pilot_owner_identity',a=>{a.state.user.permissionId='unexpected-owner';}],
  ['later-page extra editor','expense_pilot_book_permissions',a=>{a.state.pages.get('second').permissions.push({id:'unexpected-writer',type:'user',role:'writer'});}],
  ['published URL','expense_pilot_book_permissions',a=>{a.state.pages.get('second').permissions.push({id:'published',type:'anyone',role:'reader',view:'published'});}],
  ['group viewer','expense_pilot_book_permissions',a=>{a.state.pages.get('second').permissions=[{id:a.policy.readerPermissionIds[0],type:'group',role:'reader'}];}],
  ['pending owner','expense_pilot_book_permissions',a=>{a.state.pages.get('second').permissions=[{id:a.policy.readerPermissionIds[0],type:'user',role:'reader',pendingOwner:true}];}],
  ['inherited share','expense_pilot_book_permissions',a=>{a.state.pages.get('second').permissions=[{id:a.policy.readerPermissionIds[0],type:'user',role:'reader',permissionDetails:[{inherited:true}]}];}],
  ['missing owner on list','expense_pilot_book_permissions',a=>{a.state.pages.get(undefined).permissions=[];}],
  ['repeated page token','expense_pilot_permissions_incomplete',a=>{a.state.pages.get('second').nextPageToken='second';}],
  ['metadata read refused','expense_pilot_metadata_unavailable',a=>{a.state.onList=()=>{throw Error('synthetic refusal');};}],
  ['not private root','expense_pilot_book_scope',a=>{a.state.file.parents=['unapproved-folder'];}],
  ['shared drive','expense_pilot_book_scope',a=>{a.state.file.driveId='unexpected-shared-drive';}],
  ['shortcut','expense_pilot_book_scope',a=>{a.state.file.mimeType='application/vnd.google-apps.shortcut';}],
  ['not editable by writer','expense_pilot_book_scope',a=>{a.state.file.capabilities.canModifyContent=false;}],
  ['file changes while checking','expense_pilot_book_changed',a=>{a.state.onList=()=>{a.state.file.version='2';};}],
 ]) await test(pilotPrefix+scenario+' stops before reservation or Sheets access',async()=>{
  await monthlyBookScenario('pilot-denied-'+scenario,async ctx=>{
   const access=freshAccess();
   makeUnsafe(access);
   const f=ctx.fixture,{api,writer}=ctx.sheetsWriter({},undefined,access);
   const before=writes,sheetReads=requests.length;
   await assert.rejects(()=>completionCall(f,writer),e=>e.code==='failed-precondition'&&e.details?.reason===reason);
   assert.equal(writes,before);
   assert.equal(requests.length,sheetReads);
   assert.equal(attemptRecord(),undefined);
   assert.equal(documents.has(expenseFencePath(BOOK)),false);
   assert.equal(api.searches,0);
   assert.equal(api.batches,0);
  });
 });
 await test(pilotPrefix+'a share granted after reservation stops before the batch',async()=>{
  await monthlyBookScenario('pilot-mid-flight-permissions',async ctx=>{
   const access=freshAccess(),before=ctx.table.get(3);
   const {api,writer}=ctx.sheetsWriter({},async()=>{
    const live=await load('case-list-external-transfer').readExternalCaseListExpenses(COMPANY,jobId,documents.get('jobs/'+jobId));
    access.state.pages.get('second').permissions.push({id:'late-editor',type:'user',role:'writer'});
    return live;
   },access);
   assert.equal((await completionCall(ctx.fixture,writer)).reason,'readback_required');
   assert.equal(api.batches,0);
   assert.deepEqual(ctx.table.get(3),before);
   assert.equal(documents.get(expenseFencePath(BOOK)).state,'held');
  });
 });
 await test(pilotPrefix+'a file version drift around the expense observation stops the batch',async()=>{
  await monthlyBookScenario('pilot-mid-flight-version',async ctx=>{
   const access=freshAccess(),before=ctx.table.get(3);
   const {api,writer}=ctx.sheetsWriter({},async()=>{
    const live=await load('case-list-external-transfer').readExternalCaseListExpenses(COMPANY,jobId,documents.get('jobs/'+jobId));
    access.state.file.version='2';
    return live;
   },access);
   assert.equal((await completionCall(ctx.fixture,writer)).reason,'readback_required');
   assert.equal(api.batches,0);
   assert.equal(await writer.readReceipt(attemptRecord().intent.id),null);
   assert.deepEqual(ctx.table.get(3),before);
  });
 });
 await test(pilotPrefix+'an existing positive receipt can be recovered without a new permission check or batch',async()=>{
  await monthlyBookScenario('pilot-positive-recovery',async ctx=>{
   const access=freshAccess(),f=ctx.fixture;
   const first=ctx.sheetsWriter({loseResponse:true,searchResult:()=>[]},undefined,access);
   assert.equal((await completionCall(f,first.writer)).reason,'readback_required');
   assert.equal(first.api.batches,1);
   const id=attemptRecord().intent.id;
   ctx.reopen();
   access.state.onList=()=>assert.fail('lookup must not run a new write preflight');
   const next=ctx.sheetsWriter({},undefined,access),before=access.state.reads.length;
   assert.equal((await traceCall(id,next.writer)).status,'verified_pending');
   assert.equal((await completionCall(f,next.writer)).status,'completed');
   assert.equal(next.api.batches,0);
   assert.equal(access.state.reads.length,before);
  });
 });
 function expenseGateway(writer,config={},runtimeOverrides={}){
  const create=load('case-list-expense-pilot-gateway').createExpensePilotGateway;
  const current=documents.get('jobs/'+jobId), projectId='synthetic-crew-pilot';
  const policy={enabled:true,mode:'exercise',pilotId:'synthetic-one-case',projectId,companyId:COMPANY,jobId,caseId:CASE,staffId:STAFF,dateKey:DATE,
   jobRevision:current.revision,spreadsheetId:BOOK,sheetId:434431224,validUntilMs:Clock.now()+120_000,
   principals:{crew:'synthetic_crew',gas:'synthetic_gas',manual:'synthetic_manual'},...config};
  const reads=[],revoked=new Set();
  const runtime={projectId,environment:'staging',async verifyIdToken(token,checkRevoked){
   assert.equal(checkRevoked,true);
   const actor=token.split('.')[0];
   reads.push(actor);
   if(revoked.has(actor)||!Object.hasOwn(policy.principals,actor))throw Error('synthetic unverified actor');
   const now=Math.floor(Clock.now()/1000),uid=policy.principals[actor];
   const claims={uid,sub:uid,companyId:COMPANY,expensePilotId:policy.pilotId,expensePilotChannel:actor,
    role:actor==='crew'?'admin':'expense_pilot',aud:projectId,iss:'https://securetoken.google.com/'+projectId,
    exp:now+300,iat:now-10,auth_time:Math.floor(policy.validUntilMs/1000)-200};
   return runtimeOverrides.changeClaims?.(claims,actor)??claims;
  },...runtimeOverrides};
  const execute=create(policy,runtime,writer);
  const send=(actor,action,data)=>execute('Bearer '+actor+'.synthetic.token',{
   pilotId:policy.pilotId,jobId,action,...(action==='complete'?{operationId:crypto.randomUUID()}:{}),...data,
  });
  return { policy, execute, send, revoked, reads, verifyIdToken:runtime.verifyIdToken };
 }
 await test(gatewayPrefix+'preflight can read the approved workbook but cannot reserve or reconcile',async()=>{
  await monthlyBookScenario('gateway-preflight-no-write',async ctx=>{
   const native=ctx.sheetsWriter(),gateway=expenseGateway(native.writer,{mode:'preflight'}),http=httpExpenseFixture(gateway);
   assert.throws(()=>expenseGateway(native.writer,{mode:undefined}),{name:'ZodError'});
   const beforeWrites=writes, beforeReads=requests.length;
   const result=await http();
   assert.equal(result.code,200);
   assert.match(result.body.result.reviewVersion,/^[a-f0-9]{64}$/);
   assert.ok(requests.length>beforeReads);
   const operationId=crypto.randomUUID();
   for(const input of [{action:'complete',expectedVersion:result.body.result.reviewVersion,values:ctx.fixture.data.values},{action:'reconcile'}]){
    const reads=documentReads.length;
    const payload={pilotId:gateway.policy.pilotId,jobId,operationId,...input};
    const reply=await http({rawBody:Buffer.from(JSON.stringify(payload))});
    assert.equal(reply.code,409);
    assert.equal(documentReads.length,reads);
   }
   assert.equal(writes,beforeWrites);
   assert.equal(native.api.batches,0);
   assert.equal(attemptRecord(),undefined);
  });
 });
 await test(gatewayPrefix+'assembled preflight traces an interrupted write with read-only ports',async()=>{
  await monthlyBookScenario('gateway-preflight-read-only-ports',async ctx=>{
   const first=ctx.sheetsWriter({loseResponse:true,searchResult:()=>[]});
   const exercise=expenseGateway(first.writer);
   const seen=await exercise.send('crew','read');
   const operationId=crypto.randomUUID();
   const response=await exercise.send('crew','complete',{operationId,expectedVersion:seen.reviewVersion,values:ctx.fixture.data.values});
   assert.equal(response.reason,'readback_required');
   assert.equal(first.api.batches,1);
   assert.equal(attemptRecord().intent.id,operationId);
   ctx.reopen();
   const current=ctx.sheetsWriter();
   const {createApprovedExpensePilotEntry}=load('case-list-expense-pilot-entry');
   const book=current.pilot.policy, policy={...exercise.policy,mode:'preflight'};

   const identity=current.pilot.state.file;
   identity.capabilities={canEdit:false,canModifyContent:false};
   const scenario='gateway-preflight-read-only-ports';
   const archive=new (require('node:sqlite').DatabaseSync)(monthlyBookFile,{readOnly:true});
   try {
    const rows=archive.prepare('SELECT body FROM google_metadata WHERE scenario=?').all(scenario);
    assert.equal(rows.length,1);
    pilotEntry=readOnlyCredentialFixture(policy,exercise,current.pilot.drive,[
     {properties:{sheetId:policy.sheetId},developerMetadata:rows.map(row=>JSON.parse(row.body))},
    ]);
   }finally{archive.close();}
   runtimeEnvironment.EXPECTED_FIREBASE_PROJECT_ID='incorrect-synthetic-project';
   try {
    assert.throws(()=>createApprovedExpensePilotEntry(policy,book,{mode:'preflight',oauthClientId:pilotEntry.oauthClientId,accessToken:pilotEntry.token}),{code:'failed-precondition'});
    assert.deepEqual(pilotEntry.connections,[]);
    runtimeEnvironment.EXPECTED_FIREBASE_PROJECT_ID=policy.projectId;
    assert.throws(()=>createApprovedExpensePilotEntry(policy,book,{mode:'exercise',ownerAuth:{}}),{code:'failed-precondition'});
    const handle=createApprovedExpensePilotEntry(policy,book,{mode:'preflight',oauthClientId:pilotEntry.oauthClientId,accessToken:pilotEntry.token});
    assert.deepEqual(pilotEntry.connections,[]);
    const request=httpExpenseFixture(exercise,'manual',handle);
    const beforeWrites=writes, beforeSheetsWrites=nativeCalls, beforeSearches=current.api.searches;
    const denied=await request({headers:{authorization:'Bearer someone.synthetic.token','content-type':'application/json'},rawHeaders:['Authorization','Bearer someone.synthetic.token','Content-Type','application/json']});
    assert.equal(denied.code,403);
    assert.deepEqual(pilotEntry.connections,[]);
    assert.ok((await request()).body.result.reviewVersion);
    assert.deepEqual(pilotEntry.connections.slice(0,2),['token-info','drive']);
    const post=(action,fields={})=>request({rawBody:Buffer.from(JSON.stringify({pilotId:policy.pilotId,jobId,action,operationId,...fields}))});
    assert.deepEqual((await post('trace')).body,{ok:true,result:{operationId,status:'verified_pending'}});
    assert.equal(current.api.searches,beforeSearches);
    assert.equal(pilotEntry.connections.filter(op=>op==='token-info').length,1);
    assert.equal(pilotEntry.connections.filter(op=>op==='metadata-get').length,1);
    assert.ok(pilotEntry.connections.filter(op=>op==='financial-get').length>=6);
    const receipts=pilotEntry.receiptSheets[0].developerMetadata;
    const [receipt]=receipts;
    pilotEntry.receiptSheets[0].developerMetadata=[{...receipt,location:{locationType:'SHEET',sheetId:0}}];
    assert.deepEqual((await post('trace')).body,{ok:true,result:{operationId,status:'readback_required'}});
    pilotEntry.receiptSheets[0].developerMetadata=[receipt,{...receipt,metadataId:receipt.metadataId+1}];
    assert.deepEqual((await post('trace')).body,{ok:true,result:{operationId,status:'readback_required'}});
    pilotEntry.receiptSheets[0].developerMetadata=receipts;
    const beforeReads=documentReads.length;
    assert.equal((await post('reconcile')).code,409);
    assert.equal((await post('complete',{expectedVersion:seen.reviewVersion,values:ctx.fixture.data.values})).code,409);
    assert.equal(documentReads.length,beforeReads);
    assert.equal(writes,beforeWrites);
    assert.equal(nativeCalls,beforeSheetsWrites);
    assert.equal(current.api.batches,0);
    assert.equal(attemptRecord().status,'pending');
   } finally {
    delete runtimeEnvironment.EXPECTED_FIREBASE_PROJECT_ID;
    pilotEntry=null;
   }
  });
 });

 function readOnlyCredentialFixture(policy,gateway,drive,receiptSheets=[]){
  const expectedReadScopes=[
   'https://www.googleapis.com/auth/drive.metadata.readonly',
   'https://www.googleapis.com/auth/spreadsheets.readonly',
  ];

  const oauthClientId='synthetic-pilot.apps.googleusercontent.com';
  return {projectId:policy.projectId,drive,receiptSheets,connections:[],verifyIdToken:gateway.verifyIdToken,oauthClientId,
   token:'offline-synthetic-preflight-access', tokenInfo:{aud:oauthClientId,scopes:[...expectedReadScopes],expiry_date:Clock.now()+30_000}};
 }
 for(const scenario of ['extra-write-scope','missing-scope','expired-token','token-info-unavailable','foreign-audience','foreign-presenter'])await test(gatewayPrefix+'isolated preflight rejects '+scenario+' before creating API clients',async()=>{
  await monthlyBookScenario('gateway-credential-'+scenario,async ctx=>{
   const current=ctx.sheetsWriter(),gateway=expenseGateway(current.writer,{mode:'preflight'}),policy=gateway.policy;
   const {createApprovedExpensePilotEntry}=load('case-list-expense-pilot-entry');
   pilotEntry=readOnlyCredentialFixture(policy,gateway,current.pilot.drive);
   if(scenario==='extra-write-scope')pilotEntry.tokenInfo.scopes.push('https://www.googleapis.com/auth/spreadsheets');
   if(scenario==='missing-scope')pilotEntry.tokenInfo.scopes.pop();
   if(scenario==='expired-token')pilotEntry.tokenInfo.expiry_date=Clock.now()-1;
   if(scenario==='token-info-unavailable')pilotEntry.tokenInfoError=true;
   if(scenario==='foreign-audience')pilotEntry.tokenInfo.aud='other-client.apps.googleusercontent.com';
   if(scenario==='foreign-presenter')pilotEntry.tokenInfo.azp='other-client.apps.googleusercontent.com';
   runtimeEnvironment.EXPECTED_FIREBASE_PROJECT_ID=policy.projectId;
   try{
    const handle=createApprovedExpensePilotEntry(policy,current.pilot.policy,{mode:'preflight',oauthClientId:pilotEntry.oauthClientId,accessToken:pilotEntry.token});
    assert.deepEqual(pilotEntry.connections,[]);
    const request=httpExpenseFixture(gateway,'manual',handle),beforeReads=requests.length,beforeWrites=writes;
    const response=await request();
    assert.equal(response.code,409);
    assert.equal(JSON.stringify(response.body).includes(pilotEntry.token),false);
    assert.deepEqual(pilotEntry.connections,['token-info']);
    assert.equal(requests.length,beforeReads);
    assert.equal(writes,beforeWrites);
    assert.equal(current.api.batches,0);
   }finally{
    delete runtimeEnvironment.EXPECTED_FIREBASE_PROJECT_ID;
    pilotEntry=null;
   }
  });
 });
 for(const type of ['wide-drive-scope','read-only-sheets','wrong-audience','expired'])await test(gatewayPrefix+'isolated exercise rejects '+type+' before any write-capable client',async()=>{
  await monthlyBookScenario('gateway-exercise-credential-'+type,async ctx=>{
   const native=ctx.sheetsWriter(),gateway=expenseGateway(native.writer),policy=gateway.policy;
   const create=load("case-list-expense-pilot-entry").createApprovedExpensePilotEntry;
   pilotEntry=readOnlyCredentialFixture(policy,gateway,native.pilot.drive);
   if(type!=='read-only-sheets')pilotEntry.tokenInfo.scopes[1]='https://www.googleapis.com/auth/spreadsheets';
   if(type==='wide-drive-scope')pilotEntry.tokenInfo.scopes.push('https://www.googleapis.com/auth/drive');
   if(type==='wrong-audience')pilotEntry.tokenInfo.aud='other-client.apps.googleusercontent.com';
   if(type==='expired')pilotEntry.tokenInfo.expiry_date=Clock.now();
   runtimeEnvironment.EXPECTED_FIREBASE_PROJECT_ID=policy.projectId;
   try{
    const handle=create(policy,native.pilot.policy,{mode:'exercise',oauthClientId:pilotEntry.oauthClientId,accessToken:pilotEntry.token});
    assert.deepEqual(pilotEntry.connections,[]);
    const request=httpExpenseFixture(gateway,"gas",handle), beforeReads=requests.length, beforeWrites=writes;
    const response=await request();
    assert.equal(response.code,409);
    assert.equal(JSON.stringify(response.body).includes(pilotEntry.token),false);
    assert.deepEqual(pilotEntry.connections,['token-info']);
    assert.equal(requests.length,beforeReads);
    assert.equal(writes,beforeWrites);
    assert.equal(native.api.batches,0);
    assert.equal(attemptRecord(),undefined);
   }finally{delete runtimeEnvironment.EXPECTED_FIREBASE_PROJECT_ID;pilotEntry=null;}
  });
 });
 for(const substituted of ['delayed','wrong-sheet','expired-token'])await test(gatewayPrefix+'assembled exercise binds every read and recovers '+substituted+' receipt',async()=>{
  await monthlyBookScenario('gateway-exercise-bound-'+substituted,async ctx=>{
   const initial=ctx.sheetsWriter(),gateway=expenseGateway(initial.writer),policy=gateway.policy;
   const adjacent=copy(ctx.table.get(2));
   const create=load('case-list-expense-pilot-entry').createApprovedExpensePilotEntry;
   let originalVisible=false;
   const current=ctx.sheetsWriter({loseResponse:true,searchResult(matches){
    if(originalVisible)return matches;
    if(substituted!=='wrong-sheet')return [];
    return matches.map(row=>({...row,developerMetadata:{...row.developerMetadata,location:{...row.developerMetadata.location,sheetId:0}}}));
   }});
   const setPorts=native=>{
    pilotEntry=readOnlyCredentialFixture(policy,gateway,native.pilot.drive);
    pilotEntry.token=originalVisible?'offline-next-owner-token':'offline-first-owner-token';
    pilotEntry.tokenInfo.scopes[1]='https://www.googleapis.com/auth/spreadsheets';
    pilotEntry.metadata=native.api.client.spreadsheets.developerMetadata;
    pilotEntry.exerciseBatch=native.api.client.spreadsheets.batchUpdate;
    return create(policy,native.pilot.policy,{mode:'exercise',oauthClientId:pilotEntry.oauthClientId,accessToken:pilotEntry.token});
   };
   runtimeEnvironment.EXPECTED_FIREBASE_PROJECT_ID=policy.projectId;
   try{
    let request=httpExpenseFixture(gateway,'crew',setPorts(current));
    const shown=await request();
    assert.equal(shown.code,200,'initial financial read uses only the approved owner connection');
    assert.deepEqual(pilotEntry.connections.slice(0,2),['token-info','drive']);
    assert.ok(pilotEntry.connections.includes('financial-get'));
    const operationId=crypto.randomUUID();
    const send=(action,fields={})=>request({rawBody:Buffer.from(JSON.stringify({pilotId:policy.pilotId,jobId,action,operationId,...fields}))});
    const issued=await send('complete',{expectedVersion:shown.body.result.reviewVersion,values:ctx.fixture.data.values});
    assert.equal(issued.code,200);assert.equal(issued.body.result.reason,'readback_required');
    assert.equal(attemptRecord().intent.id,operationId);assert.equal(reviewRecord().status,'confirmation_pending');
    assert.equal(documents.get(expenseFencePath(BOOK)).state,'held');
    assert.equal(current.api.batches,1);assert.equal(pilotEntry.connections.filter(op=>op==='financial-batch').length,1);
    assert.ok(pilotEntry.connections.filter(op=>op==='financial-get').length>=6);
    if(substituted==='expired-token'){
     clockOffset+=31_000;
     assert.equal((await send('trace')).code,409);
     assert.equal(attemptRecord().intent.id,operationId);
     assert.equal(current.api.batches,1);
    }
    ctx.reopen();originalVisible=true;
    const recovered=ctx.sheetsWriter();
    request=httpExpenseFixture(gateway,'crew',setPorts(recovered));
    assert.equal((await send('trace')).body.result.status,'verified_pending');
    assert.equal((await send('reconcile')).body.result.status,'completed');
    assert.equal(attemptRecord().status,'completed');assert.equal(reviewRecord().status,'completed');
    assert.equal(documents.get(expenseFencePath(BOOK)).state,'idle');
    assert.equal(recovered.api.batches,0);
    assert.ok(pilotEntry.connections.filter(op=>op==='financial-get').length>=4);
    assert.equal(pilotEntry.connections.filter(op=>op==='financial-batch').length,0);
    assert.equal(cellValue(ctx.table.get(3)[36]),850);assert.deepEqual(ctx.table.get(2),adjacent);
   }finally{clockOffset=0;delete runtimeEnvironment.EXPECTED_FIREBASE_PROJECT_ID;pilotEntry=null;}
  });
 });
 await test(gatewayPrefix+'an unexpected editor is refused before reading financial cells',async()=>{
  await monthlyBookScenario('gateway-preflight-unapproved-editor',async ctx=>{
   const native=ctx.sheetsWriter(),gateway=expenseGateway(native.writer,{mode:'preflight'});
   const list=native.pilot.state.pages.get('second').permissions;
   native.pilot.state.pages.set('second',{permissions:[...list,{id:'SYNTH_UNAPPROVED',type:'user',role:'writer'}]});
   const reads=requests.length, beforeWrites=writes;
   await assert.rejects(()=>gateway.send('gas','read'),{code:'failed-precondition'});
   assert.equal(requests.length,reads);
   assert.equal(writes,beforeWrites);
   assert.equal(native.api.batches,0);
  });
 });
 await test(gatewayPrefix+'config changed after binding cannot redirect the financial read',async()=>{
  await monthlyBookScenario('gateway-preflight-wrong-book',async ctx=>{
   const native=ctx.sheetsWriter(),gateway=expenseGateway(native.writer,{mode:'preflight'});
   const counts=bindingReadTransactions, reads=requests.length, beforeWrites=writes;
   const key='sheetImportConfigs/'+COMPANY, config=documents.get(key);
   afterCommit=()=>{
    if(bindingReadTransactions===counts+1)documents.set(key,{...config,spreadsheetId:'UNAPPROVED_SYNTHETIC_BOOK'});
   };
   try {
    await assert.rejects(()=>gateway.send('gas','read'),e=>e.code==='failed-precondition'&&e.details?.reason==='case_list_external_expense_readback_unverified');
    assert.equal(documents.get(key).spreadsheetId,'UNAPPROVED_SYNTHETIC_BOOK');
    assert.equal(requests.length,reads);
    assert.equal(writes,beforeWrites);
    assert.equal(native.api.batches,0);
   } finally {
    afterCommit=null;
    documents.set(key,config);
   }
   assert.ok((await gateway.send('gas','read')).reviewVersion);
  });
 });
 for(const mode of ['version','editor','assignment'])await test(gatewayPrefix+'read-only lookup refuses '+mode+' drift after reading the expense fields',async()=>{
  await monthlyBookScenario('gateway-read-drift-'+mode,async ctx=>{
   const native=ctx.sheetsWriter(),gateway=expenseGateway(native.writer,{mode:'preflight'});
   const beforeWrites=writes, beforeSheetsWrites=nativeCalls, beforeReads=requests.length;
   afterRead=()=>{
    if(mode==='version')native.pilot.state.file.version='2';
    if(mode==='editor')native.pilot.state.pages.get('second').permissions.push({id:'synthetic-late-editor',type:'user',role:'writer'});
    if(mode==='assignment'){const key='jobs/'+jobId,current=documents.get(key);documents.set(key,{...current,revision:current.revision+1});}
   };
   await assert.rejects(()=>gateway.send('gas','read'),{code:'failed-precondition'});
   assert.ok(requests.length>beforeReads);
   assert.equal(writes,beforeWrites);
   assert.equal(nativeCalls,beforeSheetsWrites);
   assert.equal(native.api.batches,0);
   assert.equal(attemptRecord(),undefined);
  });
 });
 await test(gatewayPrefix+'receipt lookup remains read-only if the book version changes mid-read',async()=>{
  await monthlyBookScenario('gateway-trace-drift',async ctx=>{
   const f=ctx.fixture,first=ctx.sheetsWriter({loseResponse:true,searchResult:()=>[]}),exercise=expenseGateway(first.writer);
   const seen=await exercise.send('crew','read'),operationId=crypto.randomUUID();
   assert.equal((await exercise.send('crew','complete',{operationId,expectedVersion:seen.reviewVersion,values:f.data.values})).reason,'readback_required');
   assert.equal(first.api.batches,1);
   assert.equal(attemptRecord().intent.id,operationId);
   ctx.reopen();
   const access=freshAccess();
   const next=ctx.sheetsWriter({searchResult(matches){access.state.file.version='2';return matches;}},undefined,access);
   const gateway=expenseGateway(next.writer,{mode:'preflight'}),beforeWrites=writes;
   await assert.rejects(()=>gateway.send('manual','trace',{operationId}),{code:'failed-precondition'});
   assert.equal(writes,beforeWrites);
   assert.equal(next.api.batches,0);
   assert.equal(attemptRecord().status,'pending');
   assert.equal((await gateway.send('manual','trace',{operationId})).status,'verified_pending');
   assert.equal(next.api.batches,0);
   assert.equal(writes,beforeWrites);
  });
 });
 await test(gatewayPrefix+'three separately authenticated actors use the same review and one native operation',async()=>{
  await monthlyBookScenario('gateway-concurrent-actors',async ctx=>{
   const f=ctx.fixture,entered=deferred(),resume=deferred();
   const native=ctx.sheetsWriter({async beforeBatch(){entered.release();await resume.wait;}});
   const gateway=expenseGateway(native.writer);
   const summaries=await Promise.all(['crew','gas','manual'].map(actor=>gateway.send(actor,'read')));
   assert.deepEqual(summaries.map(item=>Object.keys(item).sort().join(',')),Array(3).fill('currentValues,reviewVersion'));
   assert(summaries.every(item=>item.reviewVersion===summaries[0].reviewVersion));
   const data={expectedVersion:summaries[0].reviewVersion,values:f.data.values};
   let operationId;
   const first=gateway.send('crew','complete',data);
   try{
    await Promise.race([entered.wait,first.then(result=>assert.fail('first operation finished before sending: '+result.status))]);
    operationId=attemptRecord().intent.id;
    for(const actor of ['gas','manual']){
     assert.equal((await gateway.send(actor,'complete',data)).reason,'readback_required');
     assert.equal((await gateway.send(actor,'trace',{operationId})).status,'readback_required');
    }
    assert.equal(native.api.batches,1);
   }finally{resume.release();}
   assert.equal((await first).status,'completed');
   assert.equal(reviewRecord().completedBy,gateway.policy.principals.crew);
   for(const actor of ['gas','manual'])assert.equal((await gateway.send(actor,'trace',{operationId})).status,'completed');
   assert.equal(native.api.batches,1);
  });
 });
 await test(gatewayPrefix+'GAS and the manual operator can each start the approved synthetic operation',async()=>{
  for(const actor of ['gas','manual']) await monthlyBookScenario('gateway-authorized-'+actor,async ctx=>{
   const native=ctx.sheetsWriter(),gateway=expenseGateway(native.writer);
   const shown=await gateway.send(actor,'read');
   assert.equal((await gateway.send(actor,'complete',{expectedVersion:shown.reviewVersion,values:ctx.fixture.data.values})).status,'completed');
   assert.equal(reviewRecord().completedBy,gateway.policy.principals[actor]);
   assert.equal(native.api.batches,1);
  });
 });
 await test(gatewayPrefix+'unapproved environment or identities cannot reach the protected records',async()=>{
  await monthlyBookScenario('gateway-denied-auth',async ctx=>{
   const native=ctx.sheetsWriter();
   assert.throws(()=>expenseGateway(native.writer,{},{environment:'production'}),{code:'failed-precondition'});
   assert.throws(()=>expenseGateway(native.writer,{},{projectId:'elsewhere'}),{code:'failed-precondition'});
   for(const changeClaims of [
    c=>({...c,role:'admin'}),c=>({...c,expensePilotChannel:'crew'}),
    c=>({...c,uid:'imposter'}),c=>({...c,sub:'imposter'}),c=>({...c,companyId:'elsewhere'}),
    c=>({...c,expensePilotId:'elsewhere'}),c=>({...c,iss:'https://invalid.example'}),c=>({...c,aud:'elsewhere'}),
    c=>({...c,exp:Math.floor(Clock.now()/1000)}),c=>({...c,firebase:{tenant:'elsewhere'}}),
   ]){
    const g=expenseGateway(native.writer,{},{changeClaims}),reads=documentReads.length;
    await assert.rejects(()=>g.send('gas','read'),{code:'permission-denied'});
    assert.equal(documentReads.length,reads);
   }
   const g=expenseGateway(native.writer);
   await assert.rejects(()=>g.execute('Bearer invalid',{}),{code:'permission-denied'});
   await assert.rejects(()=>g.send('someone','read'),{code:'permission-denied'});
   await assert.rejects(()=>g.send('crew','read',{actorUid:'fake'}),{name:'ZodError'});
   await assert.rejects(()=>g.send('crew','read',{jobId:'other-job'}),{code:'permission-denied'});
   assert.equal(native.api.searches,0);
   assert.equal(native.api.batches,0);
  });
 });
 await test(gatewayPrefix+'different staff, assignment revision or workbook is held before Sheets reads',async()=>{
  await monthlyBookScenario('gateway-denied-case',async ctx=>{
   const native=ctx.sheetsWriter();
   for(const patch of [
    {staffId:'other-staff'},{dateKey:'2026-12-07'},{jobRevision:1},
    {caseId:'LKCASE_00000000-0000-0000-0000-000000000099'},{spreadsheetId:'other-book'},{sheetId:99},
   ]){
    const count=requests.length,g=expenseGateway(native.writer,patch);
    await assert.rejects(()=>g.send('crew','read'),{code:'failed-precondition'});
    assert.equal(requests.length,count);
   }
   const expired=expenseGateway(native.writer,{validUntilMs:Clock.now()-1});
   await assert.rejects(()=>expired.send('manual','read'),{code:'failed-precondition'});
   assert.equal(native.api.batches,0);
  });
 });
 await test(gatewayPrefix+'a revoked caller is refused again between reservation and dispatch',async()=>{
  await monthlyBookScenario('gateway-revoked-before-dispatch',async ctx=>{
   const native=ctx.sheetsWriter(),wrapped={...native.writer,async stageReservation(tx,intent){
    await native.writer.stageReservation(tx,intent);gateway.revoked.add('gas');
   }};
   const gateway=expenseGateway(wrapped),shown=await gateway.send('gas','read');
   assert.equal((await gateway.send('gas','complete',{expectedVersion:shown.reviewVersion,values:ctx.fixture.data.values})).reason,'readback_required');
   assert.equal(native.api.batches,0);
   assert.equal(documents.get(expenseFenceOperation(attemptRecord().intent.id)).phase,'reserved');
   await assert.rejects(()=>gateway.send('gas','trace',{operationId:attemptRecord().intent.id}),{code:'permission-denied'});
   assert.equal((await gateway.send('manual','trace',{operationId:attemptRecord().intent.id})).status,'readback_required');
  });
 });
 for(const condition of ["revocation","operational-stop","assignment-change","approval-expiry","sheet-write-pause","external-read-only"])
 await test(gatewayPrefix+"records a refused last-row comparison without dispatch after "+condition,async()=>{
  await monthlyBookScenario("gateway-pre-batch-"+condition,async ctx=>{
   const f=ctx.fixture,expiry=Clock.now()+15_000;
   let comparisons=0;
   const native=ctx.sheetsWriter({},async intent=>{
    const job=documents.get("jobs/"+jobId);
    const live=await load("case-list-external-transfer").readExternalCaseListExpenses(COMPANY,jobId,job);
    comparisons++;assert.equal(intent.sheetRef.currentRow,live.sheetRef.currentRow);
    if(condition==="revocation")gateway.revoked.add("gas");
    if(condition==="operational-stop")operational=false;
    if(condition==="assignment-change")job.revision++;
    if(condition==="approval-expiry")clockOffset+=20_000;
    if(condition==="sheet-write-pause")runtimeEnvironment.LKC_SHEET_WRITE_MODE="paused";
    if(condition==="external-read-only")runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE="read-only";
    return live;
   });
   const gateway=expenseGateway(native.writer,{validUntilMs:expiry}),shown=await gateway.send("gas","read");
   const cellBefore=copy(ctx.table.get(3)[36]),operationId=crypto.randomUUID();
   try {
    const result=await gateway.send("gas","complete",{operationId,expectedVersion:shown.reviewVersion,values:f.data.values});
    assert.equal(comparisons,1);
    assert.equal(native.api.batches,0,"the request must be held before contacting the Sheets write port");
    assert.equal(result.operationId,operationId);
    assert.equal(attemptRecord().intent.id,operationId);
    const immediate=condition==="sheet-write-pause";
    assert.equal(result.reason,immediate?"writer_rejected":"readback_required");
    assert.equal(attemptRecord().status,immediate?"rejected":"pending");
    assert.equal(reviewRecord().status,immediate?"draft":"confirmation_pending");
    assert.equal(documents.get(expenseFenceOperation(operationId)).phase,immediate?"verified":"unissued_rejected");
    assert.deepEqual(ctx.table.get(3)[36],cellBefore);
    const reopened=ctx.sheetsWriter();
    const receipt=await reopened.writer.readReceipt(operationId);
    assert.equal(receipt?.intentId,operationId);
    assert.equal(receipt?.intentHash,attemptRecord().intentHash);
    assert.equal(receipt?.outcome,"rejected");
    assert.equal(reopened.api.searches,0,"a known no-send receipt comes from the private fence record");
    assert.equal(ctx.readReceipt(operationId),null);
    if(condition==="assignment-change"||condition==="approval-expiry"){
     await assert.rejects(()=>gateway.send("manual","reconcile",{operationId}),{code:"failed-precondition"});
     assert.equal(attemptRecord().status,"pending");
     assert.equal(documents.get(expenseFencePath(BOOK)).state,"held");
     return;
    }
    if(condition==="revocation")await assert.rejects(()=>gateway.send("gas","trace",{operationId}),{code:"permission-denied"});
    if(condition==="operational-stop"){
     await assert.rejects(()=>gateway.send("manual","reconcile",{operationId}),{code:"failed-precondition"});
     operational=true;
    }
    if(condition==="external-read-only"){
     assert.equal((await gateway.send("manual","trace",{operationId})).status,"readback_required");
     runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE="enabled";
    }
    const recovery=expenseGateway(reopened.writer,{validUntilMs:expiry});
    const beforeTrace=writes;
    assert.deepEqual(JSON.parse(JSON.stringify(await recovery.send("manual","trace",{operationId}))),{operationId,status:"rejected"});
    assert.equal(writes,beforeTrace);
    if(!immediate){
     const other=await recovery.send("manual","reconcile",{operationId});
     assert.equal(other.reason,"readback_required");
     assert.equal(documents.get(expenseFencePath(BOOK)).state,"held");
    }
    // The initial actor can reconcile again after the simulated authority is restored.
    const verified=await recovery.send("gas","reconcile",{operationId});
    assert.equal(verified.reason,"writer_rejected");assert.equal(verified.operationId,operationId);
    assert.equal(attemptRecord().status,"rejected");
    assert.equal(reviewRecord().status,"draft");
    assert.equal(documents.get(expenseFencePath(BOOK)).state,"idle");
    assert.equal(documents.get(expenseFenceOperation(operationId)).phase,"verified");
    assert.equal(reopened.api.batches,0);assert.equal(reopened.api.searches,0);
    assertPrivateExpenseWrites(f,operationId);
   }finally{operational=true;clockOffset=0;runtimeEnvironment.LKC_CASE_LIST_EXTERNAL_MODE="enabled";runtimeEnvironment.LKC_SHEET_WRITE_MODE="active";}
  });
 });
 for(const condition of ['new-editor','moved-row','deadline-during-acl']){
  await test(gatewayPrefix+'final book recheck / '+condition,async()=>{
   await monthlyBookScenario('final-book-recheck-'+condition,async ctx=>{
    const expiry=Clock.now()+20_000;
    let compared=false,authorized=false;
    const before=ctx.table.get(3),near=ctx.table.get(2);
    const native=ctx.sheetsWriter({},async()=>{
     const job=documents.get('jobs/'+jobId);
     const live=await load('case-list-external-transfer').readExternalCaseListExpenses(COMPANY,jobId,job);
     compared=true;
     return live;
    });
    const {state}=native.pilot;
    const gateway=expenseGateway(native.writer,{validUntilMs:expiry},{changeClaims(claims){
     if(!compared||authorized)return claims;
     authorized=true;
     if(condition==='new-editor'){
      state.pages.get('second').permissions.push({id:'SYNTHETIC_LATE_EDITOR',type:'user',role:'writer'});
     }
     if(condition==='moved-row'){
      ctx.move('manual',3,4);
      state.file.version='2';
     }
     if(condition==='deadline-during-acl'){
      state.onList=()=>{clockOffset+=30_000;state.onList=null;};
     }
     return claims;
    }});
    const shown=await gateway.send('gas','read');
    const operationId={
     'new-editor':'21a01e53-619e-46a3-b263-8b6243eff325',
     'moved-row':'e229362e-c2ab-47ad-b46e-3578868c5ca9',
     'deadline-during-acl':'0727340a-e4c1-414a-942d-08cbd067bb88',
    }[condition];
    try{
     const result=await gateway.send('gas','complete',{operationId,expectedVersion:shown.reviewVersion,values:ctx.fixture.data.values});
     assert.ok(compared&&authorized);
     assert.equal(native.api.batches,0,'no amount or receipt request may be dispatched');
     assert.equal(result.operationId,operationId);
     assert.equal(result.reason,condition==='deadline-during-acl'?'readback_required':'writer_rejected');
     const op=documents.get(expenseFenceOperation(operationId));
     assert.equal(op.phase,condition==='deadline-during-acl'?'unissued_rejected':'verified');
     assert.equal(op.receipt.outcome,'rejected');
     assert.equal(op.receipt.intentId,operationId);
     assert.equal(attemptRecord().intent.id,operationId);
     assert.notEqual(reviewRecord().status,'completed');
     ctx.reopen();
     assert.deepEqual(ctx.table.get(2),near);
     assert.deepEqual(ctx.table.get(condition==='moved-row'?4:3),before);
     if(condition==='moved-row')assert.deepEqual(ctx.table.get(3)[36],near[36]);
     assertPrivateExpenseWrites(ctx.fixture,operationId);
    }finally{clockOffset=0;}
   });
  });
 }

 await test(gatewayPrefix+'a historical operation with the same job but different approved scope is unobservable',async()=>{
  await monthlyBookScenario('gateway-denied-receipt-scope',async ctx=>{
   const native=ctx.sheetsWriter(),gateway=expenseGateway(native.writer),shown=await gateway.send('crew','read');
   assert.equal((await gateway.send('crew','complete',{expectedVersion:shown.reviewVersion,values:ctx.fixture.data.values})).status,'completed');
   const existing=attemptRecord(),operationId='faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
   const off={...existing.intent,id:operationId,staffId:'other-synthetic-staff'},intentHash=shaValue(off);
   documents.set('externalExpenseCompletionAttempts/'+jobId+'/history/'+operationId,{...existing,intent:off,intentHash});
   const beforeReads=native.api.searches;
   await assert.rejects(()=>gateway.send('manual','trace',{operationId}),{code:'not-found'});
   assert.equal(native.api.searches,beforeReads);
  });
 });
 function httpExpenseFixture(gateway,actor='gas',handle=load('case-list-expense-pilot-http').createExpensePilotHttpHandler(gateway.execute)){
  const authorization='Bearer '+actor+'.synthetic.token';
  const request={method:'POST',headers:{authorization,'content-type':'application/json'},
   rawHeaders:['Authorization',authorization,'Content-Type','application/json'],
   rawBody:Buffer.from(JSON.stringify({pilotId:gateway.policy.pilotId,jobId,action:'read'}))};
  return async patch=>{
   const headers={};
   const captured={headers,code:0,body:null};
   const response={
    set(name,value){headers[name]=value;return this;},
    status(code){captured.code=code;return this;},
    json(body){captured.body=copy(body);return this;},
   };
   await handle({...request,...patch},response);
   return captured;
  };
 }
 await test(gatewayPrefix+'private HTTP transport rejects malformed or oversize requests before authorization',async()=>{
  await monthlyBookScenario('gateway-http-refused',async ctx=>{
   const g=expenseGateway(ctx.sheetsWriter().writer),send=httpExpenseFixture(g);
   for(const [patch,status] of [
    [{method:'GET'},405],
    [{rawHeaders:['Authorization','Bearer gas.synthetic.token','Authorization','Bearer manual.synthetic.token']},401],
    [{rawHeaders:['Authorization','Bearer manual.synthetic.token']},401],
    [{headers:{authorization:'Bearer gas.synthetic.token','content-type':'text/plain'}},415],
    [{rawBody:Buffer.alloc(16_385)},413],[{rawBody:Buffer.from('{"bad"')},400],
   ]){
    const result=await send(patch);
    assert.equal(result.code,status);assert.equal(result.body.ok,false);
    assert.equal(result.headers['Cache-Control'],'no-store');
   }
   assert.equal(g.reads.length,0);
  });
 });
 await test(gatewayPrefix+'the HTTP entry can confirm with the GAS principal and preserve private response bounds',async()=>{
  await monthlyBookScenario('gateway-http-gas',async ctx=>{
   const native=ctx.sheetsWriter(),g=expenseGateway(native.writer),send=httpExpenseFixture(g);
   const seen=await send();
   assert.equal(seen.code,200);assert.equal(seen.body.ok,true);
   const {reviewVersion}=seen.body.result;
   assert.deepEqual(Object.keys(seen.body.result).sort(),['currentValues','reviewVersion']);
   const payload={action:'complete',pilotId:g.policy.pilotId,jobId,operationId:crypto.randomUUID(),expectedVersion:reviewVersion,values:ctx.fixture.data.values};
   const completed=await send({rawBody:Buffer.from(JSON.stringify(payload))});
   assert.equal(completed.code,200);assert.deepEqual(completed.body,{ok:true,result:{status:'completed',operationId:payload.operationId}});
   assert.equal(native.api.batches,1);
   g.revoked.add('gas');
   const refused=await send();
   assert.equal(refused.code,403);assert.deepEqual(refused.body,{ok:false,code:'permission-denied'});
   assert.equal(native.api.batches,1);
  });
 });
 const gasRuntime=()=>require('./one-case-fixtures/expense-pilot-gas.cjs').gasPilotFixture();
 const gasValues={transportation:850,purchase8:0,purchase10:null,netPrintCost:50,postageCost:90};
 const gasToken='gas.synthetic.token';
 const gasPolicy=(gateway,patch={})=>({
  enabled:true,mode:gateway?.policy.mode??'exercise',region:'asia-northeast1',projectId:'synthetic-crew-pilot',
  pilotId:gateway?.policy.pilotId??'synthetic-one-case',jobId:gateway?.policy.jobId??jobId??'synthetic-local-job',
  approvedUrl:'https://asia-northeast1-synthetic-crew-pilot.cloudfunctions.net/crewExpensePilot',...patch,
 });
 await test(gasPrefix+'unapproved URL and configuration cannot receive credentials',async()=>{
  const f=gasRuntime();
  for(const patch of [{enabled:false},{approvedUrl:'https://example.invalid'},{projectId:undefined},{region:'a/b'},{approvedUrl:gasPolicy().approvedUrl+'?next=redirect'}]){
   assert.throws(()=>f.create(gasPolicy(null,patch)),/PILOT_(?:URL_UNAPPROVED|CONFIGURATION_INVALID)/);
  }
  assert.equal(f.state.requests.length,0);
 });
 await test(gasPrefix+'the read-only Apps Script configuration sends no confirmation and saves no ID',async()=>{
  const f=gasRuntime(),policy=gasPolicy(null,{mode:'preflight'}),client=f.create(policy);
  assert.throws(()=>f.create({...policy,mode:undefined}),/PILOT_CONFIGURATION_INVALID/);
  const prepared=f.create({...policy,mode:'exercise'}).prepare('a'.repeat(64),gasValues);
  f.state.reply=()=>({code:200,body:{ok:true,result:{reviewVersion:'a'.repeat(64),currentValues:gasValues}}});
  assert.equal(client.read(gasToken).status,'ready');
  assert.throws(()=>client.prepare('a'.repeat(64),gasValues),/PILOT_PREFLIGHT_ONLY/);
  assert.throws(()=>client.complete(gasToken,prepared),/PILOT_PREFLIGHT_ONLY/);
  assert.throws(()=>client.reconcile(gasToken),/PILOT_PREFLIGHT_ONLY/);
  assert.deepEqual(f.state.requests.map(r=>r.payload.action),['read']);
  assert.equal(f.state.properties.size,0);
 });
 await test(gasPrefix+'the Apps Script request persists one ID and never stores token or amounts',async()=>{
  const f=gasRuntime(),client=f.create(gasPolicy());
  const confirmation=client.prepare('a'.repeat(64),gasValues,'合成メモ');
  f.state.reply=request=>{
   assert.equal(request.method,'post');assert.equal(request.type,'application/json');
   assert.equal(request.authorization,'Bearer '+gasToken);
   assert.deepEqual([...f.state.properties.values()],[confirmation.operationId]);
   assert.equal(request.payload.operationId,confirmation.operationId);
   assert.equal(request.payload.values.purchase8,0);assert.equal(request.payload.values.purchase10,null);
   return null;
  };
  assert.deepEqual(copy(client.complete(gasToken,confirmation)),{status:'readback_required',operationId:confirmation.operationId});
  const restarted=f.create(gasPolicy());
  const alternate=restarted.prepare('a'.repeat(64),gasValues);
  assert.deepEqual(copy(restarted.complete(gasToken,alternate)),{status:'readback_required',operationId:confirmation.operationId});
  assert.equal(f.state.requests.length,1);
  assert.equal(f.state.locksReleased,2);
 });
 await test(gasPrefix+'write is refused if the operation ID cannot be saved and verified',async()=>{
  for(const fault of ['failStore','discardStore']){
   const f=gasRuntime();f.state[fault]=true;
   const client=f.create(gasPolicy()),confirmation=client.prepare('a'.repeat(64),gasValues);
   assert.throws(()=>client.complete(gasToken,confirmation),/properties failure|PILOT_OPERATION_RECORD_UNVERIFIED/);
   assert.equal(f.state.requests.length,0);assert.equal(f.state.locksReleased,1);
  }
 });
 await test(gasPrefix+'overlapping calls never return an unsaved operation ID',async()=>{
  const f=gasRuntime(),client=f.create(gasPolicy()),confirmation=client.prepare('a'.repeat(64),gasValues);
  f.state.busy=true;
  assert.deepEqual(copy(client.complete(gasToken,confirmation)),{status:'submission_busy'});
  assert.equal(client.trace(gasToken).status,'not_started');
  assert.equal(f.state.properties.size,0);assert.equal(f.state.requests.length,0);
  f.state.busy=false;
  assert.equal(client.complete(gasToken,confirmation).operationId,confirmation.operationId);
  const alternate=client.prepare('a'.repeat(64),gasValues);
  assert.equal(client.complete(gasToken,alternate).operationId,confirmation.operationId);
  assert.equal(f.state.requests.length,1);
 });
 await test(gasPrefix+'another eligible environment cannot reuse the saved operation or the prepared confirmation',async()=>{
  const f=gasRuntime(),first=f.create(gasPolicy()),confirmation=first.prepare('a'.repeat(64),gasValues);
  assert.equal(first.complete(gasToken,confirmation).operationId,confirmation.operationId);
  const second=f.create(gasPolicy(null,{projectId:'synthetic-crew-pilot-b',
   approvedUrl:'https://asia-northeast1-synthetic-crew-pilot-b.cloudfunctions.net/crewExpensePilot'}));
  assert.equal(second.trace(gasToken).status,'not_started');
  assert.throws(()=>second.complete(gasToken,confirmation),/PILOT_CONFIRMATION_INVALID/);
  assert.equal(f.state.requests.length,1);
 });
 await test(gasPrefix+'redirects, mismatched acknowledgements and missing operation are not retried',async()=>{
  const f=gasRuntime(),client=f.create(gasPolicy()),confirmation=client.prepare('b'.repeat(64),gasValues);
  assert.equal(client.trace(gasToken).status,'not_started');assert.equal(f.state.requests.length,0);
  f.state.reply=()=>({code:307,body:{ok:true,result:{status:'completed'}}});
  assert.equal(client.complete(gasToken,confirmation).status,'readback_required');
  f.state.reply=()=>({code:200,body:{ok:true,result:{status:'completed',operationId:crypto.randomUUID()}}});
  assert.equal(client.trace(gasToken).status,'readback_required');
  assert.deepEqual(f.state.requests.map(r=>r.payload.action),['complete','trace']);
 });
 await test(gasPrefix+'the lost first HTTP reply is recovered by ID with no second confirmation',async()=>{
  await monthlyBookScenario('gas-lost-first-reply',async ctx=>{
   const f=gasRuntime(),native=ctx.sheetsWriter({loseResponse:true,searchResult:()=>[]});
   const first=expenseGateway(native.writer),client=f.create(gasPolicy(first)),http=httpExpenseFixture(first);
   const seen=await first.send('gas','read');
   const command=client.prepare(seen.reviewVersion,ctx.fixture.data.values);
   assert.equal(client.complete(gasToken,command).status,'readback_required');
   let payload=f.state.requests[0].payload;
   const original=await http({rawBody:Buffer.from(JSON.stringify(payload))});
   assert.equal(original.body.result.reason,'readback_required');
   assert.equal(attemptRecord().intent.id,command.operationId);
   assert.equal(native.api.batches,1);
   ctx.reopen();
   const recovered=ctx.sheetsWriter(),next=expenseGateway(recovered.writer);
   const restarted=f.create(gasPolicy(next)),restore=httpExpenseFixture(next);
   assert.equal(restarted.trace(gasToken).status,'readback_required');
   payload=f.state.requests.at(-1).payload;
   assert.deepEqual(Object.keys(payload).sort(),['action','jobId','operationId','pilotId']);
   assert.equal((await restore({rawBody:Buffer.from(JSON.stringify(payload))})).body.result.status,'verified_pending');
   assert.equal(reviewRecord().status,'confirmation_pending');
   assert.equal((await next.send('manual','reconcile',{operationId:command.operationId})).reason,'readback_required');
   assert.equal(restarted.reconcile(gasToken).status,'readback_required');
   payload=f.state.requests.at(-1).payload;
   assert.deepEqual(f.state.requests.map(r=>r.payload.action),['complete','trace','reconcile']);
   assert.deepEqual(Object.keys(payload).sort(),['action','jobId','operationId','pilotId']);
   assert.equal((await restore({rawBody:Buffer.from(JSON.stringify(payload))})).body.result.status,'completed');
   assert.equal(recovered.api.batches,0);
   assert.equal(reviewRecord().completedBy,next.policy.principals.gas);
  });
 });
 await test(gasPrefix+'a new ID cannot borrow an existing result and reconciliation cannot start one',async()=>{
  await monthlyBookScenario('gas-no-borrowed-result',async ctx=>{
   const native=ctx.sheetsWriter(),g=expenseGateway(native.writer),operationId=crypto.randomUUID();
   await assert.rejects(()=>g.send('gas','reconcile',{operationId}),{code:'not-found'});
   assert.equal(attemptRecord(),undefined);assert.equal(native.api.batches,0);
   const shown=await g.send('gas','read'),command={operationId,expectedVersion:shown.reviewVersion,values:ctx.fixture.data.values};
   assert.equal((await g.send('gas','complete',command)).status,'completed');
   const other=crypto.randomUUID();
   assert.equal((await g.send('gas','complete',{...command,operationId:other})).reason,'readback_required');
   assert.equal(attemptRecord().intent.id,operationId);
   assert.equal(native.api.batches,1);
  });
 });

 let journeyLogin;
 async function signInOneCaseStaff(){
  const uid=staffAuth.auth.uid;
  documents.set('emailIndex/'+load('utils').emailHash(loginJourneyEmail),{companyId:COMPANY,staffId:STAFF,active:true});
  documents.get('staffProfiles/'+STAFF).emails=[loginJourneyEmail];
  assert.equal(documents.has('authIdentities/'+uid),false);
  const authTime=Math.floor(Clock.now()/1000);
  const result=await load('auth').bootstrapSession({auth:{uid,token:{auth_time:authTime}},data:{}});
  assert.deepEqual(copy(result),{role:'staff',companyId:COMPANY,staffId:STAFF,refreshToken:true});
  assert.deepEqual(copy(journeyClaims),[{uid,claims:{role:'staff',companyId:COMPANY,staffId:STAFF}}]);
  assert.equal(documents.get('authIdentities/'+uid).staffId,STAFF);
  assert.equal(documents.get('authIdentities/'+uid).active,true);
  staffAuth.auth.token={...journeyClaims[0].claims,auth_time:authTime};
  return {uid,companyId:result.companyId,staffId:result.staffId};
 }
 function verifyCurrentRoute(job){
  const ts=clientRequire('typescript'),React=clientRequire('react');
  const {renderToStaticMarkup}=clientRequire('react-dom/server');
  const routeSource=fs.readFileSync(path.join(repoRoot,'apps/staff/src/ShiftRoutePanel.tsx'),'utf8');
  const {outputText}=ts.transpileModule(routeSource,{compilerOptions:{
   module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,
  }});
  const module={exports:{}};
  vm.runInNewContext(outputText,{module,exports:module.exports,URLSearchParams,require:name=>{
   if(name==='./firebase')return {db:undefined};
   if(name==='firebase/firestore')return {doc:assert.fail,onSnapshot:assert.fail};
   if(name==='./job-list')return list;
   assert.ok(['react','react/jsx-runtime'].includes(name),name);
   return clientRequire(name);
  }});
  const {observeShiftRoute,ShiftRouteDetails}=module.exports;
  function render(staffId,fromCache){
   let state;
   const stop=observeShiftRoute({jobId,companyId:journeyLogin.companyId,staffId},(id,receive)=>{
    assert.equal(id,jobId);
    receive({job:{...job,id:jobId},fromCache,hasPendingWrites:false});
    return ()=>{};
   },{online:()=>true,listen:()=>()=>{}},value=>{state=value;});
   try{return renderToStaticMarkup(React.createElement(ShiftRouteDetails,{current:state,copyAddress:assert.fail,copying:false}));}
   finally{stop();}
  }
  const markup=render(journeyLogin.staffId,false);
  const urls=[...markup.matchAll(/\shref="([^"]+)"/gu)].map(([,href])=>new URL(href.replaceAll('&amp;','&')));
  assert.deepEqual(urls.map(url=>url.origin),['https://www.google.com','https://www.google.com']);
  const destination=job.storeName+' '+job.storeAddress;
  assert.equal(urls[0].searchParams.get('query'),destination);
  assert.equal(urls[1].searchParams.get('destination'),destination);
  assert.equal(urls[1].searchParams.get('travelmode'),'transit');
  assert.ok(markup.includes(job.storeNearestStation));
  assert.doesNotMatch(render('other_synthetic_staff',false),/href="/);
  assert.doesNotMatch(render(journeyLogin.staffId,true),/href="/);
  return {exactStoreAndStation:true, links:urls.length, otherStaffDenied:true, cachedRouteHeld:true};
 }
 function atReminderWindow(fn){
  const deadline=load('notification-time').submissionDeadline(DATE);
  assert.ok(deadline);
  const previousTime=journeyTime,previousMode=runtimeEnvironment.LKC_NOTIFICATION_DELIVERY_MODE;
  journeyTime=deadline.toMillis()-15*60000;
  runtimeEnvironment.LKC_NOTIFICATION_DELIVERY_MODE='active';
  return Promise.resolve().then(fn).finally(()=>{
   journeyTime=previousTime;
   if(previousMode===undefined)delete runtimeEnvironment.LKC_NOTIFICATION_DELIVERY_MODE;
   else runtimeEnvironment.LKC_NOTIFICATION_DELIVERY_MODE=previousMode;
  });
 }
 async function oneCaseTaskKinds(){
  const {tasks}=await load('staff-tasks').getMyTasks(staffAuth);
  return tasks.filter(task=>task.jobId===jobId).map(task=>task.kind);
 }
 async function triggerOneCaseReminder(path){
  await load('notifications').processNotificationQueue({data:await new Doc(path).get()});
 }
 async function queueOneCaseReminders(boundToken){
  return atReminderWindow(async()=>{
   const kinds=await oneCaseTaskKinds();
   assert.ok(kinds.includes('report')&&kinds.includes('sales_floor'));
   const scheduler=load('reminder-scheduler');
   documents.set('notificationSettings/'+COMPANY,{enabled:true,importantAnnouncementHour:2});
   const device={companyId:COMPANY,staffId:STAFF,uid:journeyLogin.uid,role:'staff',active:true,token:boundToken??'synthetic-one-case-device'};
   if(!boundToken)documents.set('pushTokens/one-case-device',device);
   documents.set('pushTokens/decoy-other-staff',{...device,staffId:'other_synthetic_staff',uid:'another-uid',token:'synthetic-decoy-staff'});
   documents.set('pushTokens/decoy-other-company',{...device,companyId:'another-company',token:'synthetic-decoy-company'});
   await scheduler.scheduleOperationalReminders();
   await scheduler.scheduleOperationalReminders();
   const queued=[...documents.entries()].filter(([path,record])=>path.startsWith('notificationQueue/')&&
    record.category==='submission_reminder'&&record.reminderContext?.jobId===jobId);
   assert.equal(queued.length,2);
   const byKind=new Map();
   for(const [path,record] of queued){
    assert.equal(record.companyId,journeyLogin.companyId);
    assert.equal(record.targetStaffId,journeyLogin.staffId);
    assert.equal(record.reminderContext.staffId,journeyLogin.staffId);
    assert.equal(record.reminderContext.dateKey,DATE);
    assert.equal(record.route,'/submissions/'+jobId+'/'+record.reminderContext.kind);
    byKind.set(record.reminderContext.kind,path);
   }
   const sale=byKind.get('sales-floor'),report=byKind.get('report');
   assert.ok(sale&&report);
   await triggerOneCaseReminder(sale);
   await triggerOneCaseReminder(sale);
   assert.equal(journeySends.length,1);
   assert.deepEqual(journeySends[0].tokens,[device.token]);
   assert.equal(journeySends[0].data.route,'/submissions/'+jobId+'/sales-floor');
   assert.equal(documents.get(report).status,'queued');
   return report;
  });
 }
 async function verifyCompletedReminders(report){
  return atReminderWindow(async()=>{
   const kinds=await oneCaseTaskKinds();
   assert.ok(!kinds.includes('report')&&!kinds.includes('sales_floor')&&!kinds.includes('resubmission'));
   await triggerOneCaseReminder(report);
   assert.equal(documents.get(report).status,'superseded');
   assert.equal(journeySends.length,1);
   return {queuedBeforeSubmission:2,syntheticRecipientCount:1,duplicateDelivery:0,staleReportReminderSuppressed:true,
    submissionTasksCleared:true,realPushSent:false};
  });
 }

 let oneCaseResult;

 async function switchOneCaseDevice(){
  const legacy=copy(staffAuth);
  const devices=load('devices'), login=load('login-links');
  const target={staffId:STAFF};
  const oldDevice=await devices.registerDeviceSession({...legacy,data:{deviceId:'synthetic-legacy-browser'}});
  const oldToken='synthetic-token-on-the-legacy-device';
  await load('push-tokens').registerPushToken({...legacy,data:{token:oldToken,deviceSessionId:oldDevice.sessionId}});
  const queueBefore=[...documents.keys()].filter(key=>key.startsWith('sheetSyncQueue/')).sort();
  const lookup={data:{applicationReceiptLookup:[{jobId,requestId:'synthetic_request_001'}]}};
  const requireReceipt=async actor=>assert.deepEqual(JSON.parse(JSON.stringify(await load('staff-tasks').getMyTasks({...actor,...lookup}))),{
   receipts:[{jobId,requestId:'synthetic_request_001',status:'accepted'}],
  });
  await requireReceipt(legacy);
  const actor={auth:{...owner.auth,token:{...owner.auth.token,auth_time:Math.floor(Clock.now()/1000)}}};
  const invoke=data=>devices.adminStaffDeviceAuthentication({...actor,data});
  const preview=await invoke({action:'preview',...target});
  assert.equal(preview.status,'eligible');
  assert.equal(preview.mode,'existing_login');
  assert.equal(preview.email,loginJourneyEmail);
  const changed=await invoke({action:'enable',...target,operationId:preview.operationId});
  assert.equal(changed.status,'enabled');
  assert.equal((await invoke({action:'preview',...target})).operationId,preview.operationId);
  await assert.rejects(()=>load('staff-tasks').getMyTasks({...legacy,...lookup}),{code:'permission-denied'});
  await assert.rejects(()=>load('push-tokens').getPushStatus({...legacy,data:{}}),{code:'permission-denied'});

  const previousTime=journeyTime;
  journeyTime=Clock.now()+1000;
  try {
   const browser='synthetic-new-browser';
   const asked=await login.requestStaffLoginLink({data:{email:loginJourneyEmail}});
   assert.equal(asked.accepted,true);
   assert.equal(journeyMail.length,1);
   assert.equal(journeyMail[0].to,loginJourneyEmail);
   const code=journeyMail[0].text.split('\n').find(line=>/^\d{6}$/.test(line));
   assert.ok(code);
   assert.equal(journeyMail[0].text.includes('確認コードを入力'),true);
   const response=await login.requestStaffLoginLink({data:{email:loginJourneyEmail,code,deviceId:browser}});
   assert.deepEqual(Object.keys(response),['customToken']);
   assert.equal(response.customToken,'synthetic.device.jwt');
   assert.equal(issuedDeviceClaims.length,1);
   const grant=issuedDeviceClaims[0];
   assert.equal(grant.uid,journeyLogin.uid);
   const current={auth:{uid:grant.uid,token:{...grant.claims,auth_time:Math.floor(Clock.now()/1000)}}};
   const bootstrapped=await load('auth').bootstrapSession({...current,data:{}});
   assert.deepEqual(copy(bootstrapped),{role:'staff',companyId:COMPANY,staffId:STAFF,refreshToken:false});
   await requireReceipt(current);
   assert.deepEqual([...documents.keys()].filter(key=>key.startsWith('sheetSyncQueue/')).sort(),queueBefore);
   const registered=await devices.registerDeviceSession({...current,data:{deviceId:browser}});
   assert.equal(registered.sessionId,grant.claims.crewDeviceSession);
   const newToken='synthetic-token-on-the-new-bound-device';
   await load('push-tokens').registerPushToken({...current,data:{token:newToken,deviceSessionId:registered.sessionId}});
   assert.equal(documents.get('pushTokens/'+sha(oldToken)).active,true);
   staffAuth.auth.token=current.auth.token;
   return {current:current.auth,operationId:preview.operationId,newToken,oldToken,legacy};
  } finally { journeyTime=previousTime; }
 }

 if(testPrefix===migrationPrefix)await test(migrationPrefix+' same application and pending report resume on a verified device',async()=>{
  let handover,submissions,reminderResult,route;
  await monthlyBookScenario('switch-staff-device-in-flight',async ({fixture,table})=>{
   const confirmationBefore=writes,projectionBefore=nativeCalls;
   const expense=await fixture.read();
   assert.equal(expense.job.id,jobId);
   assert.equal(expense.currentValues.transportation,700);
   assert.equal(expense.currentValues.purchase8,null);
   assert.equal(expense.currentValues.purchase10,0);
   assert.ok(expense.writeBlockedReason);
   await assert.rejects(()=>admin.completeExpenseReview({...owner,data:fixture.data}),
    error=>error.details?.reason==='case_list_private_expense_completion_held');
   assert.equal(nativeCalls,projectionBefore);
   assert.equal(attemptRecord(),undefined);
   assert.equal(cellValue(table.get(3)[36]),700);
   assert.equal(writes,confirmationBefore);
   assert.equal(documents.get('resubmissionRequests/'+submissions.request.requestId).status,'completed');
   oneCaseResult={caseId:CASE,jobId,staffId:STAFF,sameUid:true,operationId:handover.operationId,
    applicationReceiptUnchanged:true,oldSessionDenied:true,oldUploadPathIgnored:true,
    pendingReportId:submissions.report.submissionId,salesPhotoId:submissions.sales.submissionId,
    replacementId:submissions.replacement.submissionId,originalAndNewDriveCopies:3,reminders:reminderResult,route,
    expenseReadback:{amount:700,blankPreserved:true,zeroPreserved:true,amountWrites:0,holdKept:true}};
  },async()=>{
   documents.set('companies/'+COMPANY+'/settings/drive',{rootFolderId:'synthetic-root'});
   const assigned=documents.get('jobs/'+jobId);
   assert.equal(assigned.assignedStaffId,STAFF);
   const location=await load('job-management').adminEditCaseListLocation({...owner,data:{
    jobId,revision:assigned.revision,locationRevision:0,fields:{storeAddress:'架空県試験町1丁目4番地',storeNearestStation:'架空試験駅'},
   }});
   assert.equal(location.locationRevision,1);
   const {runAcceptedSubmissionJourney}=await import('./test-submission-lifecycle.mjs');
   let pendingReminder;
   submissions=await runAcceptedSubmissionJourney(documents,jobId,staffAuth.auth,owner.auth,async()=>{
    handover=await switchOneCaseDevice();
    route=verifyCurrentRoute(documents.get('jobs/'+jobId));
    pendingReminder=await queueOneCaseReminders(handover.newToken);
    assert.equal(journeySends.some(message=>message.tokens.includes(handover.oldToken)),false);
    return handover.current;
   });
   reminderResult=await verifyCompletedReminders(pendingReminder);
  });
 });

 await test(integrationPrefix+' submission history survives expense draft, lost reply, trace and private confirmation',async()=>{
  let submissions;
  let locationChange;
  let reminderResult;
  let staffViews;
  await monthlyBookScenario('application-submission-expense',async ctx=>{
   const request=ctx.fixture;
   const shown=await request.read();
   const afterLocation=documents.get('jobs/'+jobId);
   locationChange.expenseReadbackVerified=true;
   request.jobBefore=copy(afterLocation);
   request.beforeWrites=documentWrites.length;
   assert.equal(shown.job.id,jobId);
   assert.equal(shown.job.assignedStaffName,NAME);
   assert.equal(shown.currentValues.transportation,700);
   assert.equal(shown.currentValues.purchase8,null);
   assert.equal(shown.currentValues.purchase10,0);
   assert.equal(shown.draftAllowedWhileHeld,true);
   assert.equal((await admin.saveExpenseReviewDraft({...owner,data:request.data})).status,'draft');
   const saved=await request.read();
   assert.equal(saved.draft.status,'draft');
   assert.equal(saved.draft.values.transportation,850);
   assert.equal(saved.draft.values.purchase8,0);
   assert.equal(saved.currentValues.transportation,700);
   assert.equal(saved.currentValues.purchase8,null);
   assert.notEqual(saved.reviewVersion,shown.reviewVersion);
   request.data.expectedVersion=saved.reviewVersion;

   await assert.rejects(()=>admin.completeExpenseReview({...owner,data:request.data}),
    error=>error.details?.reason==='case_list_private_expense_completion_held');
   assert.equal(attemptRecord(),undefined);
   assert.equal(cellValue(ctx.table.get(3)[36]),700);
   const lookup=(operationId,auth=owner)=>admin.getExpenseReview({...auth,data:{
    jobId,mode:'confirmation-status',...(operationId?{operationId}:{}),
   }});
   assert.deepEqual(copy(await lookup()),{jobId,confirmationOperation:null});

   const interrupted=ctx.sheetsWriter({loseResponse:true,searchResult:()=>[]});
   const firstGateway=expenseGateway(interrupted.writer);
   const confirm={operationId:crypto.randomUUID(),expectedVersion:request.data.expectedVersion,values:request.data.values,note:request.data.note};
   assert.equal((await firstGateway.send('crew','complete',confirm)).reason,'readback_required');
   assert.equal(interrupted.api.batches,1);
   const operationId=attemptRecord().intent.id;
   assert.equal(operationId,confirm.operationId);
   assert.equal(reviewRecord().status,'confirmation_pending');
   assert.equal(documents.get(expenseFencePath(BOOK)).state,'held');
   assert.equal(documents.get(expenseFenceOperation(operationId)).phase,'dispatched');
   assert.equal((await traceCall(operationId)).status,'readback_required');
   const beforeLookupWrites=writes,beforeLookupRequests=requests.length;
   const expectedPending={jobId,confirmationOperation:{operationId,status:'readback_required'}};
   assert.deepEqual(copy(await lookup()),expectedPending);
   assert.deepEqual(copy(await lookup(operationId)),expectedPending);
   const jobPath='jobs/'+jobId;
   const linkedJob=documents.get(jobPath);
   const {caseListSource: sourceLink,...withoutSourceLink}=linkedJob;
   const {externalAck: ack,...withoutAck}=linkedJob.assignmentSheetWrite;
   assert.ok(sourceLink && ack);
   try {
    for(const job of [withoutSourceLink,{...linkedJob,assignmentSheetWrite:withoutAck}]){
     documents.set(jobPath,job);
     assert.deepEqual(copy(await lookup(operationId)),expectedPending);
     assert.deepEqual(copy(await lookup()),expectedPending);
    }
   } finally { documents.set(jobPath,linkedJob); }
   await assert.rejects(()=>lookup(operationId,staffAuth),e=>e.code==='permission-denied');
   const foreign=copy(owner);
   foreign.auth.token.companyId='foreign_synthetic';
   await assert.rejects(()=>lookup(operationId,foreign),e=>e.code==='not-found');
   await assert.rejects(()=>lookup('11111111-1111-4111-8111-111111111111'),e=>e.code==='not-found');
   await assert.rejects(()=>lookup('../wrong'),e=>e.name==='ZodError');
   assert.equal(writes,beforeLookupWrites);
   assert.equal(requests.length,beforeLookupRequests);
   ctx.reopen();
   const recovered=ctx.sheetsWriter();
   const restarted=recovered.writer;
   assert.equal((await restarted.readReceipt(operationId)).outcome,'applied');
   const reopened=expenseGateway(restarted);
   const resolved=await reopened.send('gas','trace',{operationId});
   assert.deepEqual(copy(resolved),{operationId,status:'verified_pending'});
   assert.equal(reviewRecord().status,'confirmation_pending');
   assert.equal(documents.get(expenseFencePath(BOOK)).state,'held');
   assert.equal((await reopened.send('crew','reconcile',{operationId})).status,'completed');
   assert.equal((await reopened.send('manual','trace',{operationId})).status,'completed');
   assert.equal(documents.get(expenseFencePath(BOOK)).state,'idle');
   assert.equal(documents.get(expenseFenceOperation(operationId)).phase,'verified');
   assert.equal(recovered.api.batches,0);
   assert.equal((await traceCall(operationId)).status,'completed');
   const beforeCompletedWrites=writes,beforeCompletedRequests=requests.length;
   const expectedCompleted={jobId,confirmationOperation:{operationId,status:'completed'}};
   assert.deepEqual(copy(await lookup(operationId)),expectedCompleted);
   const completedJob=documents.get(jobPath);
   try {
    documents.set(jobPath,{...completedJob,caseListSource: null});
    assert.deepEqual(copy(await lookup(operationId)),expectedCompleted);
   } finally { documents.set(jobPath,completedJob); }
   assert.equal(writes,beforeCompletedWrites);
   assert.equal(requests.length,beforeCompletedRequests);
   const confirmed=await request.read();
   assert.equal(confirmed.draft.status,'completed');
   assert.equal(confirmed.currentValues.transportation,850);
   assert.equal(confirmed.currentValues.purchase8,0);
   assert.equal(confirmed.currentValues.purchase10,0);
   assert.equal(cellValue(ctx.table.get(2)[36]),'');
   assert.equal(attemptRecord().readbackHash,attemptRecord().intent.afterHash);
   for(const receipt of [submissions.report,submissions.sales,submissions.replacement]){
    const parent=documents.get('submissions/'+receipt.submissionId);
    const file=documents.get('submissions/'+receipt.submissionId+'/files/'+receipt.files[0].fileId);
    assert.equal(parent.companyId,COMPANY);
    assert.equal(parent.staffId,STAFF);
    assert.equal(parent.jobId,jobId);
    assert.equal(file.status,'completed');
   }
   assert.equal(documents.get('resubmissionRequests/'+submissions.request.requestId).status,'completed');
   assertPrivateExpenseWrites(request,operationId);
   oneCaseResult={companyId:COMPANY,caseId:CASE,jobId,staffId:STAFF,
    submissionIds:[submissions.report,submissions.sales,submissions.replacement].map(r=>r.submissionId),
    expenseOperationId:operationId,originalReportRetained:true,uncertainOutcomeVerifiedById:true,
    monthlyWrites:interrupted.api.batches,recoveryWrites:recovered.api.batches,liveCallableHold:true,
    adminStatusLookup:{default:true,byOperationId:true,pendingWithoutSourceOrAck:true,completedWithoutSource:true,staffRefused:true,foreignRefused:true,unknownRefused:true,invalidRefused:true,sheetsCalls:0,documentWrites:0},
    finalPrivateReviewStatus:confirmed.draft.status,locationChange,
    staffLogin:journeyLogin,staffViews,reminders:reminderResult,
    bookFence:{heldUntilVerified:true,terminalPhase:'verified'},
    sheetsBatch:{atomicRequest:true,markerRequests:1,amountRequests:interrupted.api.latest.length-1},pilotGateway:{channels:['crew','gas','manual'],sameOperation:true}};
  },async()=>{
   documents.set('companies/'+COMPANY+'/settings/drive',{rootFolderId:'synthetic-root'});
   const {runAcceptedSubmissionJourney}=await import('./test-submission-lifecycle.mjs');
   assert.equal(documents.get('jobs/'+jobId).applicationUnconfirmed,false);
   assert.equal(documents.get('jobs/'+jobId).assignedStaffId,STAFF);
   const beforeLocation=copy(documents.get('jobs/'+jobId)),beforeQueues=[...documents.keys()].filter(key=>key.startsWith('sheetSyncQueue/')).length;
   const savedLocation=await load('job-management').adminEditCaseListLocation({...owner,data:{
    jobId,revision:beforeLocation.revision,locationRevision:0,fields:{storeAddress:'架空県試験町1丁目4番地',storeNearestStation:'架空試験駅'},
   }});
   const afterLocation=documents.get('jobs/'+jobId);
   assert.equal(savedLocation.locationRevision,1);
   assert.equal(typeof savedLocation.sheetWriteQueued,'undefined');
   assert.equal(savedLocation.revision,beforeLocation.revision);
   assert.equal(afterLocation.revision,beforeLocation.revision);
   assert.equal(afterLocation.locationRevision,1);
   assert.equal(afterLocation.storeAddress,'架空県試験町1丁目4番地');
   assert.equal(afterLocation.storeNearestStation,'架空試験駅');
   assert.deepEqual(afterLocation.assignmentSheetWrite,beforeLocation.assignmentSheetWrite);
   assert.deepEqual(afterLocation.sheetRef,beforeLocation.sheetRef);
   assert.equal([...documents.keys()].filter(key=>key.startsWith('sheetSyncQueue/')).length,beforeQueues);
   locationChange={sameAssignmentRevision:true,locationRevision:afterLocation.locationRevision,queuedSheetWrites:0,route:verifyCurrentRoute(afterLocation)};
   const assigned={...documents.get("jobs/"+jobId),id:jobId};
   const next=list.nextShiftJob([assigned],DATE);
   assert.equal(next?.id,jobId);
   const month=calendar.monthCalendar([assigned],DATE.slice(0,7));
   const day=month.jobs.get(DATE);
   assert.equal(day?.length,1);
   assert.equal(day[0].id,jobId);
   staffViews={listedBeforeApply:true,nextShiftSameJob:true,monthShowsOneShift:true};
   const pendingReport=await queueOneCaseReminders();
   submissions=await runAcceptedSubmissionJourney(documents,jobId,staffAuth.auth,owner.auth);
   reminderResult=await verifyCompletedReminders(pendingReport);
  });
 });
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
 if(testPrefix==='external monthly book /'){
  report.scope='Crew confirmation and read-only tracking over an on-disk synthetic monthly table. SQLite transactions use independent GAS, Crew and manual-model connections. Only the archived GAS lock helper runs locally. Google Sheets and real manual editing are not connected.';
  report.previousEvidence=['expense-confirmation-final.json','expense-readback-and-confirmation-verified.json'];
  report.monthlyBook=path.basename(monthlyBookFile);
  report.expectedCounterexample='Independent manual row movement defeats coordinate-only writes despite the separate GAS lock.';
  report.remaining=['A Google Sheets writer with enforcement across direct API, GAS and manual editors','Durable receipt tied to the actual Sheets update','Approved pilot execution'];
 }
 if(integrated){
  report.scope='One synthetic external case from staff bootstrap, application and confirmed shift through route, tasks, report/photo/replacement and private expense recovery.';
  if(testPrefix===migrationPrefix)report.scope='One synthetic case preserves the same staff, application and report across device authentication switch. Private expense is read-only with the normal hold intact.';
  report.oneCase=oneCaseResult;
  report.applicationRecovery=applicationRecovery;
  report.monthlyBook=path.basename(monthlyBookFile);
  report.remaining=['Actual approved Google Sheets writer and shared concurrency fence','Approved authenticated pilot with the exact runtime candidate'];
 }
 if(testPrefix===fencePrefix){
  report.scope='Actual Crew expense-book reservation, dispatch and finalization over synthetic Firestore and an instrumented monthly writer. GAS and manual contenders use the same candidate reservation path.';
  report.remaining=['Proof that every real GAS, Crew and manual entry shares the book fence','Approved Sheets writer with an atomic receipt','Approval and acceptance of the exact candidate'];
 }
 if(testPrefix===sheetsPrefix){
  report.scope='Private Sheets writer and Crew book fence. Actual request construction with an instrumented synthetic Sheets API and on-disk atomic storage.';
  report.monthlyBook=path.basename(monthlyBookFile);
  report.remaining=['Real Google Sheets behavior and credential scope','Shared write gate for actual Crew, GAS and manual editing','Approved pilot execution'];
 }
 if(testPrefix===pilotPrefix){
  report.scope='One private My Drive pilot book. Actual write preflight, Drive read request selection and Sheets writer with synthetic transport.';
  report.monthlyBook=path.basename(monthlyBookFile);
  report.remaining=['Provisioned synthetic book and dedicated owner OAuth identity','Real direct edits rejected for all test actors','Approved acceptance'];
 }
 if(testPrefix===gatewayPrefix){
  report.scope='Unregistered pilot gateway with role, exact case and native-scope checks. Uses synthetic Firebase authentication, Drive and Sheets transport only.';
  report.monthlyBook=path.basename(monthlyBookFile);
  report.remaining=['Approved isolated deployment and real authentication for all three actors','Actual GAS transport and direct edit denials'];
 }
 if(testPrefix===gasPrefix){
  report.scope='Actual standalone Apps Script client under synthetic UrlFetch, Properties and Lock services, with the real private HTTP gateway and synthetic database and sheets.';
  report.monthlyBook=path.basename(monthlyBookFile);
  report.remaining=['Actual isolated Apps Script execution and a provisioned short-lived Firebase token','Approved real transport and workbook'];
 }
 fs.mkdirSync(evidenceDir,{recursive:true});fs.writeFileSync(path.join(evidenceDir,process.env.LKC_TEST_EVIDENCE_FILE||'ci-crew-external-normal.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
})();
