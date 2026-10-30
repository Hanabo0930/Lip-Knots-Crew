import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {isRecruitmentMailEntry} from '../apps/admin/src/recruitment-mail-entry.ts';

const source=readFileSync('gas/recruitment-admin-entry/LK_RecruitMailV1.gs','utf8');
const html=readFileSync('gas/recruitment-admin-entry/RecruitMailDialog.html','utf8');
const bookId='SYNTHETIC_SOURCE_BOOK_0000000000';
const expectedUrl='https://lip-knots-crew-staging-admin.web.app/?entry=recruitment-mail';
let checks=0;
function setup(options={}){
 const binding=Object.hasOwn(options,"binding")?options.binding:bookId,active=Object.hasOwn(options,"active")?options.active:bookId;
 const calls=[];
 const menu={addItem:(label,handler)=>{calls.push(['item',label,handler]);return menu;},addToUi:()=>calls.push(['menu'])};
 const ui={showModalDialog:(view,title)=>calls.push(['dialog',view,title]),createMenu:label=>{calls.push(['label',label]);return menu;}};
 const scope={PropertiesService:{getScriptProperties:()=>({getProperty:key=>{assert.equal(key,'LK_RM_SOURCE_BOOK_ID');return binding;}})},SpreadsheetApp:{getActiveSpreadsheet:()=>active===null?null:{getId:()=>active},getUi:()=>ui},HtmlService:{createHtmlOutputFromFile:name=>{assert.equal(name,'RecruitMailDialog');const view={setWidth:()=>view,setHeight:()=>view};return view;}}};
 runInNewContext(source,scope);return {scope,calls};
}
{
 const {scope,calls}=setup();
 assert.equal(JSON.stringify(scope.lkRmV1Bootstrap()),JSON.stringify({purpose:'recruitment-admin-entry',url:expectedUrl}));checks++;
 scope.lkRmV1Open();assert.equal(calls[0][0],'dialog');checks++;
 scope.lkRmV1AddMenu_();assert.equal(JSON.stringify(calls.at(-2)),JSON.stringify(['item','作成画面を開く','lkRmV1Open']));checks++;
 assert.throws(()=>scope.lkRmV1Generate({selections:['STALE_PRIVATE_INPUT']}),/画面.*更新/);checks++;
 scope.LK_RM_ADMIN_ORIGIN_V1='https://elsewhere.invalid';assert.throws(()=>scope.lkRmV1Bootstrap(),/接続先/);checks++;
}
for(const binding of [null,undefined,123,'','short','invalid/binding']){
 const {scope,calls}=setup({binding});
 assert.throws(()=>scope.lkRmV1Bootstrap(),/対象設定/);assert.throws(()=>scope.lkRmV1Open(),/対象設定/);scope.lkRmV1AddMenu_();assert.equal(calls.length,0);checks++;
}
for(const active of [null,'OTHER_SYNTHETIC_BOOK_0000000000']){
 const {scope,calls}=setup({active});assert.throws(()=>scope.lkRmV1Bootstrap(),/対象設定/);scope.lkRmV1AddMenu_();assert.equal(calls.length,0);checks++;
}
assert.ok(!/Sheets\.|UrlFetchApp|GmailApp|MailApp|\.getValues\(|\.getRange\(|\.setValue\(|newTrigger|function onOpen\(/.test(source));checks++;
const inline=html.match(/<script>([\s\S]*?)<\/script>/)[1];
for(const result of [{purpose:'recruitment-admin-entry',url:expectedUrl},null,{},
 {purpose:'recruitment-admin-entry',url:'javascript:alert(1)'},
 {purpose:'recruitment-admin-entry',url:expectedUrl+'&jobId=private'},
 {purpose:'recruitment-admin-entry',url:'https://other.invalid/'},
 {purpose:'old-extractor',url:expectedUrl}]){
 const entry={hidden:true},status={},elements={entry,status};let success,failure,requests=0;
 const runner={withSuccessHandler:fn=>{success=fn;return runner;},withFailureHandler:fn=>{failure=fn;return runner;},lkRmV1Bootstrap:()=>requests++};
 runInNewContext(inline,{document:{getElementById:id=>elements[id]},google:{script:{run:runner}}});
 assert.equal(requests,1);assert.equal(entry.hidden,true);success(result);
 if(result?.purpose==='recruitment-admin-entry'&&result.url===expectedUrl){assert.equal(entry.hidden,false);assert.equal(entry.href,expectedUrl);}
 else{assert.equal(entry.hidden,true);assert.equal(entry.href,undefined);}
 failure({message:'PRIVATE_ERROR_DETAILS'});assert.ok(!status.textContent.includes('PRIVATE_ERROR_DETAILS'));checks++;
}
for(const [href,expected] of [
 [expectedUrl,true],['http://localhost/?entry=recruitment-mail',true],['https://admin.invalid/index.html?entry=recruitment-mail',true],
 ['https://admin.invalid/',false],['https://admin.invalid/?entry=other',false],['https://admin.invalid/?entry=recruitment-mail&entry=recruitment-mail',false],
 ['https://admin.invalid/admin/jobs/one?entry=recruitment-mail',false],['https://user:pass@admin.invalid/?entry=recruitment-mail',false],['javascript:alert(1)',false],['invalid',false],
 ]){assert.equal(isRecruitmentMailEntry(href),expected,href);checks++;}
const app=readFileSync('apps/admin/src/App.tsx','utf8');
const effect=app.match(/useEffect\(\(\)=>\{\s*if\(adminSessionReady&&recruitmentMailEntry\)openWorkspace\("jobs","list"\);\s*\},\[adminSessionReady,recruitmentMailEntry\]\);/);
assert.ok(effect);
for(const ready of [false,true])for(const entry of [false,true]){
 const opened=[];runInNewContext(effect[0],{useEffect:fn=>fn(),adminSessionReady:ready,recruitmentMailEntry:entry,openWorkspace:(...args)=>opened.push(args)});
 assert.equal(JSON.stringify(opened),JSON.stringify(ready&&entry?[['jobs','list']]:[]));checks++;
}
console.log(JSON.stringify({recruitmentSheetEntryChecks:checks,status:'PASS',businessRowReads:0,nativeWrites:0,realMailSends:0}));
