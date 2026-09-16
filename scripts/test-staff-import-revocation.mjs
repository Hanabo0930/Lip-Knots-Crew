import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
const { Timestamp } = require('firebase-admin/firestore'), { HttpsError } = require('firebase-functions/v2/https');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function setup(mode = 'removed') {
 const state = { environment:'development', records: new Map(), revoked: [], writes: 0, sheetReads: 0, rows: [['name','email','inactive'], ['合成スタッフ','keep@example.invalid',mode === 'manual' ? 'TRUE' : '']] };
 if (mode === 'missing') state.rows = [['name','email','inactive']];
 const clone = v => v instanceof Timestamp ? v : Array.isArray(v) ? v.map(clone) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k,clone(x)])) : v;
 let serial = 0;
 const write = (path, data, merge) => { state.writes++; state.records.set(path, { ...(merge ? clone(state.records.get(path)) : {}), ...clone(data) }); };
 const snapshot = path => { const data = clone(state.records.get(path)); return { id:path.split('/').at(-1), ref:ref(path), exists:data !== undefined, data:()=>data }; };
 const ref = path => ({path,id:path.split('/').at(-1),get:async()=>{const result=snapshot(path);await state.onRead?.(path);return result;},set:async(data,options)=>{await state.onWrite?.(path);write(path,data,options?.merge===true);}});
 const query = (name, filters=[], cap=Infinity) => ({doc:id=>ref(name+'/'+(id??'synthetic-'+ ++serial)),where:(key,op,value)=>{assert.equal(op,'==');return query(name,[...filters,[key,value]],cap);},orderBy:()=>query(name,filters,cap),limit:n=>query(name,filters,n),get:async()=>{const docs=[...state.records].filter(([p,d])=>p.startsWith(name+'/')&&filters.every(([k,v])=>d[k]===v)).slice(0,cap).map(([p])=>snapshot(p));return {docs,size:docs.length,empty:!docs.length};}});
 const db = {collection:query,getAll:async(...refs)=>Promise.all(refs.map(r=>r.get())),batch:()=>{const writes=[];return {set:(r,d,o)=>writes.push([r.path,d,o?.merge===true]),commit:async()=>{assert.ok(writes.length<=500);for(const [p,d,m] of writes){await state.onWrite?.(p);write(p,d,m);}}};},runTransaction:async callback=>{
  for(let attempt=0;attempt<10;attempt++){
   const writes=[],reads=new Map();
   const result=await callback({get:async r=>{assert.equal(writes.length,0);const s=await r.get();reads.set(r.path,JSON.stringify(s.data()));return s;},set:(r,d,o)=>writes.push([r.path,d,o?.merge===true]),update:(r,d)=>writes.push([r.path,d,true]),delete:r=>writes.push([r.path,null,false])});
   await state.onCommit?.(writes);
   if([...reads].some(([p,d])=>JSON.stringify(state.records.get(p))!==d))continue;
   for(const [p,d,m] of writes){await state.onWrite?.(p);if(d===null)state.records.delete(p);else write(p,d,m);}
   return result;
  }throw Error('Synthetic transaction retry limit');
 }};
 const sheets = {spreadsheets:{get:async()=>({data:{sheets:(state.descriptors??[{title:'fixture',rowCount:state.rows.length}]).map((d,i)=>({properties:{sheetId:i,title:d.title,hidden:d.hidden,gridProperties:{rowCount:d.rowCount,columnCount:20}}}))}}),values:{get:async({range})=>{
  state.sheetReads++;const match=/^'((?:[^']|'')*)'!A1:([A-Z]+)(\d+)$/.exec(range);assert.ok(match,range);const title=match[1].replaceAll("''","'");
  if(state.failedSheet===title)throw Error('Synthetic sheet read failure');
  return {data:{values:(state.sheetValues?.[title]??state.rows).slice(0,Number(match[3])).map(row=>row.slice(0,match[2].split('').reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)))}};
 }}}};
 const boundaries={'node:crypto':crypto,zod:require('zod'),'firebase-admin/firestore':{Timestamp,FieldValue:{serverTimestamp:()=>Timestamp.now()}},'firebase-functions/v2/https':{HttpsError,onCall:(...args)=>args.at(-1)},'firebase-functions/v2/scheduler':{onSchedule:(_o,fn)=>fn},'./firebase':{db,auth:{revokeRefreshTokens:async uid=>{await state.onRevoke?.(uid);state.revoked.push(uid);}}},googleapis:{google:{auth:{GoogleAuth:class {}},sheets:()=>sheets}}};
 const modules={};
 const load=name=>{if(boundaries[name])return boundaries[name];assert.ok(['./system-safety','./staff-import','./staff-parser','./staff-identity','./case-id','./utils','./sheet-reader'].includes(name),name);if(modules[name])return modules[name];const exports={};modules[name]=exports;runInNewContext(compile(fs.readFileSync('functions/src/'+name.slice(2)+'.ts','utf8')),{exports,require:load,process:{env:{get APP_ENVIRONMENT(){return state.environment;}}},console});return exports;};
 const config={companyId:'company-a',enabled:true,scheduleEnabled:false,spreadsheetId:'synthetic-spreadsheet',activeSheets:['fixture'],excludedSheets:[],sheetAreas:{},headerRow:1,dataStartRow:2,markMissingInactive:true,revokeRemovedEmailSessions:true,columns:{displayName:'A',email:'B',manualInactive:'C'}};
 state.records.set('staffImportConfigs/company-a',config);
 state.records.set('productionControls/company-a',{productionEnabled:true,emergencyLock:false});
 const staffId=load('./staff-identity').createStaffId('company-a','合成スタッフ'), emailHash=load('./utils').emailHash;
 state.records.set('staffProfiles/'+staffId,{companyId:'company-a',active:true,emails:['old@example.invalid','keep@example.invalid'],authUids:['uid-old','uid-keep']});
 for(const [uid,email]of [['uid-old','old@example.invalid'],['uid-keep','keep@example.invalid']]){
  state.records.set('authIdentities/'+uid,{companyId:'company-a',staffId,emailHash:emailHash(email),active:true});
  state.records.set('emailIndex/'+emailHash(email),{companyId:'company-a',staffId,email,active:true});
 }
 const api=load('./staff-import'),request={auth:{uid:'admin-a',token:{companyId:'company-a',role:'admin'}},data:{}};
 return {state,staffId,api,request,run:()=>api.syncStaffDirectoryReadOnly(request),runs:()=>[...state.records].filter(([p])=>p.startsWith('staffImportRuns/')).map(([,d])=>d)};
}
let cases=0;
for(const mode of ['removed','missing','manual'])for(const fault of ['auth','identity-write']){
 const h=setup(mode), expected=mode==='removed'?1:2;
 if(fault==='auth')h.state.onRevoke=uid=>{if(uid==='uid-old')throw Error('Synthetic Auth failure');};
 else h.state.onWrite=path=>{if(path==='authIdentities/uid-old')throw Error('Synthetic identity write failure');};
 await assert.rejects(h.run(),error=>{assert.equal(error.code,'unavailable');assert.equal(error.details.directoryWritten,true);assert.equal(error.details.sessionsFailed,1);assert.match(error.message,/再実行/);return true;},mode+':'+fault);
 assert.equal(h.runs().at(-1).status,'error');assert.equal(h.state.records.has('syncLocks/company-a_staff_import'),false);
 assert.equal(h.state.records.get('authIdentities/uid-old').active,true);
 delete h.state.onRevoke;delete h.state.onWrite;
 const retried=await h.run();assert.equal(retried.totals.sessionsRevoked,1);assert.equal(h.runs().at(-1).status,'completed');
 assert.equal(h.state.records.get('authIdentities/uid-old').active,false);
 if(expected===2)assert.equal(h.state.records.get('authIdentities/uid-keep').active,false);
 assert.equal((await h.run()).totals.sessionsRevoked,0);cases++;
}
for(const mode of ['removed','missing','manual']){
 const h=setup(mode);const result=await h.run();assert.equal(result.totals.inactivated,mode==='removed'?0:1);assert.equal(result.totals.sessionsRevoked,mode==='removed'?1:2);assert.equal((await h.run()).totals.sessionsRevoked,0);cases++;
}
{
 const h=setup('missing'),before=JSON.stringify([...h.state.records]);await h.api.previewStaffImport(h.request);assert.equal(JSON.stringify([...h.state.records]),before);assert.deepEqual(h.state.revoked,[]);cases++;
}
for(const role of ['staff',undefined]){const h=setup();await assert.rejects(h.api.syncStaffDirectoryReadOnly({...h.request,auth:{...h.request.auth,token:{companyId:'company-a',role}}}),{code:'permission-denied'});assert.equal(h.state.writes,0);cases++;}
{
 const h=setup(),app=fs.readFileSync('apps/admin/src/App.tsx','utf8'),from=app.indexOf('  async function runStaffSync()'),to=app.indexOf('  async function previewSheetSync()',from);assert.ok(from>=0&&to>from);
 const ui={messages:[],busy:false,refreshes:0},ctx={Error,window:{confirm:()=>true},firebaseConfigured:true,functions:{},httpsCallable:(_f,name)=>async()=>{assert.equal(name,'syncStaffDirectoryReadOnly');return {data:await h.run()};},setStaffSyncSummary:()=>{},setMessage:v=>ui.messages.push(v),setStaffSyncBusy:v=>ui.busy=v,loadStaff:async()=>{ui.refreshes++;}};
 runInNewContext(compile(app.slice(from,to)),ctx);h.state.onRevoke=()=>{throw Error('Synthetic Auth failure');};await ctx.runStaffSync();assert.match(ui.messages.at(-1),/再実行/);assert.equal(ui.busy,false);assert.equal(ui.refreshes,0);
 delete h.state.onRevoke;await ctx.runStaffSync();assert.match(ui.messages.at(-1),/同期が完了/);assert.equal(ui.refreshes,1);cases++;
}
for (const mode of ['removed','missing','manual']) for(const fault of ['company','staff','missing','hash','number-uid','path-uid','string-list']) {
 const h=setup(mode),identityPath='authIdentities/uid-old',profilePath='staffProfiles/'+h.staffId;
 if(fault==='company')h.state.records.get(identityPath).companyId='company-b';
 if(fault==='staff')h.state.records.get(identityPath).staffId='staff-b';
 if(fault==='missing')h.state.records.delete(identityPath);
 if(fault==='hash')delete h.state.records.get(identityPath).emailHash;
 if(fault==='number-uid')h.state.records.get(profilePath).authUids=[42];
 if(fault==='path-uid')h.state.records.get(profilePath).authUids=['nested/uid'];
 if(fault==='string-list')h.state.records.get(profilePath).authUids='uid-old';
 const before=JSON.stringify(h.state.records.get(profilePath));
 await assert.rejects(h.run(),{code:'failed-precondition'},mode+':'+fault);
 assert.deepEqual(h.state.revoked,[]);assert.equal(JSON.stringify(h.state.records.get(profilePath)),before);assert.equal(h.runs().at(-1).status,'error');cases++;
}
for (const mode of ['removed','missing']) for(const phase of ['before-auth','during-auth','commit']) for(const field of ['companyId','staffId','emailHash','deleted']) {
 const h=setup(mode),identityPath='authIdentities/uid-old',profilePath='staffProfiles/'+h.staffId;
 const mutate=()=>{if(field==='deleted')h.state.records.delete(identityPath);else h.state.records.get(identityPath)[field]='changed';};
 if(phase==='before-auth')h.state.onWrite=path=>{if(path===profilePath){delete h.state.onWrite;mutate();}};
 if(phase==='during-auth')h.state.onRevoke=uid=>{if(uid==='uid-old')mutate();};
 if(phase==='commit')h.state.onCommit=writes=>{if(writes.some(([path])=>path===identityPath)){delete h.state.onCommit;mutate();}};
 await assert.rejects(h.run(),{code:'unavailable'},mode+':'+phase+':'+field);
 if(field==='deleted')assert.equal(h.state.records.has(identityPath),false);
 else {assert.equal(h.state.records.get(identityPath)[field],'changed');assert.equal(h.state.records.get(identityPath).active,true);}
 assert.equal(h.state.revoked.includes('uid-old'),phase!=='before-auth');cases++;
}
for(const mode of ['removed','missing','manual']){
 const h=setup(mode),config=h.state.records.get('staffImportConfigs/company-a');config.revokeRemovedEmailSessions=false;config.markMissingInactive=false;
 const result=await h.run();assert.equal(result.totals.sessionsRevoked,mode==='manual'?2:0);cases++;
}
{
 const h=setup('removed');h.state.rows=[['name','email','inactive'],['合成スタッフ','old@example.invalid keep@example.invalid','']];
 const result=await h.run();assert.equal(result.totals.sessionsRevoked,0);assert.deepEqual(h.state.revoked,[]);cases++;
}
for(const mode of ['removed','missing'])for(const phase of ['before-auth','during-auth']){
 const h=setup(mode),profilePath='staffProfiles/'+h.staffId;
 const restore=()=>{const profile=h.state.records.get(profilePath);if(mode==='missing')profile.active=true;else profile.emails=['old@example.invalid','keep@example.invalid'];};
 if(phase==='before-auth'){let reads=0;h.state.onRead=path=>{if(path==='authIdentities/uid-old'&&++reads===2)restore();};}
 else h.state.onRevoke=uid=>{if(uid==='uid-old')restore();};
 if(phase==='before-auth'){assert.equal((await h.run()).totals.sessionsRevoked,0);assert.deepEqual(h.state.revoked,[]);}
 else await assert.rejects(h.run(),{code:'unavailable'});
 assert.equal(h.state.records.get('authIdentities/uid-old').active,true);cases++;
}
for(const entry of ['preview','commit','scheduled'])for(const declared of ['company-b','',null,42,' ',{},['company-a']]){
 const h=setup(),config=h.state.records.get('staffImportConfigs/company-a');config.companyId=declared;config.scheduleEnabled=true;
 const before=JSON.stringify([...h.state.records]);
 if(entry==='scheduled')await h.api.syncStaffDirectoryScheduled();
 else await assert.rejects(entry==='preview'?h.api.previewStaffImport(h.request):h.run(),{code:'failed-precondition'},entry+':'+JSON.stringify(declared));
 assert.equal(h.state.sheetReads,0);assert.equal(h.state.writes,0);assert.deepEqual(h.state.revoked,[]);assert.equal(JSON.stringify([...h.state.records]),before);cases++;
}
for(const entry of ['preview','commit']){
 const h=setup();delete h.state.records.get('staffImportConfigs/company-a').companyId;
 const result=await (entry==='preview'?h.api.previewStaffImport(h.request):h.run());
 assert.equal(result.companyId,'company-a');assert.equal(result.samples[0].staffId,h.staffId);
 assert.equal(h.state.records.get('staffProfiles/'+h.staffId).companyId,'company-a');cases++;
}
const fixtureHash=email=>crypto.createHash('sha256').update(email).digest('hex');
for(const mode of ['claim','removed','missing','manual'])for(const owner of ['company','staff','unknown']){
 const h=setup(mode==='claim'?'removed':mode),email=['claim','manual'].includes(mode)?'keep@example.invalid':'old@example.invalid',indexPath='emailIndex/'+fixtureHash(email);
 const index=h.state.records.get(indexPath);
 if(owner==='company')index.companyId='company-b';
 if(owner==='staff')index.staffId='staff-b';
 if(owner==='unknown')delete index.staffId;
 const before=JSON.stringify(index),result=await h.run();
 assert.equal(JSON.stringify(h.state.records.get(indexPath)),before,mode+':'+owner);
 if(['claim','manual'].includes(mode)){assert.equal(result.totals.emailConflicts,1);assert.equal(h.state.records.get('staffProfiles/'+h.staffId).emails.includes(email),false);}
 cases++;
}
for(const mode of ['claim','removed','missing','manual'])for(const phase of ['after-read','commit'])for(const field of ['companyId','staffId']){
 const h=setup(mode==='claim'?'removed':mode),email=['claim','manual'].includes(mode)?'keep@example.invalid':'old@example.invalid',indexPath='emailIndex/'+fixtureHash(email);
 let changed;
 const mutate=()=>{h.state.records.get(indexPath)[field]='new-owner';changed=JSON.stringify(h.state.records.get(indexPath));};
 if(phase==='after-read')h.state.onRead=path=>{if(path===indexPath){delete h.state.onRead;mutate();}};
 else h.state.onCommit=writes=>{if(writes.some(([path])=>path===indexPath)){delete h.state.onCommit;mutate();}};
 if(['claim','manual'].includes(mode))await assert.rejects(h.run(),{code:'aborted'},mode+':'+phase+':'+field);
 else await h.run();
 assert.equal(JSON.stringify(h.state.records.get(indexPath)),changed);cases++;
}
for(const mode of ['removed','missing']){
 const h=setup(mode),indexPath='emailIndex/'+fixtureHash('old@example.invalid');h.state.records.delete(indexPath);
 await h.run();assert.equal(h.state.records.has(indexPath),false);cases++;
}
{
 const h=setup();h.state.rows=[['name','email','inactive'],['合成スタッフ','new@example.invalid',''],['合成スタッフ二','new@example.invalid','']];
 const result=await h.run(),index=h.state.records.get('emailIndex/'+fixtureHash('new@example.invalid'));
 assert.equal(result.totals.emailConflicts,1);assert.equal(index.staffId,h.staffId);
 assert.equal([...h.state.records].filter(([p,d])=>p.startsWith('staffProfiles/')&&d.emails?.includes('new@example.invalid')).length,1);cases++;
}
for(const mode of ['removed','missing'])for(const phase of ['after-read','commit']){
 const h=setup(mode),indexPath='emailIndex/'+fixtureHash('old@example.invalid');
 if(phase==='after-read')h.state.onRead=path=>{if(path===indexPath){delete h.state.onRead;h.state.records.delete(indexPath);}};
 else h.state.onCommit=writes=>{if(writes.some(([path])=>path===indexPath)){delete h.state.onCommit;h.state.records.delete(indexPath);}};
 await h.run();assert.equal(h.state.records.has(indexPath),false);cases++;
}
{
 const h=setup();for(const key of [...h.state.records.keys()])if(!key.startsWith('staffImportConfigs/'))h.state.records.delete(key);
 h.state.rows=[['name','email','inactive'],...Array.from({length:176},(_,i)=>['合成スタッフ'+i,'synthetic-'+i+'@example.invalid',''])];
 const result=await h.run();assert.equal(result.totals.profiles,176);assert.equal(result.totals.emailIndexesWritten,176);assert.equal(result.totals.firestoreWrites,352);
 assert.equal([...h.state.records.keys()].filter(key=>key.startsWith('emailIndex/')).length,176);assert.deepEqual(h.state.revoked,[]);cases++;
}
for(const mode of ['removed','missing'])for(const retry of ['same','new-company','new-staff','restored']){
 const h=setup(mode),profilePath='staffProfiles/'+h.staffId,oldEmails=Array.from({length:351},(_,i)=>'legacy-'+i+'@example.invalid');
 const profile=h.state.records.get(profilePath);profile.emails=oldEmails;profile.authUids=[];
 for(const path of [...h.state.records.keys()])if(path.startsWith('emailIndex/'))h.state.records.delete(path);
 for(const email of oldEmails)h.state.records.set('emailIndex/'+fixtureHash(email),{companyId:'company-a',staffId:h.staffId,email,active:true});
 let chunks=0;
 h.state.onCommit=writes=>{if(writes.some(([path,data])=>path.startsWith('emailIndex/')&&data?.active===false)&&++chunks===2)throw Error('Synthetic second release chunk failure');};
 await assert.rejects(h.run(),{code:'internal'});assert.equal(h.runs().at(-1).status,'error');
 const remaining=oldEmails.map(email=>'emailIndex/'+fixtureHash(email)).filter(path=>h.state.records.get(path).active===true);
 assert.ok(remaining.length>0&&remaining.length<351);
 if(mode==='removed')assert.deepEqual(Array.from(h.state.records.get(profilePath).emails),['keep@example.invalid']);else assert.equal(h.state.records.get(profilePath).active,false);
 delete h.state.onCommit;
 const moved=remaining[0];
 if(retry==='new-company')h.state.records.get(moved).companyId='company-b';
 if(retry==='new-staff')h.state.records.get(moved).staffId='staff-b';
 if(retry==='restored')h.state.rows=[['name','email','inactive'],['合成スタッフ',oldEmails.join(' '),'']];
 await h.run();
 for(const email of oldEmails){const path='emailIndex/'+fixtureHash(email),expected=retry==='restored'||(path===moved&&retry.startsWith('new-'));assert.equal(h.state.records.get(path).active,expected,mode+':'+retry+':remaining-index');}
 assert.equal(h.runs().at(-1).status,'completed');cases++;
}
function twoSheets(){const h=setup();h.state.records.get('staffImportConfigs/company-a').activeSheets=['fixture','secondary'];h.state.descriptors=[{title:'fixture',rowCount:2},{title:'secondary',rowCount:2}];h.state.sheetValues={fixture:[['name','email'],['合成スタッフ','keep@example.invalid']],secondary:[['name','email'],['合成スタッフ','old@example.invalid']]};return h;}
const directoryState=h=>JSON.stringify([...h.state.records].filter(([path])=>/^(staffProfiles|emailIndex|authIdentities)\//.test(path)));
for(const markMissing of [false,true])for(const failure of ['read','missing','hidden','limit','subset','row-limit','unknown-rows','duplicate']){
 const h=twoSheets(),config=h.state.records.get('staffImportConfigs/company-a');config.markMissingInactive=markMissing;
 if(failure==='read')h.state.failedSheet='secondary';
 if(failure==='missing')h.state.descriptors.pop();
 if(failure==='hidden')h.state.descriptors[1].hidden=true;
 if(failure==='limit')config.maxSheetsPerRun=1;
 if(failure==='subset')h.request.data={sheetNames:['fixture']};
 if(failure==='row-limit'){config.maxRowsPerSheet=100;h.state.descriptors[1].rowCount=101;}
 if(failure==='unknown-rows')h.state.descriptors[1].rowCount=0;
 if(failure==='duplicate')h.state.descriptors[1].title='fixture';
 const before=directoryState(h);
 await assert.rejects(h.run(),{code:'failed-precondition'},String(markMissing)+':'+failure);
 assert.equal(directoryState(h),before);assert.deepEqual(h.state.revoked,[]);assert.equal(h.runs().at(-1).status,'error');assert.equal(h.state.records.has('syncLocks/company-a_staff_import'),false);cases++;
}
for(const failure of ['read','missing','hidden','limit','subset','row-limit','unknown-rows','duplicate']){
 const h=twoSheets(),config=h.state.records.get('staffImportConfigs/company-a');
 if(failure==='read')h.state.failedSheet='secondary';
 if(failure==='missing')h.state.descriptors.pop();
 if(failure==='hidden')h.state.descriptors[1].hidden=true;
 if(failure==='limit')config.maxSheetsPerRun=1;
 if(failure==='subset')h.request.data={sheetNames:['fixture']};
 if(failure==='row-limit'){config.maxRowsPerSheet=100;h.state.descriptors[1].rowCount=101;}
 if(failure==='unknown-rows')h.state.descriptors[1].rowCount=0;
 if(failure==='duplicate')h.state.descriptors[1].title='fixture';
 const before=JSON.stringify([...h.state.records]),result=await h.api.previewStaffImport(h.request);
 assert.ok(result.warnings.length>0,failure);assert.equal(JSON.stringify([...h.state.records]),before);assert.deepEqual(h.state.revoked,[]);cases++;
}
for(const requested of [undefined,['fixture','secondary']]){
 const h=twoSheets();if(requested)h.request.data={sheetNames:requested};const result=await h.run();assert.equal(result.totals.sessionsRevoked,0);assert.equal(result.totals.multipleEmailProfiles,1);assert.equal(h.state.records.get('staffProfiles/'+h.staffId).emails.length,2);cases++;
}
{
 const h=twoSheets(),config=h.state.records.get('staffImportConfigs/company-a');config.activeSheets.push('excluded');config.excludedSheets=['excluded'];h.state.descriptors.push({title:'excluded',rowCount:2});h.state.failedSheet='excluded';assert.equal((await h.run()).totals.sessionsRevoked,0);cases++;
}
for(const entry of ['preview','commit'])for(const fault of ['name-column','email-column','optional-column','blank-name','blank-email','same-column','huge-column']){
 const h=setup(),config=h.state.records.get('staffImportConfigs/company-a');
 if(fault==='name-column')config.columns.displayName='Z';
 if(fault==='email-column')config.columns.email='Z';
 if(fault==='optional-column')config.columns.manualInactive='Z';
 if(fault==='blank-name')config.columns.displayName=' ';
 if(fault==='blank-email')config.columns.email=' ';
 if(fault==='same-column')config.columns.email='A';
 if(fault==='huge-column'){config.readRangeEndColumn='Z'.repeat(30);config.columns.email='Z'.repeat(30);}
 const before=directoryState(h);
 await assert.rejects(entry==='preview'?h.api.previewStaffImport(h.request):h.run(),{code:'failed-precondition'},entry+':'+fault);
 assert.equal(directoryState(h),before);assert.equal(h.state.sheetReads,0);assert.equal(h.state.writes,0);assert.deepEqual(h.state.revoked,[]);cases++;
}
for(const markMissing of [false,true])for(const fault of ['header-missing','before-header','equal-header','after-data','outside-grid']){
 const h=setup(),config=h.state.records.get('staffImportConfigs/company-a');config.markMissingInactive=markMissing;h.state.descriptors=[{title:'fixture',rowCount:10}];
 if(fault==='header-missing'){config.headerRow=5;config.dataStartRow=6;}
 if(fault==='before-header'){config.headerRow=2;config.dataStartRow=1;}
 if(fault==='equal-header')config.dataStartRow=1;
 if(fault==='after-data')config.dataStartRow=3;
 if(fault==='outside-grid'){h.state.rows=[['name','email']];config.dataStartRow=12;}
 const before=directoryState(h);await assert.rejects(h.run(),{code:'failed-precondition'},String(markMissing)+':'+fault);assert.equal(directoryState(h),before);assert.deepEqual(h.state.revoked,[]);cases++;
}
for(const kind of ['header-only','empty-spacer','lowercase-columns','data-after-spacer']){
 const h=setup(),config=h.state.records.get('staffImportConfigs/company-a');
 if(kind==='header-only')h.state.rows=[['name','email']];
 if(kind==='empty-spacer'){h.state.rows=[['name','email']];h.state.descriptors=[{title:'fixture',rowCount:10}];config.dataStartRow=5;}
 if(kind==='lowercase-columns'){config.columns={displayName:' a ',email:' b ',phone:' '};config.readRangeEndColumn='B';}
 if(kind==='data-after-spacer'){h.state.rows=[['name','email'],[],['合成スタッフ','keep@example.invalid']];config.dataStartRow=3;}
 const result=await h.run();assert.equal(result.totals.profiles,kind==='header-only'||kind==='empty-spacer'?0:1);cases++;
}
for(const scenario of ['complete','read-failed','missing-tab','bad-row']){
 let h=setup();if(scenario==='read-failed')h.state.failedSheet='fixture';
 if(scenario==='missing-tab')h.state.records.get('staffImportConfigs/company-a').activeSheets.push('missing');
 if(scenario==='bad-row')h.state.records.get('staffImportConfigs/company-a').headerRow=5;
 const app=fs.readFileSync('apps/admin/src/App.tsx','utf8'),from=app.indexOf('  async function previewStaffSync()'),to=app.indexOf('  async function runStaffSync()',from);assert.ok(from>=0&&to>from);
 const ui={summary:'',message:'',busy:false},ctx={Error,firebaseConfigured:true,functions:{},httpsCallable:(_f,name)=>async()=>{assert.equal(name,'previewStaffImport');return {data:await h.api.previewStaffImport(h.request)};},setStaffSyncSummary:v=>ui.summary=v,setMessage:v=>ui.message=v,setStaffSyncBusy:v=>ui.busy=v};
 runInNewContext(compile(app.slice(from,to)),ctx);await ctx.previewStaffSync();
 assert.equal(ui.busy,false);assert.equal(h.state.writes,0);assert.deepEqual(h.state.revoked,[]);
 if(scenario==='complete'){assert.match(ui.message,/プレビューが完了/);assert.doesNotMatch(ui.summary,/要確認/);}
 else{assert.match(ui.message,/確認が必要/);assert.match(ui.summary,/要確認/);assert.doesNotMatch(ui.message,/プレビューが完了/);h=setup();await ctx.previewStaffSync();assert.match(ui.message,/プレビューが完了/);assert.doesNotMatch(ui.summary,/要確認/);}
 cases++;
}

for(const entry of ['preview','commit','scheduled'])for(const control of [undefined,{productionEnabled:false},{productionEnabled:true,emergencyLock:true}]){
 const h=setup();h.state.environment='production';h.state.records.set('staffImportConfigs/company-a',{...h.state.records.get('staffImportConfigs/company-a'),scheduleEnabled:true});
 if(control)h.state.records.set('productionControls/company-a',control);else h.state.records.delete('productionControls/company-a');
 const before=JSON.stringify([...h.state.records]);
 if(entry==='preview')await h.api.previewStaffImport(h.request);
 else if(entry==='commit')await assert.rejects(h.run(),{code:'failed-precondition'});
 else await h.api.syncStaffDirectoryScheduled();
 assert.equal(JSON.stringify([...h.state.records]),before);assert.equal(h.state.writes,0);assert.deepEqual(h.state.revoked,[]);if(entry!=='preview')assert.equal(h.state.sheetReads,0);cases++;
}
{ const h=setup();h.state.environment='production';await h.run();assert.equal(h.runs().at(-1).status,'completed');cases++; }
const leasePath='syncLocks/company-a_staff_import';
function damageLease(h,kind){
 const lease=h.state.records.get(leasePath);assert.ok(lease);
 if(kind==='missing')h.state.records.delete(leasePath);
 else h.state.records.set(leasePath,{...lease,...(kind==='owner'?{token:'new-owner'}:kind==='company'?{companyId:'other'}:kind==='invalid'?{leaseUntil:1}:{leaseUntil:Timestamp.fromMillis(0)})});
}
for(const stage of ['directory','transaction-retry','before-auth','after-auth'])for(const kind of ['missing','owner','company','invalid','expired']){
 const h=setup(),before=directoryState(h);let triggered=false,directoryCommitted=false;
 h.state.onCommit=writes=>{
  if(writes.some(([p])=>p.startsWith('staffProfiles/'))){
   directoryCommitted=true;
   if(stage==='transaction-retry'&&!triggered){triggered=true;damageLease(h,kind);}
  }
 };
 h.state.onWrite=path=>{if(stage==='directory'&&path.startsWith('staffImportRuns/')&&!triggered){triggered=true;damageLease(h,kind);}};
 h.state.onRead=path=>{if(stage==='before-auth'&&directoryCommitted&&path.startsWith('authIdentities/')&&!triggered){triggered=true;damageLease(h,kind);}};
 h.state.onRevoke=()=>{if(stage==='after-auth'&&!triggered){triggered=true;damageLease(h,kind);}};
 await assert.rejects(h.run(),{code:stage==='directory'||stage==='transaction-retry'?'aborted':'unavailable'},stage+':'+kind);
 assert.equal(triggered,true);assert.equal(h.state.records.get('authIdentities/uid-old').active,true);
 if(stage==='directory'||stage==='transaction-retry')assert.equal(directoryState(h),before);
 assert.equal(h.state.revoked.length,stage==='after-auth'?1:0);
 if(kind==='owner')assert.equal(h.state.records.get(leasePath).token,'new-owner');cases++;
}

console.log(JSON.stringify({cases,passed:true,realSheets:false,realAuth:false,cloudChanges:false}));
