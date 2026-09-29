import assert from "node:assert/strict";
import {resolve} from "node:path";
import {mkdirSync} from "node:fs";
import {chromium} from "@playwright/test";
import {createAdminLocalServer} from "./serve-admin-local.mjs";
const server=createAdminLocalServer(resolve("apps/admin",process.env.LKC_ADMIN_DIST||"dist"));
await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
 browser=await chromium.launch({headless:true});
 for(const width of [390,1280]){
  const page=await browser.newPage({viewport:{width,height:900},serviceWorkers:"block"});const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/*",r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  await page.goto(base);await page.getByText("LIVE DEMO v5.6",{exact:true}).waitFor();
  const nav=page.getByRole("navigation",{name:"管理業務"});
  await nav.getByRole("button",{name:"案件",exact:true}).click();
  const panel=page.getByRole("region",{name:"原本の確認と取込"});await panel.waitFor();
  assert.equal(await page.locator(".workspace-panel:not([hidden]) h2").first().textContent(),"スプシ同期");
  await panel.locator('input[type="month"]').fill("2099-10");
  await panel.getByRole("button",{name:"原本を読取プレビュー",exact:true}).click();
  await panel.getByRole("region",{name:"シフト表の読取結果"}).waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.id),"shift-import");
  assert.ok(await panel.innerText().then(t=>t.includes("サンプル店舗")));
  await nav.getByRole("button",{name:"通知・運用",exact:true}).click();
  await page.getByRole("button",{name:"原本の読取結果を見る",exact:true}).click();
  assert.equal(await nav.getByRole("button",{name:"案件",exact:true}).getAttribute("aria-pressed"),"true");
  await panel.waitFor();assert.equal(await panel.locator('input[type="month"]').inputValue(),"2099-10");
  await page.getByRole("heading",{name:"案件一覧",exact:true}).waitFor();
  assert.equal(await page.getByText("この部分を表示できませんでした。",{exact:false}).count(),0);
  assert.equal(await page.locator("header img").evaluate(i=>i.complete&&i.naturalWidth>0),true);
  assert.deepEqual(errors,[]);
  if(process.env.LKC_VISUAL_EVIDENCE_DIR){mkdirSync(process.env.LKC_VISUAL_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:resolve(process.env.LKC_VISUAL_EVIDENCE_DIR,`preview-${width}.png`)});}
  await page.close();
 }
 console.log("Shift preview navigation: 390/1280px, jobs entry, result focus, return link, preserved month, lazy panels, logo passed; synthetic data only.");
}finally{await browser?.close();await new Promise(ok=>server.close(ok));}
