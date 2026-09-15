import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {createContext,Script} from "node:vm";
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
/** 関連する変換コードだけを読み、ネットワークやファイル操作を渡さず募集照合を呼ぶ。 */
export function readCaseAutomationRuntime(folder){
 const root=fs.realpathSync(folder),names=["core.js"],sources=new Map();
 for(const name of names){
  const file=path.join(root,name),stat=fs.statSync(file);if(!stat.isFile()||stat.size>1024*1024)throw Error("外部の変換コードを確認できません。");
  sources.set(name,fs.readFileSync(file));
 }
 const versions=Object.fromEntries([...sources].map(([name,bytes])=>[name,digest(bytes)]));
 const context=createContext({}, {codeGeneration:{strings:false,wasm:false}});
 new Script("globalThis.__modules=Object.create(null);").runInContext(context,{timeout:3000});
 for(const name of names){
  const wrapped='(()=>{const module={exports:{}};const exports=module.exports;const require=()=>{throw Error("unexpected dependency");};\n'+sources.get(name).toString("utf8")+'\nreturn module.exports;})()';
  context.__modules[name]=new Script(wrapped,{filename:name}).runInContext(context,{timeout:3000});
 }
 function unchanged(){
  for(const [name,bytes]of sources)if(digest(fs.readFileSync(path.join(root,name)))!==digest(bytes))throw Error("外部の変換コードが処理中に更新されました。最新の状態からやり直してください。");
 }
 return {root,versions,assertUnchanged:unchanged,validateDraft({draft,rows,staff,today}){
  unchanged();context.__input=JSON.stringify({draft,rows,staff,today});
  try{
   const value=new Script('(()=>{const input=JSON.parse(__input),core=__modules["core.js"];if(typeof core.canonical!=="function"||typeof core.validateDraft!=="function")throw Error("unsupported");if(core.canonical({cases:input.draft.cases,addresses:input.draft.addresses})!==input.draft.snapshot)return "inconsistent";const result=core.validateDraft(input.draft,input.rows,input.staff,input.today);return result&&result.ok===true&&Array.isArray(result.reasons)&&result.reasons.length===0?"valid":"changed";})()').runInContext(context,{timeout:3000});
   unchanged();return value;
  }finally{delete context.__input;}
 }};
}
