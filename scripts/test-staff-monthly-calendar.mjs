import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
import ts from 'typescript';
import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
function moduleFrom(path,dependencies={}){
 const scope={React,exports:{},require:name=>{assert.ok(Object.hasOwn(dependencies,name),'Unexpected dependency '+name);return dependencies[name];}};
 runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,scope);
 return scope.exports;
}
const jobList=moduleFrom('apps/staff/src/job-list.ts');
const model=moduleFrom('apps/staff/src/monthly-shift-calendar.ts',{'./job-list':jobList});
const {monthCalendar,adjacentMonth}=model;
const confirmed={id:'confirmed',dateKey:'2026-11-02',status:'assigned',storeName:'合成店舗',makerName:'合成メーカー',menuName:'合成業務',entryTime:'09:45',workTime:'10:00〜18:00',storeAddress:'合成住所'};
assert.equal(adjacentMonth('2026-12',1),'2027-01');assert.equal(adjacentMonth('2027-01',-1),'2026-12');
assert.equal(adjacentMonth('0001-01',0),'0001-01');
assert.throws(()=>adjacentMonth('0001-01',-1));assert.throws(()=>adjacentMonth('2026-13',0));
assert.equal(monthCalendar([],'2024-02').days.filter(Boolean).length,29);
assert.equal(monthCalendar([],'2026-02').days.filter(Boolean).length,28);
assert.equal(monthCalendar([],'2026-11').days[0],'2026-11-01');
for(const origin of ['application','source-manual']){
 for(const phase of ['waiting_selection','selected','write_started','readback_pending']){
  const result=monthCalendar([{...confirmed,id:origin,applicationUnconfirmed:true,phase}], '2026-11');
  assert.equal(result.jobs.size,0);
 }
 assert.equal(monthCalendar([{...confirmed,id:origin,applicationUnconfirmed:false}],'2026-11').jobs.get('2026-11-02').length,1);
}
for(const changes of [{cancelled:true},{status:'cancelled'},{status:'open'},{dateKey:'2026-11-31'},{dateKey:'2026-12-02'}])assert.equal(monthCalendar([{...confirmed,...changes}],'2026-11').jobs.size,0);
assert.throws(()=>monthCalendar([confirmed,{...confirmed}],'2026-11'),/重複/);
const Calendar=moduleFrom('apps/staff/src/MonthlyShiftCalendar.tsx',{'react':React,'./monthly-shift-calendar':model,'./job-list':jobList,'./monthly-shift-calendar.css':{}}).default;
const html=renderToStaticMarkup(React.createElement(Calendar,{jobs:[confirmed,{...confirmed,id:'pending',dateKey:'2026-11-03',applicationUnconfirmed:true}],today:'2026-11-01',onSelect:()=>{}}));
assert.ok(html.includes('2026-11-02の確定シフト 1件を表示'));
assert.ok(!html.includes('2026-11-03の確定シフト'));
assert.ok(html.includes('scope="col"'));assert.ok(html.includes('読み込んだシフト'));
console.log('Monthly calendar model/render: PASS (month boundaries/leap years, pending phases, cancellation, duplicate stop, loaded-data wording)');
if(process.argv.includes('--browser')){
 const {createServer}=await import('vite');const {chromium}=await import('playwright');
 const fixture=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
 import React from 'react';import{createRoot}from'react-dom/client';import Calendar from '/src/MonthlyShiftCalendar.tsx';import '/src/styles.css';
 function Fixture(){const[jobs,setJobs]=React.useState(${JSON.stringify([{...confirmed,storeName:'合成店舗'.repeat(30)}, {...confirmed,id:'pending',dateKey:'2026-11-03',applicationUnconfirmed:true}])});window.calendarFixture={confirm:()=>setJobs(rows=>rows.map(job=>({...job,applicationUnconfirmed:false}))),cancel:()=>setJobs(rows=>rows.map(job=>({...job,cancelled:true})))};return <main><Calendar jobs={jobs} today="2026-11-01" onSelect={job=>window.selectedCalendarJob=job.id}/></main>;}createRoot(document.getElementById('root')).render(<Fixture/>);
 </script></body></html>`;
 const code=fixture.replace(/(<script type="module">)([\s\S]*?)(<\/script>)/,(_,start,source,end)=>start+ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,module:ts.ModuleKind.ESNext}}).outputText+end);
 const server=await createServer({root:resolve('apps/staff'),configFile:resolve('apps/staff/vite.config.ts'),server:{host:'127.0.0.1',port:0},plugins:[{name:'monthly-calendar-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/__monthly_calendar_test.html')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,code));});}}]});
 let browser;const errors=[],external=[];
 try{
  assert.ok(!Object.entries(server.config.env).some(([key,value])=>key.startsWith('VITE_FIREBASE_')&&value));
  await server.listen();browser=await chromium.launch({headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname==='127.0.0.1'||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.origin);return route.abort();});
  for(const width of [320,390,1280]){
   await page.setViewportSize({width,height:900});await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__monthly_calendar_test.html`);
   const calendar=page.getByRole('region',{name:'確定シフトの月間カレンダー',exact:true});
   await calendar.getByRole('button',{name:'2026-11-02の確定シフト 1件を表示',exact:true}).click();
   const detail=calendar.getByRole('region',{name:'2026-11-02の確定シフト',exact:true});
   for(const text of ['合成メーカー','合成業務','09:45','10:00〜18:00','合成住所'])assert.ok((await detail.innerText()).includes(text));
   await detail.getByRole('button',{name:'このシフトの詳細を確認',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.selectedCalendarJob),'confirmed');
   assert.equal(await calendar.getByRole('button',{name:'2026-11-03の確定シフト 1件を表示',exact:true}).count(),0);
   await page.evaluate(()=>window.calendarFixture.confirm());await calendar.getByRole('button',{name:'2026-11-03の確定シフト 1件を表示',exact:true}).waitFor();
   await calendar.getByRole('button',{name:'次の月を表示',exact:true}).click();await calendar.getByText('2026年12月',{exact:true}).waitFor();
   assert.equal(await calendar.getByRole('region',{name:'2026-11-02の確定シフト',exact:true}).count(),0);
   await calendar.getByRole('button',{name:'前の月を表示',exact:true}).click();await calendar.getByRole('button',{name:'2026-11-02の確定シフト 1件を表示',exact:true}).waitFor();
   await page.evaluate(()=>window.calendarFixture.cancel());await page.waitForFunction(()=>document.querySelectorAll('.calendar-day-shifts').length===0);assert.equal(await calendar.locator('.calendar-day-shifts').count(),0);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Monthly calendar browser: PASS (3 widths, safe details, keyboard, pending-to-confirmed, cancellation, month navigation; no external requests)');
 }finally{await browser?.close();await server.close();}
}
