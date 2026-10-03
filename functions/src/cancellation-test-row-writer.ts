import {createHash,randomUUID} from "node:crypto";
import {cancellationSheetWriteIdentity,resolveSheetCaseIdMapping,assertSheetCaseIdColumn,columnToNumber,validateMutation} from "./sheet-write-core";
import {cancellationReasonLabels,cancellationTreatmentLabels,type CancellationFinancialTreatment} from "./analytics-core";

// No trigger, network client, credential lookup, or business-store adapter is exported.
type Data=Record<string,any>;
export type SyntheticCell={value:string|number|boolean|null;formula?:string;background?:string};
export type SyntheticRow={spreadsheetId:string;sheetId:number;sheetName:string;rowNumber:number;revision:number;cells:Record<string,SyntheticCell>};
export type CancellationTestInput={
  scope:{kind:"synthetic_only";fixtureId:string;companyId:string;spreadsheetId:string};
  actor:{uid:string;companyId:string;role:string};
  job:Data;queue:Data;
  mapping:{spreadsheetId:string;idColumn?:string;caseIdColumnsBySheet?:Record<string,string>;columns:Record<string,string>;
    operations:Record<string,{values:string[];styles?:string[]}>};
  policy:{treatment:CancellationFinancialTreatment;expensePayer:"company"|"pending_review";expenseReconciliation:"pending"|"reviewed";
    grayStartColumn:string;grayEndColumn:string};
};
type Plan={version:1;key:string;contextHash:string;before:SyntheticRow;after:SyntheticRow;
  originalStaff:{staffId:string;displayName:string;sourceDisplayName:string};
  contact:{companyId:string;staffId:string;status:"manual_contact_pending";delivery:"not_sent"};
  financialDisposition:{treatment:CancellationFinancialTreatment;billable:boolean;payable:boolean;expensePayer:string;expenseReconciliation:string;
    originalBasePay:unknown;originalFinancials:unknown;originalExpenses:unknown};
};
type Receipt={plan:Plan;stage:"prepared"|"unknown"|"blocked"|"complete";preparedAtMs:number;completedAtMs?:number;lease?:string;lastError?:string};
const TEST_OPERATION="test.cancel.staff_display";
const clone=<T>(value:T):T=>structuredClone(value);
const stable=(value:any):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=(value:unknown)=>createHash("sha256").update(stable(value)).digest("hex");
function refuse(message:string):never{throw new Error(message);}
const nonblank=(value:unknown):value is string=>typeof value==="string"&&value.trim().length>0;
const int=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
function mappedColumn(mapping:{columns:Record<string,string>},key:string):string{
  const column=mapping.columns[key];if(!column)refuse("Explicit mapped column required.");return column;
}
const cell=(row:SyntheticRow,column:string|undefined)=>{if(!column)refuse("Explicit mapped column required.");return row.cells[column]?.value??"";};

function context(input:CancellationTestInput){
  const {scope,actor,job,queue,policy}=input;
  if(scope?.kind!=="synthetic_only"||!/^synthetic-[a-z0-9-]+$/.test(scope.fixtureId)||
    !/^synthetic-company(?:-[a-z0-9-]+)?$/.test(scope.companyId)||!/^synthetic-sheet-[a-z0-9-]+$/.test(scope.spreadsheetId))
    refuse("Synthetic fixture scope required.");
  if(actor.role!=="admin"||actor.companyId!==scope.companyId||!/^synthetic-[a-z0-9-]+$/.test(actor.uid))
    refuse("Synthetic company administrator required.");
  if(job.companyId!==scope.companyId||queue.companyId!==scope.companyId||! /^(?:synthetic-[a-z0-9-]+|job_[a-f0-9]{24})$/.test(job.id)||
    queue.jobId!==job.id||!nonblank(job.caseId)||!nonblank(job.assignedStaffId)||!/^合成/.test(job.assignedStaffName)||
    !nonblank(job.dateKey)||job.dateKey!==job.workDate||job.status!=="cancelled"||job.cancelled!==true||
    job.publishable!==false||job.sourceCancellationClosed!==true||job.sourceMissing===true||!int(job.revision))
    refuse("Cancelled assigned synthetic job required.");
  const saved=job.cancellationSheetWrite,sheet=job.sheetRef;
  if(!saved||saved.sourceAckVersion!==1||saved.sourceAckPending!==true||!int(saved.sourceAckRequestedAtMs)||
    saved.sourceAckJobRevision!==job.revision||saved.queueId!==queue.id||saved.operation!==queue.operation||
    !["job.cancel","job.cancel.v2"].includes(queue.operation)||saved.identity!==cancellationSheetWriteIdentity(job)||
    queue.idempotencyKey!==queue.operation+":"+job.id+":"+queue.id||!nonblank(queue.actorUid))
    refuse("Cancellation intent or revision is stale.");
  if(!sheet||sheet.spreadsheetId!==scope.spreadsheetId||input.mapping.spreadsheetId!==scope.spreadsheetId||
    !int(sheet.sheetId)||!nonblank(sheet.sheetName)||!Number.isSafeInteger(sheet.currentRow)||sheet.currentRow<1)
    refuse("Synthetic source sheet identity required.");
  if(!Object.hasOwn(cancellationTreatmentLabels,policy.treatment)||job.cancellationFinancialTreatment!==policy.treatment||
    !["company","pending_review"].includes(policy.expensePayer)||!["pending","reviewed"].includes(policy.expenseReconciliation))
    refuse("Explicit independent financial decisions required.");
  const expected:Data={cancelled:true,cancellationReason:job.cancellationReason};
  if(!nonblank(job.cancellationReason)||job.cancellationReason.length>1000)refuse("Cancellation reason required.");
  if(queue.operation==="job.cancel.v2"){
    if(!Object.hasOwn(cancellationReasonLabels,job.cancellationReasonCategory))refuse("Cancellation category required.");
    expected.cancellationReasonCategory=cancellationReasonLabels[job.cancellationReasonCategory as keyof typeof cancellationReasonLabels];
    expected.cancellationFinancialTreatment=cancellationTreatmentLabels[policy.treatment];
  }
  if(stable(queue.updates)!==stable(expected)||Object.keys(queue.styles??{}).length)refuse("Original cancellation queue contract changed.");
  const mapping=resolveSheetCaseIdMapping(input.mapping,sheet.sheetName);
  assertSheetCaseIdColumn(sheet.caseIdColumn,mapping.idColumn);
  if(sheet.caseIdColumn!==mapping.idColumn||(mapping.idColumn&&mapping.columns.caseId!==mapping.idColumn))refuse("Saved monthly ID column changed.");
  const required=["staffName","workDate","clientName","storeName","workTime","cancelled","cancellationReason"];
  if(required.some(key=>!mapping.columns[key]))refuse("Explicit source columns required.");
  const columns=Object.values(mapping.columns);
  if(columns.some(column=>!/^[A-Z]{1,3}$/.test(column))||new Set(columns).size!==columns.length)
    refuse("Duplicate or invalid mapped columns.");
  const start=columnToNumber(policy.grayStartColumn),end=columnToNumber(policy.grayEndColumn);
  if(start<1||end<start||end>200||columnToNumber(mappedColumn(mapping,"staffName"))>end||
    columnToNumber(mappedColumn(mapping,"staffName"))<start)refuse("Explicit bounded gray range required.");
  const jobContext=Object.fromEntries(["id","companyId","caseId","assignedStaffId","assignedStaffName","rawStaffName","dateKey","workDate",
    "status","cancelled","publishable","sourceCancellationClosed","sourceMissing","revision","sheetRef","cancellationSheetWrite",
    "cancellationReason","cancellationReasonCategory","cancellationFinancialTreatment","basePay","financials","expenses",
    "clientName","storeName","workTime","mailIntakeHold","mailTargetHold"].map(key=>[key,job[key]]));
  jobContext.mailIntake=Boolean(job.mailIntake);
  const queueContext=Object.fromEntries(["id","companyId","jobId","operation","idempotencyKey","actorUid","updates","styles"].map(key=>[key,queue[key]]));
  return {mapping,contextHash:digest({scope,job:jobContext,queue:queueContext,mapping,policy}),key:queue.idempotencyKey+":staff-display:v1",start,end};
}

function locate(input:CancellationTestInput,rows:SyntheticRow[]){
  const {mapping}=context(input),sheet=input.job.sheetRef;
  if(!Array.isArray(rows)||rows.length>500)refuse("Bounded synthetic rows required.");
  const matching=rows.filter(row=>row.spreadsheetId===sheet.spreadsheetId&&row.sheetId===sheet.sheetId&&row.sheetName===sheet.sheetName&&
    (mapping.idColumn?cell(row,mapping.idColumn)===input.job.caseId:row.rowNumber===sheet.currentRow));
  if(matching.length!==1)refuse("Source row missing or duplicated.");
  const row=matching[0];if(!row)refuse("Source row missing.");
  if(!int(row.revision)||row.revision===Number.MAX_SAFE_INTEGER||!Number.isSafeInteger(row.rowNumber)||row.rowNumber<1||Object.keys(row.cells).length>200||
    Object.entries(row.cells).some(([column,data])=>!/^[A-Z]{1,3}$/.test(column)||!data||
      !["string","number","boolean","object"].includes(typeof data.value)||(typeof data.value==="object"&&data.value!==null)||
      (typeof data.value==="number"&&!Number.isFinite(data.value))||(typeof data.value==="string"&&data.value.length>2000)))
    refuse("Invalid synthetic source row.");
  return row;
}

export function buildCancellationTestPlan(input:CancellationTestInput,rows:SyntheticRow[]):Plan{
  const c=context(input),row=locate(input,rows),job=input.job,mapping=c.mapping;
  const original=typeof job.rawStaffName==="string"&&job.rawStaffName.trim()?job.rawStaffName:job.assignedStaffName;
  if(!/^合成/.test(original)||cell(row,mapping.columns.staffName)!==original)refuse("Original staff display does not match.");
  for(const [key,expected]of [["workDate",job.workDate],["clientName",job.clientName],["storeName",job.storeName],["workTime",job.workTime]]){
    if(!nonblank(expected)||cell(row,mapping.columns[key])!==expected)refuse("Source row business identity changed.");
  }
  if(![false,true,""].includes(cell(row,mapping.columns.cancelled) as any)||
    !["",job.cancellationReason].includes(cell(row,mapping.columns.cancellationReason) as any))refuse("Source cancellation was independently edited.");
  const updates:Data={staffName:"",cancelled:true,cancellationReason:job.cancellationReason};
  for(const key of ["cancellationReasonCategory","cancellationFinancialTreatment"]){
    if(mapping.columns[key]&&Object.hasOwn(input.queue.updates,key))updates[key]=input.queue.updates[key];
  }
  const errors=validateMutation(mapping,TEST_OPERATION,updates);if(errors.length)refuse("Test operation mapping is not permitted.");
  const before=clone(row),after=clone(row);after.revision++;
  for(const [key,value]of Object.entries(updates)){
    const column=mappedColumn(mapping,key);if(row.cells[column]?.formula)refuse("Editable cell contains a formula.");
    after.cells[column]={...after.cells[column],value};
  }
  // Background-only changes leave formulas, financial amounts, and unrelated formats intact.
  for(let n=c.start;n<=c.end;n++){
    const column=columnName(n);after.cells[column]={...(after.cells[column]??{value:null}),background:"#d9d9d9"};
  }
  return {version:1,key:c.key,contextHash:c.contextHash,before,after,
    originalStaff:{staffId:job.assignedStaffId,displayName:job.assignedStaffName,sourceDisplayName:original},
    contact:{companyId:job.companyId,staffId:job.assignedStaffId,status:"manual_contact_pending",delivery:"not_sent"},
    financialDisposition:{treatment:input.policy.treatment,billable:["invoice_and_pay","invoice_only"].includes(input.policy.treatment),
      payable:["invoice_and_pay","pay_only"].includes(input.policy.treatment),expensePayer:input.policy.expensePayer,
      expenseReconciliation:input.policy.expenseReconciliation,originalBasePay:clone(job.basePay??null),
      originalFinancials:clone(job.financials??{}),originalExpenses:clone(job.expenses??{})}};
}
function columnName(n:number){let s="";while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;}

/** Synthetic cells + a recoverable local journal. It cannot accept real spreadsheet IDs. */
export class SyntheticCancellationWriter{
  public input:CancellationTestInput;
  public rows:SyntheticRow[];
  public receipts=new Map<string,Receipt>();
  public logs:{action:string;key:string;actorUid:string;atMs:number}[]=[];
  public batches=0;
  constructor(input:CancellationTestInput,rows:SyntheticRow[]){context(input);this.input=clone(input);this.rows=clone(rows);}
  async execute(options:{dryRun?:boolean;atMs:number;failAt?:"after_history"|"before_batch"|"after_batch_response";
    beforeBatch?:()=>Promise<void>;afterBatch?:()=>Promise<void>}){
    if(!int(options.atMs)||options.atMs<=this.input.job.cancellationSheetWrite.sourceAckRequestedAtMs)refuse("Valid later execution time required.");
    const c=context(this.input),saved=this.receipts.get(c.key);
    if(saved&&saved.plan.contextHash!==c.contextHash)refuse("Saved history belongs to another intent.");
    const plan=saved?.plan??buildCancellationTestPlan(this.input,this.rows);
    if(options.dryRun!==false){
      this.logs.push({action:"dry_run",key:c.key,actorUid:this.input.actor.uid,atMs:options.atMs});
      return {status:"dry_run",plan:clone(plan),delivery:"not_sent" as const};
    }
    if(saved?.lease)return {status:"in_progress",delivery:"not_sent" as const};
    const current=locate(this.input,this.rows);
    if(saved?.stage==="complete"){
      if(digest(current)!==digest(plan.after))return {status:"needs_review",delivery:"not_sent" as const};
      return {status:"complete",replayed:true,contact:clone(plan.contact)};
    }
    const receipt=saved??{plan:clone(plan),stage:"prepared" as const,preparedAtMs:options.atMs};
    this.receipts.set(c.key,receipt); // Old staff/contact/finance are saved before any sheet mutation.
    const lease=randomUUID();receipt.lease=lease;
    this.logs.push({action:"history_saved",key:c.key,actorUid:this.input.actor.uid,atMs:options.atMs});
    let attempted=false;
    try{
      if(options.failAt==="after_history")throw new Error("simulated_after_history");
      await options.beforeBatch?.();
      if(context(this.input).contextHash!==plan.contextHash)refuse("Context changed before row write.");
      const latest=locate(this.input,this.rows);
      if(digest(latest)!==digest(plan.after)){
        if(digest(latest)!==digest(plan.before))refuse("Source row changed before batch.");
        if(options.failAt==="before_batch")throw new Error("simulated_before_batch");
        // One synchronous synthetic CAS changes values and color together.
        attempted=true;this.rows[this.rows.indexOf(latest)]=clone(plan.after);this.batches++;
        receipt.stage="unknown";
        if(options.failAt==="after_batch_response")throw new Error("simulated_lost_response");
      }
      await options.afterBatch?.();
      if(context(this.input).contextHash!==plan.contextHash||digest(locate(this.input,this.rows))!==digest(plan.after))
        refuse("Post-write verification changed; do not clear again.");
      receipt.stage="complete";receipt.completedAtMs=options.atMs;delete receipt.lastError;
      this.logs.push({action:"verified_complete",key:c.key,actorUid:this.input.actor.uid,atMs:options.atMs});
      return {status:"complete",replayed:!attempted,contact:clone(plan.contact)};
    }catch(error){
      receipt.stage=attempted||receipt.stage==="unknown"?"unknown":"blocked";
      receipt.lastError="write_or_verification_unconfirmed";
      this.logs.push({action:receipt.stage,key:c.key,actorUid:this.input.actor.uid,atMs:options.atMs});
      throw error;
    }finally{if(receipt.lease===lease)delete receipt.lease;}
  }
  exportCheckpoint(){
    if([...this.receipts.values()].some(value=>value.lease))refuse("Active executor cannot be checkpointed.");
    const data={version:1,fixtureId:this.input.scope.fixtureId,rows:clone(this.rows),receipts:[...this.receipts],logs:clone(this.logs),batches:this.batches};
    const text=JSON.stringify({data,checksum:digest(data)});if(text.length>1_000_000)refuse("Checkpoint is too large.");return text;
  }
  static restore(input:CancellationTestInput,text:string){
    if(text.length>1_000_000)refuse("Checkpoint is too large.");
    const {data,checksum}=JSON.parse(text);context(input);
    if(data?.version!==1||data.fixtureId!==input.scope.fixtureId||digest(data)!==checksum||
      !Array.isArray(data.receipts)||data.receipts.length>20||!Array.isArray(data.logs)||data.logs.length>100||!int(data.batches))
      refuse("Checkpoint is invalid.");
    const writer=new SyntheticCancellationWriter(input,data.rows),c=context(input);
    for(const [key,receipt]of data.receipts){
      if(key!==c.key||writer.receipts.has(key)||receipt?.lease||!["prepared","unknown","blocked","complete"].includes(receipt?.stage)||
        !int(receipt.preparedAtMs)||receipt.plan?.contextHash!==c.contextHash)refuse("Checkpoint history is not owned by this intent.");
      const rebuilt=buildCancellationTestPlan(input,[receipt.plan.before]);
      if(digest(rebuilt)!==digest(receipt.plan))refuse("Checkpoint history was modified.");
      writer.receipts.set(key,clone(receipt));
    }
    writer.logs=clone(data.logs);writer.batches=data.batches;return writer;
  }
}
