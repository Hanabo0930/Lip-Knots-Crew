import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import {createServer} from "vite";
import {chromium} from "@playwright/test";
import {harness,companyId,workDate} from "./automation-intake-test-harness.mjs";
const output=process.argv[2]?path.resolve(process.argv[2]):null;if(output)fs.mkdirSync(output,{recursive:true});
function seed(){
 const h=harness();h.records.get(h.paths.job).internalMemo="private-internal";h.records.get(h.paths.bindingOwner).actorUid="private-actor";
 return {h,targets:{version:1,kind:"recruitment.import-targets",companyId,sourceOperationId:"synthetic-campaign",area:"normal",cases:[{fixedCaseId:h.incoming.fixedCaseId,workDate}]},calls:[],release:null,last:null};
}
const modules=new Map();
function client(name){if(modules.has(name))return modules.get(name);const exports={};modules.set(name,exports);const code=ts.transpileModule(fs.readFileSync("apps/admin/src/"+name.slice(2)+".ts","utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;runInNewContext(code,{exports,require:client,TextEncoder});return exports;}
const model=client("./import-snapshot");
{
 const state=seed(),targets=model.parseImportTargetsText(JSON.stringify(state.targets),companyId),response=await state.h.importSnapshot({expectedCompanyId:companyId,expectedActorUid:state.h.admin.uid,targets});
 assert.equal(model.appImportSnapshotResult(response,targets).snapshot.records[0].job.id,"synthetic-job");
 for(const data of ["broken"," ".repeat(262145),JSON.stringify({...state.targets,companyId:"other"}),JSON.stringify({...state.targets,token:"private"}),JSON.stringify({...state.targets,cases:[...state.targets.cases,...state.targets.cases]})])assert.throws(()=>model.parseImportTargetsText(data,companyId));
 for(const mutate of [
  row=>row.snapshot.companyId="other",row=>row.summary[0].jobId="other",row=>row.snapshot.records[0].job.token="private",
  row=>row.snapshot.records[0].job.assignedStaffId="another",row=>row.snapshot.records[0].owner.revision="other",
  row=>row.snapshot.records[0].job.sourceMissing=true,row=>row.snapshot.policy.phase="app",row=>row.snapshot.records=[],
  row=>row.snapshot.capturedAt="bad",row=>row.dispatch="enabled",
 ]){const wrong=JSON.parse(JSON.stringify(response));mutate(wrong);assert.throws(()=>model.appImportSnapshotResult(wrong,targets));}
 console.log("照合データの画面モデル: 正式応答/不正入力5種/不正応答10種の拒否に成功。");
}
const runs=new Map();
function html(run){
 const code=[
 'import React from "react";import {createRoot} from "react-dom/client";import Panel from "/src/ImportSnapshotPanel.tsx";import "/src/styles.css";',
 'window.fault=null;',
 'function Fixture(){const [visible,setVisible]=React.useState(true),[owner,setOwner]=React.useState({companyId:'+JSON.stringify(companyId)+',uid:"synthetic-producer-user"});window.changeOwner=()=>setOwner({companyId:"other-company",uid:"other-admin"});',
 'const read=async targets=>{const response=await fetch("/__snapshot_rpc?run='+run+'",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner,targets,fault:window.fault})});const result=await response.json();if(!result.ok)throw Error(result.error);return result.data;};',
 'const send=async(action,input)=>{const response=await fetch("/__snapshot_rpc?run='+run+'",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner,action,input,fault:window.fault})});const result=await response.json();if(!result.ok)throw Error(result.error);return result.data;};',
 'return <main className="shell"><button id="open" onClick={()=>setVisible(true)}>照合データを開く</button>{visible&&<Panel key={owner.companyId+owner.uid} {...owner} api={{read}} registrationApi={{preview:campaign=>send("preview",{campaign}),register:input=>send("register",input),cancel:input=>send("cancel",input)}} onClose={()=>{setVisible(false);requestAnimationFrame(()=>document.getElementById("open").focus());}}/>}</main>;}createRoot(document.getElementById("root")).render(<Fixture/>);'
 ].join("\n");
 return '<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">'+ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,jsx:ts.JsxEmit.React}}).outputText+'</script>';
}
const server=await createServer({root:path.resolve("apps/admin"),configFile:path.resolve("apps/admin/vite.config.ts"),server:{host:"127.0.0.1",port:0},plugins:[{name:"snapshot-fixture",configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url,"http://localhost"),run=url.searchParams.get("run");
 if(url.pathname.startsWith("/__snapshot_test-")){res.setHeader("Content-Type","text/html");res.end(await dev.transformIndexHtml(url.pathname+url.search,html(run)));return;}
 if(url.pathname!=="/__snapshot_rpc")return next();
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const call=JSON.parse(Buffer.concat(chunks).toString()),state=runs.get(run);state.calls.push(call);
  if(call.fault==="hold")await new Promise(resolve=>state.release=resolve);if(call.fault==="offline")throw Error("合成テストの通信断");
  const context={expectedCompanyId:call.owner.companyId,expectedActorUid:call.owner.uid};
  const data=call.action==="preview"?await state.h.previewCampaign({...context,...call.input}):call.action==="register"?await state.h.registerCampaign({...context,...call.input}):call.action==="cancel"?await state.h.cancelCampaign({...context,...call.input}):await state.h.importSnapshot({...context,targets:call.targets});state.last=data;
  if(call.action==="register"&&call.fault==="lost-register")throw Error("登録応答の合成通信断");
  if(call.fault==="malformed")data.summary[0].jobId="other";
  res.setHeader("Content-Type","application/json");res.end(JSON.stringify({ok:true,data}));
 }catch(error){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({ok:false,error:error.message}));}
});}}]});
const blockExternal=page=>page.route("**/*",route=>new URL(route.request().url()).hostname==="127.0.0.1"?route.continue():route.abort());
const panelFor=page=>page.getByRole("region",{name:"アプリの照合データ",exact:true});
async function waitRelease(state){for(let n=0;n<100;n++){if(state.release){const release=state.release;state.release=null;return release;}await new Promise(resolve=>setTimeout(resolve,50));}throw Error("保留読取が届きません");}
let browser;const results=[];
try{
 assert.ok(!Object.entries(server.config.env).some(([key,value])=>key.startsWith("VITE_FIREBASE_")&&value));await server.listen();browser=await chromium.launch({headless:true});const base="http://127.0.0.1:"+server.httpServer.address().port;
 for(const width of [320,390,1280]){
  const run=String(width),state=seed();runs.set(run,state);const page=await browser.newPage({viewport:{width,height:950},timezoneId:"UTC"}),errors=[];page.on("pageerror",error=>errors.push(error.message));await blockExternal(page);await page.goto(base+"/__snapshot_test-"+run+".html?run="+run);
  const panel=panelFor(page),input=panel.getByLabel("募集対象データ",{exact:true}),read=panel.getByRole("button",{name:"現在の照合データを取得",exact:true});
  await input.fill("broken");await read.click();await panel.getByRole("alert").waitFor();assert.equal(state.calls.length,0);
  await panel.getByLabel("募集対象のファイル",{exact:true}).setInputFiles({name:"large.json",mimeType:"application/json",buffer:Buffer.alloc(262145,32)});
  await panel.getByText(/256 KiB以下/).waitFor();assert.equal(state.calls.length,0);
  await panel.getByLabel("募集対象のファイル",{exact:true}).setInputFiles({name:"targets.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(state.targets))});
  await page.waitForFunction(()=>document.querySelector("textarea")?.value.startsWith("{"));await page.evaluate(()=>{window.fault="hold";const originalFrame=window.requestAnimationFrame;let early=true;window.savedFrame=originalFrame;window.requestAnimationFrame=callback=>{if(early){early=false;callback(performance.now());return 0;}return originalFrame(callback);};});await read.focus();await page.keyboard.press("Enter");const release=await waitRelease(state);
  await panel.getByRole("button",{name:"現在の対応を確認しています…",exact:true}).waitFor();await page.keyboard.press("Enter");assert.equal(state.calls.length,1);release();
  await panel.getByRole("heading",{name:"取得した案件対応",exact:true}).waitFor();await page.waitForFunction(()=>document.activeElement?.textContent==="取得した案件対応");await page.evaluate(()=>window.requestAnimationFrame=window.savedFrame);
  const japaneseTime=new Date(state.last.snapshot.capturedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",hour12:false});await panel.getByText(japaneseTime,{exact:true}).waitFor();
  if(width===390)await page.evaluate(()=>document.documentElement.style.fontSize="24px");
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(output)await page.screenshot({path:path.join(output,"snapshot-"+width+".png"),fullPage:true});
  const downloadPromise=page.waitForEvent("download");await panel.getByRole("button",{name:"アプリの照合データを保存",exact:true}).click();const download=await downloadPromise;
  const saved=JSON.parse(fs.readFileSync(await download.path(),"utf8"));assert.equal(saved.companyId,companyId);assert.equal(saved.records[0].job.id,"synthetic-job");assert.ok(!JSON.stringify(saved).includes("private"));assert.equal(saved.records[0].job.storeName,undefined);
  if(output)await download.saveAs(path.join(output,"app-snapshot-"+width+".json"));
  await page.evaluate(()=>window.fault="offline");await read.click();await panel.getByRole("alert").waitFor();assert.equal(await input.inputValue(),JSON.stringify(state.targets));assert.equal(await panel.getByRole("button",{name:"アプリの照合データを保存",exact:true}).count(),0);
  await page.evaluate(()=>window.fault="malformed");await read.click();await panel.getByText(/募集対象とアプリの照合データが一致しません/).waitFor();assert.equal(await panel.locator(".campaign-preview").count(),0);
  await page.evaluate(()=>window.fault=null);await read.click();await panel.getByRole("heading",{name:"取得した案件対応",exact:true}).waitFor();
  await panel.getByRole("button",{name:"照合データを閉じる",exact:true}).click();await page.waitForFunction(()=>document.activeElement?.id==="open");assert.deepEqual(errors,[]);
  assert.ok(state.h.commits.every(writes=>writes.length===0));await page.close();results.push({width,passed:true});
 }
 {
  const run="stale",state=seed();runs.set(run,state);const page=await browser.newPage({viewport:{width:390,height:900}});await blockExternal(page);await page.goto(base+"/__snapshot_test-"+run+".html?run="+run);
  const panel=panelFor(page),input=panel.getByLabel("募集対象データ",{exact:true}),read=panel.getByRole("button",{name:"現在の照合データを取得",exact:true});
  await input.fill(JSON.stringify(state.targets));await page.evaluate(()=>window.fault="hold");await read.click();const release=await waitRelease(state);
  await input.fill("new input");const response=page.waitForResponse(row=>row.url().includes("/__snapshot_rpc"));release();await response;assert.equal(await panel.locator(".campaign-preview").count(),0);assert.equal(await input.inputValue(),"new input");
  await input.fill(JSON.stringify(state.targets));await read.click();const oldRelease=await waitRelease(state);await page.evaluate(()=>window.changeOwner());await page.waitForFunction(()=>document.querySelector("textarea")?.value==="");
  const oldResponse=page.waitForResponse(row=>row.url().includes("/__snapshot_rpc"));oldRelease();await oldResponse;assert.equal(await panel.locator(".campaign-preview").count(),0);assert.equal(await input.inputValue(),"");
  await page.close();results.push({staleAndAuth:true,passed:true});
 }
 {
  const page=await browser.newPage({viewport:{width:390,height:950}}),errors=[];page.on("pageerror",error=>errors.push(error.message));await blockExternal(page);await page.goto(base+"/");
  await page.getByRole("navigation",{name:"管理業務",exact:true}).getByRole("button",{name:"案件",exact:true}).click();await page.getByRole("button",{name:"アプリの照合データを取得",exact:true}).click();const panel=panelFor(page);
  await panel.getByRole("button",{name:"デモの募集対象を使う",exact:true}).click();await panel.getByRole("button",{name:"現在の照合データを取得",exact:true}).click();await panel.getByRole("heading",{name:"取得した案件対応",exact:true}).waitFor();
  const pending=page.waitForEvent("download");await panel.getByRole("button",{name:"アプリの照合データを保存",exact:true}).click();const download=await pending;assert.equal(JSON.parse(fs.readFileSync(await download.path(),"utf8")).companyId,"demo-company");
  await panel.getByRole("button",{name:"照合データを閉じる",exact:true}).click();await page.waitForFunction(()=>document.activeElement?.textContent==="アプリの照合データを取得");assert.deepEqual(errors,[]);
  await page.close();results.push({actualAdminDemo:true,passed:true});
 }
 for(const width of [390,1280]){
  const run="connected-"+width,state=seed();state.h.records.delete(state.h.paths.campaign);runs.set(run,state);
  const page=await browser.newPage({viewport:{width,height:950}}),errors=[],downloads=[];
  page.on("pageerror",error=>errors.push(error.message));page.on("download",item=>downloads.push(item));await blockExternal(page);
  await page.goto(base+"/__snapshot_test-"+run+".html?run="+run);
  const bundle={version:1,kind:"recruitment.import-source",targets:state.targets,sourceHash:"a".repeat(64),sourceCapturedAt:new Date().toISOString()};
  const panel=panelFor(page);
  await panel.getByLabel("募集対象のファイル",{exact:true}).setInputFiles({name:"import-source.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(bundle))});
  await page.waitForFunction(()=>document.querySelector("textarea")?.value.includes("recruitment.import-source"));
  await panel.getByRole("button",{name:"現在の照合データを取得",exact:true}).click();
  await panel.getByRole("button",{name:"この内容で募集登録へ進む",exact:true}).click();
  const registration=page.getByRole("region",{name:"募集データの取込確認",exact:true});
  await registration.getByRole("button",{name:"取込内容を確認",exact:true}).click();
  await registration.getByRole("heading",{name:"原本と照合する内容",exact:true}).waitFor();
  const register=registration.getByRole("button",{name:"原本を照合して登録する",exact:true});
  assert.equal(await register.isDisabled(),true);
  await registration.getByLabel("確認資料の識別子",{exact:true}).fill("synthetic-browser-evidence");
  await registration.getByRole("checkbox").check();
  if(width===390)await page.evaluate(()=>window.fault="lost-register");
  await register.click();
  if(width===390){
   await registration.getByRole("button",{name:"同じ募集登録の結果を確認",exact:true}).waitFor();
   await registration.getByRole("alert").waitFor();assert.equal(state.h.list("automationCampaigns").length,1);
   await page.evaluate(()=>window.fault=null);
   await registration.getByRole("button",{name:"同じ募集登録の結果を確認",exact:true}).click();
  }
  await registration.getByText(/募集の原本確認記録を保存しました/).waitFor();
  assert.equal(state.h.list("automationCampaigns").length,1);
  assert.equal(state.calls.filter(call=>call.action==="register").length,width===390?2:1);
  assert.equal(downloads.length,0);assert.deepEqual(errors,[]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(output)await page.screenshot({path:path.join(output,"connected-registration-"+width+".png"),fullPage:true});
  await page.close();results.push({connectedRegistration:width,responseLoss:width===390,passed:true});
 }
 if(output)fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({results,cloudAccess:false,sourceDataModified:false},null,2));
 console.log("照合データ画面: 3幅/文字拡大/日本時間/ファイル/保存/通信断/不正応答/旧応答/認証切替/実Adminデモ成功。");
}catch(error){
 if(browser&&output){let n=0;for(const context of browser.contexts())for(const page of context.pages()){
  await page.screenshot({path:path.join(output,"failure-"+n+".png"),fullPage:true}).catch(()=>{});
  fs.writeFileSync(path.join(output,"failure-"+n+++".txt"),await page.locator("body").innerText().catch(()=>""));}}
 throw error;
}finally{await browser?.close();await server.close();}
