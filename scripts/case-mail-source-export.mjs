import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {readCaseAutomationRuntime} from "./automation-external-runtime.mjs";
import {CaseMailImportError,prepareCaseMailImport,prepareCaseMailTargets} from "./case-mail-import-adapter.mjs";

const hash=value=>createHash("sha256").update(value).digest("hex");
const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const id=value=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const fail=(code,message)=>{throw new CaseMailImportError(code,message);};
const contains=(parent,child)=>{const relative=path.relative(parent,child);return relative===""||(!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative));};
function readJson(file){
 const absolute=fs.realpathSync(file),stat=fs.statSync(absolute);
 if(!stat.isFile()||stat.size>8*1024*1024)fail("input_size","入力は各8 MiB以下のJSONファイルを指定してください。");
 const bytes=fs.readFileSync(absolute);let value;
 try{value=JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/,""));}catch{fail("invalid_json","入力ファイルをJSONとして読み取れません。");}
 return {value,absolute,hash:hash(bytes),assertUnchanged(){if(hash(fs.readFileSync(absolute))!==hash(bytes))fail("input_changed","処理中に入力が更新されました。最新の保存状態からやり直してください。");}};
}
/** 外部の保存状態と募集案を照合する。原本・本人の真正性を新たに認定しない。 */
export function prepareCaseMailSourceExport({state,draft,staff,companyId,expectedRevision,runtime,app,now=new Date()}){
 if(!id(companyId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)fail("source_context","所属と確認した保存版を明示してください。");
 if(!object(state)||state.version!==1||!Number.isSafeInteger(state.revision)||state.revision<0||!Array.isArray(state.cases)||state.cases.length>10000||!state.cases.every(object)||!object(state.cancellations)||!object(state.operations))
  fail("state_shape","案件・取消台帳・送信操作台帳を含む保存状態を確認してください。画面用の状態応答は利用できません。");
 if(state.revision!==expectedRevision)fail("state_changed","確認後に保存版が変わりました。募集案を保持して最新の案件を確認してください。");
 if(!object(draft)||!id(draft.operationId)||!Array.isArray(draft.cases)||!Array.isArray(staff))fail("source_shape","外部の募集案と名簿スナップショットを確認してください。");
 // IDの補正や部分除外は行わず、元の案と既存の取消・送信状態を保持する。
 const ids=new Set();
 for(const row of state.cases){if(!id(row.id)||ids.has(row.id))fail("source_identity","保存案件の固定IDが不正または重複しています。");ids.add(row.id);}
 for(const [key,event]of Object.entries(state.cancellations)){
  if(!id(key)||!object(event)||event.caseId!==key||!["ACTIVE","RESTORED"].includes(event.state))fail("cancellation_state","取消台帳の固定IDと状態を確認してください。");
 }
 for(const row of draft.cases){
  if(!object(row)||!id(row.id)||!ids.has(row.id))fail("source_identity","募集案の固定IDを保存案件と照合できません。");
  if(state.cancellations[row.id]?.state==="ACTIVE")fail("cancelled","取消済みの案件が募集案に含まれています。元の募集案を確認してください。");
 }
 if(Object.hasOwn(state.operations,JSON.stringify([draft.operationId,draft.area])))fail("operation_exists","同じ送信操作の記録があります。処理中・完了・失敗・結果不明を照合してから進めてください。");
 const source={version:1,companyId,capturedAt:now.toISOString(),draft,rows:state.cases,staff};
 const prepared=app===undefined?prepareCaseMailTargets({source,runtime,now}):prepareCaseMailImport({source,app,runtime,now});
 return {...prepared,review:{...prepared.review,externalStateRevision:state.revision,sourceCaptureMethod:"local-files-read",sourceAuthenticationVerified:false}};
}

/** 外部ファイルを読むだけで、必要な識別情報とハッシュだけを新規出力する。 */
export function writeCaseMailSourceExport({stateFile,draftFile,staffFile,companyId,expectedRevision,appFile,externalCodeDir,outputDir,now=new Date()}){
 const state=readJson(stateFile),draft=readJson(draftFile),staff=readJson(staffFile),app=appFile?readJson(appFile):undefined;
 const inputs=[state,draft,staff,...app?[app]:[]],runtime=readCaseAutomationRuntime(externalCodeDir);
 const requested=path.resolve(outputDir),parent=fs.realpathSync(path.dirname(requested)),destination=path.join(parent,path.basename(requested));
 const protectedRoots=[runtime.root,...inputs.map(input=>path.dirname(input.absolute))];
 if(protectedRoots.some(root=>contains(root,destination)))fail("external_output","入力と外部コードのフォルダーには出力できません。アプリ側の別の新規フォルダーを指定してください。");
 if(fs.existsSync(destination))fail("output_exists","出力先が既にあります。既存ファイルを保持し、新しい出力先を指定してください。");
 const lock=path.join(path.dirname(state.absolute),"state.lock");
 const unchanged=()=>{if(fs.existsSync(lock))fail("source_locked","外部の保存処理中です。保存完了後に最新の案件からやり直してください。");inputs.forEach(input=>input.assertUnchanged());runtime.assertUnchanged();};
 unchanged();
 const prepared=prepareCaseMailSourceExport({state:state.value,draft:draft.value,staff:staff.value,companyId,expectedRevision,runtime,app:app?.value,now});
 unchanged();
 const file=app?"campaign.json":"targets.json",payload=app?prepared.campaign:prepared.targets;
 const bytes=Buffer.from(JSON.stringify(payload,null,2)+"\n");
 const review={...prepared.review,inputFileHashes:{state:state.hash,draft:draft.hash,staff:staff.hash,...app?{app:app.hash}:{}},[app?"campaignFileHash":"targetsFileHash"]:hash(bytes)};
 fs.mkdirSync(destination);
 fs.writeFileSync(path.join(destination,file),bytes,{flag:"wx"});
 if(hash(fs.readFileSync(path.join(destination,file)))!==hash(bytes))fail("output_verify","出力内容の保存結果を確認できません。");
 unchanged();
 if(!app){
  const importBytes=Buffer.from(JSON.stringify(prepared.importSource,null,2)+"\n");
  fs.writeFileSync(path.join(destination,"import-source.json"),importBytes,{flag:"wx"});
  if(hash(fs.readFileSync(path.join(destination,"import-source.json")))!==hash(importBytes))fail("output_verify","募集連携ファイルの保存結果を確認できません。");
  review.importSourceFileHash=hash(importBytes);unchanged();
 }
 fs.writeFileSync(path.join(destination,"review.json"),JSON.stringify(review,null,2)+"\n",{encoding:"utf8",flag:"wx"});
 return {caseCount:payload.cases.length,files:[file,...(!app?["import-source.json"]:[]),"review.json"],externalStateRevision:state.value.revision,registrationRequired:true,sourceAuthenticationVerified:false,dispatch:"disabled"};
}
export function parseSourceExportOptions(args){
 const keys=new Map([["--state","stateFile"],["--draft","draftFile"],["--staff","staffFile"],["--company-id","companyId"],["--expected-revision","expectedRevision"],["--external-code-dir","externalCodeDir"],["--out","outputDir"],["--app","appFile"]]),options={};
 for(let i=0;i<args.length;i+=2){const key=keys.get(args[i]);if(!key||!args[i+1]||args[i+1].startsWith("--")||Object.hasOwn(options,key))fail("arguments","必要な入力ファイル・所属・保存版・出力先を重複なく指定してください。");options[key]=args[i+1];}
 if([...keys.values()].filter(key=>key!=="appFile").some(key=>!Object.hasOwn(options,key))||!/^(0|[1-9][0-9]*)$/.test(options.expectedRevision))fail("arguments","--state、--draft、--staff、--company-id、--expected-revision、--external-code-dir、--outが必要です。--appは任意です。");
 options.expectedRevision=Number(options.expectedRevision);return options;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify({ok:true,...writeCaseMailSourceExport(parseSourceExportOptions(process.argv.slice(2)))}));}
 catch(error){const known=error instanceof CaseMailImportError;console.error(JSON.stringify({ok:false,code:known?error.code:"local_io",message:known?error.message:"入力と出力先を読み書きできません。部分出力は利用せず、元入力を保持して新しい出力先で再試行してください。"}));process.exitCode=1;}
}
