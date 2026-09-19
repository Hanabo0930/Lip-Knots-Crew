import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import {setupChange} from "./case-mail-change-harness.mjs";
import { harness, clone, companyId } from "./case-mail-test-harness.mjs";
const output = resolve(process.argv[2] ?? "release-evidence/research-decisions-20260918/mail-review-ui-1/browser");
mkdirSync(output, { recursive: true });
const states = new Map();
function seed(extra = 0) {
  const h = harness(), review = h.load("./case-mail-review");
  for (let index = 0; index < extra; index++) h.records.set("caseMailIntakeReceipts/extra-" + String(index).padStart(2, "0"), clone(h.records.get(h.paths.receipt)));
  return { h, review, calls: [], release: null };
}
function html(run) {
  const code = [
    'import React from "react";import {createRoot} from "react-dom/client";import Panel from "/src/CaseMailIntakePanel.tsx";import "/src/styles.css";',
    'window.run=new URLSearchParams(location.search).get("run");window.fault={};window.navigation=[];function Fixture(){',
    'const [owner,setOwner]=React.useState({companyId:"synthetic-company",uid:"synthetic-admin"}),[open,setOpen]=React.useState(true);',
    'window.changeOwner=()=>setOwner({companyId:"other-company",uid:"other-admin"});',
    'const call=async(action,input={})=>{const result=await fetch("/__mail_rpc?run="+window.run,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,input,owner,fault:window.fault[action]})});const out=await result.json();if(!out.ok)throw Object.assign(Error(out.message),{code:out.code});return out.data;};',
    'return <main className="shell"><button id="open" onClick={()=>setOpen(true)}>受信を開く</button>{open&&<Panel key={owner.companyId+owner.uid} {...owner} api={{list:cursor=>call("list",cursor?{cursor}:{}),read:receiptId=>call("read",{receiptId}),create:command=>call("create",command),confirm:command=>call("confirm",command)}} onReviewJob={(jobId,action)=>window.navigation.push({jobId,action})} onCreated={()=>{window.created=(window.created||0)+1;}} onClose={()=>{setOpen(false);requestAnimationFrame(()=>document.getElementById("open").focus());}}/>}</main>;',
    '}createRoot(document.getElementById("root")).render(<Fixture/>);',
  ].join("\n");
  return '<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">' +
    ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React } }).outputText + "</script>";
}
const server = await createServer({ root: resolve("apps/admin"), configFile: resolve("apps/admin/vite.config.ts"),
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "case-mail-ui-test", configureServer(dev) {
    dev.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, "http://localhost"), run = url.searchParams.get("run");
      if (url.pathname === "/__mail_test.html") { res.setHeader("Content-Type", "text/html"); res.end(await dev.transformIndexHtml(url.pathname, html(run))); return; }
      if (url.pathname !== "/__mail_rpc") return next();
      const state = states.get(run);
      try {
        let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 20000) throw Error("fixture limit"); }
        const { action, input, owner, fault } = JSON.parse(body); state.calls.push({ action, input, owner });
        if (fault === "hold") await new Promise(resolve => state.release = resolve);
        if (fault === "offline") throw Error("合成：通信が途切れました。");
        if (fault === "lost") state.h.loseResponse = true;
        const data = { ...input, expectedCompanyId: owner.companyId, expectedActorUid: owner.uid };
        const auth = { uid: owner.uid, token: { companyId: owner.companyId, role: "admin" } };
        const result = action === "list" ? await state.review.listCaseMailReceipts({ data, auth }) :
          action === "read" ? await state.review.getCaseMailReceipt({ data, auth }) : action === "confirm" ? await state.h.resolveChange(data, auth) : await state.h.create(data, auth);
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, data: result }));
      } catch (error) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: false, message: error.message, code: error.code ?? "unavailable" })); }
    });
  } }] });
let browser; const results = [];
const blockExternal = page => page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
const panel = page => page.getByRole("region", { name: "受信した案件候補", exact: true });
const openDetail = async box => { await box.getByRole("button", { name: "内容を確認", exact: true }).first().click(); await box.getByRole("heading", { name: "登録する内容の確認" }).waitFor(); };
const confirm = box => box.getByLabel("内容を確認しました。1名分の下書きを作成します。", { exact: true });
const save = box => box.getByRole("button", { name: "確認した候補を下書き作成", exact: true });
async function release(state) { const until = Date.now() + 7000; while (!state.release && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(state.release); const next = state.release; state.release = null; next(); }
try {assert.ok(!Object.entries(server.config.env).some(([key,value])=>key.startsWith("VITE_FIREBASE_")&&value));await server.listen();browser=await chromium.launch({headless:true});
for(const width of [320,390,1280]){
const h=await setupChange();await h.receiveChange();const state={h,review:h.review,calls:[],release:null},run=String(width);states.set(run,state);const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.setDefaultTimeout(7000);page.on("pageerror",e=>errors.push(e.message));await blockExternal(page);await page.goto("http://127.0.0.1:"+server.httpServer.address().port+"/__mail_test.html?run="+run);const box=panel(page);await openDetail(box);
const finish=box.getByRole("button",{name:"受信確認を完了",exact:true}),reload=box.getByRole("button",{name:"受信内容を再読込",exact:true}),note=box.getByLabel("変更・取消の確認メモ",{exact:true}),check=box.getByRole("checkbox",{name:"原文と現在の案件内容・担当・取消の扱いを確認しました。",exact:true});assert.equal(await finish.isDisabled(),true);await box.getByRole("button",{name:"案件を編集",exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.navigation),[{jobId:h.jobId,action:"edit"}]);results.push({width,case:"changed proposal and existing edit navigation"});
await h.applyChange();await reload.click();await page.waitForFunction(()=>document.querySelector(".mail-detail input[type=checkbox]")?.disabled===false);await note.fill("原文・担当・原本を確認");await check.check();await page.evaluate(()=>window.fault.confirm="hold");await finish.click();while(!state.release)await new Promise(resolve=>setTimeout(resolve,10));await h.receiveChange();await release(state);await box.getByRole("alert").waitFor();assert.equal(await finish.isDisabled(),true);assert.equal(await box.locator("textarea").inputValue(),"原文・担当・原本を確認");assert.equal(h.job().mailIntakeReviewRequired,true);results.push({width,case:"new receive refuses stale confirmation and preserves memo"});
await page.evaluate(()=>window.fault={});await h.reimport();await reload.click();await page.waitForFunction(()=>document.querySelector(".mail-detail input[type=checkbox]")?.disabled===false);await note.fill("最新版の原本確認");await check.check();await page.evaluate(()=>window.fault.confirm="lost");await finish.click();await box.getByRole("alert").waitFor();assert.equal(h.job().mailIntakeReviewRequired,false);assert.equal(await finish.isDisabled(),true);await page.evaluate(()=>window.fault={});await reload.click();await box.getByText("この受信変更は確認済みです。募集の再開は別途確認してください。",{exact:true}).waitFor();assert.equal(h.list("auditLogs").filter(x=>x.action==="caseMail.review.confirm").length,1);assert.equal(h.job().publishable,false);results.push({width,case:"lost response recovers one saved confirmation without republishing"});
await h.receiveChange({state:"review",issues:["SOURCE_REVIEW"],candidates:[],parts:[]});await reload.click();await box.getByRole("button",{name:"取消を確認",exact:true}).click();assert.equal((await page.evaluate(()=>window.navigation.at(-1))).action,"cancel");await h.cancel();h.row[9]+="（キャンセル）";await h.reimport();await reload.click();await page.waitForFunction(()=>document.querySelector(".mail-detail input[type=checkbox]")?.disabled===false);await box.getByText("支払のみ",{exact:true}).waitFor();await note.fill("取消原文と支払の扱いを確認");await check.check();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:resolve(output,"review-"+width+".png"),fullPage:true});await finish.click();await box.getByText(/受信内容の確認を記録しました/).waitFor();assert.equal(h.job().mailIntakeReviewRequired,false);assert.equal(h.job().cancelled,true);assert.equal(h.lock().active,false);results.push({width,case:"existing cancellation with source and payment confirmation"});assert.deepEqual(errors,[]);await page.close();}
writeFileSync(resolve(output,"result.json"),JSON.stringify({passed:results.length,results},null,2));console.log(JSON.stringify({passed:results.length,results},null,2));
}finally{await browser?.close();await server.close();}