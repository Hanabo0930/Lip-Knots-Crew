// Local synthetic cells only: no Google/Firestore adapters, login, sends, or external I/O.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";
import net from "node:net";
import {fileURLToPath} from "node:url";

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const dependencyRoot=process.env.LKC_TEST_DEPENDENCY_ROOT||repo;
const require=createRequire(path.join(dependencyRoot,"package.json"));
const ts=require("typescript");
const cache=new Map();
function loadPure(file){
  file=path.resolve(file);
  if(cache.has(file))return cache.get(file).exports;
  const mod={exports:{}};cache.set(file,mod);
  const source=fs.readFileSync(file,"utf8");
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const localRequire=name=>{
    if(name==="node:crypto")return require(name);
    if(!["./sheet-write-core","./analytics-core"].includes(name))throw new Error("Unexpected dependency: "+name);
    return loadPure(path.join(path.dirname(file),name+".ts"));
  };
  vm.runInThisContext("(function(exports,require,module){"+code+"\n})",{filename:file})(mod.exports,localRequire,mod);
  return mod.exports;
}
const {SyntheticCancellationWriter,buildCancellationTestPlan}=loadPure(path.join(repo,"functions/src/cancellation-test-row-writer.ts"));
const {cancellationSheetWriteIdentity}=loadPure(path.join(repo,"functions/src/sheet-write-core.ts"));
const {cancellationReasonLabels,cancellationTreatmentLabels,computeJobFinance}=loadPure(path.join(repo,"functions/src/analytics-core.ts"));
const schemaRoot=process.env.LKC_CANCELLATION_SCHEMA_ROOT||repo;
const ack=schemaRoot?loadPure(path.join(schemaRoot,"functions/src/sheet-write-core.ts")).importedCancellationSourceAck:undefined;
let networkAttempts=0;
const originalConnect=net.Socket.prototype.connect;
const originalFetch=globalThis.fetch;
net.Socket.prototype.connect=function(){networkAttempts++;throw new Error("Network prohibited by synthetic test");};
globalThis.fetch=async()=>{networkAttempts++;throw new Error("Network prohibited by synthetic test");};
const copy=value=>structuredClone(value);
const stable=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest=value=>createHash("sha256").update(stable(value)).digest("hex");
const cases=[];
async function test(name,fn){await fn();cases.push(name);}
function fixture({v1=false,month="合成10月",noFixed=false,treatment="pay_only"}={}){
  const companyId="synthetic-company-one",spreadsheetId="synthetic-sheet-one";
  const job={id:"synthetic-job-one",companyId,caseId:"synthetic-case-one",assignedStaffId:"synthetic-staff-one",
    assignedStaffName:"合成スタッフA",rawStaffName:"合成スタッフA",dateKey:"2026-10-03",workDate:"2026-10-03",
    clientName:"合成取引先A",storeName:"合成店舗A",workTime:"09:00-17:00",revision:3,
    status:"cancelled",cancelled:true,publishable:false,sourceCancellationClosed:true,sourceMissing:false,
    cancellationReason:"依頼なしの誤手配による実施中止",cancellationReasonCategory:"other",cancellationFinancialTreatment:treatment,
    basePay:10000,financials:{clientChargeTotal:0,staffPaymentTotal:10000,clientChargeAdditionsTotal:0,subcontractorTotal:0},
    expenses:{transportation:null,purchase8:1200,purchase10:null,netPrintCost:null,postageCost:null},
    sheetRef:{spreadsheetId,sheetId:1,sheetName:month,currentRow:8,...(!noFixed?{caseIdColumn:month==="合成11月"?"AC":"AA"}:{})}};
  const operation=v1?"job.cancel":"job.cancel.v2",queueId="synthetic-queue-one";
  job.cancellationSheetWrite={sourceAckVersion:1,sourceAckPending:true,sourceAckRequestedAtMs:1000,
    sourceAckJobRevision:job.revision,queueId,operation,identity:cancellationSheetWriteIdentity(job)};
  const updates={cancelled:true,cancellationReason:job.cancellationReason,...(!v1?{
    cancellationReasonCategory:cancellationReasonLabels.other,cancellationFinancialTreatment:cancellationTreatmentLabels[treatment]}:{})};
  const queue={id:queueId,companyId,jobId:job.id,operation,actorUid:"synthetic-original-admin",idempotencyKey:operation+":"+job.id+":"+queueId,updates,styles:{}};
  const mapping={spreadsheetId,...(!noFixed?{idColumn:"AA",caseIdColumnsBySheet:{"合成10月":"AA","合成11月":"AC"}}:{}),
    columns:{workDate:"A",staffName:"B",clientName:"C",storeName:"D",workTime:"E",cancelled:"F",cancellationReason:"G",
      clientCharge:"H",staffPayment:"I",transportation:"J",purchase8:"K",formulaTotal:"L",netPrintCost:"M",
      cancellationReasonCategory:"N",cancellationFinancialTreatment:"O",...(!noFixed?{caseId:"AA"}:{})},
    operations:{"test.cancel.staff_display":{values:["staffName","cancelled","cancellationReason","cancellationReasonCategory","cancellationFinancialTreatment"]}}};
  const policy={treatment,expensePayer:"company",expenseReconciliation:"pending",grayStartColumn:"A",grayEndColumn:"O"};
  const input={scope:{kind:"synthetic_only",fixtureId:"synthetic-cancel-one",companyId,spreadsheetId},
    actor:{uid:"synthetic-admin-one",companyId,role:"admin"},job,queue,mapping,policy};
  const values={A:job.workDate,B:job.rawStaffName,C:job.clientName,D:job.storeName,E:job.workTime,F:false,G:"",
    H:0,I:10000,J:null,K:1200,L:11200,M:null,N:"",O:"",...(!noFixed?{[job.sheetRef.caseIdColumn]:job.caseId}:{})};
  const cells=Object.fromEntries(Object.entries(values).map(([col,value])=>[col,{value,background:"#ffffff"}]));
  cells.L.formula="=I8+K8";
  const row={spreadsheetId,sheetId:1,sheetName:month,rowNumber:8,revision:7,cells};
  return {input,rows:[row],writer:new SyntheticCancellationWriter(input,[row])};
}
const run=(writer,extra={})=>writer.execute({dryRun:false,atMs:2000,...extra});
const journal=writer=>[...writer.receipts.values()][0];
const expectRejected=async(edit,pattern)=>{
  const f=fixture();edit(f);
  await assert.rejects(async()=>{const w=new SyntheticCancellationWriter(f.input,f.rows);await run(w);},pattern);
};

try{
  await test("default dry-run keeps row/job/queue and saves no history",async()=>{
    const {writer}=fixture(),before=copy(writer.rows),inputBefore=copy(writer.input);
    const result=await writer.execute({atMs:2000});
    assert.equal(result.status,"dry_run");assert.equal(result.delivery,"not_sent");
    assert.deepEqual(writer.rows,before);assert.deepEqual(writer.input,inputBefore);
    assert.equal(writer.receipts.size,0);assert.equal(writer.batches,0);assert.equal(writer.logs[0].action,"dry_run");
  });
  for(const v1 of [true,false]){
    await test((v1?"v1":"v2")+" history precedes atomic blank/gray; finance and original staff retained",async()=>{
      const {writer}=fixture({v1}),before=copy(writer.rows[0]),inputBefore=copy(writer.input);
      const result=await run(writer,{beforeBatch:async()=>{
        assert.equal(journal(writer).plan.originalStaff.staffId,"synthetic-staff-one");
        assert.equal(journal(writer).plan.contact.staffId,"synthetic-staff-one");
        assert.equal(journal(writer).plan.originalStaff.sourceDisplayName,"合成スタッフA");
        assert.deepEqual(writer.rows[0],before);assert.equal(writer.batches,0);
      }});
      const after=writer.rows[0];
      assert.equal(result.status,"complete");assert.equal(result.contact.delivery,"not_sent");
      assert.equal(result.contact.status,"manual_contact_pending");
      assert.equal(after.cells.B.value,"");assert.equal(after.cells.F.value,true);
      assert.equal(after.cells.G.value,inputBefore.job.cancellationReason);
      for(const col of ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O"])assert.equal(after.cells[col].background,"#d9d9d9");
      for(const col of ["H","I","J","K","L","M","AA"])assert.equal(after.cells[col].value,before.cells[col].value);
      assert.equal(after.cells.L.formula,before.cells.L.formula);
      assert.equal(after.cells.AA.background,"#ffffff");
      assert.deepEqual(writer.input,inputBefore);assert.equal(journal(writer).plan.financialDisposition.originalBasePay,10000);
      assert.equal(writer.input.job.cancellationSheetWrite.sourceAckPending,true);
      assert.equal(writer.input.job.assignedStaffId,"synthetic-staff-one");assert.equal(writer.input.job.publishable,false);
      assert.equal(writer.batches,1);
      assert.equal(after.cells.O.value,v1?"":cancellationTreatmentLabels.pay_only);
    });
  }
  await test("pay_only fits existing finance: bill 0, pay 10000, actual expenses pending",async()=>{
    const {writer}=fixture();await run(writer);
    const finance=computeJobFinance(writer.input.job);
    assert.equal(finance.invoice,0);assert.equal(finance.payment,10000);
    const disposition=journal(writer).plan.financialDisposition;
    assert.equal(disposition.expensePayer,"company");assert.equal(disposition.expenseReconciliation,"pending");
    assert.equal(disposition.originalExpenses.transportation,null);
    assert.equal(disposition.originalExpenses.purchase8,1200);
    assert.equal(writer.rows[0].cells.I.value,10000);assert.equal(writer.rows[0].cells.J.value,null);
  });
  await test("four explicit dispositions do not zero stored amounts or infer from cancellation reason",async()=>{
    for(const treatment of ["invoice_and_pay","invoice_only","pay_only","neither"]){
      const {writer}=fixture({treatment});writer.input.job.financials.clientChargeTotal=18000;writer.rows[0].cells.H.value=18000;
      await run(writer);const p=journal(writer).plan.financialDisposition;
      assert.equal(p.billable,["invoice_and_pay","invoice_only"].includes(treatment));
      assert.equal(p.payable,["invoice_and_pay","pay_only"].includes(treatment));
      assert.equal(writer.rows[0].cells.H.value,18000);assert.equal(writer.rows[0].cells.I.value,10000);
      assert.equal(writer.input.job.basePay,10000);assert.equal(writer.rows[0].cells.K.value,1200);
    }
  });
  await test("same intent replay produces one batch/history and remains unsent",async()=>{
    const {writer}=fixture();await run(writer);const result=await run(writer,{atMs:2001});
    assert.equal(result.replayed,true);assert.equal(writer.batches,1);assert.equal(writer.receipts.size,1);
    assert.equal(result.contact.delivery,"not_sent");assert.equal(journal(writer).plan.contact.staffId,"synthetic-staff-one");
  });
  for(const failAt of ["after_history","before_batch"]){
    await test(failAt+" retains old row/contact; retry completes once",async()=>{
      const {writer}=fixture(),before=copy(writer.rows);
      await assert.rejects(run(writer,{failAt}),/simulated_/);assert.deepEqual(writer.rows,before);
      assert.equal(writer.batches,0);assert.equal(journal(writer).stage,"blocked");
      assert.equal(journal(writer).plan.originalStaff.displayName,"合成スタッフA");
      await run(writer,{atMs:2001});assert.equal(writer.batches,1);assert.equal(writer.receipts.size,1);
    });
  }
  await test("lost response checkpoint restores locally and verifies without a second batch",async()=>{
    const {writer}=fixture();await assert.rejects(run(writer,{failAt:"after_batch_response"}),/lost_response/);
    assert.equal(journal(writer).stage,"unknown");assert.equal(writer.batches,1);assert.equal(writer.rows[0].cells.B.value,"");
    const text=writer.exportCheckpoint();assert.ok(text.length<50000);
    const output=process.env.LKC_CANCELLATION_CHECKPOINT;
    if(output){
      const resolved=path.resolve(output);
      assert.ok(resolved.startsWith(path.dirname(repo)+path.sep),"Checkpoint must stay in this evidence folder");
      fs.writeFileSync(resolved,text,"utf8");
    }
    const restored=SyntheticCancellationWriter.restore(writer.input,output?fs.readFileSync(output,"utf8"):text);
    const result=await run(restored,{atMs:2002});
    assert.equal(result.replayed,true);assert.equal(restored.batches,1);assert.equal(journal(restored).stage,"complete");
    assert.equal(journal(restored).plan.originalStaff.staffId,"synthetic-staff-one");
  });
  await test("concurrent executors in one synthetic store are excluded; active checkpoint refused",async()=>{
    const {writer}=fixture();let release,entered;const gate=new Promise(r=>{release=r;});const reached=new Promise(r=>{entered=r;});
    const first=run(writer,{beforeBatch:async()=>{entered();await gate;}});
    await reached;
    const second=await run(writer,{atMs:2001});
    assert.equal(second.status,"in_progress");assert.equal(writer.batches,0);
    assert.throws(()=>writer.exportCheckpoint(),/Active executor/);
    release();assert.equal((await first).status,"complete");assert.equal(writer.batches,1);assert.equal(writer.receipts.size,1);
  });
  await test("admin/company boundary failures refuse before history",async()=>{
    for(const edit of [f=>{f.input.actor.role="staff";},f=>{f.input.actor.companyId="synthetic-company-other";},
      f=>{f.input.job.companyId="synthetic-company-other";},f=>{f.input.queue.companyId="synthetic-company-other";}]){
      await expectRejected(edit,/administrator|job required/);
    }
  });
  await test("stale revision/queue/identity refuses",async()=>{
    for(const edit of [f=>{f.input.job.revision++;},f=>{f.input.queue.id="synthetic-new-queue";},
      f=>{f.input.queue.idempotencyKey="wrong";},f=>{f.input.job.assignedStaffId="synthetic-staff-other";}]){
      await expectRejected(edit,/intent or revision/);
    }
  });
  await test("original worker payload remains exact: staff/amount/style additions refused",async()=>{
    for(const edit of [f=>{f.input.queue.updates.staffName="";},f=>{f.input.queue.updates.staffPayment=0;},
      f=>{f.input.queue.styles.staffName={background:"#d9d9d9"};}]){
      await expectRejected(edit,/queue contract changed/);
    }
  });
  await test("month-specific fixed ID resolves AA/AC and follows row move",async()=>{
    for(const month of ["合成10月","合成11月"]){
      const {writer}=fixture({month});writer.rows[0].rowNumber=22;
      await run(writer);assert.equal(writer.rows[0].rowNumber,22);
      assert.equal(writer.rows[0].cells[month==="合成11月"?"AC":"AA"].value,"synthetic-case-one");
      assert.equal(writer.rows[0].cells.B.value,"");
    }
  });
  await test("wrong monthly ID mapping and absent saved ID column refuse",async()=>{
    await expectRejected(f=>{f.input.job.sheetRef.caseIdColumn="AC";},/固定案件ID列|monthly ID/);
    await expectRejected(f=>{delete f.input.job.sheetRef.caseIdColumn;},/monthly ID/);
  });
  await test("no fixed ID pins original row; moved or duplicate fixed IDs refuse",async()=>{
    const f=fixture({noFixed:true});await run(f.writer);assert.equal(f.writer.rows[0].cells.B.value,"");
    const moved=fixture({noFixed:true});moved.writer.rows[0].rowNumber++;
    await assert.rejects(run(moved.writer),/missing or duplicated/);
    const duplicate=fixture();duplicate.writer.rows.push(copy(duplicate.writer.rows[0]));
    await assert.rejects(run(duplicate.writer),/missing or duplicated/);assert.equal(duplicate.writer.receipts.size,0);
  });
  await test("changed source name/identity and formula in an editable cell refuse",async()=>{
    for(const edit of [w=>{w.rows[0].cells.B.value="合成別スタッフ";},w=>{w.rows[0].cells.C.value="合成別取引先";},
      w=>{w.rows[0].cells.B.formula='="合成スタッフA"';}]){
      const {writer}=fixture();edit(writer);await assert.rejects(run(writer),/does not match|identity changed|formula/);
      assert.equal(writer.receipts.size,0);assert.equal(writer.batches,0);
    }
  });
  await test("unapproved operation or colliding physical columns refuse",async()=>{
    await expectRejected(f=>{delete f.input.mapping.operations["test.cancel.staff_display"];},/not permitted/);
    await expectRejected(f=>{f.input.mapping.columns.staffPayment="B";},/Duplicate/);
  });
  await test("context change during history/batch gap refuses without clearing",async()=>{
    for(const change of [w=>{w.input.job.revision++;},w=>{w.input.queue.updates.cancellationReason="合成変更";},
      w=>{w.input.policy.expensePayer="pending_review";}]){
      const {writer}=fixture();await assert.rejects(run(writer,{beforeBatch:async()=>{change(writer);}}));
      assert.equal(writer.rows[0].cells.B.value,"合成スタッフA");assert.equal(writer.batches,0);
      assert.equal(journal(writer).plan.originalStaff.staffId,"synthetic-staff-one");
    }
  });
  await test("concurrent manual financial/name edit refuses without overwriting",async()=>{
    for(const [col,value]of [["I",20000],["B","合成別スタッフ"]]){
      const {writer}=fixture();await assert.rejects(run(writer,{beforeBatch:async()=>{writer.rows[0].cells[col].value=value;}}),/changed before batch/);
      assert.equal(writer.rows[0].cells[col].value,value);assert.equal(writer.batches,0);
      assert.equal(journal(writer).plan.originalStaff.sourceDisplayName,"合成スタッフA");
    }
  });
  await test("post-write change remains unknown and retry never erases new staff",async()=>{
    const {writer}=fixture();await assert.rejects(run(writer,{afterBatch:async()=>{writer.rows[0].cells.B.value="合成別スタッフ";}}),/Post-write/);
    assert.equal(journal(writer).stage,"unknown");
    await assert.rejects(run(writer,{atMs:2001}),/changed before batch/);
    assert.equal(writer.rows[0].cells.B.value,"合成別スタッフ");assert.equal(writer.batches,1);
  });
  await test("complete replay after manual edit returns needs_review without write",async()=>{
    const {writer}=fixture();await run(writer);writer.rows[0].cells.I.value=12000;
    const result=await run(writer,{atMs:2001});assert.equal(result.status,"needs_review");assert.equal(writer.batches,1);
    assert.equal(writer.rows[0].cells.I.value,12000);
  });
  await test("same-company second administrator may recover same intent with audit actor",async()=>{
    const {writer}=fixture();await assert.rejects(run(writer,{failAt:"after_history"}));
    writer.input.actor.uid="synthetic-admin-two";await run(writer,{atMs:2001});
    assert.equal(writer.batches,1);assert.equal(writer.logs.at(-1).actorUid,"synthetic-admin-two");
    assert.equal(writer.input.queue.actorUid,"synthetic-original-admin");
  });
  await test("checkpoint accidental corruption and forged history refuse",async()=>{
    const {writer}=fixture();await run(writer);const text=writer.exportCheckpoint();
    const bad=JSON.parse(text);bad.data.receipts[0][1].plan.contact.staffId="synthetic-staff-other";
    assert.throws(()=>SyntheticCancellationWriter.restore(writer.input,JSON.stringify(bad)),/invalid/);
    bad.checksum=digest(bad.data);
    assert.throws(()=>SyntheticCancellationWriter.restore(writer.input,JSON.stringify(bad)),/history was modified/);
    const changed=copy(writer.input);changed.job.revision++;
    assert.throws(()=>SyntheticCancellationWriter.restore(changed,text),/intent or revision/);
  });
  await test("source-missing, already-acknowledged, real sheet ID and non-admin scopes refuse",async()=>{
    await expectRejected(f=>{f.input.job.sourceMissing=true;},/job required/);
    await expectRejected(f=>{f.input.job.cancellationSheetWrite.sourceAckPending=false;},/intent or revision/);
    await expectRejected(f=>{f.input.scope.spreadsheetId="a-business-sheet-id";},/Synthetic fixture/);
    await expectRejected(f=>{f.input.actor.uid="actual-user";},/administrator/);
  });
  await test("source acknowledgment compatibility: fresh blank read only; writer does not release day lock",async()=>{
    assert.equal(typeof ack,"function","Set LKC_CANCELLATION_SCHEMA_ROOT to the existing source-ack schema");
    const {writer}=fixture(),lock={companyId:writer.input.job.companyId,staffId:writer.input.job.assignedStaffId,jobId:writer.input.job.id,dateKey:writer.input.job.dateKey,active:true};
    const lockBefore=copy(lock),old=copy(writer.input.job);
    const incoming=()=>({companyId:old.companyId,caseId:old.caseId,dateKey:old.dateKey,workDate:old.workDate,
      rawStaffName:writer.rows[0].cells.B.value,cancelled:writer.rows[0].cells.F.value,status:"cancelled",
      sheetRef:{...old.sheetRef,currentRow:writer.rows[0].rowNumber}});
    assert.throws(()=>ack(old,incoming(),2001));
    await run(writer);assert.equal(ack(old,incoming(),2001),true);
    assert.throws(()=>ack(old,incoming(),1000));assert.throws(()=>ack(old,incoming(),999));
    assert.deepEqual(lock,lockBefore);assert.equal(writer.input.job.cancellationSheetWrite.sourceAckPending,true);
    assert.equal(writer.input.job.sourceCancellationClosed,true);assert.equal(writer.input.job.publishable,false);
    assert.equal(writer.input.job.assignedStaffId,old.assignedStaffId);
  });
  await test("bounded row/gray range and physical cell revision guards refuse",async()=>{
    await expectRejected(f=>{f.input.policy.grayEndColumn="ZZ";},/bounded gray/);
    const {writer}=fixture();writer.rows[0].revision=Number.MAX_SAFE_INTEGER;
    await assert.rejects(run(writer),/Invalid synthetic/);assert.equal(writer.receipts.size,0);
  });
  const configFile=path.join(repo,"functions/tsconfig.json");
  const config=ts.readConfigFile(configFile,ts.sys.readFile);
  assert.equal(config.error,undefined);
  const parsed=ts.parseJsonConfigFileContent({...config.config,include:[],files:["src/cancellation-test-row-writer.ts"]},ts.sys,path.dirname(configFile));
  assert.equal(parsed.errors.length,0);
  const program=ts.createProgram(parsed.fileNames,{...parsed.options,noEmit:true,types:["node"],typeRoots:[path.join(dependencyRoot,"node_modules/@types")]});
  const diagnostics=ts.getPreEmitDiagnostics(program);
  if(diagnostics.length){
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>repo,getNewLine:()=>"\n"}));
  }
  assert.equal(networkAttempts,0);
  const result={scope:"synthetic_cancellation_writer_only",casesPassed:cases.length,cases,noEmit:"PASS",
    sourceAckCompatibility:"existing local pure helper only; no DB release or importer executed",
    executionProof:"single in-memory store CAS + local JSON checkpoint; no real Sheets/Firestore transaction proof",
    realSheetRequests:0,realDbRequests:0,messagesSent:0,networkAttempts};
  const out=process.env.LKC_CANCELLATION_RESULTS;
  if(out){assert.ok(path.resolve(out).startsWith(path.dirname(repo)+path.sep));fs.writeFileSync(out,JSON.stringify(result,null,2)+"\n","utf8");}
  console.log(JSON.stringify({casesPassed:cases.length,noEmit:"PASS",networkAttempts,messagesSent:0}));
}finally{
  net.Socket.prototype.connect=originalConnect;globalThis.fetch=originalFetch;
}
