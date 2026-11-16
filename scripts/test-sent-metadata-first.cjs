'use strict';
// Executes the dedicated TS port and real existing GmailReadClient URL/response
// handling with synthetic fetch/auth only. No live credentials or Google calls.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),inputs=path.resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||root),deps=createRequire(path.join(inputs,'package.json')),ts=deps('typescript');
const src=path.join(root,'functions/src'),Sent=require(path.join(src,'case-list-gas-sent-readback.cjs'));
const {GmailReadClient}=require(path.join(inputs,'functions/case-mail-runtime/read-mail.cjs'));
const METADATA_FIELDS='id,labelIds,internalDate,payload(headers(name,value))',BODY_FIELDS='id,labelIds,internalDate,payload(mimeType,filename,headers(name,value),parts(mimeType),body(data,attachmentId))';
const sha=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex'),clone=x=>structuredClone(x);
const mailbox='owner@example.invalid',actor={uid:'synthetic-owner',companyId:'synthetic-company',email:mailbox},caseId='LKCASE_00000000-0000-0000-0000-000000000001',messageId='synthetic_sent_001';
const rawMarker='SYNTHETIC_PRIVATE_BODY_MUST_NOT_LOG',secretMarker='SYNTHETIC_CREDENTIAL_ERROR_MUST_NOT_LOG',now=1794132000000;
const logging=[],safeConsole=Object.fromEntries(['log','error','warn','info','debug'].map(k=>[k,(...args)=>logging.push(args)]));
const box={module:{exports:{}},exports:null,Buffer,console:safeConsole,require:name=>{
 if(name==='../src/case-list-gas-sent-readback.cjs')return Sent;
 if(name==='../src/case-list-assignment-observation.cjs')return require(path.join(src,'case-list-assignment-observation.cjs'));
 throw Error('Unexpected dependency');
}};box.exports=box.module.exports;
const transformed=ts.transpileModule(fs.readFileSync(path.join(src,'case-list-gas-read-ports.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
vm.runInNewContext(transformed.outputText,box,{filename:'case-list-gas-read-ports.ts'});
const {createGasReadPorts}=box.module.exports;
let networkAttempts=0;const priorFetch=globalThis.fetch;globalThis.fetch=async()=>{networkAttempts++;throw Error('NETWORK_FORBIDDEN');};
function fixture(){
 const group={client:'synthetic-client',to:['recipient@example.invalid'],cc:['copy@example.invalid'],subject:'Synthetic subject',body:rawMarker+'\nsecond line',cases:[{id:caseId}]};
 const receipt={caseId,digest:sha(group),messageId};
 const headers=[{name:'From',value:'Synthetic Owner <'+mailbox+'>'},{name:'To',value:group.to.join(', ')},{name:'Cc',value:group.cc.join(', ')},{name:'Subject',value:group.subject}];
 const metadata={id:messageId,labelIds:['SENT'],internalDate:String(now-5000),payload:{headers:clone(headers)}};
 const full={...clone(metadata),payload:{mimeType:'text/plain',filename:'',headers:clone(headers),body:{data:Buffer.from(group.body.replace(/\n/g,'\r\n')+'\r\n').toString('base64url')}}};
 const config={companyId:actor.companyId,uid:'synthetic-receiver',producerId:'synthetic-producer',principalRevision:'synthetic-v1',mailbox,startedAt:'2026-01-01T00:00:00Z',gmailServiceAccountEmail:'synthetic-service@example.invalid'};
 const options={profile:{emailAddress:mailbox},metadata,full,config,group,receipt,failStage:null,afterMetadata:null,metadataBodyTrap:false};
 const stats={requests:[],tokens:0,configReads:0,accessChecks:0,forbiddenCalls:0,bodyPropertyReads:0};
 const request={groups:[group],prepared:{cases:[{id:caseId,nameUpDigest:receipt.digest}]},firstPreparedAt:now-10000};
 const item={caseId,receipt};
 const ports={now:()=>now,hash:sha,readMonthly:async()=>assert.fail('No Sheets read in SENT test'),sentPolicy:{enabled:true,companyId:actor.companyId,ownerUid:actor.uid,mailbox,principalRevision:config.principalRevision},
  readMailConfig:async()=>{stats.configReads++;if(options.configReadHook)options.configReadHook(stats.configReads);return clone(options.config);},
  assertMailAccess:async()=>{stats.accessChecks++;if(options.accessHook)await options.accessHook(stats.accessChecks);},
  createMailAuth:serviceAccount=>{assert.equal(serviceAccount,config.gmailServiceAccountEmail);if(options.failStage==='factory')throw Error(secretMarker);return {obtainGmailAccessToken:async c=>{stats.tokens++;assert.equal(c.scope,'https://www.googleapis.com/auth/gmail.readonly');assert.equal(c.mailbox,mailbox);if(options.failStage==='token')throw Error(secretMarker);return 'SYNTHETIC_ACCESS_VALUE';}};},
  createGmailReader:getAccessToken=>{
   if(options.failStage==='client')throw Error(secretMarker);
   const client=new GmailReadClient({obtainAccessToken:getAccessToken,fetchImpl:async(raw,init)=>{
    const url=new URL(raw);assert.equal(url.origin,'https://gmail.googleapis.com');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
    let stage;if(url.pathname==='/gmail/v1/users/me/profile'){stage='profile';assert.equal(url.searchParams.get('fields'),'emailAddress');assert.equal(url.searchParams.size,1);}
    else{assert.equal(url.pathname,'/gmail/v1/users/me/messages/'+messageId);stage=url.searchParams.get('format');assert(['metadata','full'].includes(stage));assert.equal(url.searchParams.get('fields'),stage==='metadata'?METADATA_FIELDS:BODY_FIELDS);assert.equal(url.searchParams.size,2);}
    stats.requests.push(stage);if(options.failStage===stage)throw Error(secretMarker);
    return {ok:true,status:200,json:async()=>{if(options.failStage===stage+'-json')throw Error(secretMarker);const result=stage==='profile'?clone(options.profile):stage==='metadata'?clone(options.metadata):clone(options.full);
     if(stage==='metadata'){if(options.afterMetadata)await options.afterMetadata();if(options.metadataBodyTrap)Object.defineProperty(result.payload,'body',{get(){stats.bodyPropertyReads++;throw Error(rawMarker);}});}
     return result;
    }};
   }});
   for(const key of ['list','getMessage','getAttachment'])client[key]=()=>{stats.forbiddenCalls++;assert.fail('Unexpected broad reader method');};
   return client;
  }
 };
 return {options,stats,request,item,ports,read:()=>createGasReadPorts(ports).observeMail(item,request,actor),expected:{state:'SENT_VERIFIED',digest:receipt.digest,messageId,sentAt:now-5000}};
}
const results=[];
async function test(name,fn){const f=fixture();logging.length=0;const previous=Object.fromEntries(Object.keys(safeConsole).map(k=>[k,console[k]]));try{for(const key of Object.keys(safeConsole))console[key]=safeConsole[key];await fn(f);assert.equal(f.stats.forbiddenCalls,0);assert.equal(networkAttempts,0);assert.equal(logging.length,0);}finally{Object.assign(console,previous);}results.push({name,passed:true});}
async function held(f,{body=false,fetches}={}){let error;try{await f.read();}catch(e){error=e;}assert(error,'Must hold');assert(!String(error.message).includes(rawMarker));assert(!String(error.message).includes(secretMarker));assert.equal(error.cause,undefined);assert.equal(f.stats.requests.includes('full'),body);if(fetches)assert.deepEqual(f.stats.requests,fetches);return error;}
const header=(m,name)=>m.payload.headers.find(x=>x.name.toLowerCase()===name.toLowerCase());
(async()=>{try{
 await test('normal SENT keeps exact existing proof and limited request order',async f=>{assert.deepEqual(await f.read(),f.expected);assert.deepEqual(f.stats.requests,['profile','metadata','full']);assert.equal(f.stats.tokens,1);assert.equal(f.stats.accessChecks,3);assert.equal(f.stats.configReads,3);});
 await test('metadata cannot return SENT_VERIFIED or inspect a body',async f=>{f.options.metadataBodyTrap=true;assert.deepEqual(await f.read(),f.expected);assert.equal(f.stats.bodyPropertyReads,0);assert.equal(Sent.verifySentMetadata(f.options.metadata,f.options.group,f.options.receipt,{mailbox,firstPreparedAt:f.request.firstPreparedAt,now}),undefined);});
 await test('normal encoded subject preserves proof',async f=>{for(const m of [f.options.metadata,f.options.full])header(m,'subject').value='=?UTF-8?B?'+Buffer.from(f.options.group.subject).toString('base64')+'?=';assert.deepEqual(await f.read(),f.expected);});
 for(const [name,alter]of [
  ['non-SENT',m=>m.labelIds=['INBOX']],['mismatched ID',m=>m.id='different'],['missing metadata',()=>null],['missing labels',m=>delete m.labelIds],['string labels',m=>m.labelIds='NOT_SENT'],['damaged labels',m=>m.labelIds=['SENT',null]],
  ['missing time',m=>delete m.internalDate],['invalid time',m=>m.internalDate='not-a-time'],['exponent time',m=>m.internalDate='1e12'],['too early',m=>m.internalDate=String(now-11000)],['future time',m=>m.internalDate=String(now+1)],
  ['missing payload',m=>delete m.payload],['missing headers',m=>delete m.payload.headers],['non-array headers',m=>m.payload.headers={}],
  ['wrong From',m=>header(m,'from').value='other@example.invalid'],['wrong To',m=>header(m,'to').value='other@example.invalid'],['wrong Cc',m=>header(m,'cc').value='other@example.invalid'],['wrong subject',m=>header(m,'subject').value='different'],
  ['missing From',m=>m.payload.headers=m.payload.headers.filter(h=>h.name!=='From')],['duplicate From',m=>m.payload.headers.push({name:'from',value:mailbox})],['malformed From',m=>header(m,'from').value=123],
  ['Bcc',m=>m.payload.headers.push({name:'Bcc',value:'hidden@example.invalid'})],['Reply-To',m=>m.payload.headers.push({name:'Reply-To',value:mailbox})],['References',m=>m.payload.headers.push({name:'References',value:'synthetic-reference'})]
 ])await test('metadata '+name+' holds before body',async f=>{const out=alter(f.options.metadata);if(out===null)f.options.metadata=null;await held(f,{fetches:['profile','metadata']});});
 await test('wrong profile holds before metadata/body',async f=>{f.options.profile.emailAddress='other@example.invalid';await held(f,{fetches:['profile']});});
 await test('invalid receipt ID stops before any Gmail access',async f=>{f.options.receipt.messageId='../received';await held(f,{fetches:[]});assert.equal(f.stats.tokens,0);});
 await test('group digest mismatch stops before any Gmail access',async f=>{f.options.group.body+=' changed';await held(f,{fetches:[]});assert.equal(f.stats.tokens,0);});
 await test('missing existing read policy stays closed',async f=>{f.ports.sentPolicy=undefined;await held(f,{fetches:[]});assert.equal(f.stats.tokens,0);});
 await test('existing intake-disabled refusal stays closed',async f=>{f.options.accessHook=async()=>{throw Object.assign(Error('SENT_EXISTING_READ_FEATURE_DISABLED'),{code:'SENT_EXISTING_READ_FEATURE_DISABLED'});};const e=await held(f,{fetches:[]});assert.equal(e.code,'SENT_EXISTING_READ_FEATURE_DISABLED');assert.equal(f.stats.tokens,0);});
 await test('config changes during metadata wait stop before body',async f=>{f.options.afterMetadata=async()=>{await Promise.resolve();f.options.config.principalRevision='changed';};await held(f,{fetches:['profile','metadata']});});
 await test('read permission changes during metadata wait stop before body',async f=>{f.options.accessHook=async n=>{if(n===2)throw Error(secretMarker);};await held(f,{fetches:['profile','metadata']});});
 for(const [name,alter]of [
  ['body changed',m=>m.payload.body.data=Buffer.from('changed').toString('base64url')],['full ID changed',m=>m.id='different'],['full SENT lost',m=>m.labelIds=['INBOX']],['full From changed',m=>header(m,'from').value='other@example.invalid'],
  ['multipart',m=>m.payload.parts=[{mimeType:'application/pdf'}]],['attachment reference',m=>m.payload.body.attachmentId='synthetic-attachment'],['wrong MIME',m=>m.payload.mimeType='text/html']
 ])await test(name+' still holds at existing full verification without attachment fetch',async f=>{alter(f.options.full);await held(f,{body:true});});
 for(const stage of ['factory','client','token','profile','profile-json','metadata','metadata-json','full','full-json'])await test('private '+stage+' exception is sanitized without logging',async f=>{f.options.failStage=stage;const e=await held(f,{body:stage==='full'||stage==='full-json'});assert.equal(e.message,'SENT_READBACK_UNAVAILABLE');assert.deepEqual(Object.keys(e).sort(),['code']);});
 if(process.env.LKC_TEST_PREVIOUS_SENT_VERIFIER)await test('normal result matches frozen previous verifier',async f=>{const previous=require(path.resolve(process.env.LKC_TEST_PREVIOUS_SENT_VERIFIER));const expected=previous.verifySentMessage(f.options.full,f.options.group,f.options.receipt,{mailbox,firstPreparedAt:f.request.firstPreparedAt,now});assert.deepEqual(await f.read(),expected);});
 const report={checkedAt:new Date().toISOString(),cases:results.length,passed:results.length,failed:0,scope:'Dedicated SENT port + real existing GmailReadClient with synthetic fetch/auth only',networkAttempts,realApi:false,realToken:false,attachmentOrListCalls:0,storageWrites:0,results};
 const output=process.env.LKC_OFFLINE_EVIDENCE_DIR;if(output){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'SENT_METADATA_TESTS.json'),JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify({...report,results:undefined}));
}finally{globalThis.fetch=priorFetch;}})().catch(e=>{console.error(e);process.exitCode=1;});
