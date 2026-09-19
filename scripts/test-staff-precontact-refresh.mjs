import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';import {runInNewContext} from 'node:vm';
const app=fs.readFileSync('apps/staff/src/App.tsx','utf8'),start=app.indexOf('  const preContactDraftKey='),end=app.indexOf('  const [submissionType',start);assert.ok(start>=0&&end>start);const code=ts.transpileModule('(()=>{'+app.slice(start,end)+'})()', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const state={};let previous;const ctx={setPreContactError:v=>state.error=v,user:{uid:'user'},companyId:'company',staffId:'staff',selectedJob:{id:'one',preContact:{temperature:36.5,arrivalTime:'9:00'}},preContactDraftsRef:{current:new Map()},setTemperature:v=>state.temperature=v,setArrivalTime:v=>state.time=v,useEffect:(fn,deps)=>{if(!previous||deps.some((v,i)=>v!==previous[i])){fn();previous=deps;}}};const render=()=>runInNewContext(code,ctx);
render();assert.equal(state.time,'09:00');assert.equal(state.temperature,'36.5');
ctx.selectedJob={id:'one',preContact:{temperature:36.8,arrivalTime:'10:15'}};render();assert.equal(state.time,'10:15');assert.equal(state.temperature,'36.8');
ctx.preContactDraftsRef.current.set('user|company|staff|one|',{temperature:'37.0',arrivalTime:'11:30'});ctx.selectedJob={id:'one',preContact:{temperature:36.2,arrivalTime:'10:30'}};render();assert.equal(state.time,'11:30');assert.equal(state.temperature,'37.0');
ctx.selectedJob={id:'two',preContact:{temperature:36.1,arrivalTime:'8:05'}};render();assert.equal(state.time,'08:05');
ctx.selectedJob={id:'one',preContact:{temperature:36.2,arrivalTime:'10:30'}};render();assert.equal(state.time,'11:30');
ctx.preContactDraftsRef.current.clear();ctx.selectedJob={id:'one',preContact:{temperature:null,arrivalTime:'invalid'}};render();assert.equal(state.time,'');assert.equal(state.temperature,'');

const source=app.replace(/\r\n/g,'\n');
const resetStart=source.indexOf('  function resetPreContactInput('),resetEnd=source.indexOf('  async function submitPreContact(',resetStart);
assert.ok(resetStart>=0&&resetEnd>resetStart);
const resetCode=ts.transpileModule(source.slice(resetStart,resetEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const exitStart=source.lastIndexOf('  useEffect(()=>{',source.indexOf('    const preventPreContactExit=')),exitEnd=source.indexOf('  },[user?.uid,companyId,staffId,myJobs]);',exitStart);
assert.ok(exitStart>=0&&exitEnd>exitStart);
const exitCode=ts.transpileModule(source.slice(exitStart,exitEnd)+'  },[]);',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
for(const savedTime of [['9:00'],{},true,900,null,undefined,'25:00','09:70']){
 ctx.preContactDraftsRef.current.clear();ctx.selectedJob={id:'one',preContact:{temperature:36.5,arrivalTime:savedTime}};render();assert.equal(state.time,'');
 ctx.preContactDraftKey='user|company|staff|one|';ctx.isPending=()=>false;ctx.confirm=()=>true;
 ctx.preContactDraftsRef.current.set(ctx.preContactDraftKey,{temperature:'36.8',arrivalTime:'10:00'});
 runInNewContext(resetCode,ctx);ctx.resetPreContactInput();assert.equal(state.time,'');assert.equal(ctx.preContactDraftsRef.current.size,0);
 let listener;const exitCtx={...ctx,myJobs:[ctx.selectedJob],useEffect:fn=>fn(),window:{addEventListener:(name,fn)=>{assert.equal(name,'beforeunload');listener=fn;},removeEventListener:()=>{}}};
 runInNewContext(exitCode,exitCtx);
 for(const arrivalTime of ['', '10:00']){ctx.preContactDraftsRef.current.set(ctx.preContactDraftKey,{temperature:'36.5',arrivalTime});let prevented=false;const event={preventDefault:()=>{prevented=true;}};listener(event);assert.equal(prevented,arrivalTime!=='');}
}

for(const savedTemperature of [{},[36.5],true,'36.5',null,undefined,NaN,Infinity]){
 ctx.preContactDraftsRef.current.clear();ctx.selectedJob={id:'one',preContact:{temperature:savedTemperature,arrivalTime:'09:00'}};render();assert.equal(state.temperature,'');
 ctx.preContactDraftsRef.current.set(ctx.preContactDraftKey,{temperature:'36.8',arrivalTime:'09:00'});ctx.resetPreContactInput();assert.equal(state.temperature,'');assert.equal(ctx.preContactDraftsRef.current.size,0);
 let listener;runInNewContext(exitCode,{...ctx,myJobs:[ctx.selectedJob],useEffect:fn=>fn(),window:{addEventListener:(name,fn)=>{listener=fn;},removeEventListener:()=>{}}});
 for(const temperature of ['', '36.5']){ctx.preContactDraftsRef.current.set(ctx.preContactDraftKey,{temperature,arrivalTime:'09:00'});let prevented=false;listener({preventDefault:()=>{prevented=true;}});assert.equal(prevented,temperature!=='');}
}

const noticeMarker='selectedJob.preContact!=null&&<p',noticeStart=app.indexOf(noticeMarker,app.indexOf('aria-label="選択したシフトの詳細"')),noticeEnd=app.indexOf('</p>}',noticeStart)+4;
assert.ok(noticeStart>0&&noticeEnd>noticeStart);
const noticeCode=ts.transpileModule('function Notice(){return ('+app.slice(noticeStart,noticeEnd)+');}',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
for(const temperature of [{},[36.5],true,'36.5',null,undefined,NaN,Infinity,36.5]){
 const context={React,selectedJob:{preContact:{temperature,arrivalTime:'09:00'}}};runInNewContext(noticeCode,context);const html=renderToStaticMarkup(React.createElement(context.Notice));assert.equal(html.includes('登録内容：体温'),temperature===36.5);assert.equal(html.includes('「シフトを更新」'),temperature!==36.5);
}

for(const preContact of [null,undefined,{},[],true,{temperature:33,arrivalTime:'09:00'},{temperature:43,arrivalTime:'09:00'},{temperature:36.5,arrivalTime:['09:00']},{temperature:36.5,arrivalTime:'25:00'},{temperature:36.5,arrivalTime:''},{temperature:34,arrivalTime:'0:00'},{temperature:42,arrivalTime:'23:59'}]){
 const context={React,selectedJob:{preContact}};runInNewContext(noticeCode,context);const html=renderToStaticMarkup(React.createElement(context.Notice));
 if(preContact==null)assert.equal(html,'');else if(preContact.temperature===34||preContact.temperature===42){assert.ok(html.includes('登録内容：体温'));assert.ok(!html.includes('「シフトを更新」'));}else{assert.ok(html.includes('「シフトを更新」'));assert.ok(!html.includes('登録内容：体温'));assert.ok(html.includes('role="status"'));}
}
console.log('Precontact refresh passed: restore/reset/exit protection and 21 registered notice cases including invalid/missing data and boundaries.');

ctx.selectedJob={id:'one',dateKey:'2099-09-20',preContact:null};ctx.preContactDraftsRef.current.set('user|company|staff|one|2099-09-20',{temperature:'37.2',arrivalTime:'09:30'});render();assert.equal(state.temperature,'37.2');
ctx.selectedJob={id:'one',dateKey:'2099-09-21',preContact:null};render();assert.equal(state.temperature,'');assert.equal(state.time,'');
ctx.selectedJob={id:'one',dateKey:'2099-09-20',preContact:null};render();assert.equal(state.temperature,'37.2');
const readinessStart=app.indexOf('function preContactReadinessMessage('),readinessEnd=app.indexOf('function bootstrapRefreshToken(',readinessStart);
assert.ok(readinessStart>=0&&readinessEnd>readinessStart);
const readinessCode=ts.transpileModule(app.slice(readinessStart,readinessEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const syncStart=app.indexOf('{preContactReadinessMessage(selectedJob)&&<p'),syncEnd=app.indexOf('<div className="form-grid">',syncStart);
assert.ok(syncStart>0&&syncEnd>syncStart);
const syncCode=ts.transpileModule('function SyncNotice(){return (<>'+app.slice(syncStart,syncEnd)+'</>);}',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
for(const flags of [{},{preContactNeedsReview:true},{preContactSyncPending:true},{preContactNeedsReview:true,preContactSyncPending:true},{preContactNeedsReview:'true',preContactSyncPending:'true'}]){
 const context={React,selectedJob:flags};runInNewContext(readinessCode+syncCode,context);const html=renderToStaticMarkup(React.createElement(context.SyncNotice));
 assert.equal(html.includes('事前連絡を入力し、内容を確認して送信'),flags.preContactNeedsReview===true);assert.equal(html.includes('反映は未確認'),flags.preContactNeedsReview!==true&&flags.preContactSyncPending===true);
}
console.log('Precontact source status and date-specific drafts passed.');
for(const [flag,reason] of [['sourceMissing','取込元'],['applicationUnconfirmed','シフト表の担当確認'],['assignmentUnresolved','担当者の照合']]){
 const context={React,selectedJob:{[flag]:true,preContactNeedsReview:true,preContactSyncPending:true}};runInNewContext(readinessCode+syncCode,context);const html=renderToStaticMarkup(React.createElement(context.SyncNotice));
 assert.ok(html.includes(reason));assert.ok(html.includes('id="precontact-readiness"'));assert.ok(html.includes('role="status"'));
 assert.equal(html.includes('事前連絡を入力し、内容を確認して送信'),false);assert.equal(html.includes('反映は未確認'),false);
}
console.log('Precontact readiness notices passed: three blocked states precede input/sync instructions.');

for(const flags of [{mailIntakeReviewRequired:true},{mailIntake:{},pendingSourceWrite:true},{mailIntake:{},adminEditSheetWrite:{pending:true}}]){
 const context={React,selectedJob:{...flags,preContactNeedsReview:true,preContactSyncPending:true}};runInNewContext(readinessCode+syncCode,context);
 const html=renderToStaticMarkup(React.createElement(context.SyncNotice));assert.ok(html.includes("受信内容・勤務条件"));assert.equal(html.includes("事前連絡を入力し、内容を確認して送信"),false);
}
console.log("受信案件の保留表示3条件成功");
