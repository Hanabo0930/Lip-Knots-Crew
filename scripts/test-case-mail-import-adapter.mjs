import assert from "node:assert/strict";
import {prepareCaseMailSourceExport,writeCaseMailSourceExport,parseSourceExportOptions} from "./case-mail-source-export.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {createHash,webcrypto} from "node:crypto";
import ts from "typescript";
import {runInNewContext} from "node:vm";
import {spawnSync} from "node:child_process";
import {harness,companyId,jobId,staffId,workDate} from "./automation-intake-test-harness.mjs";
import {readCaseAutomationRuntime} from "./automation-external-runtime.mjs";
import {prepareCaseMailImport,prepareCaseMailTargets,CaseMailImportError} from "./case-mail-import-adapter.mjs";
import {writeCaseMailImport,writeCaseMailTargets,parseOptions} from "./prepare-case-mail-import.mjs";
const folder=process.argv[2];if(!folder)throw Error("読取専用の外部コードフォルダーを指定してください。");
const output=process.argv[3]?path.resolve(process.argv[3]):fs.mkdtempSync(path.join(os.tmpdir(),"lkc-import-adapter-"));
if(process.argv[3])fs.mkdirSync(output);
const sha=value=>createHash("sha256").update(value).digest("hex"),clone=value=>JSON.parse(JSON.stringify(value));
const names=["core.js","business-rules.js","shift-adapter.js"],sources=new Map(names.map(name=>[name,fs.readFileSync(path.join(folder,name),"utf8")])),modules=new Map();
function load(name){
 assert.ok(names.includes(name));if(modules.has(name))return modules.get(name);const module={exports:{}};modules.set(name,module.exports);
 runInNewContext(sources.get(name),{module,exports:module.exports,require:relative=>{assert.match(relative,/^\.\/[a-z-]+\.js$/);return load(relative.slice(2));},Date},{timeout:3000});
 modules.set(name,module.exports);return module.exports;
}
const core=load("core.js"),shift=load("shift-adapter.js"),runtime=readCaseAutomationRuntime(folder);
const now=new Date(),template={id:"synthetic-template",source:"synthetic-confirmed-source",verified:true,render:rows=>({subject:"Synthetic subject",body:"private-body "+rows.map(row=>row.id).join("\n")})};
function makeDraft(source){return core.draft({rows:source.rows,staff:source.staff,area:source.draft?.area??"normal",today:"2099-09-19",template,operationId:"synthetic-campaign"});}
function fixture(area="normal"){
 const h=harness();h.records.delete(h.paths.campaign);const binding=clone(h.records.get(h.paths.binding)),job={...clone(h.records.get(h.paths.job)),id:jobId},owner=clone(h.records.get(h.paths.bindingOwner));
 const headers=Array(66).fill("");for(const [column,label]of Object.values(shift.FIELDS))headers[shift.index(column)]=label;headers[65]="連絡_固定案件ID";
 const values=Array(headers.length).fill(""),fields={day:"2099/09/20",staffName:"",client:"Synthetic client",store:"Synthetic store",maker:"Synthetic maker",product:"Synthetic menu",time:"10:00～18:00",plannedArrival:"09:45"};
 for(const [key,value]of Object.entries(fields))values[shift.index(shift.FIELDS[key][0])]=value;values[65]=binding.fixedCaseId;
 const normalized=shift.normalize({name:"2099.9",sheetId:1,headers,rows:[{rowNumber:12,values}]},{locations:{[binding.fixedCaseId]:{prefecture:area==="normal"?"東京都":"青森県",verified:true,source:"synthetic-location"}}});
 assert.equal(normalized.issues.length,0);
 const source={version:1,companyId,capturedAt:now.toISOString(),rows:clone(normalized.rows),staff:[{id:"synthetic-recipient",name:"private-person",list:area==="normal"?"マスターデータ":"東北",email:"private-email@example.invalid"}],draft:{area}};
 source.draft=clone(makeDraft(source));
 const app={version:1,companyId,capturedAt:now.toISOString(),policy:clone(h.records.get(h.paths.policy)),records:[{binding,job,owner}]};
 return {h,source,app};
}
let count=0;const results=[];
async function test(name,fn){try{await fn();count++;results.push({name,passed:true});console.log("成功: "+name);}catch(error){results.push({name,passed:false});throw Error(name,{cause:error});}}
const prepare=f=>prepareCaseMailImport({source:f.source,app:f.app,runtime,now});
for(const area of ["normal","tohoku"])await test("現行外部コード→取込JSON→登録→受信→既存担当確定: "+area,async()=>{
 const f=fixture(area),targets=prepareCaseMailTargets({source:f.source,runtime,now}).targets;
 const snapshot=await f.h.importSnapshot({expectedCompanyId:companyId,expectedActorUid:f.h.admin.uid,targets});
 f.app=clone(snapshot.snapshot);const before=JSON.stringify({source:f.source,app:f.app}),out=prepare(f);
 assert.equal(JSON.stringify({source:f.source,app:f.app}),before);assert.equal(out.campaign.cases[0].jobRevision,"0");
 assert.equal(out.campaign.cases[0].jobId,jobId);assert.equal(out.campaign.area,area);assert.equal(out.campaign.sourceOperationId,"synthetic-campaign");
 const serialized=JSON.stringify(out);for(const sensitive of ["private-body","private-person","private-email","@","Synthetic subject"])assert.ok(!serialized.includes(sensitive));
 assert.equal(out.review.registrationRequired,true);assert.equal(out.review.sourceAuthenticationVerified,false);assert.equal(out.review.dispatch,"disabled");
 const context={expectedCompanyId:companyId,expectedActorUid:f.h.admin.uid},preview=await f.h.previewCampaign({...context,campaign:out.campaign});
 const registered=await f.h.registerCampaign({...context,campaign:out.campaign,requestId:"import-request",expectedPrincipalRevision:preview.expectedPrincipalRevision,evidenceRecordId:"synthetic-manual-proof",confirmedAgainstSource:true});
 assert.equal(registered.campaignKey,out.campaign.operationKey);f.h.appMode();
 await f.h.receive({...f.h.incoming,campaignKey:out.campaign.operationKey});const candidate=f.h.list("automationApplications")[0];await f.h.apply(candidate);
 assert.equal(f.h.records.get(f.h.paths.job).assignedStaffId,staffId);assert.equal(f.h.list("automationCampaigns").length,1);
});
await test("本文編集は元の操作を保持し、同じ募集キーの内容差として検出",async()=>{
 const f=fixture(),first=prepare(f);f.source.draft=clone(core.editBody(f.source.draft,"private-body revised"));const next=prepare(f);
 assert.equal(next.campaign.operationKey,first.campaign.operationKey);assert.notEqual(next.campaign.payloadHash,first.campaign.payloadHash);
 assert.notEqual(next.campaign.sourceHash,first.campaign.sourceHash);assert.equal(next.campaign.cases[0].jobId,first.campaign.cases[0].jobId);
});
for(const [name,mutate,code]of [
 ["送信済み案",f=>f.source.draft.state="SENT","source_shape"],
 ["未確認書式",f=>f.source.draft.template.verified=false,"source_shape"],
 ["空本文",f=>f.source.draft.body="","source_shape"],
 ["空白だけの本文",f=>f.source.draft.body="   ","source_shape"],
 ["件名の改行",f=>f.source.draft.subject="Subject\r\nInjected","source_shape"],
 ["確認後の担当変更",f=>f.source.rows[0].staffName="changed","source_changed"],
 ["確認後の店舗変更",f=>f.source.rows[0].store="changed","source_changed"],
 ["確認後の宛先変更",f=>f.source.staff[0].email="changed@example.invalid","source_changed"],
 ["請求確認待ち",f=>f.source.rows[0].billingState="REVIEW","source_changed"],
 ["所在地再確認待ち",f=>f.source.rows[0].locationReviewReason="synthetic-pending","source_changed"],
 ["保存された案件の差替え",f=>f.source.draft.cases[0].day="2099-09-21","draft_inconsistent"],
 ["保存された宛先の差替え",f=>f.source.draft.addresses.bcc=[],"draft_inconsistent"],
 ["募集スナップショットの不一致",f=>f.source.draft.snapshot="changed","draft_inconsistent"],
 ["異なる会社",f=>f.source.companyId="other-company","company_mismatch"],
 ["別会社の案件",f=>f.app.records[0].job.companyId="other-company","company_mismatch"],
 ["固定ID所有者の変更",f=>f.app.records[0].owner.jobId="other-job","binding_owner"],
 ["所有版の不一致",f=>f.app.records[0].owner.revision="other","binding_owner"],
 ["不正な案件版",f=>f.app.records[0].job.revision=.5,"job_revision"],
 ["案件日の変更",f=>f.app.records[0].job.dateKey="2099-09-21","app_mismatch"],
 ["アプリ受付へ移行",f=>f.app.policy.phase="app","app_mismatch"],
 ["アプリで募集停止",f=>f.app.records[0].job.recruitmentStopped=true,"app_mismatch"],
 ["案件対応の重複",f=>f.app.records.push(clone(f.app.records[0])),"app_mismatch"],
 ["対応する固定IDなし",f=>{f.source.rows[0].id="other-fixed";f.source.draft=clone(makeDraft(f.source));},"app_mismatch"],
 ["101枠",f=>f.source.draft.cases=Array.from({length:101},(_,n)=>({...f.source.draft.cases[0],id:"fixed-"+n})),"source_shape"],
 ["生のサーバー状態に含まれるトークン",f=>f.source.token="synthetic-private-token","source_shape"],
 ])await test("生成を中止し入力を保持: "+name,async()=>{
 const f=fixture();mutate(f);const before=JSON.stringify({source:f.source,app:f.app});assert.throws(()=>prepare(f),error=>error instanceof CaseMailImportError&&error.code===code);assert.equal(JSON.stringify({source:f.source,app:f.app}),before);
});
await test("日付を日本時間で再確認し、勤務当日になった古い募集案を拒否",async()=>{
 const f=fixture();assert.throws(()=>prepareCaseMailImport({source:f.source,app:f.app,runtime,now:new Date("2099-09-19T15:00:00.000Z")}),error=>error.code==="source_changed");
});
function writeInputs(name,f=fixture()){
 const dir=path.join(output,name);fs.mkdirSync(dir);const sourceFile=path.join(dir,"source.json"),appFile=path.join(dir,"app.json");
 fs.writeFileSync(sourceFile,JSON.stringify(f.source));fs.writeFileSync(appFile,JSON.stringify(f.app));return {dir,sourceFile,appFile,externalCodeDir:folder,outputDir:path.join(dir,"generated")};
}
await test("新規フォルダーに取込JSONと照合記録を書き、既存出力・入力を上書きしない",async()=>{
 const input=writeInputs("write"),before=[sha(fs.readFileSync(input.sourceFile)),sha(fs.readFileSync(input.appFile))],out=writeCaseMailImport(input);
 const campaign=JSON.parse(fs.readFileSync(path.join(out.outputDir,"campaign.json"))),review=JSON.parse(fs.readFileSync(path.join(out.outputDir,"review.json")));
 assert.equal(campaign.operationKey,out.campaignKey);assert.equal(review.campaignFileHash,sha(fs.readFileSync(path.join(out.outputDir,"campaign.json"))));
 assert.throws(()=>writeCaseMailImport(input),error=>error.code==="output_exists");assert.deepEqual([sha(fs.readFileSync(input.sourceFile)),sha(fs.readFileSync(input.appFile))],before);
 assert.ok(!JSON.stringify(review).includes("private"));assert.equal(fs.readdirSync(out.outputDir).length,2);
});
await test("CLIを実行して内容を出力せず生成結果を案内し、引数重複を拒否",async()=>{
 const input=writeInputs("cli"),args=["scripts/prepare-case-mail-import.mjs","--source",input.sourceFile,"--app",input.appFile,"--external-code-dir",folder,"--out",input.outputDir];
 const child=spawnSync(process.execPath,args,{encoding:"utf8",timeout:15000});assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);assert.equal(result.ok,true);assert.equal(result.caseCount,1);assert.ok(!child.stdout.includes("private"));
 assert.throws(()=>parseOptions(["--source","one","--source","two"]),error=>error.code==="arguments");
 const repeat=spawnSync(process.execPath,args,{encoding:"utf8",timeout:15000});assert.equal(repeat.status,1);assert.equal(JSON.parse(repeat.stderr).code,"output_exists");
});
await test("読み取り中の入力更新を検出し、出力を作らない",async()=>{
 const input=writeInputs("racing"),original=fs.readFileSync;let reads=0;
 fs.readFileSync=function(file,...args){if(String(file)===fs.realpathSync(input.sourceFile)&&++reads===2)fs.appendFileSync(input.sourceFile,"\n");return original.call(this,file,...args);};
 try{assert.throws(()=>writeCaseMailImport(input),error=>error.code==="input_changed");}finally{fs.readFileSync=original;}
 assert.equal(fs.existsSync(input.outputDir),false);
});
await test("壊れたJSON・過大入力・失敗時に入力内容をログへ出さない",async()=>{
 for(const mode of ["broken","large"]){
  const input=writeInputs("invalid-"+mode);fs.writeFileSync(input.sourceFile,mode==="large"?Buffer.alloc(8*1024*1024+1,32):"private-body broken");
  const child=spawnSync(process.execPath,["scripts/prepare-case-mail-import.mjs","--source",input.sourceFile,"--app",input.appFile,"--external-code-dir",folder,"--out",input.outputDir],{encoding:"utf8",timeout:15000});
  assert.equal(child.status,1);assert.ok(!child.stderr.includes("private-body"));assert.ok(!child.stderr.includes(input.sourceFile));assert.equal(fs.existsSync(input.outputDir),false);
 }
});
await test("外部変換コードの更新を検出し、外部フォルダーへの出力を拒否",async()=>{
 const copied=path.join(output,"copied-external");fs.mkdirSync(copied);for(const name of ["core.js","business-rules.js"])fs.writeFileSync(path.join(copied,name),sources.get(name));
 const loaded=readCaseAutomationRuntime(copied);fs.appendFileSync(path.join(copied,"core.js"),"\n");assert.throws(()=>loaded.assertUnchanged(),/更新/);
 const input=writeInputs("external-output");assert.throws(()=>writeCaseMailImport({...input,externalCodeDir:copied,outputDir:path.join(copied,"forbidden")}),error=>error.code==="external_output");assert.equal(fs.existsSync(path.join(copied,"forbidden")),false);
});
await test("外部コードへファイル・通信APIや任意のrequireを渡さない",async()=>{
 const copied=path.join(output,"unsupported-external");fs.mkdirSync(copied);fs.writeFileSync(path.join(copied,"business-rules.js"),"module.exports={};");
 fs.writeFileSync(path.join(copied,"core.js"),'module.exports=require("node:fs");');assert.throws(()=>readCaseAutomationRuntime(copied),/unexpected dependency/);
 fs.writeFileSync(path.join(copied,"core.js"),'module.exports={canonical:()=>"",validateDraft:()=>({ok:typeof process==="undefined"&&typeof fetch==="undefined"&&typeof Buffer==="undefined"&&typeof WebSocket==="undefined",reasons:[]})};');
 const loaded=readCaseAutomationRuntime(copied);assert.equal(loaded.validateDraft({draft:{cases:[],addresses:{},snapshot:""},rows:[],staff:[],today:"2099-09-19"}),"valid");
});
await test("100枠の固定ID対応を保ち、取込ファイルの上限内に収める",async()=>{
 const f=fixture(),base=f.app.records[0],row=f.source.rows[0];
 f.source.rows=Array.from({length:100},(_,index)=>({...row,id:"fixed-"+index}));
 f.app.records=f.source.rows.map((row,index)=>({
  binding:{...base.binding,jobId:"job-"+index,appCaseId:"case-"+index,fixedCaseId:row.id},
  job:{...base.job,id:"job-"+index,caseId:"case-"+index},
  owner:{...base.owner,jobId:"job-"+index,fixedCaseId:row.id},
 }));
 f.source.draft=clone(makeDraft(f.source));const out=prepare(f);assert.equal(out.campaign.cases.length,100);
 for(const target of out.campaign.cases)assert.equal(target.jobId,"job-"+target.fixedCaseId.slice(6));
 assert.ok(Buffer.byteLength(out.campaignText)<=262144);
});
await test("生成ファイルを管理画面の実パーサーで読み、実プレビューの確認内容へ渡す",async()=>{
 const f=fixture(),input=writeInputs("admin-parser",f),out=writeCaseMailImport(input),loaded=new Map();
 function client(name){if(loaded.has(name))return loaded.get(name);const exports={};loaded.set(name,exports);
  const code=ts.transpileModule(fs.readFileSync("apps/admin/src/"+name.slice(2)+".ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  runInNewContext(code,{exports,require:client,TextEncoder,crypto:webcrypto});return exports;}
 const parser=client("./campaign-registration"),campaign=await parser.parseCampaignText(fs.readFileSync(path.join(out.outputDir,"campaign.json"),"utf8"),companyId);
 const response=await f.h.previewCampaign({expectedCompanyId:companyId,expectedActorUid:f.h.admin.uid,campaign});
 assert.equal(parser.campaignPreview(response,campaign).cases[0].jobId,jobId);
});
await test("アプリ情報なしで対象ファイルを作り、本文や宛先を出さない",async()=>{
 const input=writeInputs("targets"),out=writeCaseMailTargets(input),targets=JSON.parse(fs.readFileSync(path.join(out.outputDir,"targets.json")));
 assert.equal(targets.kind,"recruitment.import-targets");assert.equal(targets.cases[0].fixedCaseId,"synthetic-fixed");
 assert.equal(targets.cases[0].workDate,workDate);assert.equal(targets.sourceOperationId,"synthetic-campaign");
 for(const file of ["targets.json","import-source.json","review.json"]){const text=fs.readFileSync(path.join(out.outputDir,file),"utf8");assert.ok(!text.includes("private"));assert.ok(!text.includes("@"));}
 assert.throws(()=>writeCaseMailTargets(input),error=>error.code==="output_exists");
});
await test("対象ファイル用CLIから取得画面の対象形式を生成できる",async()=>{
 const input=writeInputs("targets-cli"),child=spawnSync(process.execPath,["scripts/prepare-case-mail-targets.mjs","--source",input.sourceFile,"--external-code-dir",folder,"--out",input.outputDir],{encoding:"utf8",timeout:15000});
 assert.equal(child.status,0,child.stderr);const report=JSON.parse(child.stdout);assert.equal(report.appSnapshotRequired,true);assert.deepEqual(report.files,["targets.json","import-source.json","review.json"]);assert.equal(report.recommendedImportFile,"import-source.json");for(const file of report.files)assert.ok(fs.existsSync(path.join(input.outputDir,file)));assert.ok(fs.existsSync(path.join(input.outputDir,"targets.json")));
 assert.throws(()=>parseOptions(["--source","one","--app","two","--external-code-dir",folder,"--out","out"],true),error=>error.code==="arguments");
});
await test("画面内変換が従来CLIと一致し、現在値の確認から登録プレビューへつながる",async()=>{
 const loaded=new Map();
 function client(name){if(loaded.has(name))return loaded.get(name);const exports={};loaded.set(name,exports);
  const code=ts.transpileModule(fs.readFileSync("apps/admin/src/"+name.slice(2)+".ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  runInNewContext(code,{exports,require:client,TextEncoder,crypto:webcrypto});return exports;
 }
 const model=client("./campaign-import");
 for(const area of ["normal","tohoku"]){
  const f=fixture(area),bundle=prepareCaseMailTargets({source:f.source,runtime,now}).importSource;
  const selected=model.parseCampaignImportText(JSON.stringify(bundle),companyId);
  assert.ok(!JSON.stringify(bundle).includes("private"));assert.ok(!JSON.stringify(bundle).includes("@"));
  const response=await f.h.importSnapshot({expectedCompanyId:companyId,expectedActorUid:f.h.admin.uid,targets:selected.targets});
  const result=client("./import-snapshot").appImportSnapshotResult(response,selected.targets);
  const campaign=await model.campaignFromImport(selected,result,companyId,now);
  assert.deepEqual(clone(campaign),clone(prepareCaseMailImport({source:f.source,app:clone(response.snapshot),runtime,now}).campaign));
  const preview=await f.h.previewCampaign({expectedCompanyId:companyId,expectedActorUid:f.h.admin.uid,campaign});
  assert.equal(preview.cases.length,1);
  for(const bad of [{...bundle,token:"private"},{...bundle,sourceHash:"bad"},{...bundle,sourceCapturedAt:"bad"},{...bundle,targets:{...bundle.targets,companyId:"other"}}])
   assert.throws(()=>model.parseCampaignImportText(JSON.stringify(bad),companyId));
  await assert.rejects(model.campaignFromImport({...selected,sourceHash:null},result,companyId,now));
  await assert.rejects(model.campaignFromImport(selected,result,"other",now));
  const wrong=clone(result);wrong.snapshot.records[0].owner.revision="changed";
  await assert.rejects(model.campaignFromImport(selected,wrong,companyId,now));
  await assert.rejects(model.campaignFromImport(selected,result,companyId,new Date(workDate+"T00:00:00+09:00")));
  assert.equal(model.parseCampaignImportText(JSON.stringify(selected.targets),companyId).sourceHash,null);
 }
});
function exportInput(f=fixture()){
 return {state:{version:1,revision:2,cases:clone(f.source.rows),cancellations:{},operations:{},inbox:[{body:"private-inbox"}],audit:[{actor:"private-auditor"}]},draft:clone(f.source.draft),staff:clone(f.source.staff),companyId,expectedRevision:2,runtime,now};
}
await test("外部保存形式から最小対象→認証付き照合→募集登録まで接続",async()=>{
 const f=fixture(),input=exportInput(f),before=JSON.stringify(input.state);
 const targets=prepareCaseMailSourceExport(input).targets;
 const snapshot=await f.h.importSnapshot({expectedCompanyId:companyId,expectedActorUid:f.h.admin.uid,targets});
 const prepared=prepareCaseMailSourceExport({...input,app:clone(snapshot.snapshot)});
 assert.deepEqual(prepared.campaign,prepare(f).campaign);
 const context={expectedCompanyId:companyId,expectedActorUid:f.h.admin.uid},preview=await f.h.previewCampaign({...context,campaign:prepared.campaign});
 await f.h.registerCampaign({...context,campaign:prepared.campaign,requestId:"export-request",expectedPrincipalRevision:preview.expectedPrincipalRevision,evidenceRecordId:"synthetic-export-proof",confirmedAgainstSource:true});
 assert.equal(f.h.list("automationCampaigns").length,1);assert.equal(JSON.stringify(input.state),before);
 assert.equal(prepared.review.externalStateRevision,2);assert.equal(prepared.review.sourceAuthenticationVerified,false);
 for(const value of ["private","@","Synthetic subject"])assert.ok(!JSON.stringify(prepared).includes(value));
});
for(const [name,mutate,code]of [
 ["古い保存版",i=>i.expectedRevision=1,"state_changed"],
 ["画面向け応答で台帳が欠落",i=>delete i.state.cancellations,"state_shape"],
 ["重複固定ID",i=>i.state.cases.push(clone(i.state.cases[0])),"source_identity"],
 ["数値固定ID",i=>i.state.cases[0].id=123,"source_identity"],
 ["取消台帳ACTIVE",i=>i.state.cancellations[i.draft.cases[0].id]={caseId:i.draft.cases[0].id,state:"ACTIVE"},"cancelled"],
 ["取消台帳の所有ID不一致",i=>i.state.cancellations[i.draft.cases[0].id]={caseId:"other",state:"RESTORED"},"cancellation_state"],
 ["未知の取消状態",i=>i.state.cancellations[i.draft.cases[0].id]={caseId:i.draft.cases[0].id,state:"UNKNOWN"},"cancellation_state"],
 ["確認後に案件内容変更",i=>i.state.cases[0].store="changed","source_changed"],
 ["確認後に名簿変更",i=>i.staff[0].email="changed@example.invalid","source_changed"],
 ...["SENDING","SENT","UNCERTAIN","FAILED"].map(state=>["既存送信操作"+state,i=>i.state.operations[JSON.stringify([i.draft.operationId,i.draft.area])]={state},"operation_exists"]),
 ])await test("最小出力を保留: "+name,async()=>{
 const input=exportInput();mutate(input);const before=JSON.stringify({state:input.state,draft:input.draft,staff:input.staff});
 assert.throws(()=>prepareCaseMailSourceExport(input),error=>error.code===code);
 assert.equal(JSON.stringify({state:input.state,draft:input.draft,staff:input.staff}),before);
});
await test("取消解除後は案件・原案も一致した場合に限り復帰",async()=>{
 const input=exportInput(),key=input.draft.cases[0].id;input.state.cancellations[key]={caseId:key,state:"RESTORED"};
 assert.equal(prepareCaseMailSourceExport(input).targets.cases.length,1);
 input.state.cases[0].cancelled=true;assert.throws(()=>prepareCaseMailSourceExport(input),error=>error.code==="source_changed");
});
function exportFiles(name){
 const input=exportInput(),dir=path.join(output,name);fs.mkdirSync(dir);
 const options={stateFile:path.join(dir,"state.json"),draftFile:path.join(dir,"draft.json"),staffFile:path.join(dir,"staff.json"),companyId,expectedRevision:2,externalCodeDir:folder,outputDir:path.join(output,name+"-export"),now};
 for(const [key,file]of [["state","stateFile"],["draft","draftFile"],["staff","staffFile"]])fs.writeFileSync(options[file],JSON.stringify(input[key]));
 return options;
}
await test("ファイル出力は必要項目だけで入力を保持し、既存出力を上書きしない",async()=>{
 const options=exportFiles("source-files"),files=[options.stateFile,options.draftFile,options.staffFile],before=files.map(file=>sha(fs.readFileSync(file)));
 const result=writeCaseMailSourceExport(options);assert.equal(result.caseCount,1);
 assert.deepEqual(fs.readdirSync(options.outputDir).sort(),["import-source.json","review.json","targets.json"]);
 for(const file of result.files){const text=fs.readFileSync(path.join(options.outputDir,file),"utf8");assert.ok(!text.includes("private"));assert.ok(!text.includes("@"));}
 const review=JSON.parse(fs.readFileSync(path.join(options.outputDir,"review.json")));assert.equal(review.targetsFileHash,sha(fs.readFileSync(path.join(options.outputDir,"targets.json"))));
 assert.deepEqual(files.map(file=>sha(fs.readFileSync(file))),before);
 assert.throws(()=>writeCaseMailSourceExport(options),error=>error.code==="output_exists");
 assert.throws(()=>writeCaseMailSourceExport({...options,outputDir:path.join(path.dirname(options.stateFile),"nested")}),error=>error.code==="external_output");
});
await test("保存ロック中は出力せず、解除後は同じ入力から復帰",async()=>{
 const options=exportFiles("source-locked"),lock=path.join(path.dirname(options.stateFile),"state.lock");fs.writeFileSync(lock,"synthetic-lock");
 assert.throws(()=>writeCaseMailSourceExport(options),error=>error.code==="source_locked");assert.ok(!fs.existsSync(options.outputDir));
 fs.unlinkSync(lock);assert.equal(writeCaseMailSourceExport(options).caseCount,1);
});
await test("最小出力CLIは成功時・失敗時とも本文と宛先を表示しない",async()=>{
 const options=exportFiles("source-cli"),args=["scripts/case-mail-source-export.mjs","--state",options.stateFile,"--draft",options.draftFile,"--staff",options.staffFile,"--company-id",companyId,"--expected-revision","2","--external-code-dir",folder,"--out",options.outputDir];
 let child=spawnSync(process.execPath,args,{encoding:"utf8",timeout:15000});assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).dispatch,"disabled");
 child=spawnSync(process.execPath,args,{encoding:"utf8",timeout:15000});assert.equal(child.status,1);assert.equal(JSON.parse(child.stderr).code,"output_exists");assert.ok(!child.stderr.includes("private"));
 assert.throws(()=>parseSourceExportOptions(args.slice(1).concat(["--expected-revision","2"])),error=>error.code==="arguments");
});
await test("最小出力中の案件・募集案・名簿変更は出力前に停止",async()=>{
 for(const field of ["stateFile","draftFile","staffFile"]){
  const options=exportFiles("source-race-"+field),original=fs.readFileSync;let reads=0;
  fs.readFileSync=function(file,...args){if(String(file)===fs.realpathSync(options[field])&&++reads===2)fs.appendFileSync(options[field],"\n");return original.call(this,file,...args);};
  try{assert.throws(()=>writeCaseMailSourceExport(options),error=>error.code==="input_changed");}finally{fs.readFileSync=original;}
  assert.ok(!fs.existsSync(options.outputDir));
 }
});
await test("照合済みappファイルから募集JSONを出力し、保存失敗後は新規先で回復",async()=>{
 const f=fixture(),options=exportFiles("source-app"),appFile=path.join(path.dirname(options.stateFile),"app.json");fs.writeFileSync(appFile,JSON.stringify(f.app));
 options.appFile=appFile;const original=fs.writeFileSync;
 fs.writeFileSync=function(file,...args){if(String(file)===path.join(options.outputDir,"review.json"))throw Error("synthetic-write-failure");return original.call(this,file,...args);};
 try{assert.throws(()=>writeCaseMailSourceExport(options),/synthetic-write-failure/);}finally{fs.writeFileSync=original;}
 assert.ok(!fs.existsSync(path.join(options.outputDir,"review.json")));
 const out=writeCaseMailSourceExport({...options,outputDir:options.outputDir+"-recovered"});assert.deepEqual(out.files,["campaign.json","review.json"]);
 const campaign=JSON.parse(fs.readFileSync(path.join(options.outputDir+"-recovered","campaign.json")));assert.deepEqual(campaign,prepare(f).campaign);
});
for(const [name,source]of sources)assert.equal(sha(fs.readFileSync(path.join(folder,name))),sha(source),"外部コードが検証中に変更されました。");
runtime.assertUnchanged();
fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({passed:count,results,externalCodeVersions:Object.fromEntries([...sources].map(([name,source])=>[name,sha(source)])),finishedAt:new Date().toISOString(),externalFilesChanged:false,network:false,delivery:false,sourceAuthenticationVerified:false},null,2));
console.log("募集受け渡しアダプター: "+count+"条件成功。外部原本・実DB・実送信への操作なし。");
