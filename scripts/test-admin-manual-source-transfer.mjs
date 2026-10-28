import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRequire} from 'node:module';
const dependency=createRequire(import.meta.url),ts=dependency('typescript');
const compile=(path,require=dependency)=>{const scope={exports:{},require};runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,scope);return scope.exports;};
const helpers=compile('apps/admin/src/manual-source-transfer.ts');
const issue={id:'manual-case',jobId:'manual-case',operation:'case_list.manual',status:'blocked',manualSourcePending:true,manualTransferPending:true,canSelectMonthlyTransfer:true,manualObservationHash:'a'.repeat(64),manualExpectedJobRevision:2,manualExpectedSourceRevision:'b'.repeat(64),canRetry:true,attempts:0,errorType:'owner_transfer_required',errorMessage:'手入力確認待ち',beforeValues:{},desiredUpdates:{},job:{workDate:'2026/11/10',storeName:'合成店舗',assignedStaffName:'合成担当',clientName:'合成クライアント',makerName:'合成メーカー',menuName:'合成業務',entryTime:'09:45',workTime:'10:00〜18:00'}};
const confirmation={confirmedFields:{arrival:true,execution:true,headcount:true,dateMode:true,payOffer:true},payOffer:{dailyWageJPY:12000,travelExpenses:'全額支給',communicationExpenses:'全額支給'}};
assert.equal(helpers.readyManualSourceTransferIssue(issue),true);assert.equal(helpers.validManualSourceTransferConfirmation(confirmation),true);
const source=fs.readFileSync('apps/admin/src/App.tsx','utf8');
const from=source.indexOf('  async function selectMonthlyTransfer('),through=source.indexOf('  async function confirmJobApplication(',from);assert.ok(from>0&&through>from);
function handler(accept=true){const calls=[],dialogs=[],messages=[];const scope={...helpers,window:{confirm:text=>{dialogs.push(text);return accept;}},setMessage:message=>messages.push(message),runAdminOperation:async(...args)=>calls.push(args)};runInNewContext(ts.transpileModule(source.slice(from,through),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);return {...scope,calls,dialogs,messages};}
let h=handler();await h.selectMonthlyTransfer(issue,confirmation);assert.equal(h.calls.length,1);assert.ok(h.dialogs[0].includes('合成店舗'));assert.ok(h.dialogs[0].includes('合成担当'));assert.ok(h.dialogs[0].includes('ネームアップは済みましたか'));assert.ok(h.dialogs[0].includes('12000円'));
const payload=h.calls[0][2];assert.deepEqual(JSON.parse(JSON.stringify(payload)),{action:'select-case-list-manual-monthly',jobId:issue.jobId,observationHash:issue.manualObservationHash,expectedJobRevision:2,expectedSourceRevision:issue.manualExpectedSourceRevision,clientNameUpConfirmed:true,manualConfirmation:confirmation});assert.ok(!('queueId'in payload));assert.ok(!('vacancy'in payload.manualConfirmation.confirmedFields));
h=handler(false);await h.selectMonthlyTransfer(issue,confirmation);assert.equal(h.calls.length,0);
for(const patch of [{canSelectMonthlyTransfer:false},{manualSourcePending:false},{manualTransferPending:false},{manualObservationHash:'bad'},{manualExpectedJobRevision:-1},{manualExpectedSourceRevision:'bad'},{job:null}]){h=handler();await h.selectMonthlyTransfer({...issue,...patch},confirmation);assert.equal(h.calls.length,0);assert.equal(h.dialogs.length,0);}
const invalid=[undefined,{...confirmation,confirmedFields:{...confirmation.confirmedFields,vacancy:true}},...Object.keys(confirmation.confirmedFields).map(key=>({...confirmation,confirmedFields:{...confirmation.confirmedFields,[key]:false}})),...['',0,-1,1.5,1000001,'12000',null].map(dailyWageJPY=>({...confirmation,payOffer:{...confirmation.payOffer,dailyWageJPY}})),{...confirmation,payOffer:{...confirmation.payOffer,travelExpenses:'実費'}},{...confirmation,payOffer:{...confirmation.payOffer,communicationExpenses:'なし'}}];
for(const value of invalid){h=handler();await h.selectMonthlyTransfer(issue,value);assert.equal(h.calls.length,0);assert.equal(h.dialogs.length,0);}
const crew={...issue,operation:'case_list.assign',manualTransferReviewKey:'c'.repeat(64)};h=handler();await h.selectMonthlyTransfer(crew);assert.equal(h.calls[0][2].action,'select-case-list-monthly');assert.equal(h.calls[0][2].queueId,crew.id);
let Review;const reviewRequire=name=>name.endsWith('.css')?{}:name==='./manual-source-transfer'?helpers:dependency(name);Review=compile('apps/admin/src/ManualSourceTransferReview.tsx',reviewRequire).default;
const html=renderToStaticMarkup(React.createElement(Review,{issue,busy:false,onSelect:()=>assert.fail('render must never select')}));assert.ok(html.includes('スタッフへ提示する日給'));assert.equal((html.match(/type="checkbox"/g)||[]).length,5);assert.ok(html.includes('取消チェックは移行選択に使いません'));assert.ok(html.includes('disabled=""'));
const heldHtml=renderToStaticMarkup(React.createElement(Review,{issue:{...issue,canSelectMonthlyTransfer:false},busy:false,onSelect:()=>{}}));assert.ok(heldHtml.includes('照合が終わるまで保留'));
function runReview(wage,fields,busy=false){let hook=0;const calls=[];const fakeReact={...React,useState:()=>[hook++===0?wage:fields,()=>{}]};const Component=compile('apps/admin/src/ManualSourceTransferReview.tsx',name=>name==='react'?fakeReact:reviewRequire(name)).default;const form=Component({issue,busy,onSelect:input=>calls.push(input)});form.props.onSubmit({preventDefault:()=>{}});return calls;}
assert.equal(runReview('12000',confirmation.confirmedFields).length,1);assert.equal(runReview('',confirmation.confirmedFields).length,0);assert.equal(runReview('12000',{}).length,0);assert.equal(runReview('12000',confirmation.confirmedFields,true).length,0);
console.log(`Manual Source transfer UI: PASS (exact request/name-up dialog, ${invalid.length+7} held mutations, Crew path, five explicit checks, wage/busy/held form boundaries).`);
const Panel=compile('apps/admin/src/AdminSheetIssuePanel.tsx',name=>name==='./ManualSourceTransferReview'?{__esModule:true,default:Review}:name==='./SheetWriteReviewEntry'?{__esModule:true,default:()=>null}:dependency(name)).default;
const panelProps={sheetIssues:[issue],issuesBusy:false,operationKeys:[],loadSheetIssues:async()=>{},loadMoreManualIssues:async()=>{},manualNextCursor:'manual-next',retrySheetIssue:async()=>assert.fail('render retry'),acknowledgeSheetIssue:async()=>assert.fail('render memo'),selectMonthlyTransfer:async()=>assert.fail('render select')};
const manualPanel=renderToStaticMarkup(React.createElement(Panel,panelProps));
for(const text of ['>再試行</button>','>確認メモを記録</button>','>保存結果を再照合</button>'])assert.ok(!manualPanel.includes(text));
assert.ok(manualPanel.includes('シート手入力の確認対象を続きを読み込む'));
assert.ok(manualPanel.includes('シート手入力案件の移行確認'));
const crewPanel=renderToStaticMarkup(React.createElement(Panel,{...panelProps,sheetIssues:[crew]}));assert.ok(crewPanel.includes('この案件を選択してシフト表へ移行'));assert.ok(!crewPanel.includes('シート手入力案件の移行確認'));
const genericPanel=renderToStaticMarkup(React.createElement(Panel,{...panelProps,sheetIssues:[{...issue,operation:'expense.review',manualSourcePending:false,manualTransferPending:false,canRetry:true}]}));assert.ok(genericPanel.includes('>再試行</button>'));assert.ok(genericPanel.includes('>確認メモを記録</button>'));
const guardStart=source.indexOf('  async function retrySheetIssue('),guardEnd=source.indexOf('  async function runSheetIssueAction(',guardStart);assert.ok(guardStart>0&&guardEnd>guardStart);
const forbidden=[];const guardScope={setMessage:()=>{},runAdminOperation:async()=>forbidden.push('operation'),runSheetIssueAction:async()=>forbidden.push('generic'),window:{prompt:()=>{forbidden.push('prompt');return '';}}};runInNewContext(ts.transpileModule(source.slice(guardStart,guardEnd),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,guardScope);
await guardScope.retrySheetIssue(issue);await guardScope.acknowledgeSheetIssue(issue);assert.deepEqual(forbidden,[],'manual candidates cannot be retried or memo-acknowledged through direct client handlers');
console.log('Manual issue panel: PASS (manual-only review, Crew/generic controls retained, direct retry/memo blocked, continuation available).');
if(process.argv.includes('--browser')){
 const {resolve}=await import('node:path');const {createServer}=await import('vite');const {chromium}=await import('@playwright/test');
 const fixtureCode=`import React from 'react';import {createRoot}from'react-dom/client';import Review from '/src/ManualSourceTransferReview.tsx';import {readyManualSourceTransferIssue,validManualSourceTransferConfirmation}from'/src/manual-source-transfer.ts';import '/src/styles.css';
 function Fixture(){const[selected,setSelected]=React.useState([]),[message,setMessage]=React.useState('');window.manualTransferPackets=window.manualTransferPackets||[];const runAdminOperation=async(key,action,payload,success)=>{window.manualTransferPackets.push({key,action,payload});setSelected(rows=>[...rows,payload.jobId]);setMessage(success);};
 ${source.slice(from,through)}
 const rows=[${JSON.stringify(issue)},{...${JSON.stringify(issue)},id:'manual-other',jobId:'manual-other',job:{...${JSON.stringify(issue.job)},storeName:'未選択の合成店舗'}},{...${JSON.stringify(issue)},id:'manual-held',jobId:'manual-held',canSelectMonthlyTransfer:false,job:{...${JSON.stringify(issue.job)},storeName:'照合保留の合成店舗'}}];
 return <main><p role="status">{message}</p>{rows.map(issue=><article className="panel" key={issue.id} aria-label={issue.job.storeName}><h2>{issue.job.storeName} / {issue.job.assignedStaffName}</h2>{selected.includes(issue.jobId)?<p role="status">確認待ち（転記・照合待ち）</p>:<Review issue={issue} busy={false} onSelect={confirmation=>selectMonthlyTransfer(issue,confirmation)}/>}</article>)}</main>;}
 createRoot(document.getElementById('root')).render(<Fixture/>);`;
 const html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">'+ts.transpileModule(fixtureCode,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,module:ts.ModuleKind.ESNext}}).outputText+'</script></body></html>';
 const server=await createServer({root:resolve('apps/admin'),configFile:resolve('apps/admin/vite.config.ts'),server:{host:'127.0.0.1',port:0},plugins:[{name:'manual-source-transfer-isolated-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/__manual_source_transfer.html')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,html));});}}]});
 let browser;const errors=[],external=[];
 try{
  assert.ok(!Object.entries(server.config.env).some(([key,value])=>key.startsWith('VITE_FIREBASE_')&&value));
  await server.listen();browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname==='127.0.0.1'||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.origin);return route.abort();});
  for(const width of [390,1280]){
   await page.setViewportSize({width,height:900});await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__manual_source_transfer.html`);
   const card=page.getByRole('article',{name:'合成店舗',exact:true}),other=page.getByRole('article',{name:'未選択の合成店舗',exact:true}),held=page.getByRole('article',{name:'照合保留の合成店舗',exact:true});
   const select=card.getByRole('button',{name:'この案件を選択してシフト表へ移行',exact:true});await select.waitFor();assert.equal(await select.isDisabled(),true);
   await card.getByLabel('スタッフへ提示する日給（円）',{exact:true}).fill('12000');assert.equal(await select.isDisabled(),true);
   const boxes=card.getByRole('checkbox');assert.equal(await boxes.count(),5);for(let i=0;i<4;i++)await boxes.nth(i).check();assert.equal(await select.isDisabled(),true);await boxes.nth(4).check();assert.equal(await select.isEnabled(),true);
   assert.equal(await held.getByRole('button',{name:'この案件を選択してシフト表へ移行',exact:true}).isDisabled(),true);assert.equal(await held.getByRole('checkbox').first().isDisabled(),true);
   page.once('dialog',async dialog=>{assert.ok(dialog.message().includes('ネームアップは済みましたか'));assert.ok(dialog.message().includes('合成担当'));await dialog.dismiss();});await select.click();assert.equal(await card.getByRole('form',{name:'シート手入力案件の移行確認',exact:true}).count(),1);assert.equal(await page.evaluate(()=>window.manualTransferPackets.length),0);
   page.once('dialog',async dialog=>{assert.ok(dialog.message().includes('12000円'));await dialog.accept();});await select.click();await card.getByText('確認待ち（転記・照合待ち）',{exact:true}).waitFor();
   const packets=await page.evaluate(()=>window.manualTransferPackets);assert.equal(packets.length,1);assert.deepEqual(packets[0].payload,{action:'select-case-list-manual-monthly',jobId:issue.jobId,observationHash:issue.manualObservationHash,expectedJobRevision:2,expectedSourceRevision:issue.manualExpectedSourceRevision,clientNameUpConfirmed:true,manualConfirmation:confirmation});
   assert.equal(await other.getByRole('form',{name:'シート手入力案件の移行確認',exact:true}).count(),1);assert.equal(await other.getByRole('button',{name:'この案件を選択してシフト表へ移行',exact:true}).isDisabled(),true);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('Manual Source transfer browser: PASS (390/1280, five checks and wage gate, name-up cancellation, one exact selected request, other/held cases untouched, no external requests).');
 }finally{await browser?.close();await server.close();}
}
