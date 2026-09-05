import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {preview} from 'vite';
import {chromium} from '@playwright/test';
// 通常のデモビルドを配信し、読込済み画面の操作から描画機会までを計測する。
const server=await preview({root:resolve('apps/staff'),configFile:resolve('apps/staff/vite.config.ts'),preview:{host:'127.0.0.1',port:0,open:false}});
let browser;
try{
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({serviceWorkers:'block'});
 const port=server.httpServer.address().port;
 await page.route('**/*',route=>{const url=new URL(route.request().url());return url.hostname==='127.0.0.1'||url.protocol==='data:'?route.continue():route.abort();});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const assets=resolve('apps/staff/dist/assets');
 const buildAssetsSha256=Object.fromEntries(readdirSync(assets).filter(name=>name.endsWith('.js')).map(name=>[name,createHash('sha256').update(readFileSync(resolve(assets,name))).digest('hex')]));
 const result={sourceSha256:createHash('sha256').update(readFileSync('apps/staff/src/App.tsx')).digest('hex'),buildAssetsSha256,browser:browser.version(),fixture:'built-in demo',build:'apps/staff/dist',cpuThrottle:1,network:'localhost; external requests blocked',measurement:'DOM click to target visible plus two requestAnimationFrame callbacks; warmed navigation, not initial load or real network',samples:20,results:[]};
 for(const width of [390,1280]){
  await page.setViewportSize({width,height:844});
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByRole('button',{name:'シフトを開く',exact:true}).waitFor();
  for(const target of ['シフト','ホーム']){
   const times=[];
   for(let i=0;i<21;i++){
    const other=target==='シフト'?'ホーム':'シフト';
    await page.locator('.bottom-nav').getByRole('button',{name:new RegExp(other)}).click();
    const duration=await page.locator('.bottom-nav').getByRole('button',{name:new RegExp(target)}).evaluate((button,target)=>new Promise((resolve,reject)=>{
     const start=performance.now();button.click();
     function check(){
      const ready=target==='シフト'?!!document.querySelector('.shift-list-heading'):Array.from(document.querySelectorAll('h2')).some(h=>h.textContent==='今日やること');
      if(ready){requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));return;}
      if(performance.now()-start>5000){reject(new Error('Navigation did not render'));return;}
      requestAnimationFrame(check);
     }check();
    }),target);
    if(i>0)times.push(duration);
   }
   times.sort((a,b)=>a-b);
   result.results.push({width,target,medianMs:Number(((times[9]+times[10])/2).toFixed(1)),p95Ms:Number(times[18].toFixed(1)),samplesMs:times.map(value=>Number(value.toFixed(1)))});
  }
 }
 assert.deepEqual(errors,[]);
 const output=resolve(process.env.LKC_VISUAL_EVIDENCE_DIR||'release-evidence/navigation-performance');mkdirSync(output,{recursive:true});
 writeFileSync(resolve(output,'staff-navigation-performance.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({...result,buildAssetsSha256:undefined,results:result.results.map(({samplesMs,...summary})=>summary)}));
}finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}