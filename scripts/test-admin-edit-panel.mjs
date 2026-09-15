import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(path.resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||'.','package.json'));
const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),modules=new Map();
function load(name){
 if(name==='react/jsx-runtime')return require(name);
 if(name==='./AutomationRegistryEntry')return {__esModule:true,default:()=>null};
 assert.ok(['./JobSafeEditPanel','./StoreLocationFields'].includes(name),'Unexpected panel dependency');
 if(modules.has(name))return modules.get(name);
 const source=fs.readFileSync('apps/admin/src/'+name.slice(2)+'.tsx','utf8'),exports={};
 runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:load});modules.set(name,exports);return exports;
}
const Panel=load('./JobSafeEditPanel').default,values=Object.fromEntries(['assignedStaffId','clientName','storeName','storeAddress','storeNearestStation','makerName','menuName','entryTime','workTime','subcontractorName'].map(k=>[k,'']));
let cases=0;
for(const dirty of [false,true])for(const busy of [false,true])for(const pendingSourceWrite of [false,true]){
 const html=renderToStaticMarkup(React.createElement(Panel,{jobs:[{id:'j',workDate:'2099-09-20',storeName:'Synthetic',pendingSourceWrite}],staff:[],jobEditId:'j',revision:3,values,busy,dirty,invoiceLabels:[],staffPayLabels:[],onSelectJob:()=>{},onUpdate:()=>{},onSave:()=>{}}));
 assert.equal(/<button[^>]*disabled/.test(html),busy||!dirty);
 assert.equal(html.includes('シフト表への反映は確認待ちです。'),pendingSourceWrite);
 assert.ok(html.includes(busy?'保存結果を確認しています。':dirty?'未保存の変更があります。':'表示中の内容に変更はありません。'));cases++;
}
console.log('Admin edit panel: '+cases+' real React render states passed; no API calls.');