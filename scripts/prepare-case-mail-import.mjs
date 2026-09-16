import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {readCaseAutomationRuntime} from "./automation-external-runtime.mjs";
import {CaseMailImportError,prepareCaseMailImport,prepareCaseMailTargets} from "./case-mail-import-adapter.mjs";
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const contains=(parent,child)=>{const relative=path.relative(parent,child);return relative===""||(!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative));};
function readInput(file){
 const absolute=fs.realpathSync(file),stat=fs.statSync(absolute);
 if(!stat.isFile()||stat.size>8*1024*1024)throw new CaseMailImportError("input_size","受け渡しファイルは各8 MiB以下のJSONを指定してください。");
 const bytes=fs.readFileSync(absolute);let value;
 try{value=JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/,""));}catch{throw new CaseMailImportError("invalid_json","受け渡しファイルをJSONとして読み取れません。");}
 return {absolute,bytes,value,assertUnchanged(){if(hash(fs.readFileSync(absolute))!==hash(bytes))throw new CaseMailImportError("input_changed","処理中に受け渡しファイルが更新されました。最新の状態からやり直してください。");}};
}
function outputDestination(runtime,outputDir){
 const requested=path.resolve(outputDir),parent=fs.realpathSync(path.dirname(requested)),destination=path.join(parent,path.basename(requested));
 if(contains(runtime.root,destination))throw new CaseMailImportError("external_output","別タスクのフォルダーへは出力できません。アプリ側の新しい出力先を指定してください。");
 if(fs.existsSync(destination))throw new CaseMailImportError("output_exists","出力先が既にあります。既存ファイルを上書きせず、新しいフォルダー名を指定してください。");
 return destination;
}
export function writeCaseMailImport({sourceFile,appFile,externalCodeDir,outputDir,now=new Date()}){
 const source=readInput(sourceFile),app=readInput(appFile),runtime=readCaseAutomationRuntime(externalCodeDir);
 const destination=outputDestination(runtime,outputDir);
 const prepared=prepareCaseMailImport({source:source.value,app:app.value,runtime,now});
 source.assertUnchanged();app.assertUnchanged();runtime.assertUnchanged();
 const campaignBytes=Buffer.from(prepared.campaignText,"utf8"),review={...prepared.review,campaignFileHash:hash(campaignBytes)};
 fs.mkdirSync(destination);
 fs.writeFileSync(path.join(destination,"review.json"),JSON.stringify(review,null,2)+"\n",{encoding:"utf8",flag:"wx"});
 fs.writeFileSync(path.join(destination,"campaign.json"),campaignBytes,{flag:"wx"});
 if(hash(fs.readFileSync(path.join(destination,"campaign.json")))!==review.campaignFileHash)throw new CaseMailImportError("output_verify","生成ファイルの保存結果を確認できません。");
 return {outputDir:destination,caseCount:prepared.campaign.cases.length,campaignKey:prepared.campaign.operationKey,dispatch:"disabled"};
}
export function writeCaseMailTargets({sourceFile,externalCodeDir,outputDir,now=new Date()}){
 const source=readInput(sourceFile),runtime=readCaseAutomationRuntime(externalCodeDir),destination=outputDestination(runtime,outputDir);
 const prepared=prepareCaseMailTargets({source:source.value,runtime,now});
 source.assertUnchanged();runtime.assertUnchanged();
 const bytes=Buffer.from(JSON.stringify(prepared.targets,null,2)+"\n","utf8");
 fs.mkdirSync(destination);
 fs.writeFileSync(path.join(destination,"review.json"),JSON.stringify({...prepared.review,targetsFileHash:hash(bytes)},null,2)+"\n",{encoding:"utf8",flag:"wx"});
 fs.writeFileSync(path.join(destination,"targets.json"),bytes,{flag:"wx"});
 const importBytes=Buffer.from(JSON.stringify(prepared.importSource,null,2)+"\n");
 fs.writeFileSync(path.join(destination,"import-source.json"),importBytes,{flag:"wx"});
 if(hash(fs.readFileSync(path.join(destination,"import-source.json")))!==hash(importBytes))throw new CaseMailImportError("output_verify","募集連携ファイルの保存結果を確認できません。");
 if(hash(fs.readFileSync(path.join(destination,"targets.json")))!==hash(bytes))throw new CaseMailImportError("output_verify","対象ファイルの保存結果を確認できません。");
 return {outputDir:destination,caseCount:prepared.targets.cases.length,dispatch:"disabled"};
}

export function parseOptions(args,targetsOnly=false){
 const keys=new Map([["--source","sourceFile"],["--app","appFile"],["--external-code-dir","externalCodeDir"],["--out","outputDir"]]),options={};
 if(targetsOnly)keys.delete("--app");
 for(let i=0;i<args.length;i+=2){if(!keys.has(args[i])||!args[i+1]||args[i+1].startsWith("--")||Object.hasOwn(options,keys.get(args[i])))throw new CaseMailImportError("arguments",targetsOnly?"--source、--external-code-dir、--outを1回ずつ指定してください。":"--source、--app、--external-code-dir、--outを1回ずつ指定してください。");options[keys.get(args[i])]=args[i+1];}
 if(Object.keys(options).length!==keys.size)throw new CaseMailImportError("arguments",targetsOnly?"--source、--external-code-dir、--outを1回ずつ指定してください。":"--source、--app、--external-code-dir、--outを1回ずつ指定してください。");return options;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const out=writeCaseMailImport(parseOptions(process.argv.slice(2)));
  console.log(JSON.stringify({ok:true,caseCount:out.caseCount,campaignKey:out.campaignKey,files:["campaign.json","review.json"],registrationRequired:true,dispatch:"disabled"}));
 }catch(error){
  const known=error instanceof CaseMailImportError;
  console.error(JSON.stringify({ok:false,code:known?error.code:"local_io",message:known?error.message:"ローカルの入力・変換コード・出力先を確認できません。元ファイルを保持し、場所と読取権限を確認してください。"}));
  process.exitCode=1;
 }
}
