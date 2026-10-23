import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';
const fixture=JSON.parse(readFileSync(resolve(import.meta.dirname,'fixtures/legacy-submitted-cleanup-0be40aa.json'),'utf8'));
export const legacySourceCommit=fixture.sourceCommit;
export function legacyStorePlugin(){
 const paths={'/__legacy-draft.js':'draftStore','/__legacy-attempt.js':'attemptStore'};
 return {name:'frozen-legacy-local-stores',enforce:'pre',resolveId(id){if(paths[id])return '\0'+id;},load(id){
  const key=paths[id.slice(1)];if(id.startsWith('\0')&&key)return ts.transpileModule(fixture[key],{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 },configureServer(server){server.middlewares.use((req,res,next)=>{
  if(req.url!=='/__legacy')return next();res.setHeader('Content-Type','text/html');res.end('<!doctype html><script type="module">import * as drafts from "/__legacy-draft.js";import * as attempts from "/__legacy-attempt.js";window.legacy={drafts,attempts};</script>');
 });}};
}
