import assert from "node:assert/strict";
import {readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {runInNewContext} from "node:vm";
import ts from "typescript";
const source=readFileSync("apps/admin/src/App.tsx","utf8").replace(/\r\n/g,"\n");
const start=source.indexOf('  // 運用情報は画面を開いたときだけ取得');
const end=source.indexOf('  useEffect(() => {\n    if (!user || !selectedAdminJobId)',start);
assert.ok(start>=0&&end>start);
const effectSource=source.slice(start,end);
const calls=[...effectSource.matchAll(/\b(load\w+)\([^;\n]*isCurrentRun\)/g)].map(match=>match[1]);
assert.equal(calls.length,11);
const startup=source.slice(source.indexOf('  useEffect(() => {\n    const activeAuth=auth;'),start);
assert.match(startup,/loadProductionControlStatus\(isCurrentRun\)/);
for(const name of calls)assert.ok(!startup.includes(name+'('),'Operations call leaked into startup: '+name);
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
for(const scenario of ['closed','not-ready','success','failure','cancelled','account-changed']){
 const states=[],gates=[];let cleanup;
 const scope={operationsRequested:scenario!=='closed',adminSessionReady:scenario!=='not-ready',firebaseConfigured:true,user:{uid:'first'},functions:{},auth:{currentUser:{uid:'first'}},operationsRetry:0,setOperationsLoadState:value=>states.push(value),useEffect:fn=>{cleanup=fn();}};
 for(const name of calls)scope[name]=()=>{const gate=deferred();gates.push(gate);return gate.promise;};
 runInNewContext(ts.transpileModule(effectSource,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);
 if(['closed','not-ready'].includes(scenario)){assert.equal(gates.length,0);assert.deepEqual(states,[]);continue;}
 assert.equal(gates.length,11);assert.deepEqual(states,['loading']);
 if(scenario==='cancelled')cleanup();
 if(scenario==='account-changed')scope.auth.currentUser={uid:'second'};
 gates.forEach((gate,index)=>scenario==='failure'&&index===0?gate.reject(new Error('offline')):gate.resolve());
 await Promise.allSettled(gates.map(gate=>gate.promise));await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(states,['cancelled','account-changed'].includes(scenario)?['loading']:['loading',scenario==='failure'?'error':'ready']);
}
console.log('Admin workspace logic passed: 11 deferred loaders, global control retained, closed/not-ready/success/failure/cancel/account cases.');
// 大量の合成案件でも、絞込漏れ・重複・ページ境界の欠落を防ぐ。
const searchScope={exports:{}};
runInNewContext(ts.transpileModule(readFileSync('apps/admin/src/job-search.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,searchScope);
const {buildJobSearchIndex,filterJobSearchIndex,jobListPage}=searchScope.exports;
const synthetic=Array.from({length:10000},(_,id)=>({id,workDate:'2026-09-05',storeName:'店舗 ＡＢＣ',makerName:'メーカー',clientName:'取引先',assignedStaffName:`担当${id}`,status:id%5===0?'cancelled':'assigned',preContact:id%2?{}:undefined}));
const index=buildJobSearchIndex(synthetic);
assert.equal(filterJobSearchIndex(index,' abc　２０２６-０９ ','all').length,10000);
assert.equal(filterJobSearchIndex(index,'存在しない','all').length,0);
assert.equal(filterJobSearchIndex(index,'  ','cancelled').length,2000);
assert.equal(filterJobSearchIndex(index,'','assigned').length,8000);
assert.equal(filterJobSearchIndex(index,'','precontact').length,4000);
const special=buildJobSearchIndex([{...synthetic[1],cancelled:true},{...synthetic[1],status:'open',preContact:undefined}]);
assert.equal(filterJobSearchIndex(special,'','precontact').length,0);
assert.equal(filterJobSearchIndex(special,'','cancelled').length,1);
const ids=[];
for(let page=0;page<200;page++){const view=jobListPage(synthetic,page);assert.equal(view.rows.length,50);ids.push(...view.rows.map(job=>job.id));}
assert.equal(ids.length,10000);assert.equal(new Set(ids).size,10000);assert.equal(ids[9999],9999);
assert.equal(jobListPage(synthetic.slice(0,51),999).rows[0].id,50);
assert.equal(jobListPage([],5).page,0);assert.equal(jobListPage([],5).rows.length,0);
assert.match(source,/jobPageView\.rows\.map/);
const timings=[];
for(let sample=0;sample<20;sample++){const start=performance.now();filterJobSearchIndex(index,'abc 2026','precontact');timings.push(performance.now()-start);}
timings.sort((a,b)=>a-b);
console.log(`Admin search passed: 10000 synthetic jobs, normalization/AND/status/cancellation, 200 pages without missing or duplicate rows. Node filter only: median ${timings[10].toFixed(2)}ms, p95 ${timings[18].toFixed(2)}ms (20 samples; not browser/network latency).`);
if(!process.argv.includes('--browser'))process.exit(0);
const {preview}=await import('vite');
const {chromium}=await import('@playwright/test');
const server=await preview({root:resolve('apps/admin'),configFile:resolve('apps/admin/vite.config.ts'),build:{outDir:process.env.LKC_ADMIN_DIST||'dist'},preview:{host:'127.0.0.1',port:0}});
let browser;
try{
 if(Object.entries(server.config.env).some(([key,value])=>key.startsWith('VITE_FIREBASE_')&&value))throw new Error('Demo-only verification requires no Firebase configuration.');
 const base=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[],scripts=new Set();
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('.js'))scripts.add(new URL(request.url()).pathname);});
 await page.route('**/*',route=>{const url=new URL(route.request().url());return url.hostname==='127.0.0.1'||['data:','blob:'].includes(url.protocol)?route.continue():route.abort();});
 await page.goto(base);await page.waitForLoadState('networkidle');
 const initial={domNodes:await page.locator('*').count(),scripts:[...scripts],visibleHeadings:await page.locator('h2').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>node.textContent))};
 const output=process.env.LKC_VISUAL_EVIDENCE_DIR;
 if(output){mkdirSync(output,{recursive:true});writeFileSync(resolve(output,process.argv.includes('--baseline')?'admin-baseline.json':'admin-current.json'),JSON.stringify(initial,null,2));await page.screenshot({path:resolve(output,process.argv.includes('--baseline')?'admin-baseline.png':'admin-overview.png')});}
 if(process.argv.includes('--baseline')){console.log(JSON.stringify(initial));assert.deepEqual(errors,[]);}
 else{
  assert.ok(!initial.scripts.some(path=>path.includes('ProductionAcceptanceRollbackConsole')),'Operational console must not load at startup');
  assert.equal(initial.visibleHeadings[0],'今すぐ確認');
  const nav=page.getByRole('navigation',{name:'管理業務'});
  const expected={'概要':'今すぐ確認','案件':'案件一覧','報告書・再提出':'報告書確認・経費入力','スタッフ':'スタッフ一覧','通知・運用':'本番公開承認・全体停止'};
  for(const width of [390,1280]){
   await page.setViewportSize({width,height:900});
   for(const [label,heading] of Object.entries(expected)){
    await nav.getByRole('button',{name:label,exact:true}).click();
    await page.getByRole('heading',{name:heading,exact:true}).waitFor();
    assert.equal(await nav.getByRole('button',{name:label,exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${label} overflows at ${width}px`);
    if(output)await page.screenshot({path:resolve(output,`admin-${label}-${width}.png`)});
   }
  }
  assert.ok([...scripts].some(path=>path.includes('ProductionAcceptanceRollbackConsole')),'Operational console must become available on demand');
  await nav.getByRole('button',{name:'案件',exact:true}).click();
  const search=page.getByPlaceholder('スタッフ名・店舗・メーカー・クライアントを検索');
  await search.fill('船橋');
  await nav.getByRole('button',{name:'スタッフ',exact:true}).click();
  await nav.getByRole('button',{name:'案件',exact:true}).click();
  assert.equal(await search.inputValue(),'船橋');
  const list=page.locator('section.panel').filter({has:page.getByRole('heading',{name:'案件一覧',exact:true})});
  await search.fill('船橋　乳業');
  assert.equal(await list.locator('tbody tr').count(),1);
  await page.getByLabel('案件の絞り込み',{exact:true}).selectOption('precontact');
  assert.equal(await list.locator('tbody tr').count(),0);
  assert.match(await list.getByRole('status').innerText(),/該当する案件はありません/);
  await list.getByRole('button',{name:'条件をクリア',exact:true}).click();
  assert.equal(await list.locator('tbody tr').count(),4);
  await page.getByLabel('案件の絞り込み',{exact:true}).selectOption('precontact');
  assert.equal(await list.locator('tbody tr').count(),2);
  await nav.getByRole('button',{name:'スタッフ',exact:true}).click();
  await nav.getByRole('button',{name:'案件',exact:true}).click();
  assert.equal(await page.getByLabel('案件の絞り込み',{exact:true}).inputValue(),'precontact');
  await list.getByRole('button',{name:'条件をクリア',exact:true}).click();
  await search.fill('ａさん ２０２６-０７');
  assert.equal(await list.locator('tbody tr').count(),2);
  assert.equal(await list.getByRole('button',{name:'次の50件',exact:true}).isDisabled(),true);
  await list.getByRole('button',{name:'条件をクリア',exact:true}).click();
  await search.fill('船橋');
  await page.getByRole('button',{name:'経費',exact:true}).click();
  await page.getByRole('heading',{name:'報告書確認・経費入力',exact:true}).waitFor();
  assert.equal(await nav.getByRole('button',{name:'報告書・再提出',exact:true}).getAttribute('aria-pressed'),'true');
  await nav.getByRole('button',{name:'スタッフ',exact:true}).focus();await page.keyboard.press('Enter');
  assert.equal(await nav.getByRole('button',{name:'スタッフ',exact:true}).getAttribute('aria-pressed'),'true');
  assert.deepEqual(errors,[]);
  console.log(`Admin browser passed: five views at 390/1280px, input persistence, expense navigation, keyboard access; initial DOM ${initial.domNodes}, ${initial.scripts.length} JS requests.`);
 }
}finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}
