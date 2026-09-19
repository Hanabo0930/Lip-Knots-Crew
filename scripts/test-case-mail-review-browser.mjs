import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { targetResolutionFixture } from "./case-mail-target-resolution-harness.mjs";
import { targetHoldFixture } from "./case-mail-target-hold-harness.mjs";
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
    'window.run=new URLSearchParams(location.search).get("run");window.fault={};function Fixture(){',
    'const [owner,setOwner]=React.useState({companyId:"synthetic-company",uid:"synthetic-admin"}),[open,setOpen]=React.useState(true);',
    'window.changeOwner=()=>setOwner({companyId:"other-company",uid:"other-admin"});',
    'const call=async(action,input={})=>{const result=await fetch("/__mail_rpc?run="+window.run,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,input,owner,fault:window.fault[action]})});const out=await result.json();if(!out.ok)throw Object.assign(Error(out.message),{code:out.code});return out.data;};',
    'return <main className="shell"><button id="open" onClick={()=>setOpen(true)}>受信を開く</button>{open&&<Panel key={owner.companyId+owner.uid} {...owner} api={{list:cursor=>call("list",cursor?{cursor}:{}),read:receiptId=>call("read",{receiptId}),create:command=>call("create",command),...(window.run.startsWith("binding-")||window.run.startsWith("open-")||window.run.startsWith("hold-")||window.run.startsWith("resolve-")?{previewTarget:command=>call("previewTarget",command),confirmTarget:command=>call("confirmTarget",command),holdTarget:command=>call("holdTarget",command),resolveTarget:command=>call("resolveTarget",command)}:{})}} onCreated={()=>{window.created=(window.created||0)+1;}} onReviewJob={(jobId,action)=>{window.opened=[...(window.opened||[]),{jobId,action}];}} onClose={()=>{setOpen(false);requestAnimationFrame(()=>document.getElementById("open").focus());}}/>}</main>;',
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
          action === "read" ? await state.review.getCaseMailReceipt({ data, auth }) : action === "previewTarget" ? await state.review.getCaseMailTargetPreview({data,auth}) : action === "confirmTarget" ? await state.review.confirmCaseMailTarget({data,auth}) : action === "holdTarget" ? await state.review.holdCaseMailTarget({data,auth}) : action === "resolveTarget" ? await state.review.resolveCaseMailTargetHold({data,auth}) : await state.h.create(data, auth);
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
try {
  assert.ok(!Object.entries(server.config.env).some(([key, value]) => key.startsWith("VITE_FIREBASE_") && value));
  await server.listen(); browser = await chromium.launch({ headless: true });
  const base = "http://127.0.0.1:" + server.httpServer.address().port;
  if (!process.argv.includes("--targets-only") && !process.argv.includes("--binding-only") && !process.argv.includes("--open-only") && !process.argv.includes("--hold-only") && !process.argv.includes("--resolve-only")) {
  for (const width of [320, 390, 1280]) {
    const run = String(width), state = seed(); states.set(run, state);
    const page = await browser.newPage({ viewport: { width, height: 1000 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message)); await blockExternal(page);
    const url = base + "/__mail_test.html?run=" + run;
    await page.goto(url); const box = panel(page); await openDetail(box);
    assert.equal(await save(box).isDisabled(), true); await confirm(box).check();
    if (width === 390) {
      await page.evaluate(() => document.documentElement.style.fontSize = "24px");
      assert.equal(await box.locator("select").evaluate(node => getComputedStyle(node).fontSize === getComputedStyle(node.parentElement).fontSize), true);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(output, "detail-" + width + ".png"), fullPage: true });
    await page.evaluate(() => { window.originalSet = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw Error("synthetic quota"); }; });
    await save(box).click(); await box.getByRole("alert").waitFor(); assert.equal(state.calls.filter(call => call.action === "create").length, 0);
    await page.evaluate(() => { Storage.prototype.setItem = window.originalSet; window.fault.create = "hold"; });
    await save(box).click(); await box.getByRole("button", { name: "結果を確認しています…" }).waitFor();
    assert.equal(state.calls.filter(call => call.action === "create").length, 1);
    state.h.loseResponse = true; await release(state); await box.getByRole("alert").waitFor();
    assert.equal(await box.getByRole("button", { name: "最新内容に戻る" }).count(), 0);
    const original = state.calls.find(call => call.action === "create").input.mailIntake;
    await page.reload(); await box.getByRole("button", { name: "同じ案件作成の結果を確認" }).click();
    await box.getByText(/保存済みの作成結果を確認しました/).waitFor();
    assert.equal(state.h.list("jobs").length, 1); assert.equal(state.h.list("sheetRowCreateQueue").length, 1);
    assert.deepEqual(state.calls.filter(call => call.action === "create").at(-1).input.mailIntake, original);
    await openDetail(box); await box.getByText("この候補は登録済みです。案件一覧で確認できます。", { exact: true }).waitFor();
    assert.equal(await save(box).count(), 0);
    await box.getByRole("button", { name: "受信候補を閉じる" }).click(); await page.waitForFunction(() => document.activeElement?.id === "open");
    await page.getByRole("button", { name: "受信を開く" }).click(); await box.getByRole("button", { name: "内容を確認" }).waitFor();
    await page.evaluate(() => window.fault.list = "hold"); await box.getByRole("button", { name: "受信一覧を更新" }).click();
    await page.evaluate(() => { window.fault.list = null; window.changeOwner(); });
    await box.getByText("受信した案件候補はありません。", { exact: true }).waitFor(); await release(state);
    assert.equal(await box.getByRole("button", { name: "内容を確認" }).count(), 0);
    assert.deepEqual(errors, []); await page.close(); results.push({ width, storageFailure: true, lostResponseRecovery: true, ownerChange: true });
  }
  {
    const state = seed(), run = "stale"; states.set(run, state); const page = await browser.newPage(); await blockExternal(page);
    await page.goto(base + "/__mail_test.html?run=" + run); const box = panel(page); await openDetail(box); await confirm(box).check();
    state.h.records.get(state.h.paths.receipt).revision = 2;
    await save(box).click(); await box.getByRole("button", { name: "最新内容に戻る" }).click();
    await openDetail(box); assert.equal(await confirm(box).isChecked(), false); assert.equal(state.h.list("jobs").length, 0);
    await confirm(box).check(); await save(box).click(); await box.getByText(/下書きを作成しました/).waitFor();
    assert.equal(state.calls.filter(call => call.action === "create").at(-1).input.mailIntake.expectedReceiptRevision, 2);
    await page.close(); results.push({ staleVersionReconfirm: true });
  }
  {
    const state = seed(25), run = "paging"; states.set(run, state); const page = await browser.newPage({ viewport: { width: 320, height: 1000 } }); await blockExternal(page);
    await page.goto(base + "/__mail_test.html?run=" + run); const box = panel(page);
    await box.getByRole("button", { name: "次の25件" }).waitFor(); assert.equal(await box.locator(".mail-receipts>li").count(), 25);
    await box.getByRole("button", { name: "次の25件" }).click(); await box.getByRole("button", { name: "先頭へ戻る" }).waitFor();
    assert.equal(await box.locator(".mail-receipts>li").count(), 1);
    await box.getByRole("button", { name: "先頭へ戻る" }).click(); await box.getByRole("button", { name: "次の25件" }).waitFor();
    await page.evaluate(() => window.fault.read = "offline"); await box.getByRole("button", { name: "内容を確認" }).first().click();
    await box.getByRole("alert").waitFor(); assert.equal(await save(box).count(), 0);
    await page.close(); results.push({ pagingAndReadFailure: true });
  }
  for (const mode of ["review", "disabled"]) {
    const state = seed(); states.set(mode, state);
    if (mode === "review") state.h.records.get(state.h.paths.receipt).status = "review";
    else state.h.records.get(state.h.paths.feature).caseMailJobCreationEnabled = false;
    const page = await browser.newPage(); await blockExternal(page); await page.goto(base + "/__mail_test.html?run=" + mode);
    const box = panel(page); await openDetail(box); assert.equal(await save(box).count(), 0);
    assert.equal(state.calls.filter(call => call.action === "create").length, 0); await page.close(); results.push({ blockedMode: mode });
  }
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 1000 } }); await blockExternal(page);
    await page.goto(base + "/");
    await page.getByRole("navigation", { name: "管理業務" }).getByRole("button", { name: "案件", exact: true }).click();
    await page.getByRole("button", { name: "受信候補を確認", exact: true }).click();
    await panel(page).getByText("受信した案件候補はありません。", { exact: true }).waitFor();
    await panel(page).getByRole("button", { name: "受信候補を閉じる" }).click();
    await page.waitForFunction(() => document.activeElement?.textContent === "受信候補を確認");
    await page.close(); results.push({ actualAdminEntry: true });
  }
  }

  if (!process.argv.includes("--binding-only") && !process.argv.includes("--open-only") && !process.argv.includes("--hold-only") && !process.argv.includes("--resolve-only")) for (const [mode,width] of [["matches",320],["matches",390],["matches",1280],["empty",390],["limited",390],["insufficient",390]]) {
    const run="targets-"+mode+"-"+width,state=seed();states.set(run,state);
    state.h.records.get(state.h.paths.receipt).status="review";
    state.h.records.get(state.h.paths.candidate).status="review";
    const input=state.h.records.get(state.h.paths.candidate).input;
    if(mode==="matches")for(let i=0;i<2;i++)state.h.records.set("jobs/target-"+i,{companyId,...clone(input),status:i?"cancelled":"draft"});
    if(mode==="limited")for(let i=0;i<201;i++)state.h.records.set("jobs/limit-"+i,{companyId,...clone(input),storeName:"別店舗"});
    if(mode==="insufficient")input.storeName="";
    const before=JSON.stringify([...state.h.records]);
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
    page.on("pageerror",e=>errors.push(e.message));await blockExternal(page);
    await page.goto(base+"/__mail_test.html?run="+run);await openDetail(panel(page));
    const targets=page.getByRole("region",{name:"対応先の案件候補",exact:true});
    await targets.getByRole("heading",{name:"対応先の案件候補（未確定）"}).waitFor();
    if(mode==="matches"){assert.equal(await targets.locator("dl").count(),2);await targets.getByText("取消済み",{exact:true}).waitFor();}
    if(mode==="empty")await targets.getByText(/同じ日付・店舗の候補はありません/).waitFor();
    if(mode==="limited"){await targets.getByText(/上限に達しました/).waitFor();assert.equal(await targets.getByText(/候補はありません/).count(),0);}
    if(mode==="insufficient")await targets.getByText(/候補を検索できません/).waitFor();
    assert.equal(await targets.getByRole("button").count(),0);
    assert.equal(await save(panel(page)).count(),0);
    assert.ok(state.calls.every(c=>["list","read"].includes(c.action)));
    assert.equal(JSON.stringify([...state.h.records]),before);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:resolve(output,run+".png"),fullPage:true});
    await page.close();results.push({mode,width,readOnly:true});
  }


  if (!process.argv.includes("--targets-only") && !process.argv.includes("--open-only") && !process.argv.includes("--hold-only") && !process.argv.includes("--resolve-only")) for (const [mode,width] of [["save",320],["save",390],["save",1280],["lost",390],["stale",390],["owner",390]]) {
    const run="binding-"+mode+"-"+width,state=seed();states.set(run,state);
    state.h.records.get(state.h.paths.receipt).status="review";state.h.records.get(state.h.paths.candidate).status="review";
    state.h.records.get(state.h.paths.feature).caseMailIntakeEnabled=true;
    for(let i=1;i<=2;i++)state.h.records.set("jobs/target-"+i,{companyId,...clone(state.h.input),revision:1,status:"draft"});
    const beforeJobs=JSON.stringify(state.h.list("jobs"));
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on("pageerror",e=>errors.push(e.message));await blockExternal(page);
    await page.goto(base+"/__mail_test.html?run="+run);await openDetail(panel(page));
    const box=page.getByRole("region",{name:"対象案件の対応確定",exact:true}),choose=box.getByLabel("対応先の案件ID",{exact:true}),read=box.getByRole("button",{name:"対応先を再確認",exact:true});
    assert.equal(await read.isDisabled(),true);await choose.selectOption("target-1");
    if(mode==="owner"){
      await page.evaluate(()=>window.fault.previewTarget="hold");await read.click();
      await page.evaluate(()=>window.changeOwner());await panel(page).getByText("受信した案件候補はありません。",{exact:true}).waitFor();await release(state);
      assert.equal(await box.count(),0);assert.equal(state.calls.filter(x=>x.action==="confirmTarget").length,0);
    } else {
      await read.click();const saveTarget=box.getByRole("button",{name:"対象案件との対応を確定",exact:true});
      await saveTarget.waitFor();assert.equal(await saveTarget.isDisabled(),true);
      await box.getByLabel("対応先の確認メモ",{exact:true}).fill("合成原文を照合");
      await box.getByLabel("受信原文と案件ID・日付・店舗・条件を照合しました。",{exact:true}).check();
      if(mode==="save"){
        await choose.selectOption("target-2");assert.equal(await saveTarget.count(),0);
        await choose.selectOption("target-1");await read.click();await saveTarget.waitFor();assert.equal(await saveTarget.isDisabled(),true);
        await box.getByLabel("対応先の確認メモ",{exact:true}).fill("合成原文を照合");
        await box.getByLabel("受信原文と案件ID・日付・店舗・条件を照合しました。",{exact:true}).check();
      }
      if(mode==="lost")await page.evaluate(()=>window.fault.confirmTarget="lost");
      if(mode==="stale")state.h.records.get("jobs/target-1").revision++;
      await saveTarget.click();await page.waitForFunction(()=>[...document.querySelectorAll("button")].some(b=>b.textContent==="対応先を再確認"&&!b.disabled));
      assert.equal(await saveTarget.isDisabled(),true);assert.equal(state.calls.filter(x=>x.action==="confirmTarget").length,1);
      await read.click();
      if(mode==="stale"){await saveTarget.waitFor();assert.equal(await saveTarget.isDisabled(),true);assert.equal(state.h.list("auditLogs").length,0);}
      else {
        await box.getByText("対象案件との対応記録を確認しました。変更・取消処理は未実施です。",{exact:true}).waitFor();
        assert.equal(state.h.list("auditLogs").filter(x=>x.action==="caseMail.target.confirm").length,1);
        assert.equal(JSON.stringify(state.h.list("jobs")),beforeJobs);
        await page.reload();await openDetail(panel(page));await box.getByText("対応記録があります。現在の状態を再確認してください。",{exact:true}).waitFor();
        assert.equal(await choose.isDisabled(),true);await read.click();
        await box.getByText("対象案件との対応記録を確認しました。変更・取消処理は未実施です。",{exact:true}).waitFor();
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await box.screenshot({path:resolve(output,run+".png")});
    }
    assert.deepEqual(errors,[]);await page.close();results.push({binding:mode,width});
  }


  if(!process.argv.includes("--hold-only") && !process.argv.includes("--resolve-only")) for(const [mode,width] of [["both",320],["both",390],["both",1280],["stale",390],["offline",390],["owner",390]]) {
    const run="open-"+mode+"-"+width,state=seed();states.set(run,state);
    state.h.records.get(state.h.paths.receipt).status="review";state.h.records.get(state.h.paths.candidate).status="review";
    state.h.records.get(state.h.paths.feature).caseMailIntakeEnabled=true;
    state.h.records.set("jobs/target-1",{companyId,...clone(state.h.input),caseId:"case-1",revision:1,status:"draft"});
    const request={expectedCompanyId:companyId,expectedActorUid:state.h.auth.uid,receiptId:"receipt-1",candidateId:"candidate-1",jobId:"target-1"};
    const auth=state.h.auth;
    const preview=await state.review.getCaseMailTargetPreview({data:request,auth});
    await state.review.confirmCaseMailTarget({data:{...request,reviewVersion:preview.reviewVersion,note:"合成原文を確認",confirmed:true},auth});
    const before=JSON.stringify([...state.h.records]);
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
    page.on("pageerror",e=>errors.push(e.message));await blockExternal(page);
    await page.goto(base+"/__mail_test.html?run="+run);await openDetail(panel(page));
    const box=page.getByRole("region",{name:"対象案件の対応確定",exact:true});
    await box.getByRole("button",{name:"対応先を再確認",exact:true}).click();
    const edit=box.getByRole("button",{name:"対応先の案件を編集",exact:true});
    const cancel=box.getByRole("button",{name:"対応先の取消を確認",exact:true});
    await edit.waitFor();
    if(mode==="stale")state.h.records.get("jobs/target-1").revision++;
    if(mode==="offline")await page.evaluate(()=>window.fault.previewTarget="offline");
    if(mode==="owner")await page.evaluate(()=>window.fault.previewTarget="hold");
    await edit.click();
    if(mode==="owner"){await page.evaluate(()=>window.changeOwner());await panel(page).getByText("受信した案件候補はありません。",{exact:true}).waitFor();await release(state);}
    else if(mode==="both"){
      await page.waitForFunction(()=>window.opened?.length===1);
      await cancel.click();await page.waitForFunction(()=>window.opened?.length===2);
      assert.deepEqual(await page.evaluate(()=>window.opened),[{jobId:"target-1",action:"edit"},{jobId:"target-1",action:"cancel"}]);
      assert.equal(JSON.stringify([...state.h.records]),before);
      await box.screenshot({path:resolve(output,run+".png")});
    }else{
      await box.getByRole("status").last().waitFor();
      assert.deepEqual(await page.evaluate(()=>window.opened||[]),[]);
      assert.equal(state.h.list("auditLogs").filter(x=>x.action==="caseMail.target.confirm").length,1);
    }
    assert.ok(state.calls.every(c=>["list","read","previewTarget"].includes(c.action)));
    assert.deepEqual(errors,[]);await page.close();results.push({open:mode,width});
  }


  if(process.argv.includes("--hold-only")) for(const [mode,width] of [["change",320],["change",390],["change",1280],["cancel",390],["lost",390],["stale",390]]) {
    const run="hold-"+mode+"-"+width,h=await targetHoldFixture(),state={h,review:h.load("./case-mail-review"),calls:[],release:null};states.set(run,state);
    const before=clone(h.targetJob()),page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
    page.on("pageerror",e=>errors.push(e.message));await blockExternal(page);await page.goto(base+"/__mail_test.html?run="+run);await openDetail(panel(page));
    const box=page.getByRole("region",{name:"対象案件の対応確定",exact:true}),read=box.getByRole("button",{name:"対応先を再確認",exact:true});
    await read.click();const saveHold=box.getByRole("button",{name:"依頼を保留して募集を停止",exact:true});await saveHold.waitFor();assert.equal(await saveHold.isDisabled(),true);
    await box.getByLabel("受信した依頼",{exact:true}).selectOption(mode==="cancel"?"cancel":"change");
    await box.getByLabel("原文の変更・取消依頼を確認し、募集を停止して保留します。",{exact:true}).check();
    if(mode==="lost")await page.evaluate(()=>window.fault.holdTarget="lost");
    if(mode==="stale")h.targetJob().revision++;
    await saveHold.click();await box.getByText(/対応先を再確認してください/).waitFor();assert.equal(await saveHold.isDisabled(),true);
    assert.equal(state.calls.filter(x=>x.action==="holdTarget").length,1);await read.click();
    if(mode==="stale"){await box.getByText(/対応記録後に受信内容/).waitFor();assert.equal(h.targetJob().mailTargetHold,undefined);}
    else {
      await box.getByText("変更・取消依頼を確認中です。募集は停止しています。案件条件・取消の確定と保留解除は未完了です。",{exact:true}).waitFor();
      assert.equal(h.targetJob().publishable,false);assert.equal(h.targetJob().storeName,before.storeName);assert.equal(h.targetJob().cancelled,before.cancelled);
      assert.equal(h.list("auditLogs").filter(x=>x.action==="caseMail.target.hold").length,1);
      await box.getByRole("button",{name:"対応先の案件を編集",exact:true}).click();await page.waitForFunction(()=>window.opened?.length===1);
      assert.deepEqual(await page.evaluate(()=>window.opened),[{jobId:h.targetJobId,action:"edit"}]);
      await box.screenshot({path:resolve(output,run+".png")});
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
    await page.close();results.push({hold:mode,width});
  }


  if(process.argv.includes("--resolve-only"))for(const [mode,width] of [["change",320],["change",390],["change",1280],["cancel",390],["lost",390],["stale",390],["pending",390],["origin",390],["owner",390]]){
    const run="resolve-"+mode+"-"+width,h=await targetResolutionFixture({kind:mode==="cancel"?"cancel":"change",ready:mode!=="pending"});
    if(mode==="origin"){await h.receiveChange();await h.reimport();}
    const state={h,review:h.load("./case-mail-review"),calls:[],release:null};states.set(run,state);
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on("pageerror",e=>errors.push(e.message));await blockExternal(page);
    await page.goto(base+"/__mail_test.html?run="+run);
    const box=page.getByRole("region",{name:"対象案件の対応確定",exact:true});
    const records=[...h.records].filter(([p,v])=>p.startsWith("caseMailIntakeReceipts/")&&v.companyId===companyId).sort(([a],[b])=>a.localeCompare(b));
    await panel(page).getByRole("button",{name:"内容を確認",exact:true}).nth(records.findIndex(([p])=>p.endsWith("/"+h.targetReceiptId))).click();
    const read=box.getByRole("button",{name:"対応先を再確認",exact:true});await read.click();
    const save=box.getByRole("button",{name:"このメールの保留を解除",exact:true});await save.waitFor();assert.equal(await save.isDisabled(),true);
    if(mode!=="pending"){
      await box.getByLabel("保留解除の確認メモ",{exact:true}).fill("原文・原本・担当を確認");
      await box.getByLabel("原文・案件・原本の照合結果を確認しました。",{exact:true}).check();
      if(mode==="lost")await page.evaluate(()=>window.fault.resolveTarget="lost");
      if(mode==="stale")h.job().revision++;
      if(mode==="owner")await page.evaluate(()=>window.fault.resolveTarget="hold");
      await save.click();
      if(mode==="owner"){
        await page.waitForFunction(()=>document.querySelector("textarea")?.disabled===true);
        await page.evaluate(()=>window.changeOwner());await panel(page).getByText("受信した案件候補はありません。",{exact:true}).waitFor();await release(state);
        assert.equal(await page.getByText(/このメールの保留を解除しました/).count(),0);
      }else{
        await box.getByText(/対応先を再確認してください/).waitFor();assert.equal(await save.isDisabled(),true);await read.click();
        if(mode==="stale"){await save.waitFor();assert.ok(h.job().mailTargetHold);}
        else{
          await box.getByText("このメールの保留解除を確認しました。解除時に募集は再開していません。",{exact:true}).waitFor();
          assert.equal(h.job().mailTargetHold,undefined);assert.equal(h.job().publishable,false);
          assert.equal(h.list("auditLogs").filter(x=>x.action==="caseMail.target.resolve").length,1);
          if(mode==="origin")await box.getByText("元メール側の確認待ちは残ります。元メールの受信内容も確認してください。",{exact:true}).waitFor();
        }
      }
    }
    if(mode!=="owner")await box.screenshot({path:resolve(output,run+".png")});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
    await page.close();results.push({resolve:mode,width});
  }

  writeFileSync(resolve(output, "result.json"), JSON.stringify({ results, cloudAccess: false }, null, 2));
  console.log(process.argv.includes("--resolve-only") ? "別メール解除画面: 3幅・取消・応答喪失・古い版・未反映・元保留・会社切替の9条件成功。" : process.argv.includes("--hold-only") ? "別メール保留画面: 3幅・変更/取消・応答喪失・古い版の6条件成功。" : process.argv.includes("--open-only") ? "対応先から既存編集・取消を開く画面6条件成功。" : process.argv.includes("--binding-only") ? "対象案件対応確定: 3幅・選び直し・保存/再読込・応答喪失・古い版・会社切替の6条件成功。" : process.argv.includes("--targets-only") ? "別メール対象候補画面: 3幅・複数/該当なし/検索上限/検索不可の6条件成功、書込みなし。" : "受信候補画面: 既存導線と対象候補6条件成功。");
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {});
    writeFileSync(resolve(output, "failure.txt"), (await page.locator("body").innerText().catch(() => "")) + "\n" + error.stack);
  }
  throw error;
} finally { await browser?.close(); await server.close(); }
