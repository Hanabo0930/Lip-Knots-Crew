import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
const base = { id: "synthetic-one", workDate: "2026-11-20", clientName: "合成依頼元", storeName: "合成店舗一", makerName: "合成メーカー", menuName: "試食", region: "通常", revision: 2, status: "open", publishable: true, sourceReady: true, caseListSource: { sourceRevision: "a".repeat(64) } };
const jobs = [base, {...base,id:"synthetic-two",storeName:"合成店舗二"}, {...base,id:"synthetic-tohoku",storeName:"合成東北店舗",region:"東北"}, {...base,id:"synthetic-cancelled",storeName:"取消店舗",cancelled:true}, {...base,id:"synthetic-assigned",storeName:"手配済店舗",assignedStaffId:"synthetic-staff",status:"assigned"}, {...base,id:"synthetic-draft",storeName:"下書店舗",status:"draft"}];
const fakeAuth = `export const auth={currentUser:{uid:'synthetic-owner'}};const listeners=new Set();export function onAuthStateChanged(_auth,callback){listeners.add(callback);queueMicrotask(()=>callback(auth.currentUser));window.recruitFixture.setUser=user=>{auth.currentUser=user;listeners.forEach(fn=>fn(user));};return()=>listeners.delete(callback);}`;
const fakeFunctions = `export function httpsCallable(_functions,name){return input=>new Promise((resolve,reject)=>{window.recruitFixture.calls.push({name,input});window.recruitFixture.pending.push({resolve,reject});});}`;
const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import Panel from '/src/RecruitmentDraftPanel.tsx';import '/src/styles.css';window.recruitFixture={calls:[],pending:[],copies:[],initial:${JSON.stringify(jobs)}};function Fixture(){const[jobs,setJobs]=React.useState(window.recruitFixture.initial);window.recruitFixture.change=(id,patch)=>setJobs(current=>current.map(job=>job.id===id?{...job,...patch}:job));return React.createElement('main',{className:'shell'},React.createElement('section',{className:'panel'},React.createElement(Panel,{jobs,functions:{},demo:false})));}createRoot(document.getElementById('root')).render(React.createElement(Fixture));</script></body></html>`;
const server = await createServer({ root:resolve("apps/admin"), configFile:resolve("apps/admin/vite.config.ts"), server:{host:"127.0.0.1",port:0}, plugins:[{
  name:"recruitment-draft-isolated-fixture", enforce:"pre",
  resolveId(id,importer){if(!importer?.split("?")[0].endsWith("/RecruitmentDraftPanel.tsx"))return;if(id==="./firebase"||id==="firebase/auth")return"\0recruit-auth";if(id==="firebase/functions")return"\0recruit-functions";},
  load(id){if(id==="\0recruit-auth")return fakeAuth;if(id==="\0recruit-functions")return fakeFunctions;},
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{if(req.url!=="/__recruitment.html")return next();try{res.setHeader("Content-Type","text/html");res.end(await dev.transformIndexHtml(req.url,html));}catch(error){next(error);}});},
}]});
let browser, checks=0;
try {
  assert.ok(!Object.entries(server.config.env).some(([key,value])=>key.startsWith("VITE_FIREBASE_")&&value),"Real Firebase config forbidden");
  await server.listen(); browser=await chromium.launch({headless:true});
  const host="http://127.0.0.1:"+server.httpServer.address().port;
  for(const width of [320,390,1280]) {
    const page=await browser.newPage({viewport:{width,height:900}}),errors=[],external=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.route("**/*",route=>{const url=new URL(route.request().url());if(url.protocol==="http:"&&url.hostname==="127.0.0.1")return route.continue();external.push(url.hostname);return route.abort();});
    await page.addInitScript(()=>Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async value=>window.recruitFixture.copies.push(value)}}));
    await page.goto(host+"/__recruitment.html");
    await page.getByText("募集メールを作成",{exact:true}).click();
    await page.getByLabel("募集地域",{exact:true}).selectOption("通常");
    assert.equal(await page.getByRole("checkbox").count(),2);checks++;
    await page.getByRole("checkbox",{name:"2026-11-20 合成店舗一を募集文に掲載",exact:true}).check();
    await page.getByRole("button",{name:"1件の募集文を作成",exact:true}).click();
    await page.waitForFunction(()=>window.recruitFixture.calls.length===1);
    const call=await page.evaluate(()=>window.recruitFixture.calls[0]);
    assert.deepEqual(call.input.selections,[{jobId:base.id,expectedJobRevision:2,expectedSourceRevision:"a".repeat(64)}]);checks++;
    await page.evaluate(()=>{const call=window.recruitFixture.calls.at(-1);window.recruitFixture.pending.shift().resolve({data:{purpose:"recruitment-draft",subject:call.input.subject,body:"合成募集文",caseCount:call.input.selections.length,region:call.input.region,validatedAt:"2026-10-29T00:00:00.000Z",dispatch:"disabled"}});});
    await page.getByLabel("作成した本文",{exact:true}).waitFor();
    await page.getByRole("button",{name:"再照合して本文をコピー",exact:true}).click();
    await page.waitForFunction(()=>window.recruitFixture.calls.length===2);
    assert.equal(await page.evaluate(()=>window.recruitFixture.copies.length),0);checks++;
    await page.evaluate(()=>{const call=window.recruitFixture.calls.at(-1);window.recruitFixture.pending.shift().resolve({data:{purpose:"recruitment-draft",subject:call.input.subject,body:"再照合した合成募集文",caseCount:call.input.selections.length,region:call.input.region,validatedAt:"2026-10-29T00:01:00.000Z",dispatch:"disabled"}});});
    await page.waitForFunction(()=>window.recruitFixture.copies.length===1);
    assert.deepEqual(await page.evaluate(()=>window.recruitFixture.copies),["再照合した合成募集文"]);checks++;
    await page.getByRole("checkbox",{name:"2026-11-20 合成店舗二を募集文に掲載",exact:true}).check();
    assert.equal(await page.getByLabel("作成した本文",{exact:true}).count(),0);checks++;
    await page.getByRole("button",{name:"2件の募集文を作成",exact:true}).click();
    await page.waitForFunction(()=>window.recruitFixture.calls.length===3);
    await page.evaluate(()=>window.recruitFixture.change("synthetic-one",{cancelled:true}));
    await page.waitForFunction(()=>document.querySelectorAll('input[type="checkbox"]').length===1);
    await page.evaluate(()=>{const call=window.recruitFixture.calls.at(-1);window.recruitFixture.pending.shift().resolve({data:{purpose:"recruitment-draft",subject:call.input.subject,body:"古い募集文",caseCount:2,region:call.input.region,validatedAt:"2026-10-29T00:00:00.000Z",dispatch:"disabled"}});});
    assert.equal(await page.getByLabel("作成した本文",{exact:true}).count(),0);checks++;
    await page.getByRole("button",{name:"1件の募集文を作成",exact:true}).click();
    await page.waitForFunction(()=>window.recruitFixture.calls.length===4);
    await page.evaluate(()=>window.recruitFixture.setUser(null));
    await page.evaluate(()=>{const call=window.recruitFixture.calls.at(-1);window.recruitFixture.pending.shift().resolve({data:{purpose:"recruitment-draft",subject:call.input.subject,body:"前の利用者の募集文",caseCount:1,region:call.input.region,validatedAt:"2026-10-29T00:00:00.000Z",dispatch:"disabled"}});});
    // Auth invalidation is synchronous, while React commits the cleared input
    // on the next render. Observe that commit before asserting its DOM value.
    await page.waitForFunction(()=>document.querySelector('[aria-label="募集地域"]').value==="");
    assert.equal(await page.getByLabel("作成した本文",{exact:true}).count(),0);assert.equal(await page.getByLabel("募集地域",{exact:true}).inputValue(),"");checks++;
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),"No viewport overflow at "+width);checks++;
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);checks++;
    await page.close();
  }
  console.log(JSON.stringify({adminRecruitmentDraftBrowserChecks:checks,status:"PASS",viewports:[320,390,1280],nativeRequests:0,cloudWrites:0,realCopies:0}));
} finally { await browser?.close(); await server.close(); }
