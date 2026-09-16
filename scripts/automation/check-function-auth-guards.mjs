import { execFileSync } from "node:child_process";
import process from "node:process";

function valueAfter(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

function parseCsv(value) {
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const ref = valueAfter("--ref", "HEAD");
const repository = valueAfter("--repository", ".");
const requirePass = process.argv.includes("--require-pass");
const requestedFunctions = parseCsv(
  valueAfter("--functions", "requestStaffLoginLink,getSubmissionProcessingStatus,driveFilePreview"),
);
const supportedFunctions = new Set([
  "previewStaffImport",
  "syncStaffDirectoryReadOnly",
  "previewShiftImport",
  "syncShiftSheetsReadOnly",
  "retrySheetWriteIssue",
  "acknowledgeSheetWriteIssue",
  "getSheetWriteIssues",
  "getOperationsDashboard",
  "getStaffPerformance",
  "createAdminJobGroup",
  "updateJobPublication",
  "adminEditJobInputs",
  "generateJobExport",
  "updateNetPrintNumbers",
  "adminSetJobCancellation",
  "adminRestoreCancelledJob",
  "applyToJob",
  "getMyTasks",
  "listMyMailApplications",
  "setSalesFloorClientSubmitted",
  "submitPreContact",
  "createUploadSession",
  "getExpenseReview",
  "saveExpenseReviewDraft",
  "completeExpenseReview",
  "getJobSheetLink",
  "markNetPrintPrinted",
  "adminCancelJob",
  "duplicateAdminJob",
  "bootstrapSession",
  "confirmApplication",
  "completeResubmissionRequest",
  "getAdminResubmissionRequests",
  "getMyResubmissionRequests",
  "createResubmissionRequest",
  "getSubmissionTimeline",
  "requestStaffLoginLink",
  "getSubmissionProcessingStatus",
  "getResubmissionComparison",
  "driveFilePreview",
  "finalizeStagedUpload",
  "registerDeviceSession",
  "heartbeatDeviceSession",
  "listMyDevices",
  "revokeMyDevice",
  "revokeAllMyDevices",
  "getStaffDevices",
  "adminRevokeStaffDevices",
  "registerPushToken",
  "unregisterPushToken",
  "getPushStatus",
  "sendTestPush",
  "processNotificationQueue",
]);

if (
  requestedFunctions.length === 0
  || new Set(requestedFunctions).size !== requestedFunctions.length
  || requestedFunctions.some((name) => !supportedFunctions.has(name))
) {
  console.error("SOURCE_GUARD_STATUS=FAIL");
  console.error("SOURCE_GUARD_ERROR=FUNCTION_LIST_NOT_SUPPORTED");
  process.exit(1);
}

const sourceCache = new Map();
function sourceFile(path) {
  if (sourceCache.has(path)) return sourceCache.get(path);
  try {
    const source = execFileSync(
      "git",
      ["show", `${ref}:${path}`],
      { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    sourceCache.set(path, source);
    return source;
  } catch {
    console.error("SOURCE_GUARD_STATUS=FAIL");
    console.error(`SOURCE_GUARD_ERROR=SOURCE_REF_OR_FILE_UNAVAILABLE:${path}`);
    process.exit(1);
  }
}

function functionBlock(source, exportName) {
  const start = source.indexOf(`export const ${exportName}`);
  if (start < 0) return "";
  const remaining = source.slice(start + 1);
  const nextOffset = remaining.search(/\nexport const [A-Za-z0-9_]+/);
  const end = nextOffset < 0 ? source.length : start + 1 + nextOffset;
  return source.slice(start, end);
}




function checkImportIssues(name) {
  const staff = ["previewStaffImport", "syncStaffDirectoryReadOnly"].includes(name);
  const shift = ["previewShiftImport", "syncShiftSheetsReadOnly"].includes(name);
  const source = sourceFile("functions/src/" + (staff ? "staff-import" : shift ? "shift-import" : "admin-operations") + ".ts");
  const start = source.indexOf("export const " + name + " =");
  const marker = staff || shift ? "\n);" : "\n});";
  const end = source.indexOf(marker, start);
  if (start < 0 || end < start) return false;
  const compact = text => text.replace(/\s+/g, "");
  const block = compact(source.slice(start, end + marker.length)), whole = compact(source);
  const has = values => values.every(value => block.includes(value));
  const utils = source.match(/import \{([^}]+)\} from "\.\/utils";/)?.[1] ?? "";
  if (!/\brequireAdmin\b/.test(utils) || !/\bcompanyFromClaims\b/.test(utils)
    || !has(["constsession=requireAdmin(request);", "constcompanyId=companyFromClaims(session.token);"])
    || /(?:input|request\.data)\.(?:companyId|actorUid|uid)/.test(block)) return false;
  const body = block.slice(block.indexOf("async(request)=>{") + "async(request)=>{".length);
  if (!body.startsWith("constsession=requireAdmin(request);constcompanyId=companyFromClaims(session.token);")) return false;
  if (staff || shift) {
    const mode = name.startsWith("preview") ? "preview" : "commit";
    const execute = staff ? "executeStaffImport" : "executeShiftImport";
    if (!has(["RequestSchema.parse(request.data??{})", execute+'(companyId,"'+mode+'",input.sheetNames)'])
      || !source.includes('from "./system-safety";')
      || !whole.includes('if(mode==="commit")awaitassertProductionOperational(companyId);constconfig=awaitloadConfig(companyId);')
      || !whole.includes(staff ? "stored.companyId!==undefined&&stored.companyId!==companyId" : "saved?.companyId!==undefined&&saved.companyId!==companyId")
      || !whole.includes(staff ? "ConfigSchema.safeParse({...stored,companyId})" : "ConfigSchema.safeParse({...saved,companyId,})")) return false;
    const reader = compact(sourceFile("functions/src/sheet-reader.ts"));
    if (!reader.includes('scopes:["https://www.googleapis.com/auth/spreadsheets.readonly"]')
      || /sheets\.spreadsheets\.(?:batchUpdate|values\.(?:update|append|clear|batchUpdate|batchClear))\(/.test(whole + reader)) return false;
    const requirements = staff ? [
      'if(mode==="commit"&&(!completeSelection||!completeRows))', 'if(failedSheets>0)',
      'newBatchWriter(companyId,lock)', 'if(!lock)thrownewHttpsError("aborted",',
      'lease.companyId!==companyId', 'lease.token!==token', '!(lease.leaseUntilinstanceofTimestamp)',
      'lease.leaseUntil.toMillis()<=Timestamp.now().toMillis()',
      'assertStaffImportLease((awaittx.get(this.lock.ref)).data(),this.companyId,this.lock.token);',
      'assertStaffImportLease((awaitlock.ref.get()).data(),companyId,lock.token);awaitauth.revokeRefreshTokens(item.uid);',
      'assertStaffImportLease((awaittx.get(lock.ref)).data(),companyId,lock.token);',
      'constcommitted=awaitdb.runTransaction(asynctx=>{',
      'current?.companyId===item.data.companyId&&current?.staffId===item.data.staffId',
      'awaitdb.runTransaction(async(tx)=>{constnow=Timestamp.now();constleaseUntil=Timestamp.fromMillis(now.toMillis()+10*60*1000);',
    ] : [
      'awaitwriteJobsAndLocks(allJobs,staffIndex.byName,runRef?.id??"",lock)',
      'const[leaseSnap]=awaittx.getAll(lock.ref);', 'lease.token!==lock.token',
      'lease.companyId!==chunk[0]?.companyId', '!(lease.leaseUntilinstanceofTimestamp)',
      'lease.leaseUntil.toMillis()<=Timestamp.now().toMillis()',
    ];
    return requirements.every(value => whole.includes(value));
  }
  if (!has(['QueueActionSchema.parse(request.data??{})', 'awaitdb.runTransaction(async(tx)=>{',
    'constsnap=awaittx.get(ref);', '!snap.exists||snap.data()?.companyId!==companyId', 'tx.update(ref,{',
    'tx.set(auditRef,{companyId,actorUid:session.uid,'])) return false;
  if (name === "retrySheetWriteIssue") return has([
    'awaitassertProductionOperational(companyId);', 'if(!canManuallyRetrySheetWrite({',
    'writeVerificationRequired:data.writeVerificationRequired', 'status:"pending",attempts:0,',
    'manualRetryBy:session.uid', 'action:"sheet.issue.retry"',
  ]);
  return has([
    'if(data.status==="acknowledged")', 'data.acknowledgedBy===session.uid&&data.acknowledgedNote===input.note',
    'if(!["blocked","dead_letter","retry_wait","error","paused_global"].includes(String(data.status??"")))',
    'status:"acknowledged",acknowledgedFromStatus:data.status,acknowledgedBy:session.uid',
    'action:"sheet.issue.acknowledge"', 'return{acknowledged:true,sourceWriteVerified:false};',
  ]);
}

function checkAdminCore(name) {
  const modules = { getSheetWriteIssues: "admin-operations", getOperationsDashboard: "analytics", getStaffPerformance: "analytics", createAdminJobGroup: "job-management", updateJobPublication: "job-management", adminEditJobInputs: "job-management", generateJobExport: "job-management", updateNetPrintNumbers: "netprint", adminSetJobCancellation: "analytics", adminRestoreCancelledJob: "analytics" };
  const source = sourceFile("functions/src/" + modules[name] + ".ts");
  const start = source.indexOf("export const " + name + " =");
  const marker = name === "generateJobExport" ? "\n);" : "\n});";
  const end = source.indexOf(marker, start);
  if (start < 0 || end < start) return false;
  const compact = text => text.replace(/\s+/g, "");
  const block = compact(source.slice(start, end + marker.length));
  const has = values => values.every(value => block.includes(value));
  if (!/import \{[^}]*\bcompanyFromClaims\b[^}]*\brequireAdmin\b[^}]*\} from "\.\/utils";/.test(source)
      || !has(["constsession=requireAdmin(request);", "constcompanyId=companyFromClaims(session.token);"])
      || /(?:input|request\.data)\.(?:companyId|actorUid|uid)/.test(block)) return false;
  const readOnly = ["getSheetWriteIssues", "getOperationsDashboard", "getStaffPerformance"].includes(name);
  if (readOnly && /\.(?:add|create|update|delete|set|commit)\(/.test(block)) return false;
  if (!readOnly && (!has(["awaitassertProductionOperational(companyId);"]) || !source.includes('from "./system-safety";'))) return false;
  const requirements = {
    getSheetWriteIssues: [
      'IssueQuerySchema.parse(request.data??{})', 'db.collection("sheetSyncQueue").where("companyId","==",companyId)',
      '.where("status","in",["blocked","dead_letter","retry_wait","acknowledged","error","paused_global"])',
      '.orderBy("updatedAt","desc").limit(input.limit)', 'job?.companyId===companyId?',
      'canRetry:canManuallyRetrySheetWrite({', 'sourceWriteVerified:false',
    ],
    getOperationsDashboard: [
      'MonthSchema.parse(request.data??{})', 'db.collection("jobs").where("companyId","==",companyId)',
      '.where("dateKey",">=",from).where("dateKey","<",through).limit(15001)',
      'if(snapshot.size>15000)thrownewHttpsError("resource-exhausted",', 'returnbuildMonthlyDashboard(jobs,input.month,tokyoToday());',
    ],
    getStaffPerformance: [
      'StaffPerformanceSchema.parse(request.data??{})', 'if(input.from>input.through)',
      'if(!profile.exists||profile.data()?.companyId!==companyId)',
      'db.collection("jobs").where("companyId","==",companyId).where("assignedStaffId","==",input.staffId)',
      '.where("dateKey",">=",input.from).where("dateKey","<=",input.through).limit(10001)',
      'if(snapshot.size>10000)thrownewHttpsError("resource-exhausted",',
    ],
    createAdminJobGroup: [
      'CreateSchema.parse(request.data??{})', 'normalizeJobInput(parsed)', 'if(normalized.errors.length)',
      'constrowCreationConfigured=awaitnativeJobSourceEnabled(companyId);', 'constsourceReady=false;',
      'constpublication=resolvePublication({', 'constbatch=db.batch();',
      'batch.set(jobRef,{companyId,', 'source:{type:"admin_created",createdBy:session.uid}',
      'batch.set(db.collection("jobGroups").doc(groupId),{companyId,jobIds,',
      'if(rowQueueRef){batch.set(rowQueueRef,{companyId,groupId,jobIds,', 'awaitbatch.commit();',
      'awaitwriteAudit(companyId,session.uid,"job.group.create",',
    ],
    updateJobPublication: [
      'PublicationSchema.parse(request.data??{})', 'awaitdb.runTransaction(async(tx)=>{', 'constsnapshots=awaittx.getAll(...refs);',
      'if(!snap.exists||snap.data()?.companyId!==companyId)continue;', 'if(job.cancelled===true||job.status==="cancelled")',
      'if(job.assignedStaffId){blocked.push(snap.id);continue;}', 'status:job.assignedStaffId?"assigned":"stopped",',
      'constpublication=resolvePublication({', 'tx.set(snap.ref,', 'revision:FieldValue.increment(1)',
      'return{updated,blocked};', 'awaitwriteAudit(companyId,session.uid,"job.publication.update",',
    ],
    adminEditJobInputs: [
      'EditSchema.parse(request.data??{})', 'awaitdb.runTransaction(async(tx)=>{',
      'if(!jobSnap.exists||jobSnap.data()?.companyId!==companyId)',
      'previousQueue.companyId!==companyId||previousQueue.jobId!==input.jobId||previousQueue.errorType==="verification_required"',
      'if(input.revision!==undefined&&input.revision!==currentRevision)',
      '!staffSnap.exists||staffSnap.data()?.companyId!==companyId||staffSnap.data()?.active!==true',
      '!targetLock||targetLock.companyId!==companyId||targetLock.staffId!==staffRef.id||targetLock.dateKey!==lockDateKey',
      'if(targetLock.active&&targetLock.jobId!==input.jobId)',
      'constownsOldLock=oldLock?.active===true&&oldLock.jobId===input.jobId&&oldLock.companyId===companyId&&oldLock.staffId===oldStaffId&&oldLock.dateKey===lockDateKey;',
      'if(oldLockRef&&ownsOldLock)', 'assignmentPreparationPatch(job,nextJob)',
      'prepareAdminEditIntent({jobId:input.jobId,previous:job,next:nextJob,requested:sheetUpdates,',
      'if(writeEnabled)tx.set(queueRef,{companyId,jobId:input.jobId,operation:"job.admin_edit",',
      'updates:intent.updates,expected:intent.expected,', 'tx.set(jobRef,update,{merge:true});',
    ],
    generateJobExport: [
      'ExportSchema.parse(request.data??{})', 'if(input.through<input.from)',
      'db.collection("jobs").where("companyId","==",companyId)',
      '.where("dateKey",">=",input.from).where("dateKey","<=",input.through).orderBy("dateKey","asc").limit(5001)',
      'if(snap.size>5000)thrownewHttpsError("resource-exhausted",', 'constcsv=buildJobCsv(rows);',
      'awaitdb.collection("exportLogs").add({companyId,actorUid:session.uid,',
    ],
    updateNetPrintNumbers: [
      'UpdateSchema.parse(request.data??{})', 'awaitdb.runTransaction(async(tx)=>{', 'if(job.companyId!==companyId)',
      'constidentity=netPrintWriteIdentity(job);', 'if(previous?.syncPending===true)', 'if(previous.writeIdentity!==identity)throw',
      'expected=baselineastypeofexpected;', 'old.printedContext===identity&&old.printedByStaffId===job.assignedStaffId&&old.printedForDate===job.dateKey',
      'tx.update(jobRef,{netPrint:{items,updatedAt:now,changedCount,writeOperationId:queueRef.id,writeIdentity:identity,syncPending:true,writeStyles:styles,writeExpected:expected}',
      'tx.create(queueRef,{companyId,jobId:input.jobId,operation:"netprint.update",',
      'if(notifyStaffId&&changedCount>0&&job.cancelled!==true&&job.status!=="cancelled")',
    ],
    adminSetJobCancellation: [
      'CancellationSchema.parse(request.data??{})', 'awaitdb.runTransaction(async(tx)=>{',
      'if(!jobSnap.exists||jobSnap.data()?.companyId!==companyId)',
      'constownsActiveLock=lock?.active===true&&lock.jobId===input.jobId&&lock.companyId===companyId&&lock.staffId===job.assignedStaffId&&lock.dateKey===job.dateKey;',
      'job.cancellationFinancialTreatment===treatment&&!ownsActiveLock)return;', 'if(lockRef&&ownsActiveLock)',
      'cancellationSheetWrite:{queueId:queueRef.id,operation:"job.cancel.v2",identity:cancellationSheetWriteIdentity(job)}',
      'tx.set(queueRef,{companyId,jobId:input.jobId,operation:"job.cancel.v2",', 'actorUid:session.uid,',
    ],
    adminRestoreCancelledJob: [
      'RestoreSchema.parse(request.data??{})', 'awaitdb.runTransaction(async(tx)=>{',
      'if(!jobSnap.exists||jobSnap.data()?.companyId!==companyId)', 'if(job.cancelled!==true&&job.status!=="cancelled")',
      'if(!staffSnap.exists||staffSnap.data()?.companyId!==companyId)throw',
      'currentLock?.companyId!==companyId||currentLock.staffId!==assignedStaffId||currentLock.dateKey!==dateKey',
      'lockSnap.data()?.active===true&&lockSnap.data()?.jobId!==input.jobId',
      'tx.set(lockRef,{companyId,staffId:assignedStaffId,dateKey,jobId:input.jobId,active:true,',
      'cancellationSheetWrite:{queueId:queueRef.id,operation:"job.restore",identity:cancellationSheetWriteIdentity(job)}',
      'tx.set(queueRef,{companyId,jobId:input.jobId,operation:"job.restore",', 'actorUid:session.uid,',
    ],
  };
  if (!has(requirements[name])) return false;
  if (name === "updateJobPublication" && ((block.match(/if\(job\.assignedStaffId\)\{/g) ?? []).length !== 2 || (block.match(/tx\.set\(/g) ?? []).length !== 3 || /(?:batch|snap\.ref)\.(?:set|update|delete)\(/.test(block))) return false;
  const whole = compact(source);
  if (name === "generateJobExport" && !whole.includes('constExportSchema=z.object({from:z.iso.date(),through:z.iso.date(),')) return false;
  if (name === "createAdminJobGroup" && !['feature.data()?.adminJobCreationSourceReady===true', 'mapping.data()?.enabled===true', 'mapping.data()?.rowCreation?.enabled===true'].every(part => whole.includes(part))) return false;
  return true;
}

function checkStaffJourney(name) {
  const modules = {applyToJob:"jobs",getMyTasks:"staff-tasks",listMyMailApplications:"automation-intake",setSalesFloorClientSubmitted:"submission-status",submitPreContact:"precontact"};
  const source = sourceFile("functions/src/" + modules[name] + ".ts");
  const start = source.indexOf("export const " + name + " =");
  const end = source.indexOf("\n});", start);
  if (start < 0 || end < start) return false;
  const compact = text => text.replace(/\s+/g, "");
  const block = compact(source.slice(start, end + 4));
  const has = values => values.every(value => block.includes(value));
  if (!/import \{[^}]*\bcompanyFromClaims\b[^}]*\brequireAuth\b[^}]*\bstaffFromClaims\b[^}]*\} from "\.\/utils";/.test(source)
      || !has(["requireAuth(request)", "companyFromClaims(session.token)", "staffFromClaims(session.token)"])
      || /(?:input|request\.data)\.(?:companyId|uid|staffId|actorUid)/.test(block)) return false;
  const readOnly = ["getMyTasks", "listMyMailApplications"].includes(name);
  if (readOnly && (/\.(?:add|create|update|delete|commit)\(/.test(block)
      || (block.match(/\.set\(/g)??[]).length !== (block.match(/(?:jobMap|cache)\.set\(/g)??[]).length)) return false;
  if (!readOnly && (!has(["awaitassertProductionOperational(companyId);", "awaitdb.runTransaction(async(tx)=>{"])
      || !source.includes('import { assertProductionOperational } from "./system-safety";'))) return false;
  if (name === "getMyTasks") return has([
    'db.collection("jobs").where("companyId","==",companyId).where("assignedStaffId","==",staffId)',
    '.where("dateKey",">=",from).where("dateKey","<=",through).limit(2000).get()',
    'db.collection("resubmissionRequests").where("companyId","==",companyId).where("staffId","==",staffId).where("status","==","open").limit(100).get()',
    'snapshot.exists&&data?.companyId===companyId&&data?.assignedStaffId===staffId',
    'returnjob?.status==="assigned"&&job.cancelled!==true;',
    'deriveStaffTasks({jobs,resubmissions,nowMs:Date.now()})',
  ]);
  if (name === "applyToJob" || name === "listMyMailApplications") {
    const intake = compact(sourceFile("functions/src/automation-intake.ts"));
    const helper = intake.slice(intake.indexOf("exportasyncfunctionreadMailApplicationForAssignment("), intake.indexOf("constListApplicationsSchema="));
    if (![
      'parsed.data.companyId!==input.companyId||parsed.data.staffId!==input.staffId||parsed.data.jobId!==input.jobId',
      'if(candidate.revision!==input.revision)',
      'requireRecord((awaittx.get(db.collection("automationApplicationReceipts").doc(candidate.receiptKey))).data(),input.companyId)',
      'receiptKey(incoming)!==candidate.receiptKey||savedReceipt.applicationId!==input.applicationId',
      'currentSender.data.companyId!==input.companyId||currentSender.data.uid!==savedReceipt.receivedBy',
      'currentSender.data.producerId!==savedReceipt.producerId||currentSender.data.revision!==savedReceipt.principalRevision',
      'context.policy.phase!=="app"||context.result.route!=="review"',
      'context.result.applicationKey!==input.applicationId||context.person?.staffId!==input.staffId',
      'context.person.revision!==candidate.personRevision||context.selected.workDate!==candidate.workDate',
    ].every(x=>helper.includes(x))) return false;
  }
  if (name === "listMyMailApplications") return has([
    'if(session.token.role!=="staff")throw',
    'ListApplicationsSchema.parse(request.data??{})',
    'db.collection("automationApplications").where("companyId","==",companyId).where("staffId","==",staffId).where("status","==","review").orderBy(FieldPath.documentId()).limit(26)',
    'if(input.cursor)query=query.startAfter(input.cursor);',
    'returndb.runTransaction(asynctx=>{',
    'if(staff?.companyId!==companyId||staff.active!==true)throw',
    'if(!policySnap.exists)return{ok:true,mode:"not_configured",items:[],nextCursor:null};',
    'RecruitmentRoutingSchema.parse(requireRecord(policySnap.data(),companyId))',
    'if(policy.phase!=="app")return{ok:true,mode:"legacy_mail",items:[],nextCursor:null};',
    'if(candidate.companyId!==companyId||candidate.staffId!==staffId)throw',
    'if(jobData&&jobData.companyId!==companyId)throw',
    'awaitreadMailApplicationForAssignment(reader,{companyId,staffId,jobId:candidate.jobId,applicationId:doc.id,revision:candidate.revision})',
    'constrecords=page.docs.slice(0,25);',
  ]);
  if (name === "applyToJob") return source.includes('import { readMailApplicationForAssignment } from "./automation-intake";') && has([
    'if(session.token.role!=="staff")', 'ApplySchema.parse(request.data)',
    'constidempotencySnap=awaittx.get(idempotencyRef);',
    'previous?.uid!==session.uid||previous?.companyId!==companyId',
    'if(previous.staffId!==staffId)',
    '(previous.mailApplicationId??null)!==(input.mailApplicationId??null)',
    'response?.ok!==true||response.jobId!==input.jobId',
    'if(job.companyId!==companyId||staff.companyId!==companyId)',
    'if(staff.active!==true)', 'if(job.status!=="open"||job.assignedStaffId)',
    'if(job.recruitmentStopped===true||job.cancelled===true)',
    'job.sourceMissing===true||job.assignmentUnresolved===true||job.applicationUnconfirmed===true||job.publishable!==true',
    'constlockSnap=awaittx.get(lockRef);', 'if(lockSnap.exists&&lockSnap.data()?.active===true)',
    'awaitreadMailApplicationForAssignment(tx,{companyId,staffId,jobId:input.jobId,applicationId:input.mailApplicationId,revision:input.mailApplicationRevision!,})',
    'tx.update(jobRef,{status:"assigned",assignedStaffId:staffId,assignedStaffName:displayName,assignedUid:session.uid,',
    'tx.set(lockRef,{companyId,staffId,dateKey:workDate,jobId:input.jobId,active:true,',
    'tx.set(queueRef,{companyId,jobId:input.jobId,operation:"job.assign",',
    'actorUid:session.uid,actorStaffId:staffId,',
    'tx.set(idempotencyRef,{mailApplicationId:input.mailApplicationId??null,uid:session.uid,companyId,staffId,result:response,',
  ]);
  if (!has([
    'if(job.companyId!==companyId||job.assignedStaffId!==staffId)',
    'job.cancelled===true||job.status==="cancelled"', 'if(job.status!=="assigned")throw',
    'tx.update(jobRef,',
  ])) return false;
  if (name === "setSalesFloorClientSubmitted") return has([
    'ClientSubmittedSchema.parse(request.data??{})', 'constsnap=awaittx.get(jobRef);',
    'constlipKnotsSubmitted=current?.lipKnotsSubmitted===true;',
    'if(current?.clientSubmitted===input.submitted&&current.completed===(input.submitted||lipKnotsSubmitted))return;',
    '"submissionStatus.salesFloor.completed":input.submitted||lipKnotsSubmitted,',
    'tx.set(db.collection("sheetSyncQueue").doc(),{companyId,jobId:input.jobId,operation:"submission.sales_floor",',
    'actorUid:session.uid,actorStaffId:staffId,',
  ]);
  return has([
    'Schema.parse(request.data)', 'constjobSnap=awaittx.get(jobRef);',
    'if(!workDate.success||(input.dateKey!==undefined&&input.dateKey!==workDate.data))throw',
    'if(job.sourceMissing===true)throw', 'if(job.applicationUnconfirmed===true)throw', 'if(job.assignmentUnresolved===true)throw',
    'awaitreadAutomationJobContext(tx,companyId,input.jobId,job)',
    'previous?.source==="app"&&previous.staffId===staffId&&previous.dateKey===job.dateKey',
    'if(!context?.binding.assignment||matchesAutomationPreContactProof(context,previous,previous?.automationProof))return;',
    'preContact:{...nextContact,automationProof:makeAutomationPreContactProof(context,nextContact,now)}',
    'tx.set(queueRef,{companyId,jobId:input.jobId,operation:"precontact.submit",',
    'actorUid:session.uid,actorStaffId:staffId,',
  ]) && source.includes('from "./automation-precontact-proof";');
}

function checkBusinessRecovery(name) {
  const file = name === "markNetPrintPrinted" ? "netprint" : name === "adminCancelJob" ? "jobs" : name === "duplicateAdminJob" ? "job-management" : "admin-operations";
  const source = sourceFile('functions/src/' + file + '.ts');
  const compact = text => text.replace(/\s+/g, '');
  const block = compact(functionBlock(source, name));
  const has = conditions => conditions.every(condition => block.includes(condition));
  const staff = name === "markNetPrintPrinted";
  const readOnly = ["getExpenseReview", "getJobSheetLink"].includes(name);
  const requiredAuth = staff ? 'requireAuth' : 'requireAdmin';
  if (!new RegExp('import \\{[^}]*\\b' + requiredAuth + '\\b[^}]*\\} from "\\./utils";').test(source)
      || !has([requiredAuth + '(request)', 'companyFromClaims(session.token)'])
      || /(?:input|request\.data)\.(?:companyId|uid|actorUid|staffId)/.test(block)) return false;
  if (readOnly && /\.(?:add|create|delete|set|update|commit)\(/.test(block)) return false;
  if (!readOnly && (!has(['awaitassertProductionOperational(companyId);'])
      || !/import \{[^}]*\bassertProductionOperational\b[^}]*\} from "\.\/system-safety";/.test(source))) return false;
  if (["saveExpenseReviewDraft", "completeExpenseReview", "getJobSheetLink", "duplicateAdminJob"].includes(name)) {
    const helper = compact(source.slice(source.indexOf('async function requireCompanyJob('), source.indexOf('\nfunction ', source.indexOf('async function requireCompanyJob('))));
    if (!helper.includes('if(!snap.exists||snap.data()?.companyId!==companyId)')
        || !has(['awaitrequireCompanyJob(companyId,input.' + (name === 'duplicateAdminJob' ? 'sourceJobId' : 'jobId') + ')'])) return false;
  }
  if (name === 'getJobSheetLink') return has(['JobSchema.parse(request.data??{})', 'return{url:buildSheetUrl(job)}']);
  if (name === 'getExpenseReview') return has([
    'JobSchema.parse(request.data??{})', 'if(!job.exists||job.data()?.companyId!==companyId)',
    'if(draft.exists&&(draft.data()?.companyId!==companyId||draft.data()?.jobId!==input.jobId))',
    'reviewVersion:expenseReviewVersion(companyId,input.jobId,job,draft)',
  ]);
  if (name === 'saveExpenseReviewDraft' || name === 'completeExpenseReview') {
    const helper = compact(source.slice(source.indexOf('function assertExpenseWriteContext('), source.indexOf('async function requireCompanyJob(')));
    if (!['if(!currentJob.exists||job?.companyId!==companyId)',
      'if(expenseWriteContext(job)!==expenseWriteContext(expectedJob))',
      'if(review.exists&&(review.data()?.companyId!==companyId||review.data()?.jobId!==jobId))'].every(x=>helper.includes(x))) return false;
    const review = name === 'saveExpenseReviewDraft' ? 'currentReview' : 'existingReview';
    if (!has(['awaitdb.runTransaction(async(tx)=>{', 'tx.get(db.collection("jobs").doc(input.jobId))',
      'assertExpenseWriteContext(companyId,input.jobId,job,currentJob,' + review + ');',
      'assertExpenseReviewVersion(input.expectedVersion,companyId,input.jobId,currentJob,' + review + ');',
      'normalizeExpenseInput(input.values)', 'if(parsed.errors.length)'])) return false;
    if (name === 'saveExpenseReviewDraft') return has(['DraftSchema.parse(request.data??{})', 'tx.get(ref)', 'tx.set(ref,{companyId,jobId:input.jobId,', 'updatedBy:session.uid']);
    return has(['CompleteSchema.parse(request.data??{})', 'tx.get(reviewRef)',
      'if(!Number.isSafeInteger(previousRevision)||previousRevision<0||previousRevision>=Number.MAX_SAFE_INTEGER)',
      'tx.set(queueRef,{companyId,jobId:input.jobId,operation:"expense.review",',
      'actorUid:session.uid', 'tx.set(reviewRef,{companyId,jobId:input.jobId,', 'completedBy:session.uid',
      'constrevision=previousRevision+1;', 'idempotencyKey:' + String.fromCharCode(96) + 'expense.review:']);
  }
  if (name === 'markNetPrintPrinted') return has([
    'staffFromClaims(session.token)', 'PrintSchema.parse(request.data??{})',
    'awaitdb.runTransaction(async(tx)=>{', 'constsnap=awaittx.get(jobRef);',
    'if(job.companyId!==companyId||job.assignedStaffId!==staffId)throw',
    'if(job.cancelled===true||job.status==="cancelled")throw', 'if(job.status!=="assigned")throw',
    'if(job.sourceMissing===true||job.assignmentUnresolved===true||job.applicationUnconfirmed===true)throw',
    'if(!day.success||(input.dateKey!==undefined&&input.dateKey!==day.data))throw',
    'if(targets.length>1)throw', 'if(!target)throw',
    'target.printedContext===identity&&target.printedByStaffId===staffId&&target.printedForDate===day.data',
    'tx.update(jobRef,', 'tx.create(queueRef,{companyId,jobId:input.jobId,operation:"netprint.printed",',
    'actorUid:session.uid,actorStaffId:staffId',
  ]);
  if (name === 'adminCancelJob') return has([
    'CancelSchema.parse(request.data)', 'awaitdb.runTransaction(async(tx)=>{', 'constjobSnap=awaittx.get(jobRef);',
    'if(job.companyId!==companyId)', 'lockRef?awaittx.get(lockRef):null',
    'lock.jobId===input.jobId&&lock.companyId===companyId&&lock.staffId===job.assignedStaffId&&lock.dateKey===job.dateKey',
    'if(job.cancelled===true&&job.status==="cancelled"&&job.cancellationReason===input.reason&&!ownsActiveLock)return;',
    'if(lockRef&&ownsActiveLock){tx.set(lockRef,', 'tx.update(jobRef,',
    'tx.set(queueRef,{companyId,jobId:input.jobId,operation:"job.cancel",', 'actorUid:session.uid',
    'tx.set(db.collection("notificationQueue").doc(),queueDocumentData({companyId,targetStaffId:job.assignedStaffId,',
  ]);
  const native = compact(source.slice(source.indexOf('async function nativeJobSourceEnabled('), source.indexOf('async function requireCompanyJob(')));
  return ['feature.data()?.adminJobCreationSourceReady===true', 'mapping.data()?.enabled===true', 'mapping.data()?.rowCreation?.enabled===true'].every(x=>native.includes(x))
    && has(['DuplicateSchema.parse(request.data??{})', 'normalizeJobInput(createData)', 'if(normalized.errors.length)',
      'awaitnativeJobSourceEnabled(companyId)', 'constsourceReady=false;', 'constbatch=db.batch();',
      'batch.set(ref,{...copyableJobFields(source),companyId,', 'createdBy:session.uid',
      'if(rowQueueRef){batch.set(rowQueueRef,{companyId,', 'awaitbatch.commit();',
      'awaitwriteAudit(companyId,session.uid,"job.group.duplicate",']);
}

function checkResubmission(name) {
  const source = sourceFile("functions/src/resubmissions.ts");
  const compact = text => text.replace(/\s+/g, "");
  const block = compact(functionBlock(source, name).split("\nexport async function")[0]);
  const includes = conditions => conditions.every(condition => block.includes(condition));
  const staff = name === "getMyResubmissionRequests";
  if (!/import \{[^}]*companyFromClaims[^}]*requireAdmin[^}]*requireAuth[^}]*staffFromClaims[^}]*\} from "\.\/utils";/.test(source)
      || !includes([staff ? "requireAuth(request)" : "requireAdmin(request)", "companyFromClaims(session.token)"])
      || /(?:input|request\.data)\.(?:companyId|staffId|uid|actorUid)/.test(block)) return false;
  if (name === "getMyResubmissionRequests" || name === "getAdminResubmissionRequests") {
    return includes(['db.collection("resubmissionRequests").where("companyId","==",companyId)',
      '.where("status","in",["open","submitted"])', staff ? ".limit(100).get()" : ".limit(200).get()"])
      && (!staff || includes(["staffFromClaims(session.token)", '.where("staffId","==",staffId)']))
      && !/\.(?:add|create|delete|set|update)\(/.test(block);
  }
  if (!includes(["awaitassertProductionOperational(companyId);", "awaitdb.runTransaction(asynctx=>{"])
      || !/import \{ assertProductionOperational \} from "\.\/system-safety";/.test(source)
      || !/import \{[^}]*assertSubmissionFileIdentity[^}]*assertSubmissionCounters[^}]*assertReplacementRequest[^}]*\} from "\.\/submission-integrity";/.test(source)) return false;
  if (name === "createResubmissionRequest") {
    return includes([
      "CreateSchema.parse(request.data??{})",
      'if(!job.exists||job.data()?.companyId!==companyId)throw',
      "constcurrent=awaittx.get(jobRef);",
      'if(!current.exists||current.data()?.companyId!==companyId)throw',
      'if(String(current.data()?.assignedStaffId??"")!==staffId)throw',
      'if(current.data()?.cancelled===true||current.data()?.status==="cancelled")throw',
      'if(current.data()?.status!=="assigned")throw',
      'if(!source||source.companyId!==companyId||source.jobId!==input.jobId||source.type!==input.type)throw',
      "assertSubmissionFileIdentity(source,file.data(),input.sourceSubmissionId);",
      'if(file.data()?.status!=="completed")throw',
      "tx.create(ref,{companyId,staffId,jobId:input.jobId,",
      "createdBy:session.uid,",
      "tx.create(notificationRef,{...queueDocumentData(notification),",
    ]);
  }
  const helperStart = source.indexOf("function assertCompletedReplacement(");
  const helper = compact(source.slice(helperStart, source.indexOf("\nexport async function", helperStart)));
  const integrity = compact(sourceFile("functions/src/submission-integrity.ts"));
  return includes([
    "CompleteSchema.parse(request.data??{})",
    'constref=db.collection("resubmissionRequests").doc(input.requestId);',
    "constsnap=awaittx.get(ref);constdata=snap.data();",
    "if(!data||data.companyId!==companyId)throw",
    'if(!["submitted","completed"].includes(String(data.status))||!data.replacementSubmissionId)throw',
    "if(submission.data()?.resubmissionRequestId!==input.requestId)throw",
    "assertCompletedReplacement(data,submission.data(),String(data.replacementSubmissionId));",
    'if(data.status==="completed")return;',
    'tx.update(ref,{status:"completed",completedBy:session.uid,',
  ]) && [
    "assertReplacementRequest(request,submission,submissionId);",
    "assertSubmissionCounters(submission);",
    'if(submission.status!=="completed"||submission.completedFiles!==submission.totalFiles||submission.jobStatusApplied!==true)throw',
  ].every(condition => helper.includes(condition))
    && integrity.includes('["companyId","jobId","staffId","type"].some(key=>request[key]!==submission[key])')
    && integrity.includes("request.replacementSubmissionId!==submissionId")
    && integrity.includes("!Number.isInteger(total)")
    && integrity.includes("!Number.isInteger(completed)")
    && integrity.includes("Number(completed)>Number(total)");
}
function checkConfirmApplication() {
  const source = sourceFile("functions/src/admin-operations.ts");
  const block = functionBlock(source, "confirmApplication");
  const checks = {
    adminImport: /import \{[^}]*\brequireAdmin\b[^}]*\bcompanyFromClaims\b[^}]*\} from "\.\/utils";/.test(source)
      || /import \{[^}]*\bcompanyFromClaims\b[^}]*\brequireAdmin\b[^}]*\} from "\.\/utils";/.test(source),
    admin: /const session = requireAdmin\(request\);/.test(block),
    claimsCompany: /const companyId = companyFromClaims\(session\.token\);/.test(block),
    operational: /await assertProductionOperational\(companyId\);/.test(block)
      && /import \{ assertProductionOperational \} from "\.\/system-safety";/.test(source),
    validatedInput: /const input = JobSchema\.parse\(request\.data \?\? \{\}\);/.test(block),
    jobReference: /const ref = db\.collection\("jobs"\)\.doc\(input\.jobId\);/.test(block),
    initialCompany: /if \(!job\.exists \|\| job\.data\(\)\?\.companyId !== companyId\)/.test(block),
    transaction: /await db\.runTransaction\(async \(tx\) =>/.test(block),
    transactionRead: /const current = await tx\.get\(ref\);/.test(block),
    transactionCompany: /if \(!current\.exists \|\| current\.data\(\)\?\.companyId !== companyId\)/.test(block),
    assignmentStable: /data\.status !== "assigned" \|\| \(data\.assignedStaffId \?\? null\) !== \(job\.data\(\)\?\.assignedStaffId \?\? null\)/.test(block),
    idempotent: /if \(data\.applicationAdminConfirmed === true\) return;/.test(block),
    confirmedByActor: /tx\.update\(ref, \{\s*applicationAdminConfirmed: true,\s*applicationAdminConfirmedBy: session\.uid,/.test(block),
    audit: /const auditRef = db\.collection\("auditLogs"\)\.doc\(\);/.test(block)
      && /tx\.set\(auditRef, \{\s*companyId, actorUid: session\.uid, action: "application\.confirm",/.test(block),
    noClientIdentity: !/input\.(?:companyId|uid|actorUid|assignedStaffId)/.test(block),
  };
  return Object.values(checks).every(Boolean);
}
function checkBootstrapSession() {
  const source = sourceFile("functions/src/auth.ts");
  const bootstrap = functionBlock(source, "bootstrapSession");
  const checks = {
    authenticated: /requireAuth\s*\(\s*request\s*\)/.test(bootstrap),
    verifiedEmail: /user\.emailVerified/.test(bootstrap),
    adminAllowlist: /admins\.includes\s*\(\s*email\s*\)/.test(bootstrap),
    refreshRequiresAdmin:
      /if\s*\(\s*input\.refreshDirectory\s*\)[\s\S]*?requireAdmin\s*\(\s*request\s*\)/.test(bootstrap),
    refreshCompanyScope:
      /companyFromClaims\s*\(\s*session\.token\s*\)/.test(bootstrap)
      && /fetchAdminDirectory\s*\(\s*companyId\s*\)/.test(bootstrap),
    initialCompanyScope:
      /companyId\s*:\s*defaultCompanyId\.value\s*\(\s*\)/.test(bootstrap)
      && /fetchAdminDirectory\s*\(\s*claims\.companyId\s*\)/.test(bootstrap),
    directoryCompanyQueries:
      /async function fetchAdminDirectory\s*\(\s*companyId\s*:\s*string\s*\)/.test(source)
      && (source.match(/\.where\s*\(\s*"companyId"\s*,\s*"=="\s*,\s*companyId\s*\)/g) ?? []).length === 2,
    noClientCompanyScope: !/input\.companyId/.test(bootstrap),
  };
  return Object.values(checks).every(Boolean);
}

function checkRequestStaffLoginLink() {
  const source = sourceFile("functions/src/login-links.ts");
  const block = functionBlock(source, "requestStaffLoginLink");
  const rateLimitStart = source.indexOf("async function enforceLoginRateLimit");
  const rateLimit = rateLimitStart < 0 ? "" : source.slice(rateLimitStart);
  const checks = {
    strictEmailInput:
      /RequestLoginSchema\.safeParse\s*\(\s*request\.data\s*\?\?\s*\{\}\s*\)/.test(block)
      && /z\.string\(\)\.email\(\)\.max\(254\)/.test(source),
    normalizedEmail: /normalizeEmail\s*\(\s*input\.data\.email\s*\)/.test(block),
    hashedDirectoryLookup:
      /emailIndex/.test(block)
      && /\.doc\s*\(\s*emailHash\s*\(\s*email\s*\)\s*\)/.test(block),
    activeStaffGate:
      /indexSnap\.exists/.test(block)
      && /index\?\.active/.test(block)
      && /profileSnap\.data\(\)\?\.active\s*===\s*true/.test(block),
    operationalGate: /assertProductionOperational\s*\(\s*index\.companyId\s*\)/.test(block),
    rateLimited:
      /enforceLoginRateLimit\s*\(\s*email\s*\)/.test(block)
      && /minuteCount\s*>=\s*1\s*\|\|\s*hourCount\s*>=\s*5/.test(rateLimit)
      && /resource-exhausted/.test(rateLimit),
    enumerationResistantResponse:
      /accepted\s*:\s*true/.test(block)
      && /登録済みのメールアドレスの場合/.test(block),
    mailSecretScoped: /secrets\s*:\s*\[gmailServiceAccountJson\]/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkSubmissionTimeline() {
  const source = sourceFile("functions/src/submission-files.ts");
  const block = functionBlock(source, "getSubmissionTimeline");
  return [
    /requireAuth\s*\(\s*request\s*\)/,
    /companyFromClaims\s*\(\s*session\.token\s*\)/,
    /assertJobAccess\s*\(\s*input\.jobId\s*,\s*companyId/,
  ].every((pattern) => pattern.test(block));
}

function checkSubmissionProcessingStatus() {
  const source = sourceFile("functions/src/submission-files.ts");
  const block = functionBlock(source, "getSubmissionProcessingStatus");
  const checks = {
    requireAuth: /requireAuth\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims/.test(block) && /companyId/.test(block),
    jobAccess: /assertJobAccess/.test(block),
    staffScope: /data\.staffId/.test(block) && /permission-denied/.test(block),
    jobSubmissionMatch: /data\.jobId\s*!==\s*input\.jobId/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkResubmissionComparison() {
  const source = sourceFile("functions/src/submission-files.ts");
  const block = functionBlock(source, "getResubmissionComparison");
  const checks = {
    requireAuth: /requireAuth\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    documentScope: /snap\.data\(\)\?\.companyId\s*!==\s*companyId/.test(block),
    staffScope: /session\.token\.role\s*!==\s*"admin"[\s\S]*data\.staffId\s*!==\s*staffId/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkDriveFilePreview() {
  const source = sourceFile("functions/src/submission-files.ts");
  const handlerStart = source.indexOf("async function handleDriveFilePreview");
  const handler = handlerStart < 0 ? "" : source.slice(handlerStart);
  const block = `${handler}\n${functionBlock(source, "driveFilePreview")}`;
  const checks = {
    tokenShape: /A-Za-z0-9_-\]\{30,120\}/.test(block),
    tokenHash: /sha256\s*\(\s*token\s*\)/.test(block),
    tokenLookup: /filePreviewTokens/.test(block) && /\.doc\s*\(\s*hash\s*\)/.test(block),
    activeAndExpiry:
      /data\.active\s*!==\s*true/.test(block)
      && /expires\.toMillis\(\)\s*<\s*Date\.now\(\)/.test(block),
    invalidTokenRejected: /status\s*\(\s*400\s*\)/.test(block),
  };
  return Object.values(checks).every(Boolean);
}


function checkCreateUploadSession() {
  const source = sourceFile("functions/src/uploads.ts");
  const compact = text => text.replace(/\s+/g, "");
  const block = compact(functionBlock(source, "createUploadSession"));
  const schema = compact(source.slice(source.indexOf("const CreateSchema"), source.indexOf("export const createUploadSession")));
  const includes = items => items.every(item => block.includes(item));
  return checkFinalizeStagedUpload()
    && /import \{[^}]*\bcompanyFromClaims\b[^}]*\brequireAuth\b[^}]*\bstaffFromClaims\b[^}]*\} from "\.\/utils";/.test(source)
    && includes([
      'exportconstcreateUploadSession=onCall(async(request)=>{',
      'constsession=requireAuth(request);', 'CreateSchema.parse(request.data)',
      'constcompanyId=companyFromClaims(session.token);', 'conststaffId=staffFromClaims(session.token);',
      'if(awaitsubmissionTransferPaused(companyId))throw',
      'if((input.purpose==="replacement")!==Boolean(input.resubmissionRequestId))',
      'awaitdb.runTransaction(async(tx)=>{',
      'constjobSnap=awaittx.get(db.collection("jobs").doc(input.jobId));',
      'if(!jobSnap.exists)', 'if(job.companyId!==companyId||job.assignedStaffId!==staffId)',
      'if(job.cancelled===true||job.status==="cancelled")throw', 'if(job.status!=="assigned")throw',
      'awaittx.get(db.collection("resubmissionRequests").doc(input.resubmissionRequestId))',
      'if(resubmission?.companyId!==companyId||resubmission?.staffId!==staffId||resubmission?.jobId!==input.jobId||resubmission?.type!==input.type||resubmission?.status!=="open")',
      'if(resubmission.sourceFileId&&input.files.length!==1)',
      'tx.create(submissionRef,{', 'completedFiles:0,',
      'tx.create(submissionRef.collection("files").doc(record.fileId),{',
      'submissionId:submissionRef.id,type:input.type,', 'storagePath:record.storagePath,',
    ])
    && block.indexOf('if(awaitsubmissionTransferPaused(companyId))') < block.indexOf('db.collection("submissions")')
    && (block.match(/companyId,jobId:input\.jobId,staffId,uid:session\.uid,/g) ?? []).length === 2
    && !/(?:input|request\.data)\.(?:companyId|staffId|uid)/.test(block)
    && schema.includes('size:z.number().int().positive().max(50*1024*1024)')
    && schema.includes('})).min(1).max(20)')
    && schema.includes('value==="application/pdf"||/^image\\/[^\\s/;]+$/.test(value)');
}

function checkFinalizeStagedUpload() {
  const source = sourceFile("functions/src/uploads.ts");
  const block = functionBlock(source, "finalizeStagedUpload");
  const usesTransferControl = /if\s*\(\s*await submissionTransferPaused\(companyId\)\s*\)/.test(block)
    && /import\s*\{[^}]*\bsubmissionTransferPaused\b[^}]*\}\s*from\s*"\.\/submission-transfer-control"/.test(source);
  const control = usesTransferControl ? sourceFile("functions/src/submission-transfer-control.ts").split("\nexport function")[0] : "";
  const scopedOperationalGate = usesTransferControl
    && /export async function submissionTransferPaused\(companyId: string\): Promise<boolean>/.test(control)
    && /const mode = process\.env\.LKC_SUBMISSION_TRANSFER_MODE \?\? "active";/.test(control)
    && (/if \(mode !== "active"\) return true;/.test(control)
      || /const acceptanceOnly = mode === "acceptance"\s*&& process\.env\.APP_ENVIRONMENT === "staging"\s*&& process\.env\.EXPECTED_FIREBASE_PROJECT_ID === "lip-knots-crew-staging"\s*&& companyId === "lkc-transfer-acceptance-20260908";\s*if \(mode !== "active" && !acceptanceOnly\) return true;/.test(control))
    && /return !\(await getProductionOperationalState\(companyId\)\)\.operational;/.test(control)
    && /import \{ getProductionOperationalState \} from "\.\/system-safety";/.test(control);
  const checks = {
    storageEventOnly: /onObjectFinalized\s*\(/.test(block),
    stagingPathOnly: /parts\[0\]\s*!==\s*"staging"/.test(block),
    completeIdentity: /!companyId\s*\|\|\s*!uid\s*\|\|\s*!submissionId\s*\|\|\s*!fileId/.test(block),
    metadataScope: /meta\.uid\s*!==\s*uid\s*\|\|\s*meta\.companyId\s*!==\s*companyId/.test(block),
    operationalGate: /getProductionOperationalState\s*\(\s*companyId\s*\)/.test(block) || scopedOperationalGate,
  };
  return Object.values(checks).every(Boolean);
}

function checkRegisterDeviceSession() {
  const source = sourceFile("functions/src/devices.ts");
  const block = functionBlock(source, "registerDeviceSession");
  const checks = {
    authenticated: /requireAuth\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    staffScope: /staffFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    operationalGate: /assertProductionOperational\s*\(\s*companyId\s*\)/.test(block),
    activeCompanyProfile:
      /profile\.data\(\)\?\.companyId\s*!==\s*companyId/.test(block)
      && /profile\.data\(\)\?\.active\s*!==\s*true/.test(block),
    serverOwnedSessionId:
      /\$\{companyId\}\|\$\{staffId\}\|\$\{session\.uid\}\|\$\{input\.deviceId\}/.test(block),
    serverOwnedIdentity:
      /companyId,/.test(block)
      && /staffId,/.test(block)
      && /uid:\s*session\.uid/.test(block)
      && !/input\.(?:companyId|staffId|uid)/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkHeartbeatDeviceSession() {
  const source = sourceFile("functions/src/devices.ts");
  const block = functionBlock(source, "heartbeatDeviceSession");
  const checks = {
    authenticated: /requireAuth\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    staffScope: /staffFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    operationalGate: /assertProductionOperational\s*\(\s*companyId\s*\)/.test(block),
    exactOwner:
      /snap\.data\(\)\?\.companyId\s*!==\s*companyId/.test(block)
      && /snap\.data\(\)\?\.uid\s*!==\s*session\.uid/.test(block)
      && /snap\.data\(\)\?\.staffId\s*!==\s*staffId/.test(block),
    activeOnly: /snap\.data\(\)\?\.active\s*!==\s*true/.test(block),
    serverTimestampOnly:
      /lastSeenAt:\s*FieldValue\.serverTimestamp\(\)/.test(block)
      && !/input\.(?:companyId|staffId|uid|active)/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkListMyDevices() {
  const source = sourceFile("functions/src/devices.ts");
  const block = functionBlock(source, "listMyDevices");
  const checks = {
    authenticated: /requireAuth\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    staffScope: /staffFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    companyFilter:
      /\.where\s*\(\s*"companyId"\s*,\s*"=="\s*,\s*companyId\s*\)/.test(block),
    staffFilter:
      /\.where\s*\(\s*"staffId"\s*,\s*"=="\s*,\s*staffId\s*\)/.test(block),
    boundedRead: /\.limit\s*\(\s*30\s*\)/.test(block),
    noWrites: !/\.(?:add|create|delete|set|update)\s*\(/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkRevokeMyDevice() {
  const source = sourceFile("functions/src/devices.ts");
  const block = functionBlock(source, "revokeMyDevice");
  const checks = {
    authenticated: /requireAuth\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    staffScope: /staffFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    exactStaffCompany:
      /snap\.data\(\)\?\.companyId\s*!==\s*companyId/.test(block)
      && /snap\.data\(\)\?\.staffId\s*!==\s*staffId/.test(block),
    softRevoke:
      /active:\s*false/.test(block)
      && /revokedBy:\s*session\.uid/.test(block)
      && /revokeReason:\s*"staff\.self"/.test(block),
    noClientIdentity: !/input\.(?:companyId|staffId|uid)/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkRevokeAllMyDevices() {
  const source = sourceFile("functions/src/devices.ts");
  const block = functionBlock(source, "revokeAllMyDevices");
  const helperStart = source.indexOf("async function revokeAllSessions");
  const helper = helperStart < 0 ? "" : source.slice(helperStart);
  const checks = {
    authenticated: /requireAuth\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    staffScope: /staffFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    companyProfile: /profile\.data\(\)\?\.companyId\s*!==\s*companyId/.test(block),
    serverScopedHelper: /revokeAllSessions\s*\(\s*companyId\s*,\s*staffId/.test(block),
    companyFilteredBatch:
      /\.where\s*\(\s*"companyId"\s*,\s*"=="\s*,\s*companyId\s*\)/.test(helper)
      && /\.where\s*\(\s*"staffId"\s*,\s*"=="\s*,\s*staffId\s*\)/.test(helper),
  };
  return Object.values(checks).every(Boolean);
}

function checkGetStaffDevices() {
  const source = sourceFile("functions/src/devices.ts");
  const block = functionBlock(source, "getStaffDevices");
  const checks = {
    adminOnly: /requireAdmin\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    companyProfile: /profile\.data\(\)\?\.companyId\s*!==\s*companyId/.test(block),
    companyFilter: /\.where\s*\(\s*"companyId"\s*,\s*"=="\s*,\s*companyId\s*\)/.test(block),
    staffFilter: /\.where\s*\(\s*"staffId"\s*,\s*"=="\s*,\s*input\.staffId\s*\)/.test(block),
    boundedRead: /\.limit\s*\(\s*30\s*\)/.test(block),
    noWrites: !/\.(?:add|create|delete|set|update)\s*\(/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkAdminRevokeStaffDevices() {
  const source = sourceFile("functions/src/devices.ts");
  const block = functionBlock(source, "adminRevokeStaffDevices");
  const checks = {
    adminOnly: /requireAdmin\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    companyProfile: /profile\.data\(\)\?\.companyId\s*!==\s*companyId/.test(block),
    companyScopedAll: /revokeAllSessions\s*\(\s*companyId\s*,\s*input\.staffId/.test(block),
    companyScopedSingle: /device\.data\(\)\?\.companyId\s*!==\s*companyId/.test(block),
    audited:
      /action:\s*"device\.revoke\.admin"/.test(block)
      && /actorUid:\s*session\.uid/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkRegisterPushToken() {
  const source = sourceFile("functions/src/push-tokens.ts");
  const block = functionBlock(source, "registerPushToken");
  const checks = {
    authenticated: /requireAuth\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    operationalGate: /assertProductionOperational\s*\(\s*companyId\s*\)/.test(block),
    roleGate:
      /role\s*!==\s*"staff"\s*&&\s*role\s*!==\s*"admin"/.test(block)
      && /permission-denied/.test(block),
    activeStaffGate:
      /staffProfiles/.test(block)
      && /profile\.data\(\)\?\.active\s*!==\s*true/.test(block),
    hashedTokenDocument:
      /hashToken\s*\(\s*input\.token\s*\)/.test(block)
      && /collection\(\s*"pushTokens"\s*\)\.doc\(\s*tokenHash\s*\)/.test(block),
    serverOwnedIdentity:
      /companyId,/.test(block)
      && /uid:\s*session\.uid/.test(block)
      && /staffId,/.test(block)
      && !/input\.(?:companyId|uid|staffId|role)/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkUnregisterPushToken() {
  const source = sourceFile("functions/src/push-tokens.ts");
  const block = functionBlock(source, "unregisterPushToken");
  const checks = {
    authenticated: /requireAuth\s*\(\s*request\s*\)/.test(block),
    hashedTokenDocument:
      /hashToken\s*\(\s*input\.token\s*\)/.test(block)
      && /collection\(\s*"pushTokens"\s*\)\.doc\(\s*tokenHash\s*\)/.test(block),
    ownerCheck:
      /snap\.data\(\)\?\.uid\s*!==\s*session\.uid/.test(block)
      && /permission-denied/.test(block),
    softDisable:
      /active:\s*false/.test(block)
      && /removedAt:\s*FieldValue\.serverTimestamp\(\)/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkGetPushStatus() {
  const source = sourceFile("functions/src/push-tokens.ts");
  const block = functionBlock(source, "getPushStatus");
  const checks = {
    authenticated: /requireAuth\s*\(\s*request\s*\)/.test(block),
    uidFilter: /\.where\s*\(\s*"uid"\s*,\s*"=="\s*,\s*session\.uid\s*\)/.test(block),
    activeFilter: /\.where\s*\(\s*"active"\s*,\s*"=="\s*,\s*true\s*\)/.test(block),
    boundedRead: /\.limit\s*\(\s*20\s*\)/.test(block),
    noWrites: !/\.(?:add|create|delete|set|update)\s*\(/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkSendTestPush() {
  const source = sourceFile("functions/src/push-tokens.ts");
  const block = functionBlock(source, "sendTestPush");
  const checks = {
    authenticated: /requireAuth\s*\(\s*request\s*\)/.test(block),
    companyScope: /companyFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    operationalGate: /assertProductionOperational\s*\(\s*companyId\s*\)/.test(block),
    staffTarget:
      /targetStaffId:\s*staffFromClaims\s*\(\s*session\.token\s*\)/.test(block),
    adminTarget: /targetRole:\s*"admin"/.test(block),
    roleGate: /permission-denied/.test(block),
    noClientTarget:
      !/request\.data/.test(block)
      && !/input\.(?:companyId|targetStaffId|targetRole|targetUid)/.test(block),
  };
  return Object.values(checks).every(Boolean);
}

function checkProcessNotificationQueue() {
  const source = sourceFile("functions/src/notifications.ts");
  const block = functionBlock(source, "processNotificationQueue");
  const dispatcherStart = source.indexOf("async function dispatchQueueDocument");
  const dispatcherEnd = source.indexOf("async function bundleQuietNotifications");
  const dispatcher = dispatcherStart < 0
    ? ""
    : source.slice(dispatcherStart, dispatcherEnd < 0 ? source.length : dispatcherEnd);
  const checks = {
    exactEventTrigger: /onDocumentCreated\s*\(\s*"notificationQueue\/\{queueId\}"/.test(block),
    queuedOnly: /data\.status\s*!==\s*"queued"/.test(block),
    dueOnly: /deliverAt\s*>\s*Date\.now\(\)\s*\+\s*5_000/.test(block),
    referenceOnlyDispatch: /dispatchQueueDocument\s*\(\s*snap\.ref\s*\)/.test(block),
    operationalGate: /getProductionOperationalState\s*\(\s*pendingData\.companyId\s*\)/.test(dispatcher),
    leasedTransaction:
      /db\.runTransaction/.test(dispatcher)
      && /current\.status\s*!==\s*"queued"/.test(dispatcher)
      && /status:\s*"sending"/.test(dispatcher),
    scopedActiveTokens:
      /where\(\s*"companyId"\s*,\s*"=="\s*,\s*data\.companyId\s*\)/.test(dispatcher)
      && /where\(\s*"active"\s*,\s*"=="\s*,\s*true\s*\)/.test(dispatcher)
      && /data\.(?:targetStaffId|targetRole|targetUid)/.test(dispatcher),
    boundedMulticast:
      /query\.limit\s*\(\s*1000\s*\)/.test(dispatcher)
      && /sendEachForMulticast/.test(dispatcher),
  };
  return Object.values(checks).every(Boolean);
}

const checkers = {
  previewStaffImport: () => checkImportIssues("previewStaffImport"),
  syncStaffDirectoryReadOnly: () => checkImportIssues("syncStaffDirectoryReadOnly"),
  previewShiftImport: () => checkImportIssues("previewShiftImport"),
  syncShiftSheetsReadOnly: () => checkImportIssues("syncShiftSheetsReadOnly"),
  retrySheetWriteIssue: () => checkImportIssues("retrySheetWriteIssue"),
  acknowledgeSheetWriteIssue: () => checkImportIssues("acknowledgeSheetWriteIssue"),
  getSheetWriteIssues: () => checkAdminCore("getSheetWriteIssues"),
  getOperationsDashboard: () => checkAdminCore("getOperationsDashboard"),
  getStaffPerformance: () => checkAdminCore("getStaffPerformance"),
  createAdminJobGroup: () => checkAdminCore("createAdminJobGroup"),
  updateJobPublication: () => checkAdminCore("updateJobPublication"),
  adminEditJobInputs: () => checkAdminCore("adminEditJobInputs"),
  generateJobExport: () => checkAdminCore("generateJobExport"),
  updateNetPrintNumbers: () => checkAdminCore("updateNetPrintNumbers"),
  adminSetJobCancellation: () => checkAdminCore("adminSetJobCancellation"),
  adminRestoreCancelledJob: () => checkAdminCore("adminRestoreCancelledJob"),
  applyToJob: () => checkStaffJourney("applyToJob"),
  getMyTasks: () => checkStaffJourney("getMyTasks"),
  listMyMailApplications: () => checkStaffJourney("listMyMailApplications"),
  setSalesFloorClientSubmitted: () => checkStaffJourney("setSalesFloorClientSubmitted"),
  submitPreContact: () => checkStaffJourney("submitPreContact"),
  createUploadSession: checkCreateUploadSession,
  getExpenseReview: () => checkBusinessRecovery("getExpenseReview"),
  saveExpenseReviewDraft: () => checkBusinessRecovery("saveExpenseReviewDraft"),
  completeExpenseReview: () => checkBusinessRecovery("completeExpenseReview"),
  getJobSheetLink: () => checkBusinessRecovery("getJobSheetLink"),
  markNetPrintPrinted: () => checkBusinessRecovery("markNetPrintPrinted"),
  adminCancelJob: () => checkBusinessRecovery("adminCancelJob"),
  duplicateAdminJob: () => checkBusinessRecovery("duplicateAdminJob"),
  bootstrapSession: checkBootstrapSession,
  confirmApplication: checkConfirmApplication,
  completeResubmissionRequest: () => checkResubmission("completeResubmissionRequest"),
  getAdminResubmissionRequests: () => checkResubmission("getAdminResubmissionRequests"),
  getMyResubmissionRequests: () => checkResubmission("getMyResubmissionRequests"),
  createResubmissionRequest: () => checkResubmission("createResubmissionRequest"),
  requestStaffLoginLink: checkRequestStaffLoginLink,
  getSubmissionTimeline: checkSubmissionTimeline,
  getSubmissionProcessingStatus: checkSubmissionProcessingStatus,
  getResubmissionComparison: checkResubmissionComparison,
  driveFilePreview: checkDriveFilePreview,
  finalizeStagedUpload: checkFinalizeStagedUpload,
  registerDeviceSession: checkRegisterDeviceSession,
  heartbeatDeviceSession: checkHeartbeatDeviceSession,
  listMyDevices: checkListMyDevices,
  revokeMyDevice: checkRevokeMyDevice,
  revokeAllMyDevices: checkRevokeAllMyDevices,
  getStaffDevices: checkGetStaffDevices,
  adminRevokeStaffDevices: checkAdminRevokeStaffDevices,
  registerPushToken: checkRegisterPushToken,
  unregisterPushToken: checkUnregisterPushToken,
  getPushStatus: checkGetPushStatus,
  sendTestPush: checkSendTestPush,
  processNotificationQueue: checkProcessNotificationQueue,
};

const results = requestedFunctions.map((name) => ({
  name,
  passed: checkers[name](),
}));
const allPass = results.every(({ passed }) => passed);
const loadedSource = [...sourceCache.values()].join("\n");
const appCheckEnforced = /enforceAppCheck\s*:\s*true/.test(loadedSource);

console.log(`SOURCE_REF=${ref}`);
console.log(`SOURCE_GUARD_FUNCTIONS=${requestedFunctions.join(",")}`);
for (const { name, passed } of results) {
  console.log(`APP_LEVEL_AUTH_${name}=${passed ? "PASS" : "FAIL"}`);
}
console.log(`APP_CHECK_ENFORCED=${appCheckEnforced ? "true" : "false"}`);
console.log("APP_CHECK_HANDLING=Firebase Auth, company boundaries, user-owned push tokens, scoped preview tokens, or trusted event identity checks are enforced by function type.");
console.log(`SOURCE_GUARD_STATUS=${allPass ? "PASS" : "FAIL"}`);

if (requirePass && !allPass) process.exitCode = 1;
