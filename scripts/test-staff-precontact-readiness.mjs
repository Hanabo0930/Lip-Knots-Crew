import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createServer} from "vite";
import {chromium} from "@playwright/test";

const output=process.argv[2];if(!output)throw Error("新規の合成ブラウザー証跡保存先を指定してください。");
const destination=path.resolve(output);if(fs.existsSync(destination))throw Error("既存の証跡は変更しません。");
fs.mkdirSync(destination,{recursive:true});
const report={startedAt:new Date().toISOString(),scope:"Actual Staff App with a synthetic refreshed-job state seam; no Firebase configuration, cloud writes or messages",results:[],deploymentPerformed:false,cloudResourcesChanged:false};
const server=await createServer({root:path.resolve("apps/staff"),configFile:path.resolve("apps/staff/vite.config.ts"),server:{host:"127.0.0.1",port:0},plugins:[{
 name:"precontact-readiness-synthetic-state",enforce:"pre",
 transform(source,id){if(!id.split("?")[0].replaceAll("\\","/").endsWith("/apps/staff/src/App.tsx"))return;
  const marker="  const selectedAssignedJob=";assert.equal(source.split(marker).length,2);
  // テスト用の読取結果だけを更新する。製品コードや実データに操作入口は追加しない。
  return source.replace(marker,`  Object.assign(window,{__precontactReadinessFixture:(flags:Partial<Job>)=>{
    setMyJobs(current=>current.map(job=>job.id===selectedJob?.id?{...job,...flags}:job));
    setSelectedJob(current=>current?{...current,...flags}:current);
  }});\n`+marker);
 }
}]});
let browser,page;const errors=[],externalRequests=[];
try{
 if(Object.entries(server.config.env).some(([name,value])=>name.startsWith("VITE_FIREBASE_")&&value))throw Error("合成検証はFirebase設定のない実行キャッシュだけで行います。");
 await server.listen();const port=server.httpServer.address().port;browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route("**/*",route=>{const url=new URL(route.request().url());if(url.hostname==="127.0.0.1"||url.protocol==="data:"||url.protocol==="blob:")return route.continue();externalRequests.push(url.origin);return route.abort();});
 for(const width of [320,390,1280]){
  page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));page.setDefaultTimeout(10000);await page.setViewportSize({width,height:844});
  await page.goto(`http://127.0.0.1:${port}/`);await page.getByRole("button",{name:"シフトを開く",exact:true}).click();
  const detail=page.getByRole("region",{name:"選択したシフトの詳細",exact:true}),temperature=detail.getByLabel("体温",{exact:true}),arrival=detail.getByLabel("到着予定時刻",{exact:true});
  await temperature.fill("36.8");await arrival.fill("10:20");
  const applyFlags=async flags=>page.evaluate(async value=>{window.__precontactReadinessFixture(value);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},flags);
  for(const [flag,reason]of [["sourceMissing","取込元"],["applicationUnconfirmed","シフト表の担当確認"],["assignmentUnresolved","担当者の照合"],["mailIntakeReviewRequired","受信内容・勤務条件"]]){
   await applyFlags({sourceMissing:false,applicationUnconfirmed:false,assignmentUnresolved:false,mailIntakeReviewRequired:false,[flag]:true,preContactNeedsReview:true,preContactSyncPending:true});
   const send=detail.getByRole("button",{name:/^事前連絡(?:を送信|は確認待ち)$/});
   assert.equal(await send.isDisabled(),true,"確認待ちの送信ボタンを無効にする");
   const notice=detail.locator("#precontact-readiness");assert.match(await notice.innerText(),new RegExp(reason));assert.equal(await notice.getAttribute("role"),"status");
   assert.equal(await send.getAttribute("aria-describedby"),"precontact-readiness");assert.equal(await temperature.isEnabled(),true);assert.equal(await arrival.isEnabled(),true);
   assert.equal(await temperature.inputValue(),"36.8");assert.equal(await arrival.inputValue(),"10:20");
   assert.equal(await detail.getByText("事前連絡を入力し、内容を確認して送信してください。",{exact:true}).count(),0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   if(width===390&&flag==="applicationUnconfirmed"){await notice.evaluate(node=>node.scrollIntoView({block:"start"}));await page.screenshot({path:path.join(destination,"pending-390.png")});}
   if(width===320&&flag==="applicationUnconfirmed"){
    await page.addStyleTag({content:"html,body,button,input,p,label{font-size:24px!important}"});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await page.locator(".bottom-nav").evaluate(nav=>{
     const outer=nav.getBoundingClientRect();
     return [...nav.querySelectorAll("button")].every(button=>{
      const bounds=button.getBoundingClientRect();if(bounds.left<outer.left-1||bounds.right>outer.right+1)return false;
      return [...button.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE&&node.textContent?.trim()).every(node=>{
       const range=document.createRange();range.selectNodeContents(node);return [...range.getClientRects()].every(rect=>rect.left>=bounds.left-1&&rect.right<=bounds.right+1);
      });
     });
    }),true,"文字拡大でも下部タブの文字が隣の項目や画面外へ重ならない");
    await notice.evaluate(node=>node.scrollIntoView({block:"start"}));await page.screenshot({path:path.join(destination,"pending-320-large-text.png")});
    await page.locator("style").evaluateAll(nodes=>nodes.filter(node=>node.textContent?.includes("font-size:24px!important")).forEach(node=>node.remove()));
   }
   if(flag==="mailIntakeReviewRequired"){assert.ok((await detail.innerText()).includes("受信内容・勤務条件を確認中"));assert.ok(!(await detail.innerText()).includes("準備完了"));await page.screenshot({path:path.join(destination,"mail-hold-"+width+".png"),fullPage:true});}
   report.results.push({width,flag,passed:true});
  }
  await applyFlags({sourceMissing:false,applicationUnconfirmed:false,assignmentUnresolved:false,mailIntakeReviewRequired:false,preContactNeedsReview:true,preContactSyncPending:true});
  const send=detail.getByRole("button",{name:"事前連絡を送信",exact:true});assert.equal(await send.isEnabled(),true);assert.equal(await detail.locator("#precontact-readiness").count(),0);
  assert.equal(await temperature.inputValue(),"36.8");assert.equal(await arrival.inputValue(),"10:20");
  await send.focus();await page.keyboard.press("Enter");await page.getByText("デモ：事前連絡を送信しました。",{exact:true}).waitFor();
  assert.match(await detail.getByLabel("登録済みの事前連絡").innerText(),/36\.8℃.*10:20/);
  report.results.push({width,refreshedReadinessPreservesDraftAndKeyboardSubmission:true,passed:true});await page.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;if(page&&!page.isClosed())await page.screenshot({path:path.join(destination,"failure.png"),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{await browser?.close();await server.close();report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(destination,"result.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
