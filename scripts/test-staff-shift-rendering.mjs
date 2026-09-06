import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {build,preview} from 'vite';
import {chromium} from '@playwright/test';
const output=resolve(process.env.LKC_VISUAL_EVIDENCE_DIR||'release-evidence/shift-rendering');
const dist=resolve('release-evidence/shift-fixture-build');
const phase=process.argv.includes('--baseline')?'baseline':'current';
const fixturePlugin={name:'local-shift-fixture',enforce:'pre',configResolved(config){assert.ok(!Object.entries(config.env).some(([key,value])=>key.startsWith('VITE_FIREBASE_')&&value),'Fixture requires unconfigured demo');},transform(code,id){
 if(!id.replaceAll('\\','/').endsWith('/apps/staff/src/App.tsx'))return;
 const marker='const demoTasks: StaffTask[] = [';assert.ok(code.includes(marker));
 return code.replace(marker,`const fixtureCount=Number(new URLSearchParams(location.search).get('count')||100);
 if(![100,300,1000].includes(fixtureCount))throw new Error('Invalid fixture count');
 demoJobs.splice(0,demoJobs.length,...Array.from({length:fixtureCount},(_,i)=>({...demoJobs[0],id:'fixture-'+i,storeName:'合成店舗 '+String(i+1).padStart(4,'0'),storeAddress:'検証用住所',storeNearestStation:'検証駅'})));
 ${marker}`);
}};
await build({root:resolve('apps/staff'),configFile:resolve('apps/staff/vite.config.ts'),build:{outDir:dist},plugins:[fixturePlugin],logLevel:'error'});
const server=await preview({root:resolve('apps/staff'),configFile:resolve('apps/staff/vite.config.ts'),build:{outDir:dist},preview:{host:'127.0.0.1',port:0,open:false}});
let browser;
try{
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({serviceWorkers:'block'});
 await page.route('**/*',route=>{const u=new URL(route.request().url());return u.hostname==='127.0.0.1'||u.protocol==='data:'?route.continue():route.abort();});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const results=[];
 for(const width of [390,1280])for(const count of [100,300,1000]){
  await page.setViewportSize({width,height:844});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?count=${count}`);
  await page.getByRole('button',{name:'シフトを開く',exact:true}).waitFor();
  const times=[];let dom=0,cards=0;
  for(let i=0;i<21;i++){
   await page.locator('.bottom-nav').getByRole('button',{name:/ホーム/}).click();
   const duration=await page.locator('.bottom-nav').getByRole('button',{name:/シフト/}).evaluate(button=>new Promise((resolve,reject)=>{
    const start=performance.now();button.click();
    function check(){if(document.querySelector('.shift-list-heading')){requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));return;}if(performance.now()-start>5000){reject(new Error('render timeout'));return;}requestAnimationFrame(check);}check();
   }));
   if(i>0)times.push(duration);
  }
  dom=await page.locator('*').count();cards=await page.locator('.shift-job').count();
  assert.equal(cards,phase==='baseline'?count:50);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(phase!=='baseline'){
   const next=page.getByRole('button',{name:'次の50件',exact:true}).first();
   await next.click();
   assert.match(await page.locator('.shift-job').first().getAttribute('aria-label'),/0051/);
   const card=page.locator('.shift-job').first();await card.focus();await page.keyboard.press('Enter');
   const detail=page.getByRole('region',{name:'選択したシフトの詳細',exact:true});
   await detail.getByRole('heading',{name:'合成店舗 0051',exact:true}).waitFor();
   assert.match(await detail.innerText(),/合成店舗 0051/);
   assert.equal(await detail.evaluate(el=>el===document.activeElement),true);
   if(count===1000){
    await next.click();
    await page.locator('.bottom-nav').getByRole('button',{name:/ホーム/}).click();
    await page.locator('.bottom-nav').getByRole('button',{name:/シフト/}).click();
    assert.match(await page.locator('.shift-job').first().getAttribute('aria-label'),/0101/,'Returning to shifts must preserve the page without selecting a card');
   }
   // 全ページを順に見て、表示の重複・欠落を検出する。
   const prev=page.getByRole('button',{name:'前の50件',exact:true}).first();
   while(await prev.isEnabled())await prev.click();
   const seen=[];
   while(true){
    seen.push(...await page.locator('.shift-job').evaluateAll(cards=>cards.map(card=>card.getAttribute('aria-label'))));
    if(await next.isDisabled())break;
    await next.click();
   }
   assert.equal(seen.length,count);assert.equal(new Set(seen).size,count);
   if(width===390&&count===1000){
    mkdirSync(output,{recursive:true});
    await page.screenshot({path:resolve(output,'staff-paged-shifts.png'),fullPage:true});
   }
  }
  times.sort((a,b)=>a-b);results.push({width,count,dom,cards,medianMs:+((times[9]+times[10])/2).toFixed(1),p95Ms:+times[18].toFixed(1),samplesMs:times.map(n=>+n.toFixed(1))});
 }
 assert.deepEqual(errors,[]);
 mkdirSync(output,{recursive:true});
 const report={phase,browser:browser.version(),cpuThrottle:1,network:'localhost; external blocked',samples:20,fixture:'synthetic loaded upcoming jobs; build-only injection',measurement:'click to target DOM and two animation frames; warmed navigation; not initial load/network',sourceSha256:createHash('sha256').update(readFileSync('apps/staff/src/App.tsx')).digest('hex'),componentSha256:phase==='baseline'?null:createHash('sha256').update(readFileSync('apps/staff/src/ShiftJobCards.tsx')).digest('hex'),results};
 writeFileSync(resolve(output,`shift-rendering-${phase}.json`),JSON.stringify(report,null,2));
 console.log(JSON.stringify({...report,results:results.map(({samplesMs,...r})=>r)}));
}finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}