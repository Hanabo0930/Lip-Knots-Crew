import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import {runInNewContext} from "node:vm";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
function compile(source){return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;}
const parserContext={exports:{}};runInNewContext(compile(fs.readFileSync("apps/admin/src/shift-import-preview.ts","utf8")),parserContext);
const {parseShiftImportPreview,previewSheetNames}=parserContext.exports;
const payload={spreadsheetId:"synthetic-spreadsheet",totals:{sheets:1,jobs:24,unresolvedStaff:0},warnings:[],samples:[{caseId:"synthetic-case",sheetName:"2099.10",row:2,workDate:"2099-10-01",storeName:"<script>unsafe()</script>",assignedStaffName:"",status:"open"}]};
assert.deepEqual(Array.from(previewSheetNames("2099-10")),["2099.10"]);assert.equal(previewSheetNames(""),undefined);assert.throws(()=>previewSheetNames("2099-13"));
for(const invalid of [{...payload,samples:null},{...payload,samples:Array(21).fill(payload.samples[0])},{...payload,totals:{...payload.totals,jobs:0}},{...payload,samples:[{...payload.samples[0],status:"unknown"}]},{...payload,totals:{...payload.totals,jobs:-1}}])assert.throws(()=>parseShiftImportPreview(invalid));
const componentContext={exports:{},require};runInNewContext(compile(fs.readFileSync("apps/admin/src/AdminShiftImportPreview.tsx","utf8")),componentContext);
const React=require("react"),{renderToStaticMarkup}=require("react-dom/server");
const markup=renderToStaticMarkup(React.createElement(componentContext.exports.default,{preview:parseShiftImportPreview(payload),demo:false}));
assert.ok(markup.includes("24件中1件"));assert.ok(markup.includes("先頭20件まで"));assert.ok(markup.includes("&lt;script&gt;"));assert.ok(!markup.includes("<script>"));assert.ok(markup.includes("未手配"));assert.ok(!markup.includes("<button"));
const app=fs.readFileSync("apps/admin/src/App.tsx","utf8"),a=app.indexOf("  async function previewSheetSync() {"),b=app.indexOf("  async function runSheetSync()",a);assert.ok(a>=0&&b>a);const handler=compile(app.slice(a,b));
const results=[];
for(const mode of ["success","failure","auth-change","newer","logged-out","invalid-response","demo"]){
 const state={preview:{old:true},busy:false,summary:"old",message:""},user={uid:"synthetic-admin"};let resolve,reject,calls=[];
 const context={syncBusy:false,shiftPreviewMonth:"2099-10",shiftPreviewVersionRef:{current:0},firebaseConfigured:mode!=="demo",functions:{},auth:{currentUser:mode==="logged-out"?null:user},parseShiftImportPreview,previewSheetNames,setShiftPreview:v=>state.preview=v,setSyncBusy:v=>state.busy=v,setSyncSummary:v=>state.summary=v,setMessage:v=>state.message=v,httpsCallable:(_f,name)=>input=>{calls.push({name,input});return new Promise((ok,no)=>{resolve=ok;reject=no;});}};
 runInNewContext(handler,context);const pending=context.previewSheetSync();
 if(mode==="logged-out"||mode==="demo"){await pending;assert.equal(calls.length,0);assert.equal(state.busy,false);if(mode==="demo")assert.ok(state.message.includes("実際のシフト表は読み取っていません"));else assert.equal(state.preview,null);}
 else{
  assert.equal(state.preview,null);assert.equal(calls.length,1);assert.equal(calls[0].name,"previewShiftImport");assert.equal(JSON.stringify(calls[0].input),JSON.stringify({sheetNames:["2099.10"]}));
  if(mode==="auth-change")context.auth.currentUser={uid:"other"};if(mode==="newer")context.shiftPreviewVersionRef.current++;
  if(mode==="failure")reject(Error("synthetic failure"));else resolve({data:mode==="invalid-response"?{}:payload});await pending;
  if(mode==="success"){assert.equal(state.preview.totalJobs,24);assert.equal(state.busy,false);}else assert.equal(state.preview,null);
  if(["failure","invalid-response"].includes(mode)){assert.equal(state.busy,false);assert.equal(state.summary,"読取に失敗しました");}
 }
 results.push({mode,passed:true});
}
const callback=app.slice(app.indexOf("      const currentRun=++authRun;"),app.indexOf("      resubmissionNeedsReviewRef.current=false;",app.indexOf("      const currentRun=++authRun;")));
const reset={authRun:0,shiftPreviewVersionRef:{current:4},setShiftPreview:v=>assert.equal(v,null),setSyncBusy:v=>assert.equal(v,false),setSyncSummary:v=>assert.equal(v,"未実行")};runInNewContext(callback,reset);assert.equal(reset.shiftPreviewVersionRef.current,5);
console.log(JSON.stringify({adminShiftPreview:results,malformedPayloadsRejected:5,escapingAndTruncation:true,authReset:true,realData:false}));

const syncStart=app.indexOf("  async function runSheetSync() {"),syncEnd=app.indexOf("  function selectAdminJob(",syncStart),syncHandler=compile(app.slice(syncStart,syncEnd));
for(const mode of ["success","auth-change","cancel"]){
 let finish,calls=0,loaded=0;const active={uid:"synthetic-admin"},state={summary:"",busy:false};
 const context={syncBusy:false,shiftPreviewMonth:"2099-10",previewSheetNames,window:{confirm:()=>mode!=="cancel"},firebaseConfigured:true,functions:{},auth:{currentUser:active},shiftPreviewVersionRef:{current:0},setSyncBusy:v=>state.busy=v,setSyncSummary:v=>state.summary=v,setMessage:()=>{},setShiftPreview:()=>{},loadJobs:async guard=>{assert.equal(guard(),true);loaded++;},httpsCallable:(_f,name)=>input=>{assert.equal(name,"syncShiftSheetsReadOnly");assert.equal(JSON.stringify(input),JSON.stringify({sheetNames:["2099.10"]}));calls++;return new Promise(resolve=>finish=resolve);}};
 runInNewContext(syncHandler,context);const pending=context.runSheetSync();if(mode!=="cancel"){if(mode==="auth-change")context.auth.currentUser=null;finish({data:{totals:{sheets:1,jobs:1,writes:1}}});}await pending;assert.equal(calls,mode==="cancel"?0:1);assert.equal(loaded,mode==="success"?1:0);if(mode==="auth-change")assert.equal(state.summary,"");
}
console.log("Selected month stays consistent between preview/import; stale auth does not load jobs; cancellation does not invoke import.");
