import {staffStoreLoader} from './submission-store-test-loader.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {runInNewContext} from 'node:vm';
const code=ts.transpileModule(fs.readFileSync('apps/staff/src/draft-store.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const markerCode=ts.transpileModule(fs.readFileSync('apps/staff/src/submitted-marker-store.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
for(const action of ['saveDraft','clearDraft']){
 let opens=0;const failure=Error('synthetic mutation failure');
 const namespace=staffStoreLoader()('submission-namespace');const marker={exports:{},require:()=>namespace,localStorage:{getItem:()=>null}};runInNewContext(markerCode,marker);
 const ctx={exports:{},require:name=>{if(name==='./submission-namespace')return namespace;if(name==='./submitted-marker-store')return marker.exports;assert.equal(name,'./submitted-binding-store');return {hasSubmittedBindings:async()=>false,canClearBoundDraft:async()=>true};},indexedDB:{open:()=>{opens++;throw failure;}}};runInNewContext(code,ctx);
 const mutation=ctx.exports[action]('key',[]),read=ctx.exports.loadDraft('key');
 const results=await Promise.allSettled([mutation,read]);assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'rejected');assert.equal(results[1].reason,failure);assert.equal(opens,1,'Do not restore older data after the pending mutation failed.');
 const retried=await Promise.allSettled([ctx.exports[action]('key',[])]);assert.equal(retried[0].status,'rejected');assert.equal(opens,2,'A failed queue entry must not prevent a new mutation attempt.');
}
console.log('Draft store ordering passed: pending save/clear failures reach readers without stale reads; subsequent mutation attempts remain possible.');
