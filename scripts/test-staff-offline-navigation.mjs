import assert from 'node:assert/strict';import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {preview} from 'vite';import {chromium} from '@playwright/test';
export async function verifyStaffOfflineNavigation(app="staff"){
 const server=await preview({root:resolve('apps/'+app),configFile:resolve('apps/'+app+'/vite.config.ts'),preview:{host:'127.0.0.1',port:0}});let browser,htmlRequests=0;server.httpServer.prependListener("request",req=>{if(req.url==="/")htmlRequests++;});
 try{assert.ok(!Object.entries(server.config.env).some(([k,v])=>k.startsWith('VITE_FIREBASE_')&&v),'Offline test is synthetic only');browser=await chromium.launch({headless:true});const context=await browser.newContext(),page=await context.newPage(),base='http://127.0.0.1:'+server.httpServer.address().port,errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base);await page.evaluate(async()=>{await navigator.serviceWorker.ready;});await page.reload();await (app==='staff'?page.getByRole('button',{name:'シフトを開く',exact:true}):page.getByRole('heading',{name:'今すぐ確認',exact:true})).waitFor();assert.equal(await page.evaluate(()=>!!navigator.serviceWorker.controller),true);
 const beforeReload=htmlRequests;await page.reload();await page.waitForLoadState("load");assert.ok(htmlRequests>beforeReload,"Online HTML must still reach network");
 await context.setOffline(true);
 if(app==="admin"){await page.goto(base+"/admin/jobs/synthetic",{timeout:15000});await page.getByRole("heading",{name:"今すぐ確認",exact:true}).waitFor();await page.reload();await page.getByRole("heading",{name:"今すぐ確認",exact:true}).waitFor();assert.deepEqual(errors,[]);console.log("Admin offline navigation passed: online HTML revalidated, uncached path and reload open installed shell without network.");return;}
 await page.goto(base+'/shifts/demo_job_1/netprint',{timeout:15000});await page.getByRole('region',{name:'選択したシフトの詳細'}).waitFor();assert.equal(new URL(page.url()).pathname,'/');
 await page.goto(base+'/resubmissions/demo_request',{timeout:15000});await page.getByRole('button',{name:'提出情報を再読み込み',exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,'/');
 await page.reload();await page.getByRole('button',{name:'シフトを開く',exact:true}).waitFor();assert.deepEqual(errors,[]);console.log('Staff offline navigation passed: online HTML revalidated, installed worker, uncached shift/request links and root reload without network; synthetic demo only.');
 }finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await verifyStaffOfflineNavigation(process.argv.includes("--admin")?"admin":"staff");
