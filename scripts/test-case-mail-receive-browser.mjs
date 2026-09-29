import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {createServer} from "vite";
import {chromium} from "@playwright/test";
import {harness,companyId} from "./case-mail-test-harness.mjs";
const output=path.resolve(process.argv[2]??"release-evidence/case-mail-receiver-20260929/browser");fs.mkdirSync(output,{recursive:true});
const states=new Map();
const html=`import React from "react";import {createRoot} from "react-dom/client";import Panel from "/src/CaseMailIntakePanel.tsx";import "/src/styles.css";
function Fixture(){const[owner,setOwner]=React.useState({companyId:"synthetic-company",uid:"synthetic-admin"});window.changeOwner=()=>setOwner({companyId:"other-company",uid:"other-admin"});
const call=async(action,input={})=>{const r=await fetch("/__receive_rpc"+location.search,{method:"POST",body:JSON.stringify({action,input,owner})});const out=await r.json();if(!out.ok)throw Error(out.message);return out.data;};
return <main className="shell"><Panel key={owner.companyId+owner.uid} {...owner} api={{receive:cursor=>call("receive",cursor?{cursor}:{}),list:cursor=>call("list",cursor?{cursor}:{}),read:receiptId=>call("read",{receiptId}),create:command=>call("create",command)}} onCreated={()=>window.created=(window.created||0)+1} onClose={()=>{}}/></main>;}createRoot(document.getElementById("root")).render(<Fixture/>);`;
const server=await createServer({root:path.resolve("apps/admin"),configFile:path.resolve("apps/admin/vite.config.ts"),server:{host:"127.0.0.1",port:0},plugins:[{name:"synthetic-receive",configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url,"http://localhost");if(url.pathname==="/__receive.html"){res.setHeader("Content-Type","text/html");res.end(await dev.transformIndexHtml(url.pathname,'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">'+ts.transpileModule(html,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText+'</script>'));return;}
 if(url.pathname!=="/__receive_rpc")return next();
 const state=states.get(url.searchParams.get("run"));let body="";for await(const c of req)body+=c;
 const {action,input,owner}=JSON.parse(body);res.setHeader("Content-Type","application/json");
 try {let data;const scope={expectedCompanyId:owner.companyId,expectedActorUid:owner.uid},auth={uid:owner.uid,token:{role:"admin",companyId:owner.companyId}};
  if(action==="receive"){state.calls.push(input.cursor??null);state.visible=true;
   if(state.mode==="owner"||state.mode==="busy")await new Promise(resolve=>state.release=resolve);
   if((state.mode==="loss"||state.mode==="loss-list")&&state.calls.length===1)throw Error("途中まで保存された候補は一覧で確認できます。同じ範囲を再試行してください。");
   data=state.mode==="invalid"?{ok:true,received:6,skipped:0,nextCursor:"p2"}:{ok:true,received:input.cursor?0:1,skipped:0,nextCursor:input.cursor?null:"p2"};
  }else if(action==="list"){if(state.mode==="loss-list"&&state.visible)throw Error("合成：候補一覧を読み込めません。");data=state.visible?await state.review.listCaseMailReceipts({auth,data:{...scope,...input}}):{ok:true,items:[],nextCursor:null};}
  else if(action==="read")data=await state.review.getCaseMailReceipt({auth,data:{...scope,...input}});
  else if(action==="create")data=await state.h.create(input,auth);
  else throw Error("unknown action");res.end(JSON.stringify({ok:true,data}));
 }catch(error){res.end(JSON.stringify({ok:false,message:error.message}));}
 });}}]});
let browser;const results=[];
try{await server.listen();browser=await chromium.launch({headless:true});
 for(const [mode,width]of [["success",320],["success",390],["success",1280],["loss",390],["loss-list",390],["invalid",390],["owner",390],["busy",390]]){
  const run=mode+width,h=harness(),state={mode,h,review:h.load("./case-mail-review"),visible:false,calls:[],release:null};states.set(run,state);
  const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];page.on("pageerror",e=>errors.push(e.message));await page.goto(server.resolvedUrls.local[0]+"__receive.html?run="+run);
  const start=page.getByRole("button",{name:"受信箱のメールを確認",exact:true});await start.click();
  if(mode==="busy"||mode==="owner"){
   await page.getByRole("button",{name:"処理中…",exact:true}).waitFor();assert.equal(state.calls.length,1);
   if(mode==="owner")await page.evaluate(()=>window.changeOwner());else assert.equal(await page.getByRole("button",{name:"処理中…",exact:true}).isDisabled(),true);
   while(!state.release)await new Promise(r=>setTimeout(r,10));state.release();
  }
  if(mode==="owner"){await start.waitFor();assert.equal(await page.getByText(/1通を確認しました/).count(),0);}
  else if(mode==="loss-list"){await page.getByRole("alert").filter({hasText:"途中まで保存された候補"}).waitFor();await page.getByRole("alert").filter({hasText:"候補一覧を読み込めません"}).waitFor();assert.deepEqual(state.calls,[null]);assert.equal(await page.getByRole("button",{name:"内容を確認",exact:true}).count(),0);}
  else if(mode==="invalid"){await page.getByRole("alert").waitFor();assert.equal(await page.getByRole("button",{name:"続きのメールを確認",exact:true}).count(),0);}
  else {
   if(mode==="loss"){await page.getByRole("alert").waitFor();await page.getByRole("button",{name:"内容を確認",exact:true}).waitFor();assert.deepEqual(state.calls,[null]);await start.click();assert.deepEqual(state.calls,[null,null]);}
   await page.getByText(/1通を確認しました/).waitFor();await page.getByRole("button",{name:"内容を確認",exact:true}).click();
   await page.getByLabel("内容を確認しました。1名分の下書きを作成します。",{exact:true}).check();await page.getByRole("button",{name:"確認した候補を下書き作成",exact:true}).click();await page.getByText(/下書きを作成しました/).waitFor();
   assert.equal(h.list("jobs").length,1);assert.equal(await page.evaluate(()=>window.created),1);
   if(mode!=="busy"){await page.getByRole("button",{name:"続きのメールを確認",exact:true}).click();await page.getByText(/受信箱の確認が終わりました/).waitFor();assert.equal(state.calls.at(-1),"p2");}
  }
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(output,run+".png"),fullPage:true});await page.close();results.push({mode,width});
 }
 fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({results,cloudAccess:false},null,2));console.log(JSON.stringify({receiveBrowserScenarios:results.length,cloudAccess:false}));
}finally{await browser?.close();await server.close();}
