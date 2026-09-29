import assert from "node:assert/strict";
import fs from "node:fs";
import {resolve} from "node:path";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
import ts from "typescript";
const require=createRequire(import.meta.url);
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const core={exports:{},Buffer};runInNewContext(compile(fs.readFileSync("functions/src/shift-preview-core.ts","utf8")),core);
const {createShiftPreviewRows,PREVIEW_ROW_LIMIT,PREVIEW_BYTE_LIMIT}=core.exports;
const makeJob=i=>({caseId:`fixture-${i}`,sheetRef:{sheetName:"2099.10",currentRow:i+2},workDate:`2099-10-${String(i%31+1).padStart(2,"0")}`,storeName:`合成店舗${String(i).padStart(3,"0")}`,assignedStaffName:i%3?"合成担当":"",status:i%3?"assigned":"open",privateMemo:"must-not-return",financials:{privateValue:123}});
for(const size of [0,1,20,21,169,5000,5001]){
 const jobs=Array.from({length:size},(_,i)=>makeJob(i)),result=createShiftPreviewRows(jobs);
 assert.equal(result.rows.length,Math.min(size,PREVIEW_ROW_LIMIT));assert.equal(result.complete,size<=PREVIEW_ROW_LIMIT);
 assert.equal(new Set(result.rows.map(row=>row.row)).size,result.rows.length);
 assert.ok(!JSON.stringify(result).includes("must-not-return"));assert.ok(!JSON.stringify(result).includes("privateValue"));
 if(result.rows.length)assert.equal(result.rows.at(-1).caseId,`fixture-${result.rows.length-1}`);
}
const huge=createShiftPreviewRows(Array.from({length:100},(_,i)=>({...makeJob(i),storeName:"あ".repeat(30000)})));
assert.equal(huge.complete,false);assert.ok(huge.rows.length>0);assert.ok(Buffer.byteLength(JSON.stringify(huge.rows),"utf8")<=PREVIEW_BYTE_LIMIT);
assert.equal(createShiftPreviewRows([{...makeJob(0),storeName:"あ".repeat(PREVIEW_BYTE_LIMIT)}]).rows.length,0);
const source=fs.readFileSync("functions/src/shift-import.ts","utf8");
const schema=source.slice(source.indexOf("const ImportRequestSchema"),source.indexOf("const ColumnSchema"));
const handler=source.slice(source.indexOf("export const previewShiftImport"),source.indexOf("export const syncShiftSheetsReadOnly"));
const calls=[];const entry={exports:{},z:require("zod").z,onCall:(_options,fn)=>fn,requireAdmin:request=>{if(!request.auth)throw Error("unauthenticated");return {token:{company:"fixture-company"}};},companyFromClaims:token=>token.company,executeShiftImport:(...args)=>{calls.push(args);return {previewRows:{rows:[{caseId:"fixture"}],complete:true}};}};
runInNewContext(compile(schema+handler),entry);
await assert.rejects(entry.exports.previewShiftImport({data:{includePreviewRows:true}}));assert.equal(calls.length,0);
const detailed=await entry.exports.previewShiftImport({auth:true,data:{sheetNames:["2099.10"],includePreviewRows:true}});assert.equal(detailed.previewRows.rows.length,1);assert.equal(JSON.stringify(calls.pop()),JSON.stringify(["fixture-company","preview",["2099.10"]]));
const legacy=await entry.exports.previewShiftImport({auth:true,data:{}});assert.equal(Object.hasOwn(legacy,"previewRows"),false);assert.equal(calls.pop().length,3);
await assert.rejects(entry.exports.previewShiftImport({auth:true,data:{includePreviewRows:"true"}}));assert.equal(calls.length,0);
const a=source.indexOf("async function executeShiftImport("),b=source.indexOf("async function loadConfig(",a);assert.ok(a>=0&&b>a);
const jobs=Array.from({length:169},(_,i)=>makeJob(i));
{
 let reads=0;const deny=()=>{throw Error("Unexpected write or commit dependency");};
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 const context={exports:{},HttpsError,Date,createShiftPreviewRows,loadConfig:async()=>({enabled:false,spreadsheetId:"fixture-sheet",columns:{caseId:"BC"},readRangeEndColumn:"BC",maxRowsPerSheet:10000}),assertProductionOperational:deny,db:{collection:deny},acquireSyncLock:deny,releaseSyncLock:deny,writeJobsAndLocks:deny,buildStaffNameIndex:deny,createReadOnlySheetsClient:async()=>({}),listSpreadsheetSheets:async()=>[{title:"2099.10",sheetId:1}],selectImportSheets:rows=>rows,resolveSheetCaseIdColumn:()=>"BC",readShiftSheet:async()=>{reads++;return[];},parseShiftSheet:()=>({jobs:structuredClone(jobs),summary:{warnings:[]}}),captureEditSource:()=>({}),summarize:()=>({jobs:169,sheets:1,unresolvedStaff:0,writes:0})};
 runInNewContext(compile(source.slice(a,b)+"\nexports.executeShiftImport=executeShiftImport;"),context);
 const result=await context.exports.executeShiftImport("fixture-company","preview",["2099.10"]);
 assert.equal(reads,1);assert.equal(result.samples.length,20);assert.equal(result.previewRows?.rows.length,169);assert.equal(result.runId,null);assert.equal(result.totals.writes,0);
 await assert.rejects(context.exports.executeShiftImport("fixture-company","commit",["2099.10"]),/Unexpected write or commit dependency/);
}
const parser={exports:{}};runInNewContext(compile(fs.readFileSync("apps/admin/src/shift-import-preview.ts","utf8")),parser);
const full={spreadsheetId:"synthetic-spreadsheet",totals:{sheets:1,jobs:169,unresolvedStaff:0},warnings:[],samples:createShiftPreviewRows(jobs.slice(0,20)).rows,previewRows:createShiftPreviewRows(jobs)};
assert.equal(parser.exports.parseShiftImportPreview(full).rows.length,169);
for(const previewRows of [{rows:[],complete:true},{rows:full.previewRows.rows,complete:false},{rows:[full.previewRows.rows[0],full.previewRows.rows[0]],complete:false},{rows:Array(5001).fill(full.previewRows.rows[0]),complete:false},{rows:[{...full.previewRows.rows[0],row:0}],complete:false},{rows:[],complete:"true"}])assert.throws(()=>parser.exports.parseShiftImportPreview({...full,previewRows}));
console.log("Full preview contract passed: 0/1/20/21/169/5000/5001 rows, UTF-8 byte cap, no private fields, admin scope, legacy opt-in, single read and no writes, malformed/duplicate rejection.");
if(process.argv.includes("--browser")){
 const {createServer}=await import("vite"),{chromium}=await import("@playwright/test");
 const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">'+
 `import React from 'react';import {createRoot} from 'react-dom/client';import Panel from '/src/AdminShiftImportPreview.tsx';import {parseShiftImportPreview} from '/src/shift-import-preview.ts';import '/src/styles.css';const full=${JSON.stringify(full)};function Fixture(){const [payload,setPayload]=React.useState(full);window.replacePreview=value=>setPayload(value);return React.createElement('main',{className:'shell admin-shell'},React.createElement('div',{className:'workspace-content',style:{gridColumn:'1 / -1'}},React.createElement('div',{className:'workspace-panel'},React.createElement('div',{className:'panel'},React.createElement(Panel,{preview:React.useMemo(()=>parseShiftImportPreview(payload),[payload]),demo:true})))));}createRoot(document.getElementById('root')).render(React.createElement(Fixture));`+'</script>';
 const server=await createServer({root:resolve("apps/admin"),configFile:resolve("apps/admin/vite.config.ts"),server:{host:"127.0.0.1",port:0},plugins:[{name:"preview-pages-fixture",configureServer(dev){dev.middlewares.use(async(req,res,next)=>{if(req.url!=="/__preview_pages")return next();res.setHeader("Content-Type","text/html");res.end(await dev.transformIndexHtml(req.url,html));});}}]});
 await server.listen();const base=`http://127.0.0.1:${server.httpServer.address().port}`;const browser=await chromium.launch({headless:true});
 try{for(const width of [390,1280]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on("pageerror",e=>errors.push(e.message));let external=0,requests=0;
  await page.route("**/*",route=>{if(new URL(route.request().url()).origin!==base){external++;return route.abort();}requests++;return route.continue();});
  await page.goto(base+"/__preview_pages");await page.getByRole("region",{name:"シフト表の読取結果"}).waitFor();await page.waitForLoadState("networkidle");const initialRequests=requests;
  const table=page.getByRole("table"),pager=page.getByRole("navigation",{name:"読取結果のページ切替"});const collected=[];
  for(let index=0;index<9;index++){
   const rows=table.locator("tbody tr");assert.equal(await rows.count(),index===8?9:20);
   collected.push(...await rows.locator("td:nth-child(5)").allTextContents());
   if(index<8){await page.getByLabel("読取案件一覧",{exact:true}).evaluate(node=>{node.scrollTop=200;});await pager.getByRole("button",{name:"次へ",exact:true}).click();assert.equal(await page.getByLabel("読取案件一覧",{exact:true}).evaluate(node=>node.scrollTop),0,"New page must start at its first row");}
  }
  assert.equal(collected.length,169);assert.equal(new Set(collected).size,169);assert.equal(await pager.getByRole("button",{name:"次へ",exact:true}).isDisabled(),true);
  await pager.getByRole("button",{name:"先頭",exact:true}).click();await pager.getByRole("button",{name:"最後",exact:true}).click();assert.ok((await table.innerText()).includes("合成店舗168"));
  const search=page.getByRole("searchbox",{name:"読取案件を検索"});await search.fill("合成店舗１６８");assert.equal(await table.locator("tbody tr").count(),1);assert.ok((await table.innerText()).includes("合成店舗168"));
  await search.fill("10/11");assert.equal(await table.locator("tbody tr").count(),6);assert.ok((await table.locator("tbody td:first-child").allTextContents()).every(v=>v==="2099-10-11"));
  await search.fill("");await page.getByLabel("読取案件の状態").selectOption("open");assert.ok((await table.locator("tbody td:nth-child(4)").allTextContents()).every(v=>v==="未手配"));
  await search.fill("存在しない店舗");await page.getByText("条件に合う案件がありません。",{exact:false}).waitFor();assert.equal(await table.count(),0);
  await page.evaluate(value=>window.replacePreview(value),{...full,totals:{...full.totals,jobs:1},samples:full.samples.slice(0,1),previewRows:{rows:full.samples.slice(0,1),complete:true}});
  await table.waitFor();assert.equal(await search.inputValue(),"");assert.equal(await page.getByLabel("読取案件の状態").inputValue(),"");assert.equal(await table.locator("tbody tr").count(),1);assert.equal(await pager.count(),0);
  assert.equal(requests,initialRequests,"Filtering and paging must not re-read the original");assert.equal(external,0);assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.evaluate(value=>window.replacePreview(value),full);
  if(process.env.LKC_VISUAL_EVIDENCE_DIR){fs.mkdirSync(process.env.LKC_VISUAL_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:resolve(process.env.LKC_VISUAL_EVIDENCE_DIR,`preview-pages-${width}.png`)});}
  await page.close();
 }console.log("Preview browser passed: 169 rows across 9 pages without loss/duplicates, first/last, NFKC search, date/status filters, empty result, snapshot reset, no extra network and 390/1280 layout.");}finally{await browser.close();await server.close();}
}
