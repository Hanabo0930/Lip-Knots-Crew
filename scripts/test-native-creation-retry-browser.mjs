import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {chromium} from '@playwright/test';
const output=resolve(process.argv[2]??'release-evidence/native-creation-retry-browser');mkdirSync(output,{recursive:true});
const states=new Map(),results=[],errors=[],external=[];
const fakeAuth=`const listeners=new Set();let claims={companyId:'synthetic-company',role:'admin'};
const user={uid:'synthetic-admin',getIdTokenResult:async()=>({claims:{...claims}})};
export const auth={currentUser:user,onIdTokenChanged:fn=>{listeners.add(fn);queueMicrotask(()=>{if(listeners.has(fn))fn(auth.currentUser);});return()=>listeners.delete(fn);}};
export const functions={};window.changeOwner=()=>{claims={companyId:'other-company',role:'admin'};for(const fn of listeners)fn(user);};`;
const fakeFunctions=`export const httpsCallable=(_functions,name)=>async payload=>{const response=await fetch('/__native_rpc?run='+new URLSearchParams(location.search).get('run'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,payload})});const result=await response.json();if(!result.ok)throw Error(result.message);return {data:result.data};};`;
const html=`<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import Panel from '/src/NativeCreationRecovery.tsx';import {submitNativeCreation} from '/src/native-creation-client.ts';import '/src/styles.css';
window.start=async(kind='create')=>{try{await submitNativeCreation({kind,input:{workDate:'2026-10-10',slots:2,clientName:'合成会社'}},()=>true);}catch(error){document.getElementById('fixture-status').textContent=error.message;}};
createRoot(document.getElementById('root')).render(React.createElement('main',{className:'shell'},React.createElement('h1',null,'案件管理'),React.createElement('p',{id:'fixture-status'}),React.createElement(Panel)));</script>`;
const server=await createServer({root:resolve('apps/admin'),configFile:resolve('apps/admin/vite.config.ts'),server:{host:'127.0.0.1',port:0},plugins:[{name:'native-retry-fixture',enforce:'pre',resolveId(id,importer){if(importer&&/native-creation-client\.ts|NativeCreationRecovery\.tsx/.test(importer)){if(id==='./firebase')return '\0native-auth';if(id==='firebase/functions')return '\0native-functions';}},load(id){if(id==='\0native-auth')return fakeAuth;if(id==='\0native-functions')return fakeFunctions;},configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url,'http://localhost');if(url.pathname==='/__native_test.html'){res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(url.pathname,html));return;}if(url.pathname!=='/__native_rpc')return next();
 const state=states.get(url.searchParams.get('run'));let text='';for await(const chunk of req)text+=chunk;const {name,payload}=JSON.parse(text),c=payload.nativeCreation;state.calls.push({name,payload});
 if(state.hold)await new Promise(done=>state.release=done);
 let receipt=state.receipts.get(c.operationId);if(!receipt){receipt={nativeCreationReceipt:{version:1,companyId:c.expectedCompanyId,actorUid:c.expectedActorUid,operationId:c.operationId,kind:name==='createAdminJobGroup'?'create':'duplicate',status:c.action==='cancel'?'cancelled':'committed'},groupId:'synthetic-group',jobIds:['job-1','job-2']};state.receipts.set(c.operationId,receipt);if(c.action!=='cancel')state.creates++;}
 res.setHeader('Content-Type','application/json');if(state.lose){state.lose=false;res.end(JSON.stringify({ok:false,message:'合成：応答が途切れました'}));}else res.end(JSON.stringify({ok:true,data:receipt}));
 });}}]});
let browser;
async function until(fn){const end=Date.now()+10000;while(!fn()){assert.ok(Date.now()<end,'fixture timed out');await new Promise(r=>setTimeout(r,15));}}
try{
 assert.ok(!Object.entries(server.config.env).some(([k,v])=>k.startsWith('VITE_FIREBASE_')&&v));await server.listen();browser=await chromium.launch({headless:true});const base='http://127.0.0.1:'+server.httpServer.address().port;
 for(const width of [320,390,1280]){
  const run='width-'+width,state={calls:[],receipts:new Map(),creates:0,lose:true};states.set(run,state);const context=await browser.newContext({viewport:{width,height:900}});
  await context.route('**/*',route=>{if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();external.push(route.request().url());return route.abort();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/__native_test.html?run='+run);await page.waitForFunction(()=>typeof window.start==='function');
  await page.evaluate(()=>window.start('duplicate'));await page.getByText('合成：応答が途切れました',{exact:true}).waitFor();const original=state.calls[0].payload;
  await page.getByRole('button',{name:'作成結果を確認',exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:resolve(output,'pending-'+width+'.png'),fullPage:true});
  await page.reload();await page.getByRole('button',{name:'作成結果を確認',exact:true}).click();await page.getByText(/2件の作成済み案件を確認/).waitFor();assert.deepEqual(state.calls[1].payload,original);assert.equal(state.creates,1);
  assert.equal(await page.getByRole('button',{name:'作成結果を確認',exact:true}).count(),0);results.push({width,reloadRecovery:true,creates:state.creates});await context.close();
 }
 for(const committed of [false,true]){
  const run='cancel-'+committed,state={calls:[],receipts:new Map(),creates:0,lose:committed};states.set(run,state);const context=await browser.newContext();await context.route('**/*',r=>{if(new URL(r.request().url()).hostname==='127.0.0.1')return r.continue();external.push(r.request().url());return r.abort();});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/__native_test.html?run='+run);await page.waitForFunction(()=>typeof window.start==='function');
  if(committed)await page.evaluate(()=>window.start());else await page.evaluate(()=>{const owner={companyId:'synthetic-company',uid:'synthetic-admin'},value={version:1,owner,operationId:crypto.randomUUID(),kind:'create',input:{workDate:'2026-10-10',slots:2}};localStorage.setItem('lkc.nativeCreation.v1:'+JSON.stringify([owner.companyId,owner.uid]),JSON.stringify(value));window.dispatchEvent(new Event('lkc-native-creation-changed'));});
  page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'未完了なら取り消す',exact:true}).click();assert.equal(state.calls.length,committed?1:0);
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'未完了なら取り消す',exact:true}).click();await page.getByText(committed?/2件の作成済み案件を確認/:/未完了の作成依頼を取り消しました/).waitFor();assert.equal(state.creates,committed?1:0);results.push({cancel:true,alreadyCommitted:committed,creates:state.creates});await context.close();
 }
 {
  const run='tabs',state={calls:[],receipts:new Map(),creates:0,hold:true};states.set(run,state);const context=await browser.newContext();await context.route('**/*',r=>{if(new URL(r.request().url()).hostname==='127.0.0.1')return r.continue();external.push(r.request().url());return r.abort();});const first=await context.newPage(),second=await context.newPage();for(const p of [first,second]){p.on('pageerror',e=>errors.push(e.message));await p.goto(base+'/__native_test.html?run='+run);await p.waitForFunction(()=>typeof window.start==='function');}
  await first.evaluate(()=>{void window.start();});await until(()=>state.release);await second.getByRole('button',{name:'作成結果を確認',exact:true}).click();await second.getByText(/別の画面で作成結果を確認しています/).waitFor();assert.equal(state.calls.length,1);
  await first.evaluate(()=>window.changeOwner());state.hold=false;state.release();await until(()=>state.creates===1);await first.getByRole('heading',{name:'案件管理',exact:true}).waitFor();assert.equal(await first.getByRole('button',{name:'作成結果を確認',exact:true}).count(),0);
  await second.getByRole('button',{name:'作成結果を確認',exact:true}).click();await second.getByText(/2件の作成済み案件を確認/).waitFor();assert.equal(state.creates,1);results.push({multipleTabs:true,claimChange:true,creates:state.creates});await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);writeFileSync(resolve(output,'result.json'),JSON.stringify({passed:results.length,results,pageErrors:errors,externalRequests:external,realApiCalls:0},null,2));console.log(JSON.stringify({browserCases:results.length,pageErrors:errors.length,externalRequests:external.length}));
}finally{for(const state of states.values())state.release?.();await browser?.close();await server.close();}
