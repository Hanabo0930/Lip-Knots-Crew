import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {preview} from 'vite';
import {chromium} from '@playwright/test';
const server=await preview({root:resolve('apps/staff'),configFile:resolve('apps/staff/vite.config.ts'),preview:{host:'127.0.0.1',port:0}});
let browser;
try{
 if(Object.entries(server.config.env).some(([key,value])=>key.startsWith('VITE_FIREBASE_')&&value))throw Error('Demo-only verification requires no Firebase configuration.');
 browser=await chromium.launch({headless:true});const page=await browser.newPage({timezoneId:'Asia/Tokyo'});
 await page.clock.install({time:new Date('2026-09-09T12:00:00Z')});
 await page.route('**/*',route=>{const url=new URL(route.request().url());return url.hostname==='127.0.0.1'||['data:','blob:'].includes(url.protocol)?route.continue():route.abort();});
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port);
 await page.locator('.bottom-nav').getByRole('button',{name:/シフト/}).click();
 const upcoming=page.locator('.shift-card-list[aria-label="これからのシフト"] .shift-card-button');
 assert.equal(await upcoming.count(),1);
 await page.getByLabel('体温',{exact:true}).fill('36.7');
 await page.getByLabel('到着予定時刻',{exact:true}).fill('09:45');
 await page.clock.setSystemTime(new Date('2026-09-10T15:01:00Z'));
 await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
 await page.clock.runFor(60001);
 await page.locator('.bottom-nav').getByRole('button',{name:/ホーム/}).click();await page.locator('.bottom-nav').getByRole('button',{name:/シフト/}).click();
 const after=await upcoming.count();const result={businessDate:'2026-09-11',fixtureShiftDate:'2026-09-10',beforeUpcoming:1,afterUpcoming:after,expectedAfterUpcoming:0,bugReproduced:after===1};
 console.log(JSON.stringify(result));
 assert.equal(await page.getByLabel('体温',{exact:true}).inputValue(),'36.7');
 assert.equal(await page.getByLabel('到着予定時刻',{exact:true}).inputValue(),'09:45');
 assert.equal(after,process.argv.includes('--expect-current-bug')?1:0);
 if(!process.argv.includes('--expect-current-bug')){

  assert.equal(await page.locator('.shift-card-list[aria-label="過去のシフト"] .shift-card-button').count(),1);
  await page.getByRole('button',{name:/報告書を提出/}).click();
  await page.locator('input[type="file"][multiple]').setInputFiles({name:'rollover.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 synthetic')});
  await page.getByRole('group',{name:'1件目: rollover.pdf',exact:true}).waitFor();
  const target=await page.locator('.submission-target-summary').textContent();
  await page.clock.setSystemTime(new Date('2026-09-11T15:01:00Z'));
  await page.clock.runFor(60001);
  assert.equal(await page.locator('.submission-target-summary').textContent(),target);
  assert.equal(await page.getByRole('group',{name:'1件目: rollover.pdf',exact:true}).count(),1);
  console.log('Day rollover preserves precontact inputs, selected submission and files; expired shift remains accessible in history.');
 }
 for(const width of [320,390,1280])for(const preserveFocus of [false,true]){
  const jobsPage=await browser.newPage({timezoneId:'Asia/Tokyo',viewport:{width,height:900}});
  try{
   await jobsPage.clock.install({time:new Date('2026-09-09T12:00:00Z')});
   await jobsPage.route('**/*',route=>{const url=new URL(route.request().url());return url.hostname==='127.0.0.1'||['data:','blob:'].includes(url.protocol)?route.continue():route.abort();});
   await jobsPage.goto('http://127.0.0.1:'+server.httpServer.address().port);
   await jobsPage.locator('.bottom-nav').getByRole('button',{name:/案件/}).click();
   const card=jobsPage.locator('.open-job');assert.equal(await card.count(),1);
   const focusTarget=preserveFocus?jobsPage.getByRole('button',{name:'募集案件を更新',exact:true}):card.getByRole('button',{name:'詳細を見る',exact:true});
   await focusTarget.focus();assert.equal(await focusTarget.evaluate(el=>document.activeElement===el),true);
   await jobsPage.clock.setSystemTime(new Date('2026-09-10T15:01:00Z'));
   await jobsPage.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
   await jobsPage.clock.runFor(60001);
   assert.equal(await card.count(),0);assert.equal(await jobsPage.getByText('現在募集中の案件はありません',{exact:true}).count(),1);
   const expected=preserveFocus?jobsPage.getByRole('button',{name:'募集案件を更新',exact:true}):jobsPage.getByRole('heading',{name:'募集中の案件',exact:true});
   assert.equal(await expected.evaluate(el=>document.activeElement===el),true,'Focus after rollover at width '+width+' preserve='+preserveFocus);
  }finally{await jobsPage.close();}
 }
 console.log('Open-job rollover browser passed: expired cards disappear at 320/390/1280px, lost detail-button focus returns to heading and existing refresh-button focus stays put.');
}finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}
