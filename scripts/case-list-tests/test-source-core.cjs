const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const file = path.join(__dirname,'../../functions/src/case-list-source-core.ts');
const source = stripTypeScriptTypes(readFileSync(file,'utf8'),{mode:'transform'}).replace('import { createHash } from "node:crypto";', 'const {createHash}=require("node:crypto");').replaceAll(/^export /gm,'');
const box = { require: name => name.startsWith('../') ? require(path.resolve(path.dirname(file),name)) : require(name), module: {exports:{}}, console, Date, Set, Map };
vm.runInNewContext(source+'\nmodule.exports={CASE_LIST_SOURCE,LEDGER_HEADERS,inspectCaseList,confirmedCaseListCandidate,hashCaseList,canonical,assertExecutive,assertCaseListJobBinding};',box,{filename:file});
const core=box.module.exports, projection=require('../../functions/src/case-list-projection.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const str=x=>({userEnteredValue:{stringValue:x},effectiveValue:{stringValue:x}});
const id='LKCASE_00000000-0000-5000-8000-000000000001';
function fixture(){
 const r=Array.from({length:65},()=>({}));
 for(const [n,v] of [[1,'2026-11-20'],[10,'依頼元'],[11,'店舗'],[12,'メーカー'],[13,'試食'],[14,'09:30'],[15,'10:00～18:00'],[55,'募集中'],[56,'東京'],[58,'単日'],[60,id],[62,JSON.stringify({schema:'LKCM1_CASE_META_V1',publicEligible:true,headcountConfirmed:true})]])r[n]=str(v);
 const l=Array.from({length:25},()=>({}));l[0]=str(id);l[8]=str('未手配');l[19]=str(JSON.stringify({schema:'LK_HISTORY_CORE_SNAPSHOT_V1',caseId:id,monthly:null}));
 return {rows:[projection.HEADERS.map(str),r],ledger:[[],[],core.LEDGER_HEADERS.map(str),l]};
}
const bookId='synthetic_book_20261027';
const now='2026-10-27T00:00:00.000Z';
function confirmation(f){return {expectedSourceRevision:core.inspectCaseList(f.rows,f.ledger,now,bookId).jobs[0].source.sourceRevision,confirmedFields:{arrival:true,execution:true,headcount:true,dateMode:true,payOffer:true,vacancy:true},payOffer:{dailyWageJPY:10000,travelExpenses:'全額支給',communicationExpenses:'全額支給'}};}
const results=[];function test(name,fn){fn();results.push({name,passed:true});}
test('source/ledger bound hash and confirmed public allowlist',()=>{const f=fixture(),c=confirmation(f),p=core.confirmedCaseListCandidate(f.rows,f.ledger,id,c,now,'owner',bookId);assert.equal(p.payOffer.dailyWageJPY,10000);assert.equal(p.staffName,undefined);assert.equal(p.sourceMail,undefined);});
test('source financial edit invalidates owner approval',()=>{const f=fixture(),c=confirmation(f);f.rows[1][28]={userEnteredValue:{numberValue:8000},effectiveValue:{numberValue:8000}};assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,c,now,'owner',bookId));});
test('ledger assignment invalidates source authority even C blank',()=>{const f=fixture(),c=confirmation(f);f.ledger[3][9]=str('既存担当');assert.notEqual(confirmation(f).expectedSourceRevision,c.expectedSourceRevision);assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,confirmation(f),now,'owner',bookId));});
test('existing monthly link cannot publish',()=>{const f=fixture();f.ledger[3][19]=str(JSON.stringify({schema:'LK_HISTORY_CORE_SNAPSHOT_V1',caseId:id,monthly:{caseId:'old-id'}}));assert.equal(core.inspectCaseList(f.rows,f.ledger,now,bookId).jobs[0].ledgerLinked,true);assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,confirmation(f),now,'owner',bookId));});
test('ledger missing holds',()=>{const f=fixture();f.ledger=f.ledger.slice(0,3);assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,confirmation(f),now,'owner',bookId));});
test('duplicate ledger IDs fail closed',()=>{const f=fixture();f.ledger.push(clone(f.ledger[3]));assert.throws(()=>core.inspectCaseList(f.rows,f.ledger,now,bookId));});
test('case-only duplicate Source IDs fail closed',()=>{const f=fixture(),r=clone(f.rows[1]);r[60]=str(id.toUpperCase());f.rows.push(r);assert.throws(()=>core.inspectCaseList(f.rows,f.ledger,now,bookId));});
test('A selection checkbox is not cancellation',()=>{const f=fixture();f.rows[1][0]={userEnteredValue:{boolValue:true},effectiveValue:{boolValue:true}};assert.ok(core.confirmedCaseListCandidate(f.rows,f.ledger,id,confirmation(f),now,'owner',bookId));});
test('BL cancellation holds',()=>{const f=fixture();f.rows[1][63]={userEnteredValue:{boolValue:true},effectiveValue:{boolValue:true}};assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,confirmation(f),now,'owner',bookId));});
for(const marker of ['取消','キャンセル','中止','cancel','CANCELLED','Ｃａｎｃｅｌｅｄ'])test('explicit K '+marker+' holds',()=>{const f=fixture();f.rows[1][10]=str('依頼元 '+marker);assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,confirmation(f),now,'owner',bookId));});
test('numeric staff C is never vacancy',()=>{const f=fixture();f.rows[1][2]={userEnteredValue:{numberValue:1},effectiveValue:{numberValue:1}};assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,confirmation(f),now,'owner',bookId));});
test('multiple date groups stay held',()=>{const f=fixture();f.rows[1][58]=str('全日同一');f.rows[1][59]=str('group1');assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,confirmation(f),now,'owner',bookId));});
test('unconfirmed arrival stays held',()=>{const f=fixture();f.rows[1][14]={};assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,confirmation(f),now,'owner',bookId));});
test('header drift stops import',()=>{const f=fixture();f.rows[0][0]=str('different');assert.throws(()=>core.inspectCaseList(f.rows,f.ledger,now,bookId));});
test('row position does not change authority',()=>{const f=fixture(),c=confirmation(f);f.rows.splice(1,0,Array.from({length:65},()=>({})));assert.equal(confirmation(f).expectedSourceRevision,c.expectedSourceRevision);});
test('format only does not change public source revision',()=>{const f=fixture(),c=confirmation(f);f.rows[1][11].userEnteredFormat={textFormat:{bold:true}};assert.equal(confirmation(f).expectedSourceRevision,c.expectedSourceRevision);});
test('verified executive required rather than role admin',()=>{assert.throws(()=>core.assertExecutive({role:'admin',email:'other@example.invalid',email_verified:true},'owner@example.invalid'));assert.throws(()=>core.assertExecutive({role:'admin',email:'owner@example.invalid',email_verified:false},'owner@example.invalid'));core.assertExecutive({role:'admin',email:'owner@example.invalid',email_verified:true},'owner@example.invalid');});
test('public pay offer does not infer salary breakdown',()=>{const f=fixture();f.rows[1][28]={userEnteredValue:{numberValue:1},effectiveValue:{numberValue:1}};assert.equal(core.confirmedCaseListCandidate(f.rows,f.ledger,id,confirmation(f),now,'owner',bookId).payOffer.dailyWageJPY,10000);});
test('confirmation does not authorize new source state',()=>{const f=fixture();f.rows[1][55]=str('確認待ち');assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,confirmation(f),now,'owner',bookId));});
test('legacy 公開 state is held; current 募集中 state is accepted',()=>{const f=fixture();f.rows[1][55]=str('公開');assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,confirmation(f),now,'owner',bookId));});
test('executive source review records explicit issues without modifying source metadata',()=>{const f=fixture();f.rows[1][62]=str(JSON.stringify({schema:'LKCM1_CASE_META_V1',publicEligible:false,headcountConfirmed:false,issues:['人数確認']}));const before=JSON.stringify(f),c=confirmation(f);assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,c,now,'owner',bookId));c.sourceReview={headcountPerSlot:1,reviewedIssues:['人数確認'],resolutionNote:'1名枠として依頼元に確認済み'};assert.ok(core.confirmedCaseListCandidate(f.rows,f.ledger,id,c,now,'owner',bookId));assert.equal(JSON.stringify(f),before);});
test('review cannot omit or silently resolve a source issue',()=>{const f=fixture();f.rows[1][62]=str(JSON.stringify({schema:'LKCM1_CASE_META_V1',publicEligible:false,headcountConfirmed:false,issues:['人数確認']}));const c=confirmation(f);c.sourceReview={headcountPerSlot:1,reviewedIssues:[],resolutionNote:'確認済み'};assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,c,now,'owner',bookId));});
test('source review cannot supply missing arrival or revive a noncurrent source',()=>{const f=fixture();f.rows[1][62]=str(JSON.stringify({schema:'LKCM1_CASE_META_V1',publicEligible:false,headcountConfirmed:false,issues:[],wordReconcile:{active:false}}));const c=confirmation(f);c.sourceReview={headcountPerSlot:1,reviewedIssues:[],resolutionNote:'確認済み'};assert.throws(()=>core.confirmedCaseListCandidate(f.rows,f.ledger,id,c,now,'owner',bookId));});
test('trusted source binding defaults to deny missing server ID',()=>{assert.throws(()=>projection.create({sha256:()=> 'a'.repeat(64)}));});
console.log(JSON.stringify({status:'PASS',tests:results.length,results},null,2));
