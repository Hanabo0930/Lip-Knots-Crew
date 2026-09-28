import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { harness, companyId } from "./case-mail-test-harness.mjs";
const require = createRequire(import.meta.url), ts = require("typescript");
const compiled = process.argv.includes("--compiled");
function load(name, dependencies, globals = {}) {
  const source = fs.readFileSync(new URL(`../functions/${compiled ? "lib" : "src"}/${name}.${compiled ? "js" : "ts"}`, import.meta.url), "utf8");
  const code = compiled ? source : ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(code, { exports, require: key => { assert.ok(key in dependencies, key); return dependencies[key]; },
    Date, URLSearchParams, AbortSignal, ...globals });
  return exports;
}
const serviceAccountEmail = "synthetic-receiver@lip-knots-crew-staging.iam.gserviceaccount.com";
const origin = "https://lkcm-attachment-extractor-740154137290.asia-northeast1.run.app";
function setup() {
  const h = harness(), calls = [];
  h.records.delete(h.paths.receipt); h.records.delete(h.paths.candidate);
  h.records.get(h.paths.feature).caseMailIntakeEnabled = true;
  const config = { companyId, uid: "synthetic-ingester", producerId: "synthetic-producer",
    principalRevision: "principal-1", mailbox: "info@lipknots.com", startedAt: "2026-09-18T00:00:00Z", gmailServiceAccountEmail: serviceAccountEmail };
  h.records.set("caseMailReceiverConfigs/" + companyId, config);
  const text = ["実施日：2026/10/10", "クライアント：合成取引先", "店舗：合成店舗", "メーカー：合成メーカー",
    "メニュー：試食", "入店時間：09:30", "実施時間：10:00～18:00", "人数：1名"].join("\n");
  const bytes = Buffer.from(text), raw = { id: "synthetic-mail", internalDate: String(Date.parse("2026-09-18T01:00:00Z")),
    payload: { partId: "0", mimeType: "text/plain", headers: [{ name: "From", value: "client@example.invalid" },
      { name: "To", value: "info@lipknots.com" }, { name: "Subject", value: "新規手配依頼" }],
      body: { size: bytes.length, data: bytes.toString("base64url") } } };
  const env = { APP_ENVIRONMENT: "staging", EXPECTED_FIREBASE_PROJECT_ID: "lip-knots-crew-staging" };
  const state = { failCredentials: false, afterFetch: null, page: {messages:[{id:"synthetic-mail"}],nextPageToken:null}, profile:"info@lipknots.com" };
  const deps = {
    obtainGmailAccessToken: async context => { calls.push("token"); assert.equal(context.mailbox,"info@lipknots.com");
      if(state.failCredentials)throw Error("synthetic-secret-never-expose"); return "synthetic-token"; },
    obtainExtractorCredentials: async () => { throw Error("unexpected extractor"); },
    fetchImpl: async (url, options) => {
      url = String(url); calls.push(url); assert.equal(options.method, "GET");
      if (url.endsWith("/profile")) return new Response(JSON.stringify({ emailAddress: state.profile }));
      if(new URL(url).pathname.endsWith("/messages")){assert.equal(new URL(url).searchParams.get("maxResults"),"5");return new Response(JSON.stringify(state.page));}
      assert.match(url, /messages\/synthetic-mail/); await state.afterFetch?.(); return new Response(JSON.stringify(raw));
    },
  };
  const api = load("case-mail-receive", {
    "firebase-functions/v2/https": h.load("firebase-functions/v2/https"),
    "firebase-functions/params": { defineSecret: name => { assert.equal(name,"CASE_MAIL_EXTRACTOR_SECRET"); return { value: () => "s".repeat(43) }; } },
    zod: require("zod"), "./firebase": h.load("./firebase"), "./utils": h.load("./utils"),
    "./case-mail-gmail": h.load("./case-mail-gmail"), "./case-mail-intake": h.load("./case-mail-intake"),
    "../case-mail-runtime/read-mail.cjs": require("../functions/case-mail-runtime/read-mail.cjs"),
    "./case-mail-cloud-auth": { createCaseMailCloudAuth: account => { assert.equal(account,serviceAccountEmail); return deps; } },
  }, { process: { env } });
  const data = { messageId: raw.id, expectedCompanyId: companyId, expectedActorUid: h.auth.uid };
  return { h, calls, config, env, state, data, batch: (cursor) => api.receiveCaseMailMessages({auth:h.auth,data:{expectedCompanyId:companyId,expectedActorUid:h.auth.uid,...(cursor?{cursor}:{})}}), receive: (input = data, auth = h.auth) => api.receiveCaseMailMessage({ data: input, auth }) };
}
let cases = 0;
async function check(name, fn) { await fn(); cases++; console.log("成功: " + name); }
await check("管理者受信→Gmail本文→保存→Crew下書き、同じ依頼の再送でも1件", async () => {
  const f = setup(), out = await f.receive(); assert.equal(out.ok,true); assert.equal(out.status,"ready");
  const command = { mailIntake: { receiptId: out.receiptId, candidateId: out.candidateIds[0], expectedReceiptRevision:out.revision, expectedRevision:1, operationId:"receive-create-1" } };
  await f.h.create(command); await f.receive(); await f.h.create(command);
  assert.equal(f.h.list("jobs").length,1); assert.equal(f.h.list("jobs")[0].status,"draft");
  assert.equal(f.h.list("caseMailIntakeReceipts").length,1);
});
for (const [name, mutate] of [
  ["未認証", f=>f.auth=null], ["スタッフ権限", f=>f.auth={...f.h.auth,token:{...f.h.auth.token,role:"staff"}}],
  ["所属の差替え", f=>f.data.expectedCompanyId="other"], ["本人の差替え",f=>f.data.expectedActorUid="other"],
  ["認証情報の持込み",f=>f.data.accessToken="forged"], ["原文の持込み",f=>f.data.preview={}],
  ["本番環境",f=>f.env.APP_ENVIRONMENT="production"], ["別プロジェクト",f=>f.env.EXPECTED_FIREBASE_PROJECT_ID="other"],
  ["別受信箱",f=>f.config.mailbox="other@example.invalid"], ["設定の別会社",f=>f.config.companyId="other"],
  ["設定なし",f=>f.h.records.delete("caseMailReceiverConfigs/"+companyId)],
  ["機能停止",f=>f.h.records.get(f.h.paths.feature).caseMailIntakeEnabled=false],
  ["受信実行者失効",f=>f.h.records.get(f.h.paths.principal).active=false],
]) await check(name+"は取得前に拒否", async()=>{
  const f=setup(); mutate(f); await assert.rejects(f.receive(f.data,"auth" in f?f.auth:f.h.auth)); assert.equal(f.calls.length,0);
});
await check("取得中の停止で保存しない",async()=>{
  const f=setup();f.state.afterFetch=()=>{f.h.records.get(f.h.paths.feature).caseMailIntakeEnabled=false;};
  await assert.rejects(f.receive());assert.equal(f.h.list("caseMailIntakeReceipts").length,0);
});
await check("認証例外の秘密を応答へ出さない",async()=>{
  const f=setup();f.state.failCredentials=true;await assert.rejects(f.receive(),e=>e.code==="failed-precondition"&&!e.message.includes("synthetic-secret"));
});
await check("受信箱の確認→候補一覧→Crew下書き、続きの範囲を返す",async()=>{
  const f=setup();f.state.page.nextPageToken="page-2";const out=await f.batch();assert.equal(out.received,1);assert.equal(out.nextCursor,"page-2");
  const api=f.h.load("./case-mail-review"),scope={expectedCompanyId:companyId,expectedActorUid:f.h.auth.uid};
  const list=await api.listCaseMailReceipts({auth:f.h.auth,data:scope});assert.equal(list.items.length,1);
  const detail=await api.getCaseMailReceipt({auth:f.h.auth,data:{...scope,receiptId:list.items[0].receiptId}});assert.equal(detail.candidates[0].creatable,true);
  await f.h.create({mailIntake:{receiptId:detail.receiptId,candidateId:detail.candidates[0].candidateId,expectedReceiptRevision:detail.revision,expectedRevision:detail.candidates[0].revision,operationId:"batch-create-1"}});
  f.state.page={messages:[],nextPageToken:null};const end=await f.batch("page-2");assert.equal(end.received,0);assert.equal(end.nextCursor,null);assert.equal(f.h.list("jobs").length,1);
});
await check("途中失敗は続きを返さず同じ範囲で受信を回収",async()=>{
  const f=setup();f.state.page={messages:[{id:"synthetic-mail"},{id:"synthetic-failure"}],nextPageToken:"page-2"};
  await assert.rejects(f.batch());assert.equal(f.h.list("caseMailIntakeReceipts").length,1);
  f.state.page.messages.pop();const out=await f.batch();assert.equal(out.nextCursor,"page-2");assert.equal(f.h.list("caseMailIntakeReceipts").length,1);
});
for(const [name,mutate]of[["重複ID",f=>f.state.page.messages.push({id:"synthetic-mail"})],["上限超え",f=>f.state.page.messages=Array.from({length:6},(_,i)=>({id:"mail-"+i}))],["受信箱相違",f=>f.state.profile="other@example.invalid"],["不正cursor",f=>f.state.page.nextPageToken="bad token"]])await check(name+"は本文取得前に拒否",async()=>{
  const f=setup();mutate(f);await assert.rejects(f.batch());assert.equal(f.h.list("caseMailIntakeReceipts").length,0);assert.ok(f.calls.every(x=>!x.includes("/messages/synthetic-mail")));
});
await check("受信停止中は一覧の認証も取得しない",async()=>{
  const f=setup();f.h.records.get(f.h.paths.feature).caseMailIntakeEnabled=false;await assert.rejects(f.batch());assert.equal(f.calls.length,0);
});
function authSetup() {
  const events=[], state={ status:200, body:{access_token:"synthetic-token",token_type:"Bearer"},secret:"s".repeat(43) };
  class GoogleAuth { async getIdTokenClient(audience) { events.push(["audience",audience]);return {idTokenProvider:{fetchIdToken:async a=>{events.push(["idtoken",a]);return "a.b.c";}}}; } }
  const api=load("case-mail-cloud-auth",{googleapis:{google:{auth:{GoogleAuth},iamcredentials:()=>({projects:{serviceAccounts:{signJwt:async(request,options)=>{events.push(["sign",request,options]);return {data:{signedJwt:"synthetic-assertion"}};}}}})}}},
    {fetch:async(url,options)=>{events.push(["exchange",url,options]);return new Response(JSON.stringify(state.body),{status:state.status});}});
  return {api,events,state,auth:api.createCaseMailCloudAuth(serviceAccountEmail,()=>state.secret)};
}
await check("鍵を作らず読取専用の短期委任認証を取得",async()=>{
  const f=authSetup();assert.equal(await f.auth.obtainGmailAccessToken({mailbox:"info@lipknots.com",scope:"https://www.googleapis.com/auth/gmail.readonly"}),"synthetic-token");
  const sign=f.events.find(e=>e[0]==="sign"),payload=JSON.parse(sign[1].requestBody.payload);
  assert.equal(payload.sub,"info@lipknots.com");assert.equal(payload.scope,"https://www.googleapis.com/auth/gmail.readonly");assert.equal(payload.exp-payload.iat,300);assert.equal(sign[2].timeout,30000);
  const exchange=f.events.find(e=>e[0]==="exchange");assert.equal(exchange[2].redirect,"error");assert.equal(exchange[2].body.get("assertion"),"synthetic-assertion");
});
await check("送信スコープ・別受信箱・別プロジェクトIDを拒否",async()=>{
  const f=authSetup();assert.throws(()=>f.api.createCaseMailCloudAuth("other@other.iam.gserviceaccount.com",()=>""));
  await assert.rejects(f.auth.obtainGmailAccessToken({mailbox:"info@lipknots.com",scope:"https://www.googleapis.com/auth/gmail.send"}));
  await assert.rejects(f.auth.obtainGmailAccessToken({mailbox:"other@example.invalid",scope:"https://www.googleapis.com/auth/gmail.readonly"}));assert.equal(f.events.length,0);
});
await check("抽出認証の宛先を固定し、秘密不足時は通信しない",async()=>{
  const f=authSetup();await assert.rejects(f.auth.obtainExtractorCredentials({mailbox:"info@lipknots.com",audience:"https://example.invalid"}));
  f.state.secret="";await assert.rejects(f.auth.obtainExtractorCredentials({mailbox:"info@lipknots.com",audience:origin}));assert.equal(f.events.length,0);
  f.state.secret="s".repeat(43);const result=await f.auth.obtainExtractorCredentials({mailbox:"info@lipknots.com",audience:origin});assert.equal(result.idToken,"a.b.c");assert.equal(f.events[0][1],origin);
});
await check("認証サーバーの失敗詳細を隠す",async()=>{
  const f=authSetup();f.state.status=400;f.state.body={error_description:"synthetic-secret-never-expose"};
  await assert.rejects(f.auth.obtainGmailAccessToken({mailbox:"info@lipknots.com",scope:"https://www.googleapis.com/auth/gmail.readonly"}),e=>!e.message.includes("synthetic-secret"));
});
console.log(JSON.stringify({caseMailReceiveTests:cases,compiled,cloudOperations:false}));
