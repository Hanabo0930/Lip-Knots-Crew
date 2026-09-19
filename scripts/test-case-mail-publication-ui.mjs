import assert from "node:assert/strict";
import fs from "node:fs";
import {runInNewContext} from "node:vm";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url),ts=require("typescript");
const source=fs.readFileSync(new URL("../apps/admin/src/App.tsx",import.meta.url),"utf8");
const start=source.indexOf("async function changePublicationAction("),end=source.indexOf("function loadJobEdit(",start);assert.ok(start>0&&end>start);
const code=ts.transpileModule(source.slice(start,end)+"\nexports.change=changePublicationAction;",{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const fixture=()=>({id:"job-1",revision:7,mailIntake:{receiptId:"r",candidateId:"c",sourceKey:"s"},workDate:"2099-10-10",clientName:"合成取引先",storeName:"合成店舗",makerName:"合成メーカー",menuName:"試食",menuConditions:["白シャツ"],entryTime:"09:30",workTime:"10:00-18:00"});
function setup(yes=true,blocked=false){const prompts=[],calls=[],messages=[],exports={};let current=true;
runInNewContext(code,{exports,Number,window:{confirm:message=>{prompts.push(message);return typeof yes==="function"?yes():yes;}},firebaseConfigured:true,functions:{},
httpsCallable:(_functions,name)=>async input=>{calls.push({name,input});return{data:{updated:blocked?[]:["job-1"],blocked:blocked?["job-1"]:[]}};},
setMessage:value=>messages.push(value),refreshJobsAfterAction:async(value,active)=>{if(active())messages.push(value);}});
return{prompts,calls,messages,change:(job=fixture(),action="publish")=>exports.change(job,action,()=>current),invalidate:()=>current=false};}
let count=0;async function test(name,run){await run();count++;console.log("成功: "+name);}
await test("表示内容・条件を確認して同じ版を既存APIへ送る",async()=>{const h=setup();await h.change();assert.ok(h.prompts[0].includes("白シャツ"));assert.ok(h.prompts[0].includes("10:00-18:00"));assert.equal(h.calls[0].name,"updateJobPublication");assert.equal(h.calls[0].input.expectedRevisions["job-1"],7);});
await test("確認を戻したら送信しない",async()=>{const h=setup(false);await h.change();assert.equal(h.calls.length,0);});
await test("版が欠落していれば送信しない",async()=>{const h=setup(),job=fixture();delete job.revision;await h.change(job);assert.equal(h.calls.length,0);assert.equal(h.prompts.length,0);});
await test("受信変更保留なら送信しない",async()=>{const h=setup();await h.change({...fixture(),mailIntakeReviewRequired:true});assert.equal(h.calls.length,0);assert.equal(h.prompts.length,0);});
await test("確認中のログイン変更で送信しない",async()=>{const h=setup(()=>{h.invalidate();return true;});await h.change();assert.equal(h.calls.length,0);});
await test("確認中に状態が変わっても表示前の版を送る",async()=>{const job=fixture(),h=setup(()=>{job.revision=8;return true;});await h.change(job);assert.equal(h.calls[0].input.expectedRevisions["job-1"],7);});
await test("拒否応答を下書き化成功として表示しない",async()=>{const h=setup(true,true);await h.change();assert.match(h.messages[0],/募集を開始できません/);assert.ok(!h.messages[0].includes("下書きのまま"));});
await test("既存案件と募集停止の操作を維持",async()=>{const h=setup(),job=fixture();delete job.mailIntake;await h.change(job);await h.change(fixture(),"stop");assert.equal(h.prompts.length,0);assert.equal(h.calls.length,2);});
console.log("受信案件の募集画面操作: "+count+"条件成功（実App関数・通信模擬）");
