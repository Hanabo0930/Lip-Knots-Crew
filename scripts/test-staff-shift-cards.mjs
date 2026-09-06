import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const scope={exports:{},require:createRequire(import.meta.url)};
runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/ShiftJobCards.tsx','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,scope);
const {shiftPage}=scope.exports;
for(const count of [0,1,49,50,51,1000]){
 const jobs=Array.from({length:count},(_,id)=>({id}));
 const seen=[];
 for(let page=0;page<shiftPage(jobs,0).totalPages;page++)seen.push(...shiftPage(jobs,page).rows);
 assert.deepEqual(seen,jobs);
 assert.equal(shiftPage(jobs,10000).current,Math.max(0,Math.ceil(count/50)-1));
 assert.equal(shiftPage(jobs,-1).current,0);
 assert.equal(shiftPage(jobs,NaN).current,0);
 assert.equal(shiftPage(jobs,Infinity).current,0);
}
console.log('Shift cards passed: empty, 1/49/50/51/1000 rows, all-page coverage and invalid/stale page clamp.');