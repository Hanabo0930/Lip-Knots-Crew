await import('./test-admin-edit-panel.mjs');
import {timelineModule} from './admin-timeline-test-module.mjs';
await import('./test-admin-job-export.mjs');
await import('./test-admin-job-notification.mjs');
await import('./test-admin-notification-target.mjs');
import assert from "node:assert/strict";
import {readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {runInNewContext} from "node:vm";
import ts from "typescript";
const source=readFileSync("apps/admin/src/App.tsx","utf8").replace(/\r\n/g,"\n");
const start=source.indexOf('  // 運用情報は画面を開いたときだけ取得');
const end=source.indexOf('  // 提出履歴は案件・種類・認証ごとに応答を分離する。',start);
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
const {reportCompletionLabel,jobReadinessLabel}=searchScope.exports;
for(const [extra,label]of [[{applicationUnconfirmed:true},'原本の担当確認待ち'],[{sourceMissing:true,applicationUnconfirmed:true},'取込元の案件を確認中'],[{assignmentUnresolved:true},'担当者の照合待ち'],[{cancelled:true,applicationUnconfirmed:true},'キャンセル'],[{preContact:{}},'事前連絡あり'],[{},'事前連絡待ち'],[{status:'open'},'未手配'],[{status:'constructor'},'状態要確認']])assert.equal(jobReadinessLabel({status:'assigned',...extra}),label);
assert.equal(reportCompletionLabel({status:'assigned',submissionStatus:{report:{completed:true,deadlineReviewRequired:true}}}),'完了記録あり・期限要確認');
const statusScope={exports:{}};
runInNewContext(ts.transpileModule(readFileSync("apps/admin/src/submission-status.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,statusScope);
const {submissionStatusLabel}=statusScope.exports;
const reports=buildJobSearchIndex([
 {...synthetic[1],id:'done',submissionStatus:{report:{completed:true,lateFirstSubmission:true}}},
 {...synthetic[1],id:'false',submissionStatus:{report:{completed:false}}},
 {...synthetic[1],id:'missing'},
 {...synthetic[1],id:'late-only',submissionStatus:{report:{lateFirstSubmission:true}}},
 {...synthetic[1],id:'cancelled',cancelled:true,submissionStatus:{report:{completed:true}}},
 {...synthetic[1],id:'unassigned',status:'open',submissionStatus:{report:{completed:true}}},
]);
assert.equal(filterJobSearchIndex(reports,'','report-completed').length,1);
assert.equal(filterJobSearchIndex(reports,'','report-unconfirmed').length,3);
assert.equal(reportCompletionLabel(reports[0].job),'完了記録あり');
assert.equal(reportCompletionLabel(reports[3].job),'完了未確認');
assert.equal(reportCompletionLabel(reports[4].job),'対象外');
for(const [status,label] of Object.entries({completed:'処理完了',uploading:'アップロード中',waiting_upload:'アップロード待ち',processing:'保存処理中',error:'処理失敗',security_error:'安全確認で停止',paused_global:'運用停止中',future:'状態未確認',constructor:'状態未確認',toString:'状態未確認'}))assert.equal(submissionStatusLabel(status),label);
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
const timelineStart=source.indexOf('  async function loadSubmissionTimeline(');
const timelineEnd=source.indexOf('  async function openComparison(',timelineStart);
assert.ok(timelineStart>=0&&timelineEnd>timelineStart);
const timelineCode=ts.transpileModule(source.slice(timelineStart,timelineEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
for(const missing of ['user','selectedAdminJobId','functions']){
 const context={selectedAdminJobId:'job',firebaseConfigured:true,user:{uid:'one'},functions:{},httpsCallable:()=>assert.fail('Unauthenticated or unselected timeline must not call an API')};
 context[missing]=null;runInNewContext(timelineCode,context);await context.loadSubmissionTimeline();
}
for(const scenario of ['success','empty','failure','malformed','context','auth','newer']){
 const gates=[],state={status:'idle',busy:false,files:['old'],selected:'old'};
 const authUser={uid:'one'};
 const scope={require:name=>{assert.equal(name,'./submission-timeline');return timelineModule;},submissionTimeline:[],selectedAdminJobId:'job',resubmitType:'report',firebaseConfigured:true,user:authUser,auth:{currentUser:authUser},functions:{},timelineKey:'first',timelineKeyRef:{current:'first'},timelineVersionRef:{current:0},timelinePendingRef:{current:null},
  setTimelineBusy:v=>state.busy=v,setTimelineStatus:v=>state.status=v,setSubmissionTimeline:v=>state.files=v,setSelectedSourceFile:v=>state.selected=v,setTimelineLoadedKey:v=>state.key=v,
  httpsCallable:()=>()=>{const gate=deferred();gates.push(gate);return gate.promise;}};
 runInNewContext(timelineCode,scope);
 const first=scope.loadSubmissionTimeline();await scope.loadSubmissionTimeline();
 assert.equal(gates.length,1);assert.equal(state.status,'loading');assert.equal(state.files.length,0);assert.equal(state.selected,null);
 if(scenario==='context')scope.timelineKeyRef.current='second';
 if(scenario==='auth')scope.auth.currentUser={uid:'two'};
 let second;
 if(scenario==='newer'){scope.timelineKey=scope.timelineKeyRef.current='second';second=scope.loadSubmissionTimeline();gates[1].resolve({data:{submissions:[{id:'new',files:[]}]}});await second;}
 if(scenario==='failure')gates[0].reject(new Error('offline'));
 else gates[0].resolve({data:scenario==='malformed'?{}:{submissions:scenario==='empty'?[]:[{id:'old',files:[]}]}});
 await first;
 if(['success','empty'].includes(scenario)){assert.equal(state.status,'ready');assert.equal(state.files.length,scenario==='empty'?0:1);assert.equal(state.busy,false);}
 if(['failure','malformed'].includes(scenario)){
  assert.equal(state.status,'error');assert.equal(state.busy,false);
  const retry=scope.loadSubmissionTimeline();gates[1].resolve({data:{submissions:[]}});await retry;
  assert.equal(state.status,'ready');assert.equal(state.files.length,0);
 }
 if(['context','auth'].includes(scenario)){assert.equal(state.status,'loading');assert.equal(state.files.length,0);assert.equal(state.key,undefined);}
 if(scenario==='newer'){assert.equal(state.files[0].id,'new');assert.equal(state.key,'second');assert.equal(state.busy,false);}
}
assert.match(source,/disabled=\{!timelineReady\|\|timelineBusy\|\|resubmissionBusy\|\|resubmissionNeedsReview\|\|mailSubmissionHeld\(jobs\.find\(job=>job\.id===selectedAdminJobId\)\)\}/);
assert.match(source,/if\(!timelineReady\|\|timelinePendingRef.current\)/);
console.log('Admin timeline passed: success/empty/error/malformed separation, retry, synchronous double click, stale job/auth response, and reverse response order.');
await import('./test-admin-review-flow.mjs');
await import('./test-admin-staff-list.mjs');
if(!process.argv.includes('--browser'))process.exit(0);
await import('./check-admin-configured-budget.mjs');
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
 await page.addInitScript(()=>{const original=Element.prototype.scrollIntoView;window.__performanceScrolls=0;Element.prototype.scrollIntoView=function(...args){if(this.id==="staff-performance")window.__performanceScrolls++;return original.apply(this,args);};});
 await page.goto(base);await page.waitForLoadState('networkidle');
 const initial={domNodes:await page.locator('*').count(),scripts:[...scripts],visibleHeadings:await page.locator('h2').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>node.textContent))};
 const output=process.env.LKC_VISUAL_EVIDENCE_DIR;
 if(output){mkdirSync(output,{recursive:true});writeFileSync(resolve(output,process.argv.includes('--baseline')?'admin-baseline.json':'admin-current.json'),JSON.stringify(initial,null,2));await page.screenshot({path:resolve(output,process.argv.includes('--baseline')?'admin-baseline.png':'admin-overview.png')});}
 if(process.argv.includes('--baseline')){console.log(JSON.stringify(initial));assert.deepEqual(errors,[]);}
 else{
  assert.ok(!initial.scripts.some(path=>path.includes('AdminJobNotification')),'Notification panel must not load without a matching URL');
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
  await nav.getByRole('button',{name:'概要',exact:true}).click();
  const analytics=page.locator('.analytics-panel'),month=analytics.getByLabel('集計する年月');
  await analytics.getByText('集計対象：2026-07',{exact:true}).waitFor();
  assert.equal(await analytics.locator('.analytics-counts article').first().locator('strong').textContent(),'4件');
  await month.fill('2026-08');await analytics.getByText('集計対象：2026-08',{exact:true}).waitFor();
  assert.equal(await analytics.locator('.analytics-counts article').first().locator('strong').textContent(),'0件');
  assert.equal(await analytics.locator('.finance-cards article').first().locator('strong').textContent(),'0円');
  await month.fill('2026-07');await analytics.getByText('集計対象：2026-07',{exact:true}).waitFor();
  assert.equal(await analytics.locator('.analytics-counts article').first().locator('strong').textContent(),'4件');
  assert.equal(await analytics.locator('.finance-cards article').first().locator('strong').textContent(),'64,500円');
  await nav.getByRole('button',{name:'通知・運用',exact:true}).click();
  const pushPanel=page.locator('.push-panel').filter({has:page.getByRole('heading',{name:'管理者プッシュ通知',exact:true})});
  await pushPanel.getByRole('button',{name:'通知を有効にする',exact:true}).focus();await page.keyboard.press('Enter');
  await pushPanel.getByText('通知ON',{exact:true}).waitFor();
  await pushPanel.getByRole('button',{name:'通知テスト',exact:true}).click();
  await page.getByText('デモ：管理者通知テストを送信しました。',{exact:true}).waitFor();
  await pushPanel.getByRole('button',{name:'この端末の通知をOFF',exact:true}).click();
  await pushPanel.getByRole('button',{name:'通知を有効にする',exact:true}).waitFor();
  assert.ok([...scripts].some(path=>path.includes('ProductionAcceptanceRollbackConsole')),'Operational console must become available on demand');
  await nav.getByRole('button',{name:'概要',exact:true}).click();
  const issuePanel=page.locator('.issue-panel');
  await issuePanel.getByRole('heading',{name:'シフト表の反映確認',exact:true}).waitFor();
  await issuePanel.getByRole('button',{name:'再読込',exact:true}).click();
  await issuePanel.locator('article').nth(1).waitFor();
  assert.equal(await issuePanel.locator('article').count(),2);
  await issuePanel.getByRole('button',{name:'再試行',exact:true}).click();
  await page.getByText('デモ：再試行を受け付けました。',{exact:true}).waitFor();
  assert.equal(await issuePanel.locator('article').count(),1);
  page.once('dialog',dialog=>dialog.dismiss());
  await issuePanel.getByRole('button',{name:'確認メモを記録',exact:true}).click();
  assert.equal(await issuePanel.locator('article').count(),1);
  page.once('dialog',dialog=>dialog.accept('合成確認'));
  await issuePanel.getByRole('button',{name:'確認メモを記録',exact:true}).click();
  await issuePanel.getByText('確認メモあり・反映未確認',{exact:true}).waitFor();
  assert.equal(await issuePanel.locator('article').count(),1);
  await issuePanel.getByRole('button',{name:'再読込',exact:true}).click();
  await issuePanel.getByRole('button',{name:'メモ記録済み',exact:true}).waitFor();
  assert.equal(await issuePanel.locator('article').count(),1);
  if(output)await issuePanel.screenshot({path:resolve(output,'admin-issue-actions.png')});
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
  await page.getByLabel('案件の絞り込み',{exact:true}).selectOption('report-completed');
  assert.equal(await list.locator('tbody tr').count(),1);
  assert.match(await list.locator('tbody').innerText(),/完了記録あり/);
  await page.getByLabel('案件の絞り込み',{exact:true}).selectOption('report-unconfirmed');
  assert.equal(await list.locator('tbody tr').count(),2);
  assert.match(await list.locator('tbody').innerText(),/完了未確認/);
  await list.getByRole('button',{name:'条件をクリア',exact:true}).click();
  await search.fill('ａさん ２０２６-０７');
  assert.equal(await list.locator('tbody tr').count(),2);
  assert.equal(await list.getByRole('button',{name:'次の50件',exact:true}).isDisabled(),true);
  await list.getByRole('button',{name:'条件をクリア',exact:true}).click();
  await search.fill('船橋');
  if(output)await list.screenshot({path:resolve(output,'admin-job-review-list.png')});
  await list.getByRole('button',{name:'報告書を確認',exact:true}).click();
  assert.equal(await page.getByLabel('資料・再提出の対象案件',{exact:true}).inputValue(),'2');
  assert.equal(await page.locator('[aria-labelledby="submission-materials-heading"]').evaluate(el=>el===document.activeElement),true);
  await nav.getByRole('button',{name:'案件',exact:true}).click();
  await page.getByRole('button',{name:'経費',exact:true}).click();
  await page.getByRole('heading',{name:'報告書確認・経費入力',exact:true}).waitFor();
  assert.equal(await nav.getByRole('button',{name:'報告書・再提出',exact:true}).getAttribute('aria-pressed'),'true');
  const expense=page.locator('.expense-panel');
  assert.equal(await expense.getByRole('button',{name:'一時保存',exact:true}).isEnabled(),true);
  assert.equal(await expense.getByLabel('交通費',{exact:true}).getAttribute('inputmode'),'decimal');
  await expense.getByLabel('交通費',{exact:true}).fill('250.5');
  await expense.locator('textarea').fill('合成の確認メモ');
  const reviewPanel=page.locator('section.panel').filter({has:page.getByRole('heading',{name:'案件の資料・再提出',exact:true})});
  await page.getByLabel('資料・再提出の対象案件',{exact:true}).selectOption('1');
  await reviewPanel.locator('textarea').fill('保持する再提出メモ');
  const reportLink=expense.getByRole('button',{name:'この案件の報告書を確認',exact:true});
  page.once('dialog',dialog=>dialog.dismiss());
  await reportLink.focus();await page.keyboard.press('Enter');
  assert.equal(await page.getByLabel('資料・再提出の対象案件',{exact:true}).inputValue(),'1');
  assert.equal(await reviewPanel.locator('textarea').inputValue(),'保持する再提出メモ');
  page.once('dialog',dialog=>dialog.accept());
  await reportLink.focus();await page.keyboard.press('Enter');
  assert.equal(await page.getByLabel('資料・再提出の対象案件',{exact:true}).inputValue(),'2');
  assert.equal(await reviewPanel.locator('.resubmit-options select').inputValue(),'report');
  assert.equal(await reviewPanel.locator('textarea').inputValue(),'');
  assert.equal(await page.locator('[aria-labelledby="submission-materials-heading"]').evaluate(el=>el===document.activeElement),true);
  assert.equal(await expense.getByLabel('交通費',{exact:true}).inputValue(),'250.5');
  assert.equal(await expense.locator('textarea').inputValue(),'合成の確認メモ');
  const expenseExitDialog=page.waitForEvent('dialog');
  await page.evaluate(()=>{setTimeout(()=>location.reload(),0);});
  const expenseLeaving=await expenseExitDialog;assert.equal(expenseLeaving.type(),'beforeunload');await expenseLeaving.dismiss();
  assert.equal(await expense.getByLabel('交通費',{exact:true}).inputValue(),'250.5');
  assert.equal(await expense.locator('textarea').inputValue(),'合成の確認メモ');
  page.once('dialog',dialog=>dialog.dismiss());
  await expense.getByRole('button',{name:'読込',exact:true}).click();
  assert.equal(await expense.getByLabel('交通費',{exact:true}).inputValue(),'250.5');
  assert.equal(await expense.locator('textarea').inputValue(),'合成の確認メモ');
  await expense.getByRole('button',{name:'一時保存',exact:true}).click();
  assert.equal(await expense.locator('.mini-tag').innerText(),'一時保存');
  page.once('dialog',dialog=>dialog.dismiss());
  await expense.getByRole('button',{name:'確認完了・書込待ちへ',exact:true}).click();
  assert.equal(await expense.locator('.mini-tag').innerText(),'一時保存');
  page.once('dialog',dialog=>dialog.accept());
  await expense.getByRole('button',{name:'確認完了・書込待ちへ',exact:true}).click();
  assert.equal(await expense.locator('.mini-tag').innerText(),'書込待ち');
  assert.equal(await expense.getByLabel('交通費',{exact:true}).inputValue(),'250.5');
  assert.equal(await expense.getByRole('button',{name:'確認完了・書込待ちへ',exact:true}).isDisabled(),true);
  await expense.getByRole('button',{name:'読込',exact:true}).click();
  assert.equal(await expense.getByLabel('交通費',{exact:true}).isEnabled(),true);
  if(output)await expense.screenshot({path:resolve(output,'admin-expense-recovery.png')});
  const materials=page.locator('section.panel').filter({has:page.getByRole('heading',{name:'案件の資料・再提出',exact:true})});
  assert.match(await materials.getByLabel('提出ごとの処理状態').innerText(),/処理完了/);
  await materials.getByRole('button',{name:'再送対象に選ぶ',exact:true}).first().click();
  assert.equal(await materials.locator('.selected-file-note').count(),1);
  await materials.locator('.resubmit-options select').selectOption('sales_floor');
  await materials.getByRole('button',{name:'案件全体へ再提出を依頼する',exact:true}).waitFor();
  assert.equal(await materials.locator('.selected-file-note').count(),0);
  assert.equal(await materials.getByRole('button',{name:'案件全体へ再提出を依頼する',exact:true}).isEnabled(),true);
  await materials.getByRole('button',{name:'再読込',exact:true}).click();
  await materials.locator('.file-card').first().waitFor();
  assert.equal(await materials.locator('.file-card').count(),1);
  await materials.locator('.file-card img').evaluate(image=>image.dispatchEvent(new Event('error')));
  await materials.getByRole('button',{name:'画像を再取得',exact:true}).click();
  await materials.locator('.file-card img').waitFor();
  await materials.locator('textarea').fill('未送信の補足');
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByLabel('資料・再提出の対象案件',{exact:true}).selectOption('1');
  assert.equal(await page.getByLabel('資料・再提出の対象案件',{exact:true}).inputValue(),'2');
  assert.equal(await materials.locator('textarea').inputValue(),'未送信の補足');
  page.once('dialog',dialog=>dialog.accept());
  await page.getByLabel('資料・再提出の対象案件',{exact:true}).selectOption('1');
  assert.equal(await materials.locator('textarea').inputValue(),'');
  if(output)await materials.screenshot({path:resolve(output,'admin-submission-review.png')});
  await nav.getByRole('button',{name:'スタッフ',exact:true}).click();
  await page.getByRole('button',{name:'端末',exact:true}).first().click();
  const devices=page.locator('section.panel').filter({has:page.getByRole('heading',{name:/さんの端末$/})});
  await devices.getByRole('heading').waitFor();assert.equal(await devices.locator('.device-grid article').count(),2);
  await devices.getByRole('button',{name:'再読込',exact:true}).click();
  assert.equal(await devices.locator('.device-grid article').count(),2);
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'全ログアウト',exact:true}).first().click();
  await devices.getByText('ログアウト済み',{exact:true}).first().waitFor();
  assert.equal(await devices.getByText('ログアウト済み',{exact:true}).count(),2);
  if(output)await devices.screenshot({path:resolve(output,'admin-staff-devices.png')});
  await devices.getByRole('button',{name:'閉じる',exact:true}).click();
  await devices.waitFor({state:'detached'});
  await page.getByLabel('実績の開始日',{exact:true}).fill('2027-01-01');
  await page.getByLabel('実績の終了日',{exact:true}).fill('2026-07-31');
  assert.equal(await page.getByRole('button',{name:'実績',exact:true}).first().isDisabled(),true);
  await page.getByLabel('実績の開始日',{exact:true}).fill('2026-07-01');
  await page.route('**/AdminStaffPerformancePanel-*.js',async route=>{await new Promise(resolve=>setTimeout(resolve,200));await route.continue();});
  await page.getByRole('button',{name:'実績',exact:true}).first().click();
  const performance=page.locator('#staff-performance');
  await performance.getByRole('heading',{name:/稼働実績$/}).waitFor();
  assert.equal(await performance.locator('.performance-kpis article').count(),6);
  assert.match(await performance.textContent(),/集計期間：2026-07-01〜2026-07-31/);
  await page.waitForFunction(()=>window.__performanceScrolls===1);
  assert.equal(initial.scripts.some(path=>path.includes('AdminStaffPerformancePanel')),false);
  if(output)await performance.screenshot({path:resolve(output,'admin-staff-performance.png')});
  await performance.getByRole('button',{name:'閉じる',exact:true}).click();
  await performance.waitFor({state:'detached'});
  await nav.getByRole('button',{name:'スタッフ',exact:true}).focus();await page.keyboard.press('Enter');
  assert.equal(await nav.getByRole('button',{name:'スタッフ',exact:true}).getAttribute('aria-pressed'),'true');

  await page.goto(base+'/admin/jobs/2');
  await page.getByRole('heading',{name:'案件の安全編集',exact:true}).waitFor();
  assert.equal(await page.locator('#job-safe-edit').getByLabel('編集対象案件',{exact:true}).inputValue(),'2');
  assert.equal(new URL(page.url()).pathname,'/');
  const jobList=page.locator('section.panel').filter({has:page.getByRole('heading',{name:'案件一覧',exact:true})});
  assert.match(await jobList.locator('tbody tr').first().textContent(),/イオン船橋/);
  const editPanel=page.locator('#job-safe-edit');
  assert.equal(await editPanel.getByRole('button',{name:'変更はありません',exact:true}).isDisabled(),true);
  await editPanel.getByText('表示中の内容に変更はありません。',{exact:true}).waitFor();
  await editPanel.getByLabel('クライアント',{exact:true}).fill('未保存の編集');
  const exitDialog=page.waitForEvent('dialog');
  await page.evaluate(()=>{setTimeout(()=>location.reload(),0);});
  const leaving=await exitDialog;assert.equal(leaving.type(),'beforeunload');await leaving.dismiss();
  assert.equal(await editPanel.getByLabel('クライアント',{exact:true}).inputValue(),'未保存の編集');
  page.once('dialog',dialog=>dialog.dismiss());await editPanel.getByLabel('編集対象案件',{exact:true}).selectOption('1');
  assert.equal(await editPanel.getByLabel('編集対象案件',{exact:true}).inputValue(),'2');assert.equal(await editPanel.getByLabel('クライアント',{exact:true}).inputValue(),'未保存の編集');
  page.once('dialog',dialog=>dialog.accept());await editPanel.getByLabel('編集対象案件',{exact:true}).selectOption('1');
  assert.equal(await editPanel.getByLabel('編集対象案件',{exact:true}).inputValue(),'1');assert.notEqual(await editPanel.getByLabel('クライアント',{exact:true}).inputValue(),'未保存の編集');
  await editPanel.getByLabel('請求 基本単価',{exact:true}).fill('不正な金額');
  await editPanel.getByRole('button',{name:'変更を保存',exact:true}).click();
  await page.getByText('請求 基本単価は-1,000,000～10,000,000の金額で入力してください。',{exact:true}).waitFor();
  assert.equal(await editPanel.getByLabel('請求 基本単価',{exact:true}).inputValue(),'不正な金額');
  await editPanel.getByLabel('請求 基本単価',{exact:true}).fill('￥１２，０００');
  page.once('dialog',dialog=>dialog.accept());await editPanel.getByRole('button',{name:'変更を保存',exact:true}).click();
  await page.getByText('デモ：入力項目を保存しました。',{exact:true}).waitFor();
  assert.equal(await editPanel.getByRole('button',{name:'変更はありません',exact:true}).isDisabled(),true);
  const savedRevision=await editPanel.locator('.section-heading strong').textContent();
  for(const width of [390,1280]) {
    await page.setViewportSize({width,height:900});
    await editPanel.getByLabel('請求 基本単価',{exact:true}).fill(width===390?'12000円':'１２，０００');
    await editPanel.getByRole('button',{name:'変更を保存',exact:true}).focus();
    await page.keyboard.press('Enter');
    await editPanel.getByRole('button',{name:'変更はありません',exact:true}).waitFor();
    assert.equal(await editPanel.getByRole('button',{name:'変更はありません',exact:true}).isDisabled(),true);
    assert.equal(await editPanel.locator('.section-heading strong').textContent(),savedRevision);
    assert.ok(await editPanel.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Edit panel must fit the viewport');
    if(output)await editPanel.screenshot({path:resolve(output,'admin-safe-edit-'+width+'.png')});
  }
  await editPanel.getByLabel('編集対象案件',{exact:true}).selectOption('2');
  await editPanel.getByLabel('編集対象案件',{exact:true}).selectOption('1');
  assert.equal(await editPanel.getByLabel('請求 基本単価',{exact:true}).inputValue(),'12000');
  const exportsPanel=page.locator('section.panel').filter({has:page.getByRole('heading',{name:'メーカー・クライアント別資料',exact:true})});
  await exportsPanel.getByLabel('開始',{exact:true}).fill('2026-01-01');await exportsPanel.getByLabel('終了',{exact:true}).fill('2026-12-31');
  const downloadReady=page.waitForEvent('download');await exportsPanel.getByRole('button',{name:'CSVを出力',exact:true}).click();
  const download=await downloadReady;const content=readFileSync(await download.path());
  assert.equal(content.subarray(0,3).toString('hex'),'efbbbf');assert.ok(content.toString('utf8').includes('\r\n'));assert.ok(content.toString('utf8').includes('"粗利概算"'));assert.match(download.suggestedFilename(),/^デモ_2026-01-01_2026-12-31_/);
  await page.goto(base+'/admin/jobs/missing');await page.getByRole('button',{name:'通知の案件を再読込',exact:true}).waitFor();await page.getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(new URL(page.url()).pathname,'/');
  console.log('Admin job notification browser passed: target at list start and edit selection, unavailable link and close.');
  assert.deepEqual(errors,[]);
  console.log(`Admin browser passed: five views at 390/1280px, input persistence, expense navigation, keyboard access; initial DOM ${initial.domNodes}, ${initial.scripts.length} JS requests.`);
 }
}finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}

if(process.argv.includes("--browser")){const {verifyStaffOfflineNavigation}=await import("./test-staff-offline-navigation.mjs");await verifyStaffOfflineNavigation("admin");}
