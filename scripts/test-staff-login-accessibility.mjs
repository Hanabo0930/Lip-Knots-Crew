import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const dependencyRoot=process.env.LKC_TEST_DEPENDENCY_ROOT||repo;
const require=createRequire(path.join(dependencyRoot,"package.json"));
const ts=require("typescript"),React=require("react"),{renderToStaticMarkup}=require("react-dom/server"),{chromium}=require("@playwright/test");
const app=readFileSync(path.join(repo,"apps/staff/src/App.tsx"),"utf8"),css=readFileSync(path.join(repo,"apps/staff/src/styles.css"),"utf8");
const start=app.indexOf("  if(firebaseConfigured&&(!authResolved||emailLinkPending))return"),end=app.indexOf('\n  return <main className="app-shell">',start);
assert.ok(start>=0&&end>start,"actual login branches not found");
const branch=ts.transpileModule("const Render=()=>{"+app.slice(start,end)+";return null;};Render;",{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
function render(mode){
 const busy=mode==="send-pending",context={React,firebaseConfigured:true,authResolved:mode!=="initial-wait",emailLinkPending:mode==="link-wait",user:null,
 title:"Lip Knots Crew",adminLoginUrl:"https://admin.example.invalid",loginActionPending:busy,loginEmailRef:{current:null},
 email:"synthetic@example.test",loginCode:"123456",message:"",isPending:key=>busy&&key==="login",setEmail:()=>{},setLoginCode:()=>{},
 requestLogin:()=>assert.fail("No real login in DOM fixture"),verifyLoginCode:()=>assert.fail("No real login in DOM fixture"),
 messageTone:()=>"info",messageClassName:()=>"message"};
 const Component=vm.runInNewContext(branch,context);return renderToStaticMarkup(React.createElement(Component));
}
const configPath=path.join(repo,"apps/staff/tsconfig.json"),config=ts.readConfigFile(configPath,ts.sys.readFile);
assert.equal(config.error,undefined);
const converted=ts.convertCompilerOptionsFromJson(config.config.compilerOptions,path.dirname(configPath));
const program=ts.createProgram([path.join(repo,"apps/staff/src/App.tsx"),path.join(repo,"apps/staff/src/vite-env.d.ts")],
 {...converted.options,noEmit:true,incremental:false,ignoreDeprecations:"6.0"});
const diagnostics=ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:p=>p,getCurrentDirectory:()=>repo,getNewLine:()=>String.fromCharCode(10)}));
const browser=await chromium.launch({headless:true}),results=[],externalAttempts=[];
try {
 for(const scenario of [
  {mode:"initial-wait",width:320,scale:1},
  {mode:"link-wait",width:390,scale:2},
  {mode:"ready",width:320,scale:2},
  {mode:"send-pending",width:320,scale:2},
  {mode:"ready",width:390,scale:1}
 ]){
  const context=await browser.newContext({viewport:{width:scenario.width,height:844}});
  await context.route("**/*",route=>{
   const url=route.request().url();
   if(url.startsWith("http://127.0.0.1/"))return route.fulfill({status:200,contentType:"image/png",body:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64")});
   externalAttempts.push(url.split("?")[0]);return route.abort("blockedbyclient");
  });
  const page=await context.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));
  await page.setContent('<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="http://127.0.0.1/"><style>'+css+'</style></head><body>'+render(scenario.mode)+"</body></html>");
  if(scenario.scale===2)await page.evaluate(()=>{
   const values=[...document.querySelectorAll(".login-card h1,.login-card p,.login-card input,.login-card button,.login-card summary,.login-card a,.login-card .message")].map(element=>[element,parseFloat(getComputedStyle(element).fontSize)]);
   for(const [element,size]of values)element.style.fontSize=size*2+"px";
  });
  await page.getByRole("heading",{name:"Lip Knots Crew"}).waitFor();
  assert.equal(await page.getByRole("img").count(),0,"decorative logo must not repeat adjacent title");
  if(scenario.mode.endsWith("wait")){
   const status=page.getByRole("status");assert.equal(await status.count(),1);
   assert.match(await status.innerText(),/ログインを確認しています/);assert.match(await status.innerText(),/そのままお待ちください/);
   assert.equal(await page.getByRole("textbox").count(),0,"pending Auth must not expose an actionable login form");
   assert.equal(await page.getByRole("button").count(),0);
  }else if(scenario.mode==="send-pending"){
   const inputs=page.getByRole("textbox");assert.equal(await inputs.count(),2);
   for(const input of await inputs.all())assert.equal(await input.isDisabled(),true);
   for(const button of await page.getByRole("button").all())assert.equal(await button.isDisabled(),true);
   assert.equal(await page.locator('form[aria-busy="true"]').count(),2);
  }else{
   const email=page.getByRole("textbox",{name:"スタッフのメールアドレス"}),code=page.getByRole("textbox",{name:"確認コード",exact:true});
   assert.equal(await email.isEnabled(),true);assert.equal(await code.isEnabled(),true);
   await page.locator("body").click({position:{x:2,y:2}});await page.keyboard.press("Tab");await email.focus();
   await page.keyboard.press("Tab");assert.equal(await page.getByRole("button",{name:"ログインメールを送る",exact:true}).evaluate(el=>el===document.activeElement),true);
   const help=page.locator("summary");await help.focus();await page.keyboard.press("Enter");assert.equal(await page.locator("details").getAttribute("open"),"");
   await code.focus();assert.equal(await code.evaluate(el=>el===document.activeElement),true);
   assert.equal(await page.getByRole("button",{name:"確認コードでログイン",exact:true}).isEnabled(),true);
  }
  const dimensions=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,
   controls:[...document.querySelectorAll("input,button,summary")].map(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}))}));
  assert.ok(dimensions.scroll<=dimensions.viewport+1,JSON.stringify(dimensions));
  assert.ok(dimensions.controls.every(x=>x.left>=-1&&x.right<=dimensions.viewport+1),JSON.stringify(dimensions));
  assert.deepEqual(errors,[]);
  results.push({...scenario,passed:true,dimensions});await context.close();
 }
 assert.deepEqual(externalAttempts,[]);
}finally{await browser.close();}
const result={scopedTypes:"PASS",browserScenarios:results.length,results,externalRequests:0,authSdkLoaded:false,
 realLogin:false,realEmail:false,cloudApiExecuted:false,boundary:"Actual login JSX rendered by React into loopback-intercepted local DOM; no Auth state/service acceptance."};
if(process.env.LKC_TEST_EVIDENCE_PATH)writeFileSync(process.env.LKC_TEST_EVIDENCE_PATH,JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({scopedTypes:"PASS",browserScenarios:results.length,externalRequests:0,realLogin:false}));
