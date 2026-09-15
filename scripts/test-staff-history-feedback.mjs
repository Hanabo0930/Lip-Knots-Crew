import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import ts from 'typescript';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
const source=readFileSync('apps/staff/src/App.tsx','utf8');const start=source.indexOf('{submissionHistoryStatus==="loading"?');
const marker='onRefreshPreview={refreshFilePreview}/>}';const stop=source.indexOf(marker,start)+marker.length;assert.ok(start>=0&&stop>start);const code=ts.transpileModule('globalThis.node=<main>'+source.slice(start,stop)+'</main>;',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
for(const status of ['loading','error','ready'])for(const populated of [false,true]){
 let renders=0;const ctx={React:{createElement},submissionHistoryStatus:status,submissionHistory:populated?[{files:[{id:'kept'}]}]:[],refreshFilePreview:()=>assert.fail('Rendering must not fetch'),SubmissionHistoryFiles:({files})=>{renders++;return createElement('p',null,'files='+files.length);}};runInNewContext(code,ctx);const html=renderToStaticMarkup(ctx.node);
 if(status==='loading'){assert.ok(html.includes('role="status"'));assert.ok(html.includes('完了するまでお待ちください'));assert.ok(!html.includes('操作できます'));assert.equal(renders,0);}else if(status==='error'){assert.ok(html.includes('role="alert"'));assert.ok(html.includes('提出情報を再読み込み'));assert.equal(renders,0);}else{assert.equal(renders,1);assert.ok(html.includes('files='+(populated?1:0)));}
 assert.equal(ctx.submissionHistory.length,populated?1:0);
}
console.log('History feedback: loading/error/ready × empty/prior rows accurately describe waiting, announce retrieval failure and preserve history data without fetching.');
