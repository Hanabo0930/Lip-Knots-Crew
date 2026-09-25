import { execFileSync } from "node:child_process";
import process from "node:process";
import { assertRetryWorkerSource } from "./validate-staging-sheet-worker.mjs";

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
  "retrySafeSheetWrites",
  "listCaseMailReceipts",
  "getCaseMailReceipt",
  "getCaseMailTargetPreview",
  "confirmCaseMailTarget",
  "holdCaseMailTarget",
  "resolveCaseMailTargetHold",
  "confirmCaseMailReview",
  "loginGateway",
  "submitPilotOutcome",
  "decidePilotExpansion",
  "getPilotReadiness",
  "getPilotExpansionReview",
  "getProductionControlStatus",
  "getProductionSloDashboard",
  "inspectSetupWizard",
  "saveSetupWizardDraft",
  "getLoginInviteCandidates",
  "sendLoginInvites",
  "previewMonthSheetCreation",
  "createMonthSheetSafe",
  "getMonthCreationHistory",
  "previewSheetRowCreation",
  "listSheetWriteReviewRecords",
  "runGasAudit",
  "scanGasUploadSafety",
  "exportGasAuditMarkdown",
  "getAutomationRegistry",
  "saveAutomationRegistry",
  "cancelAutomationRegistryAttempt",
  "listHeldMailApplications",
  "getHeldMailApplication",
  "recheckHeldMailApplication",
  "cancelHeldMailApplicationReview",
  "previewCaseMailCampaignRegistration",
  "registerCaseMailCampaign",
  "cancelCaseMailCampaignRegistration",
  "getCaseMailImportSnapshot",
  "listAutomationNoticeReceipts",
  "getAutomationNoticeHandoff",
  "receiveCaseMailApplication",
  "receiveAutomationNoticeReceipt",
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





function checkPilotExpansionMutation(name) {
  const source=sourceFile('functions/src/pilot-expansion.ts'),start=source.indexOf('export const '+name),end=source.indexOf('\n});',start);
  if(start<0||end<start)return false;
  const compact=s=>s.replace(/\s+/g,''),block=compact(source.slice(start,end+4)),whole=compact(source),tx=block.slice(block.indexOf('db.runTransaction('));
  const prefix=new RegExp('^exportconst'+name+'=onCall\\(async\\(request\\)=>\\{constsession=requireAdmin\\(request\\);constcompanyId=companyFromClaims\\(session.token\\);');
  const imported=source.match(/import\s*\{([^}]+)\}\s*from\s*"\.\/utils";/)?.[1]??'';
  if(!prefix.test(block)||!/\brequireAdmin\b/.test(imported)||!/\bcompanyFromClaims\b/.test(imported))return false;
  if(!['rolloutSnap.data()?.companyId!==companyId','consteventId=requestId("pilot_expansion");','dedupeKey:eventId','requestId:eventId'].every(x=>block.includes(x)))return false;
  if(block.indexOf('consteventId=')>block.indexOf('db.runTransaction('))return false;
  if(!['collectAutomatedMetrics(input.rolloutId,rollout,companyId,tx)','tx.create(notification.ref,notification.data)','tx.set(db.collection("auditLogs").doc(eventId),','tx.set(reviewRef,','tx.set(rolloutRef,'].every(x=>tx.includes(x)))return false;
  if(!['db.collection("pilotHealthRuns").where("companyId","==",companyId).where("rolloutId","==",rolloutId)','db.collection("pilotAlerts").where("companyId","==",companyId).where("rolloutId","==",rolloutId)','transaction?transaction.get(healthQuery):healthQuery.get()','transaction?transaction.get(alertQuery):alertQuery.get()','targetRole:"admin"asconst','db.collection("notificationQueue").doc(notificationQueueId(notification))','data:queueDocumentData(notification)'].every(x=>whole.includes(x))||whole.includes('enqueueNotification('))return false;
  if(name==='submitPilotOutcome')return ['current.data()?.companyId!==companyId','currentReview.exists&&currentReview.data()?.companyId!==companyId','!rolloutSnap.updateTime||!current.updateTime?.isEqual(rolloutSnap.updateTime)','REVIEWABLE_STATUSES.has(String(current.data()?.status??""))','constgate=evaluatePilotExpansion(automated,outcome)'].every(x=>tx.includes(x));
  return ['typeofreview.submittedBy!=="string"||!review.submittedBy.trim()||review.submittedBy===session.uid','reviewSnap.data()?.companyId!==companyId'].every(x=>block.includes(x))&&['currentRollout.data()?.companyId!==companyId','currentReview.data()?.companyId!==companyId','currentReview.data()?.submittedBy!==review.submittedBy','currentReview.data()?.submittedBy===session.uid','!rolloutSnap.updateTime||!currentRollout.updateTime?.isEqual(rolloutSnap.updateTime)','!reviewSnap.updateTime||!currentReview.updateTime?.isEqual(reviewSnap.updateTime)','currentReview.data()?.fingerprint!==review.fingerprint','input.decision==="approve"&&(!gate.eligible||gate.fingerprint!==review.fingerprint)','tx.create(approvalRef,'].every(x=>tx.includes(x));
}

function checkReadiness(name) {
  const modules={getPilotReadiness:'sheet-row-creation',getPilotExpansionReview:'pilot-expansion',getProductionControlStatus:'production-control',getProductionSloDashboard:'production-slo'};
  const source=sourceFile('functions/src/'+modules[name]+'.ts'),start=source.indexOf('export const '+name),end=source.indexOf('\n});',start);
  if(start<0||end<start)return false;
  const compact=s=>s.replace(/\s+/g,''),block=compact(source.slice(start,end+4)),whole=compact(source);
  const prefix=new RegExp('^exportconst'+name+'=onCall\\(async\\(?request\\)?=>\\{constsession=requireAdmin\\(request\\);constcompanyId=companyFromClaims\\(session.token\\);');
  const imported=source.match(/import\s*\{([^}]+)\}\s*from\s*"\.\/utils";/)?.[1]??'';
  if(!prefix.test(block)||!/\brequireAdmin\b/.test(imported)||!/\bcompanyFromClaims\b/.test(imported)||/\.(?:add|create|delete|set|update)\(/.test(block))return false;
  const required={
    getPilotReadiness:['typeofmapping?.spreadsheetId==="string"','mapping.spreadsheetId.length>0','mapping.spreadsheetId.trim()===mapping.spreadsheetId','mapping.monthCreation?.verifiedSpreadsheetId===mapping.spreadsheetId','blockedRows.empty&&deadRows.empty','monthInterventions.empty'],
    getPilotExpansionReview:['findRollout(companyId,input.rolloutId)','collectAutomatedMetrics(rollout.id,data,companyId)','reviewSnap.exists&&reviewSnap.data()?.companyId===companyId?reviewSnap.data()asExpansionReviewRecord:null'],
    getProductionControlStatus:['findLatestCompletedStagedRollout(companyId)','review?.exists&&review.data()?.companyId===companyId?review.data()asProductionReviewRecord:null','rehearsalFingerprint:certification?.exists&&certification.data()?.companyId===companyId?','pendingApprovalSnap?.exists&&pendingApprovalSnap.data()?.companyId===companyId'],
    getProductionSloDashboard:['db.collection("productionSloControls").doc(companyId)','db.collection("productionIncidents").where("companyId","==",companyId)','openIncident?.exists&&openIncident.data()?.companyId===companyId?safeIncident('],
  };
  if(!required[name].every(x=>block.includes(x)))return false;
  if(name==='getPilotExpansionReview'&&!['snap.exists&&snap.data()?.companyId===companyId?snap:null','db.collection("pilotHealthRuns").where("companyId","==",companyId).where("rolloutId","==",rolloutId)','db.collection("pilotAlerts").where("companyId","==",companyId).where("rolloutId","==",rolloutId)'].every(x=>whole.includes(x)))return false;
  if(name==='getProductionControlStatus'&&!whole.includes('db.collection("stagedRollouts").where("companyId","==",companyId).where("status","==","completed")'))return false;
  return true;
}

function checkSetupAudit(name) {
  const modules = {inspectSetupWizard:'setup-wizard',saveSetupWizardDraft:'setup-wizard',getLoginInviteCandidates:'login-links',sendLoginInvites:'login-links',previewMonthSheetCreation:'month-sheet',createMonthSheetSafe:'month-sheet',getMonthCreationHistory:'month-sheet',previewSheetRowCreation:'sheet-row-creation',listSheetWriteReviewRecords:'sheet-write-review',runGasAudit:'gas-audit',scanGasUploadSafety:'gas-remediation',exportGasAuditMarkdown:'gas-remediation'};
  const source=sourceFile('functions/src/'+modules[name]+'.ts'),start=source.indexOf('export const '+name);
  const multi=['inspectSetupWizard','sendLoginInvites','previewMonthSheetCreation','createMonthSheetSafe','previewSheetRowCreation'].includes(name),marker=multi?'\n);':'\n});',end=source.indexOf(marker,start);
  if(start<0||end<start)return false;
  const compact=value=>value.replace(/\s+/g,''),block=compact(source.slice(start,end+marker.length)),whole=compact(source);
  const has=items=>items.every(x=>block.includes(x)),all=items=>items.every(x=>whole.includes(x));
  const prefix=new RegExp('^exportconst'+name+'=onCall\\((?:\\{[^{}]*\\},)?async\\(?request\\)?=>\\{(?:constsession=)?requireAdmin\\(request\\);');
  const utils=source.match(/import\s*\{([^}]+)\}\s*from\s*"\.\/utils";/)?.[1]??'';
  if(!prefix.test(block)||!/\brequireAdmin\b/.test(utils))return false;
  if(name!=='scanGasUploadSafety'&&(!/\bcompanyFromClaims\b/.test(utils)||!block.includes('constcompanyId=companyFromClaims(session.token);')))return false;
  const required={
    inspectSetupWizard:['awaitcreateReadOnlyClient()','buildSafeDraft({companyId,','actorUid:session.uid','expiresAt','staffExcludedSheets'],
    saveSetupWizardDraft:['inspection.data()?.companyId!==companyId','expiresAt.toMillis()<=Date.now()','db.collection("setupWizardDrafts").doc(companyId)','allEnabled:false','status:"draft_only"','savedBy:session.uid'],
    getLoginInviteCandidates:['.where("companyId","==",companyId)','.where("status","==","assigned")','.limit(10000)','profile.companyId===companyId&&profile.active===true','!profile.lastLoginAt','staffId:profile.id'],
    sendLoginInvites:['SendInvitesSchema.parse(request.data??{})','sendLoginInviteBatch({companyId,actorUid:session.uid,','secrets:[gmailServiceAccountJson]'],
    previewMonthSheetCreation:['awaitloadMapping(companyId)','buildPreview(mapping,input.targetMonth,input.sourceMonth)'],
    createMonthSheetSafe:['awaitensureMonthCreationEnabled(companyId,mapping)','awaitacquireLock(companyId,targetMonth)','verificationSucceeded=true','constcompletion=db.batch()','completion.set(runRef,','completion.set(db.collection("auditLogs").doc(),','awaitcompletion.commit()','if(verificationSucceeded){','reason:"completion_recording_uncertain"','verificationCompleted:true','awaitreleaseLock(lock)'],
    getMonthCreationHistory:['.where("companyId","==",companyId)','.orderBy("startedAt","desc")','.limit(20)'],
    previewSheetRowCreation:['awaitloadMapping(companyId)','awaitdateKeyFromGroup(companyId,input.groupId)','preflight(companyId,mapping,dateKey,input.rows,undefined,false)'],
    listSheetWriteReviewRecords:['input.expectedCompanyId!==companyId||input.expectedActorUid!==session.uid','.where("companyId","==",companyId)','.orderBy(FieldPath.documentId(),"asc")','.select(...Fields)','.limit(input.limit+1)','data.companyId!==companyId','reviewMode:"metadata_only"','sourceWriteVerified:false','consistentSnapshot:false'],
    runGasAudit:['.max(2_000_000)','.min(1).max(100)','auditGasSources(input.files)','ref.set({companyId,actorUid:session.uid,report,','action:"gas.audit.run"'],
    scanGasUploadSafety:['files:z.array(FileSchema).min(1).max(100)','scanSourcesForSecrets(input.files)'],
    exportGasAuditMarkdown:['audit.data()?.companyId!==companyId','markdownAuditReport({'],
  };
  if(!has(required[name]))return false;
  if(name==="sendLoginInvites"&&(whole.match(/getProductionOperationalState\(input\.companyId\)/g)??[]).length!==2)return false;
  if(name==="saveSetupWizardDraft"&&(block.match(/allEnabled:false/g)??[]).length!==2)return false;
  if(name==="listSheetWriteReviewRecords"&&(block.match(/sourceWriteVerified:false/g)??[]).length!==2)return false;
  if(['getLoginInviteCandidates','previewMonthSheetCreation','getMonthCreationHistory','previewSheetRowCreation','listSheetWriteReviewRecords','scanGasUploadSafety','exportGasAuditMarkdown'].includes(name)&&/\.(?:add|create|delete|set|update)\(/.test(block))return false;
  if(name==='inspectSetupWizard'&&!all(['scopes:["https://www.googleapis.com/auth/spreadsheets.readonly"]']))return false;
  if(name==='sendLoginInvites'&&!all(['awaitassertProductionOperational(input.companyId)','profiles.some(profile=>profile.companyId!==input.companyId)','getProductionOperationalState(input.companyId)','if(profile.active!==true)','awaitsendLoginLink({companyId:input.companyId,staffId:profile.id,']))return false;
  if(['previewMonthSheetCreation','createMonthSheetSafe'].includes(name)&&!all(['db.doc(`companies/${companyId}/sheetMappings/shift`).get()','spreadsheets.readonly']))return false;
  if(name==='createMonthSheetSafe'){
    if((block.match(/awaitassertProductionOperational\(companyId\);/g)??[]).length!==3)return false;
    if(!all(['confirmation:z.literal("検証コピーで作成")','mapping.enabled!==true','mapping.monthCreation?.enabled!==true','mapping.monthCreation?.verifiedSpreadsheetId!==mapping.spreadsheetId','feature.data()?.monthSheetCreationReady!==true','awaitdb.runTransaction(async(tx)=>{constsnap=awaittx.get(ref);constnow=Timestamp.now();','snap.data()?.token===lock.token']))return false;
    const preserved=block.slice(block.indexOf('if(verificationSucceeded){'),block.indexOf('if(createdSheetId!==null){',block.indexOf('if(verificationSucceeded){')));
    if(!preserved.includes('thrownewHttpsError(')||/deleteSheet\(|runRef\.set\(/.test(preserved))return false;
  }
  if(name==='previewSheetRowCreation'&&!all(['group.data()?.companyId!==companyId','db.doc(`companies/${companyId}/sheetMappings/shift`).get()']))return false;
  return true;
}

function checkExternalHandoff(name) {
  const modules = {
    getAutomationRegistry:"automation-registry",saveAutomationRegistry:"automation-registry",cancelAutomationRegistryAttempt:"automation-registry",
    listHeldMailApplications:"automation-intake",getHeldMailApplication:"automation-intake",recheckHeldMailApplication:"automation-intake",cancelHeldMailApplicationReview:"automation-intake",receiveCaseMailApplication:"automation-intake",
    previewCaseMailCampaignRegistration:"automation-campaigns",registerCaseMailCampaign:"automation-campaigns",cancelCaseMailCampaignRegistration:"automation-campaigns",
    getCaseMailImportSnapshot:"automation-import-snapshot",listAutomationNoticeReceipts:"automation-notice-receipts",receiveAutomationNoticeReceipt:"automation-notice-receipts",getAutomationNoticeHandoff:"automation-notice-handoff",
  };
  const source=sourceFile("functions/src/"+modules[name]+".ts"),start=source.indexOf("export const "+name);
  const end=source.indexOf("\n});",start);
  if(start<0||end<start)return false;
  const compact=text=>text.replace(/\s+/g,""),block=compact(source.slice(start,end+4)),whole=compact(source);
  const has=parts=>parts.every(part=>block.includes(part)),all=parts=>parts.every(part=>whole.includes(part));
  const utils=source.match(/import\s*\{([^}]+)\}\s*from\s*"\.\/utils";/)?.[1]??"";
  if(!/\brequireAdmin\b/.test(utils)||!/\bcompanyFromClaims\b/.test(utils)
    ||!block.startsWith("exportconst"+name+"=onCall(asyncrequest=>{constsession=requireAdmin(request)")
    ||!has(["companyId=id.parse(companyFromClaims(session.token))","return db.runTransaction".replace(/ /g,"")]))return false;
  const readOnly=["getAutomationRegistry","listHeldMailApplications","getHeldMailApplication","previewCaseMailCampaignRegistration","getCaseMailImportSnapshot","listAutomationNoticeReceipts","getAutomationNoticeHandoff"].includes(name);
  if(readOnly&&/tx\.(?:set|update|delete|create)\(/.test(block))return false;
  if(!["getAutomationRegistry","getHeldMailApplication","listHeldMailApplications"].includes(name)
    &&(!has(["awaitassertProductionOperational(companyId);"])||!whole.includes('from"./system-safety";')))return false;
  const requirements={
    getAutomationRegistry:["assertRegistryContext(input,companyId,session.uid)","ReadSchema.parse(request.data)","own(bindingSnap.data(),companyId)","own(staffSnap.data(),companyId)"],
    saveAutomationRegistry:["assertRegistryContext(input,companyId,session.uid)","event.actorUid!==session.uid||event.inputHash!==inputHash||event.kind!==input.kind",'event.status==="cancelled"',"unchanged(old,input.expectedRevision)","for(constwriteofwrites)tx.set(write.ref,write.value)","tx.set(eventRef,{companyId,actorUid:session.uid"],
    cancelAutomationRegistryAttempt:["assertRegistryContext(input,companyId,session.uid)","event.actorUid!==session.uid||event.inputHash!==inputHash||event.kind!==input.kind",'event.status==="cancelled"','tx.set(eventRef,{companyId,actorUid:session.uid,kind:input.kind,inputHash,status:"cancelled"'],
    listHeldMailApplications:["requireReviewScope(input,companyId,session.uid)",'.where("companyId","==",companyId).where("route","==","hold").orderBy(FieldPath.documentId()).limit(26)',"receiptKey(incoming)!==doc.id"],
    getHeldMailApplication:["requireReviewScope(input,companyId,session.uid)","awaitreadHeldReceiptContext(tx,companyId,input.receiptKey)",'assignmentPerformed:false,dispatch:"disabled"'],
    recheckHeldMailApplication:["requireReviewScope(input,companyId,session.uid)","previous.companyId!==companyId||previous.actorUid!==session.uid||previous.inputHash!==inputHash","held.revision!==input.expectedReceiptRevision||held.reviewRevision!==input.expectedReviewRevision",'existing?.status!=="assigned"',"tx.set(held.ref,saved)",'assignmentPerformed:false,dispatch:"disabled"'],
    cancelHeldMailApplicationReview:["requireReviewScope(input,companyId,session.uid)","previous.companyId!==companyId||previous.actorUid!==session.uid||previous.inputHash!==inputHash||previous.receiptKey!==input.receiptKey",'previous.status==="cancelled"','tx.set(eventRef,{companyId,actorUid:session.uid,inputHash,receiptKey:input.receiptKey,status:"cancelled"'],
    previewCaseMailCampaignRegistration:["checkContext(input,companyId,session.uid)","checkedCampaign(input.campaign,companyId)","awaitreadRegistrationContext(tx,companyId,session.uid,campaign)",'dispatch:"disabled"'],
    registerCaseMailCampaign:["checkContext(input,companyId,session.uid)","checkedCampaign(input.campaign,companyId)","checkEvent(event,input,session.uid,inputHash)",'event.status==="cancelled"',"awaitreadRegistrationContext(tx,companyId,session.uid,campaign,input.expectedPrincipalRevision)","tx.set(current.campaignRef,saved)","tx.set(current.ownerRef,{companyId"],
    cancelCaseMailCampaignRegistration:["checkContext(input,companyId,session.uid)","checkedCampaign(input.campaign,companyId)","checkEvent(event,input,session.uid,inputHash)",'tx.set(eventRef,{companyId,actorUid:session.uid,inputHash,status:"cancelled"'],
    getCaseMailImportSnapshot:["input.expectedCompanyId!==companyId||input.expectedActorUid!==session.uid||input.targets.companyId!==companyId","sender.uid!==session.uid||sender.active!==true",'parsedPolicy.data.phase!=="mail_bridge"','.where("companyId","==",companyId).where("fixedCaseId","==",target.fixedCaseId).limit(2)',"ownerSnap.id!==automationRecordKey(companyId,owner.spreadsheetId,target.fixedCaseId)","binding.revision!==owner.revision",'dispatch:"disabled"'],
    getAutomationNoticeHandoff:["input.expectedCompanyId!==companyId||input.expectedActorUid!==session.uid","sender.data.companyId!==companyId||sender.data.uid!==session.uid","job.companyId!==companyId","job.applicationUnconfirmed===true","awaitreadAutomationJobContext(tx,companyId,input.jobId,job)","matchesAutomationPreContactProof(context,rawContact,rawContact?.automationProof)",'deliveryVerified:false,automaticRetryAllowed:false,dispatch:"disabled"'],
    listAutomationNoticeReceipts:["checkedScope(input,companyId,session.uid)",'.where("companyId","==",companyId).where("current.jobId","==",input.jobId).orderBy(FieldPath.documentId()).limit(26)',"event.inputHash!==row.currentHash",'event.disposition!=="accepted"',"event.currentSequenceAtReceipt!==row.current.sequence",'dispatch:"disabled"'],
    receiveCaseMailApplication:["incoming.companyId!==companyId","senderResult.data.companyId!==companyId||senderResult.data.uid!==session.uid","previous.producerId!==sender.producerId","context.record.producerId!==sender.producerId",'existing?.status!=="assigned"',"tx.set(receiptRef,saved)","returnpublicReceipt(saved,false)"],
    receiveAutomationNoticeReceipt:["checkedScope(input,companyId,session.uid)","incoming.companyId!==companyId","previous.producerId!==sender.producerId||previous.receivedBy!==session.uid","oldEvent.inputHash!==inputHash",'context.reason!=="aligned"','deliveryVerified:false',"tx.set(eventRef,event)",'assignmentPerformed:false,dispatch:"disabled"'],
  };
  if(!has(requirements[name]))return false;
  if(name==="saveAutomationRegistry" && ((block.match(/unchanged\(old,input\.expectedRevision\)/g)??[]).length!==3 || !has(["unchanged(owner,input.expectedRevision)"])))return false;
  const shared={
    "automation-registry":["input.expectedCompanyId!==companyId||input.expectedActorUid!==uid","value.companyId!==companyId","value?.revision??null)!==expected","owner.revision!==old.revision"],
    "automation-intake":["value.companyId!==companyId","active:z.literal(true)","bindingOwner.revision!==binding.revision","personOwner.revision===matchedPerson.revision","input.expectedCompanyId!==companyId||input.expectedActorUid!==uid",'assignmentPerformed:false,dispatch:"disabled"'],
    "automation-campaigns":["input.expectedCompanyId!==companyId||input.expectedActorUid!==uid","value.companyId!==companyId","campaign.companyId!==companyId","sender.revision!==expectedPrincipalRevision","owner.registrationRevision!==previous.registrationRevision","confirmedAgainstSource:z.literal(true)"],
    "automation-import-snapshot":["value.companyId!==companyId"],
    "automation-notice-receipts":["input.expectedCompanyId!==companyId||input.expectedActorUid!==uid","value.companyId!==companyId","active:z.literal(true)","returnreconcileAutomationReceipt({companyId:binding.companyId,binding,incoming,current})"],
    "automation-notice-handoff":["active:z.literal(true)"],
  };
  return all(shared[modules[name]]);
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

function checkNativeCreationRetry(source, block, kind) {
  const compact = text => text.replace(/\s+/g, "");
  if (!compact(source).includes('import{createNativeJobGroup}from"./native-job-creation";') ||
      !block.includes('if(request.data&&Object.hasOwn(request.data,"nativeCreation")){') ||
      !block.includes('returncreateNativeJobGroup(request.data,companyId,session.uid,"' + kind + '",async') ||
      block.indexOf('awaitassertProductionOperational(companyId);') > block.indexOf('returncreateNativeJobGroup(')) return false;
  if (kind === "duplicate" && !['awaittx.get(db.collection("jobs").doc(command.sourceJobId))', '!source||source.companyId!==companyId'].every(part => block.includes(part))) return false;
  const helper = compact(sourceFile("functions/src/native-job-creation.ts"));
  const shared = compact(sourceFile("functions/src/job-group-creation.ts"));
  return [
    'envelopeSchema.safeParse(raw)', '}).strict()}).strict()',
    'command.expectedCompanyId!==companyId||command.expectedActorUid!==actorUid',
    'constinputHash=hashText(encoded,64)', 'hashText(JSON.stringify([companyId,command.operationId]),64)',
    'constbinding={version:1,operationId:command.operationId,companyId,actorUid,kind}',
    'returndb.runTransaction(asynctx=>{', 'conststored=awaittx.get(receiptRef);',
    'Object.entries(binding).some(([key,value])=>receipt[key]!==value)||receipt.inputHash!==inputHash',
    'receipt.status==="cancelled"', 'receipt.status!=="committed"||!saved.success',
    'group.companyId!==companyId||group.nativeCreationReceiptId!==receiptId',
    'job.companyId!==companyId||job.groupId!==result.groupId||job.caseId!==receipt.caseIds[index]||job.nativeCreationReceiptId!==receiptId',
    'createJobIdFromPersistedCaseId(companyId,job.caseId)!==result.jobIds[index]',
    'if(command.action==="cancel"){tx.create(receiptRef,{...binding,inputHash,status:"cancelled",createdAt:now});',
    'constprepared=awaitprepare(command.input,tx);',
    'feature?.adminJobCreationSourceReady===true&&mapping?.enabled===true&&mapping?.rowCreation?.enabled===true',
    'tx.create(ref,{...data,...extra,nativeCreationReceiptId:receiptId});',
    'stageAdminJobGroup(writer,{companyId,actorUid,input:prepared.input,...allocation,',
    'tx.create(db.collection("auditLogs").doc(),{companyId,actorUid,',
    'tx.create(receiptRef,{...binding,inputHash,status:"committed",result,caseIds:',
  ].every(part => helper.includes(part)) && !/(?:db\.batch\(|(?:receiptRef|ref)\.(?:set|create|update)\()/.test(helper)
    && ['constsourceReady=false;', 'constbatch=writer;', 'batch.set(jobRef,{companyId,caseId:job.caseId,', 'persistedIdentity?createJobIdFromPersistedCaseId(companyId,caseId):ref.id'].every(part => shared.includes(part));
}

function checkAtomicCreationAudit(source, block, action) {
  const call = `stageAudit(batch,companyId,session.uid,"${action}",`;
  const start = source.indexOf("function stageAudit(");
  const end = source.indexOf("\n}", start);
  if (start < 0 || end < start || !block.includes(call) || block.indexOf(call) > block.indexOf('awaitbatch.commit();')
      || block.split('awaitbatch.commit();').length !== 2) return false;
  const helper = source.slice(start, end).replace(/\s+/g, "");
  return helper.includes('batch.create(db.collection("auditLogs").doc(),{companyId,actorUid,action,detail,requestId:requestId("audit"),createdAt:FieldValue.serverTimestamp(),});')
    && !helper.includes('db.batch(') && !helper.includes('.commit(');
}

function checkAtomicMutationAudit(source, block, action, close) {
  const start = source.indexOf("function stageAudit("), end = source.indexOf("\n}", start);
  const helper = source.slice(start, end).replace(/\s+/g, "");
  const transaction = block.indexOf('awaitdb.runTransaction(async(tx)=>{');
  const call = block.indexOf(`stageAudit(tx,companyId,session.uid,"${action}",`);
  const finish = block.indexOf(close);
  return start >= 0 && end > start && transaction >= 0 && call > transaction && finish > call
    && !block.includes('writeAudit(') && block.split('stageAudit(').length === 2
    && helper.includes('batch.create(db.collection("auditLogs").doc(),{companyId,actorUid,action,detail,requestId:requestId("audit"),createdAt:FieldValue.serverTimestamp(),});')
    && !helper.includes('db.batch(') && !helper.includes('.commit(');
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
    createAdminJobGroup: block.includes('stageAdminJobGroup(') ? [
      'CreateSchema.parse(request.data??{})', 'normalizeJobInput(parsed)', 'if(normalized.errors.length)',
      'constallocation=allocateAdminJobGroup(companyId,normalized.value.workDate,normalized.value.slots);',
      'constrowCreationConfigured=awaitnativeJobSourceEnabled(companyId);', 'constbatch=db.batch();',
      'stageAdminJobGroup(batch,{companyId,actorUid:session.uid,input:normalized.value,...allocation,',
      'rowQueueId:rowCreationConfigured?db.collection("sheetRowCreateQueue").doc().id:null,',
      'awaitbatch.commit();', 'stageAudit(batch,companyId,session.uid,"job.group.create",',
      'if(request.data&&Object.hasOwn(request.data,"mailIntake")){',
      'returncreateCaseMailJobGroup(request.data,companyId,session.uid,raw=>{',
      'normalizeJobInput(CreateSchema.parse(raw))',
    ] : [
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
      'readMailPublication(tx,snap.id,snap.data()!,input.expectedRevisions?.[snap.id],now.toDate())',
      'if(job.mailIntake&&(!mailCheck||mailCheck.issue)){blocked.push(snap.id);continue;}',
      'constpublication=resolvePublication({', 'tx.set(snap.ref,', 'revision:FieldValue.increment(1)',
      'return{updated,blocked};', 'stageAudit(tx,companyId,session.uid,"job.publication.update",',
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
      'assertCaseMailSubmissionRevision(job,input.expectedRevision);', 'constidentity=netPrintWriteIdentity(job);', 'if(previous?.syncPending===true)', 'if(previous.writeIdentity!==identity)throw',
      'expected=baselineastypeofexpected;', 'old.printedContext===identity&&old.printedByStaffId===job.assignedStaffId&&old.printedForDate===job.dateKey',
      'tx.update(jobRef,{netPrint:{...(job.mailIntake?{caseMailContext:caseMailSubmissionContext(job)}:{}),items,updatedAt:now,changedCount,writeOperationId:queueRef.id,writeIdentity:identity,syncPending:true,writeStyles:styles,writeExpected:expected}',
      'tx.create(queueRef,{companyId,jobId:input.jobId,operation:"netprint.update",',
      'if(notifyStaffId&&changedCount>0&&!caseMailPreparationHeld(job)&&job.cancelled!==true&&job.status==="assigned"&&job.sourceMissing!==true&&job.applicationUnconfirmed!==true&&job.assignmentUnresolved!==true)',
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
      'if(!staffSnap.exists||staffSnap.data()?.companyId!==companyId)throw', 'if(staffSnap.data()?.active!==true)throw',
      'currentLock?.companyId!==companyId||currentLock.staffId!==assignedStaffId||currentLock.dateKey!==dateKey',
      'lockSnap.data()?.active===true&&lockSnap.data()?.jobId!==input.jobId',
      'tx.set(lockRef,{companyId,staffId:assignedStaffId,dateKey,jobId:input.jobId,active:true,',
      'cancellationSheetWrite:{queueId:queueRef.id,operation:"job.restore",identity:cancellationSheetWriteIdentity(job)}',
      'tx.set(queueRef,{companyId,jobId:input.jobId,operation:"job.restore",', 'actorUid:session.uid,',
    ],
  };
  if (!has(requirements[name])) return false;
  if (["updateJobPublication","adminEditJobInputs"].includes(name) && !checkAtomicMutationAudit(source, block, name === "updateJobPublication" ? "job.publication.update" : "job.admin_edit", name === "updateJobPublication" ? "return{updated,blocked};});" : "returnresult;});")) return false;
  if (name === "createAdminJobGroup" && !checkNativeCreationRetry(source, block, "create")) return false;
  if (name === "createAdminJobGroup" && block.includes("stageAdminJobGroup(") && !checkAtomicCreationAudit(source, block, "job.group.create")) return false;
  if (name === "createAdminJobGroup" && block.includes("stageAdminJobGroup(")) {
    const shared = compact(sourceFile("functions/src/job-group-creation.ts"));
    const intake = compact(sourceFile("functions/src/case-mail-job-creation.ts"));
    if (!['from"./job-group-creation";', 'from"./case-mail-job-creation";'].every(part => compact(source).includes(part))) return false;
    if (![
      'constsourceReady=false;', 'constpublication=resolvePublication({requestedMode:input.publicationMode,publishAt:input.publishAt,sourceReady,',
      'constbatch=writer;', 'batch.set(jobRef,{companyId,caseId:job.caseId,', 'source:{type:"admin_created",createdBy:actorUid}',
      'batch.set(db.collection("jobGroups").doc(groupId),{companyId,jobIds,',
      'if(rowQueueRef){batch.set(rowQueueRef,{companyId,groupId,jobIds,',
      'persistedIdentity?createJobIdFromPersistedCaseId(companyId,caseId):ref.id',
    ].every(part => shared.includes(part)) || /(?:jobRef|rowQueueRef)\.(?:set|update|create)\(/.test(shared)) return false;
    if (![
      'RequestSchema=z.object({mailIntake:CommandSchema,expectedCompanyId:id.optional(),expectedActorUid:id.optional()}).strict()',
      'expectedCompanyId!==companyId||expectedActorUid!==actorUid',
      'expectedCompanyId!==undefined||expectedActorUid!==undefined', 'returndb.runTransaction(asynctx=>{',
      'constprevious=(awaittx.get(operationRef)).data();', 'returncommittedResult(tx,previous,companyId);',
      'ReceiptSchema.safeParse(receiptSnap.data())', 'CandidateSchema.safeParse(candidateSnap.data())',
      'receipt.companyId!==companyId||candidate.companyId!==companyId', 'receipt.status!=="ready"',
      'receipt.revision!==command.expectedReceiptRevision', 'principal.companyId!==companyId',
      'principal.active!==true', 'principal.revision!==receipt.principalRevision',
      'input.slots!==1||input.basePay!==null||input.publicationMode!=="draft"||input.publishAt!==null',
      'owner.payloadHash!==payloadHash', 'candidate.revision!==command.expectedRevision',
      'featureSnap.data()?.caseMailJobCreationEnabled!==true', 'collisions.some(snap=>snap.exists)',
      'stageAdminJobGroup(tx,{...allocation,companyId,actorUid,input,rowQueueId,now,mailIntake:origin})',
      'tx.set(candidateRef,', 'tx.set(ownerRef,', 'tx.set(operationRef,', 'tx.set(auditRef,',
      'structuralComplete:z.literal(true)', 'verification:z.literal("verified")', 'kind:z.literal("new")',
    ].every(part => intake.includes(part)) || /(?:db\.batch\(|(?:operationRef|ownerRef|candidateRef|auditRef)\.(?:set|create|update)\()/.test(intake)) return false;
  }
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
    'returnjob?.status==="assigned"&&job.cancelled!==true&&job.sourceMissing!==true&&job.applicationUnconfirmed!==true&&job.assignmentUnresolved!==true&&!caseMailPreparationHeld(job);',
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
    'if(job.recruitmentStopped===true||job.cancelled===true||job.mailIntakeReviewRequired===true||job.mailTargetHold!=null)',
    'job.sourceMissing===true||job.assignmentUnresolved===true||job.applicationUnconfirmed===true||job.publishable!==true',
    'awaitreadMailPublication(tx,input.jobId,job,input.expectedJobRevision,newDate(),"apply")',
    'confirmed.context!==checked.confirmation.context',
    '(previous.expectedJobRevision??null)!==(input.expectedJobRevision??null)',
    'constlockSnap=awaittx.get(lockRef);', 'if(lockSnap.exists&&lockSnap.data()?.active===true)',
    'awaitreadMailApplicationForAssignment(tx,{companyId,staffId,jobId:input.jobId,applicationId:input.mailApplicationId,revision:input.mailApplicationRevision!,})',
    'tx.update(jobRef,{revision:nextAssignmentRevision(job),status:"assigned",assignedStaffId:staffId,assignedStaffName:displayName,assignedUid:session.uid,',
    'tx.set(lockRef,{companyId,staffId,dateKey:workDate,jobId:input.jobId,active:true,',
    'tx.set(queueRef,{companyId,jobId:input.jobId,operation:"job.assign",',
    'actorUid:session.uid,actorStaffId:staffId,',
    'tx.set(idempotencyRef,{expectedJobRevision:input.expectedJobRevision??null,mailApplicationRevision:input.mailApplicationRevision??null,mailApplicationId:input.mailApplicationId??null,uid:session.uid,companyId,staffId,result:response,',
  ]);
  if (!has([
    'if(job.companyId!==companyId||job.assignedStaffId!==staffId)',
    'job.cancelled===true||job.status==="cancelled"', 'if(job.status!=="assigned")throw',
    'tx.update(jobRef,',
  ])) return false;
  if (name === "setSalesFloorClientSubmitted") return source.includes('import { submissionSheetWriteIdentity } from "./sheet-write-core";') && has([
    'ClientSubmittedSchema.parse(request.data??{})', 'constsnap=awaittx.get(jobRef);', 'assertSubmissionReadiness(job);', 'assertCaseMailSubmissionRevision(job,input.expectedRevision);',
    'constlipKnotsSubmitted=current?.lipKnotsSubmitted===true;',
    'if(current?.clientSubmitted===input.submitted&&current.completed===(input.submitted||lipKnotsSubmitted))return;',
    '"submissionStatus.salesFloor.completed":input.submitted||lipKnotsSubmitted,',
    '"submissionStatus.salesFloor.sheetWrite":{operationId:queueRef.id,identity:submissionSheetWriteIdentity(job),...(job.mailIntake?{caseMailContext:caseMailSubmissionContext(job)}:{}),pending:true},',
    'tx.set(queueRef,{companyId,jobId:input.jobId,dateKey:job.dateKey,operation:"submission.sales_floor",',
    'actorUid:session.uid,actorStaffId:staffId,',
  ]);
  return has([
    'Schema.parse(request.data)', 'constjobSnap=awaittx.get(jobRef);',
    'if(!workDate.success||(input.dateKey!==undefined&&input.dateKey!==workDate.data))throw',
    'if(job.sourceMissing===true)throw', 'if(job.applicationUnconfirmed===true)throw', 'if(job.assignmentUnresolved===true)throw',
    'if(caseMailPreparationHeld(job))throw',
    'input.expectedRevision!==job.revision',
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
  return checkNativeCreationRetry(source, block, 'duplicate') && checkAtomicCreationAudit(source, block, 'job.group.duplicate') && ['feature.data()?.adminJobCreationSourceReady===true', 'mapping.data()?.enabled===true', 'mapping.data()?.rowCreation?.enabled===true'].every(x=>native.includes(x))
    && has(['DuplicateSchema.parse(request.data??{})', 'normalizeJobInput(createData)', 'if(normalized.errors.length)',
      'awaitnativeJobSourceEnabled(companyId)', 'constsourceReady=false;', 'constbatch=db.batch();',
      'batch.set(ref,{...copyableJobFields(source),companyId,', 'createdBy:session.uid',
      'if(rowQueueRef){batch.set(rowQueueRef,{companyId,', 'awaitbatch.commit();',
      'stageAudit(batch,companyId,session.uid,"job.group.duplicate",']);
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
      "tx.create(ref,{...(current.data()!.mailIntake?{acceptedMailContext:caseMailSubmissionContext(current.data()!)}:{}),companyId,staffId,jobId:input.jobId,",
      "assertCaseMailSubmissionRevision(current.data()!,input.expectedRevision);",
      "if(current.data()!.mailIntake)assertSubmissionOwner(source,current.data());",
      "createdBy:session.uid,",
      'tx.create(notificationRef,{...queueDocumentData({...notification,reminderContext:{version:1,kind:"resubmission",jobId:input.jobId,staffId,dateKey:String(current.data()?.dateKey??""),revision:current.data()?.revision??0,requestId:ref.id,requestType:input.type}}),',
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
    'assertSubmissionOwner(submission.data()!,job.data());',
    'assertCaseMailSubmissionCurrent(data,job.data()!);',
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
    validatedInput: block.includes('const input = ApplicationConfirmationSchema.parse(request.data ?? {});')
      && source.includes('const ApplicationConfirmationSchema = JobSchema.extend({')
      && source.includes('expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)'),
    displayedVersion: block.includes('(data.revision ?? 0) !== input.expectedRevision'),
    reviewConditionsStable: block.includes('applicationConfirmationIdentity(data) !== applicationConfirmationIdentity(job.data()!)')
      && source.includes('import { applicationConfirmationIdentity } from "./assignment-preparation-core";'),
    jobReference: /const ref = db\.collection\("jobs"\)\.doc\(input\.jobId\);/.test(block),
    initialCompany: /if \(!job\.exists \|\| job\.data\(\)\?\.companyId !== companyId\)/.test(block),
    transaction: /await db\.runTransaction\(async \(tx\) =>/.test(block),
    transactionRead: /const current = await tx\.get\(ref\);/.test(block),
    transactionCompany: /if \(!current\.exists \|\| current\.data\(\)\?\.companyId !== companyId\)/.test(block),
    assignmentStable: /data\.status !== "assigned" \|\| \(data\.assignedStaffId \?\? null\) !== \(job\.data\(\)\?\.assignedStaffId \?\? null\)/.test(block),
    receivedChangeHeld: block.includes("data.mailIntakeReviewRequired === true || data.pendingSourceWrite === true || data.adminEditSheetWrite?.pending === true"),
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
  const compact = bootstrap.replace(/\s+/g, "");
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
    indexIdentity: compact.includes('db.collection("emailIndex").doc(emailHash(email)).get()')
      && compact.includes('index.active!==true')
      && compact.includes('[index.companyId,index.staffId].some(value=>typeofvalue!=="string"||!value.trim()||')
      && compact.includes(String.raw`/[\/\\\u0000-\u001f\u007f]/.test(value)`),
    staffProfileIdentity: compact.includes('db.collection("staffProfiles").doc(index.staffId).get()')
      && compact.includes('!profileSnap.exists||profileSnap.data()?.active!==true||profileSnap.data()?.companyId!==index.companyId'),
    staffClaimsFromIndex: /constclaims=\{role:"staff",companyId:index\.companyId,staffId:index\.staffId,?\};/.test(compact),
    claimUpdatesForAuthenticatedUser: (compact.match(/auth\.setCustomUserClaims\(session\.uid,claims\)/g) ?? []).length === 2,
  };
  return Object.values(checks).every(Boolean);
}

function checkLoginGateway() {
  const source=sourceFile("functions/src/login-links.ts"),start=source.indexOf("export const loginGateway"),end=source.indexOf("\n});",start);
  if(start<0||end<start)return false;
  const block=source.slice(start,end+4).replace(/\s+/g,"");
  return ['exportconstloginGateway=onRequest(async(request,response)=>{','/^[A-Za-z0-9_-]{30,120}$/.test(token)','consttokenHash=sha256(token)','db.collection("loginGatewayTokens").doc(tokenHash).get()','data.active!==true','!isLoginDocumentId(data.companyId)||!isLoginDocumentId(data.staffId)','/^[a-f0-9]{64}$/.test(data.emailHash)','data.expiresAt.toMillis()<=Date.now()','awaitassertProductionOperational(data.companyId)','constactionLink=awaitdb.runTransaction(asynctx=>{','tx.get(snap.ref)','tx.get(db.collection("emailIndex").doc(data.emailHash!))','tx.get(db.collection("staffProfiles").doc(data.staffId!))','current?.active!==true','current.actionLink!==data.actionLink','current.companyId!==data.companyId','current.staffId!==data.staffId','current.emailHash!==data.emailHash','!(current.expiresAtinstanceofTimestamp)||current.expiresAt.toMillis()<=Date.now()','index?.active!==true','index.companyId!==data.companyId','index.staffId!==data.staffId','profile?.active!==true','profile.companyId!==data.companyId','tx.set(snap.ref,','returncurrent.actionLink!','response.redirect(302,actionLink)'].every(x=>block.includes(x));
}

function checkRequestStaffLoginLink() {
  const source = sourceFile("functions/src/login-links.ts");
  const block = functionBlock(source, "requestStaffLoginLink");
  const rateLimitStart = source.indexOf("async function enforceLoginRateLimit");
  const rateLimit = rateLimitStart < 0 ? "" : source.slice(rateLimitStart);
  const compact = source.replace(/\s+/g, "");
  const send = compact.slice(compact.indexOf("asyncfunctionsendLoginLink("), compact.indexOf("functionrenderError("));
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
    strictCompanyIdentity: [
      'index?.active===true&&isLoginDocumentId(index.staffId)&&isLoginDocumentId(index.companyId)',
      'profileSnap.data()?.active===true&&profileSnap.data()?.companyId===index.companyId',
      'isLoginDocumentId(initial.loginCodeCompanyId)', 'isLoginDocumentId(initial.loginCodeStaffId)',
      'profileSnap.data()?.companyId!==initial.loginCodeCompanyId',
      'index.companyId!==input.companyId||index.staffId!==input.staffId',
    ].every(value => compact.includes(value)) && send.includes('profile.companyId!==input.companyId'),
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
      'assertSubmissionReadiness(job);',
      'parent.companyId!==companyId||parent.uid!==session.uid||parent.staffId!==staffId',
      'parent.requestFingerprint!==fingerprint', 'parent.acceptedDateKey!==job.dateKey',
      'parent.acceptedAssignmentRevision!==(job.revision??0)',
      'assertSubmissionFile(parent,saved,submissionRef.id);',
      'assertReplacementRequest(replacement.data(),parent,submissionRef.id);',
      'object.metadata?.lkcContentSha256!==saved.contentSha256',
      'if(saved.status!=="waiting_upload")throw',
      'tx.create(submissionRef,{', 'completedFiles:0,',
      'tx.create(submissionRef.collection("files").doc(record.fileId),{',
      'submissionId:submissionRef.id,type:input.type,', 'storagePath:record.storagePath,',
    ])
    && block.indexOf('if(awaitsubmissionTransferPaused(companyId))') < block.indexOf('db.collection("submissions")')
    && (block.match(/companyId,jobId:input\.jobId,staffId,uid:session\.uid,/g) ?? []).length === 2
    && !/(?:input|request\.data)\.(?:companyId|staffId|uid|submissionId|storagePath)/.test(block)
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
  const core = sourceFile("functions/src/notification-core.ts");
  const pause = core.match(/export function notificationDeliveryPaused\(\): boolean \{([^}]*)\}/)?.[1]?.replace(/\s+/g, "") ?? "";
  const block = functionBlock(source, "processNotificationQueue");
  const dispatcherStart = source.indexOf("async function dispatchQueueDocument");
  const dispatcherEnd = source.indexOf("async function bundleQuietNotifications");
  const dispatcher = dispatcherStart < 0
    ? ""
    : source.slice(dispatcherStart, dispatcherEnd < 0 ? source.length : dispatcherEnd);
  const checks = {
    deliveryPause: pause === 'constmode=process.env.LKC_NOTIFICATION_DELIVERY_MODE;if(mode!==undefined&&mode!=="active")returntrue;returnprocess.env.APP_ENVIRONMENT==="staging"&&mode!=="active";'
      && /import \{ notificationDeliveryPaused \} from "\.\/notification-core";/.test(source)
      && /async \(event\) => \{\s*if \(notificationDeliveryPaused\(\)\) return;/.test(block)
      && /\): Promise<void> \{\s*if \(notificationDeliveryPaused\(\)\) return;/.test(dispatcher),
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


// 受信callableの既知の安全条件を固定する。動作試験と組み合わせ、配備許可とは分離する。
function checkCaseMail(name) {
  const original = name === "confirmCaseMailReview";
  const source = sourceFile("functions/src/case-mail-" + (original ? "resolution" : "review") + ".ts");
  const clean = text => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
  const compact = text => clean(text).replace(/\s+/g, "");
  const code = clean(source);
  const start = code.search(new RegExp("export const " + name + "\\s*="));
  const end = code.indexOf("\n});", start);
  if (start < 0 || end < start) return false;
  const block = compact(code.slice(start, end + 4));
  const whole = compact(source);
  const has = (text, parts) => parts.every(part => text.includes(part));
  const section = (text, from, to) => {
    const begin = text.indexOf(from), finish = text.indexOf(to, begin + from.length);
    return begin < 0 || finish < 0 ? "" : compact(text.slice(begin, finish));
  };
  const readOnly = ["listCaseMailReceipts", "getCaseMailReceipt", "getCaseMailTargetPreview"].includes(name);
  if (!has(whole, [
    'import{requireAdmin,companyFromClaims}from"./utils";',
    'import{onCall,HttpsError}from"firebase-functions/v2/https";',
    'import{db}from"./firebase";',
  ]) || /(?:input|request\.data)\.(?:companyId|actorUid|uid)/.test(block)) return false;
  const schemas = {
    listCaseMailReceipts: "ListSchema", getCaseMailReceipt: "DetailSchema",
    getCaseMailTargetPreview: "TargetPreviewSchema", confirmCaseMailTarget: "TargetConfirmSchema",
    holdCaseMailTarget: "TargetHoldSchema", resolveCaseMailTargetHold: "TargetConfirmSchema",
  };
  let prefix = "exportconst" + name + "=onCall(asyncrequest=>{constsession=requireAdmin(request),companyId=";
  if (original) prefix += "companyFromClaims(session.token),input=Command.parse(request.data);if(input.expectedCompanyId!==companyId||input.expectedActorUid!==session.uid)fail();";
  else {
    prefix += "id.parse(companyFromClaims(session.token))";
    prefix += ["listCaseMailReceipts", "getCaseMailReceipt"].includes(name) ? ";constinput=" : ",input=";
    prefix += schemas[name] + ".parse(request.data);scope(input,companyId,session.uid);";
    const scope = section(code, "function scope(", "function receipt(");
    if (!has(scope, ['if(input.expectedCompanyId!==companyId||input.expectedActorUid!==uid){thrownewHttpsError("failed-precondition",'])) return false;
  }
  if (!readOnly) prefix += "awaitassertProductionOperational(companyId);";
  if (name !== "listCaseMailReceipts") prefix += "returndb.runTransaction(asynctx=>{";
  else prefix += 'letquery=db.collection("caseMailIntakeReceipts").where("companyId","==",companyId)';
  if (!block.startsWith(prefix)) return false;
  if (!readOnly && !whole.includes('import{assertProductionOperational}from"./system-safety";')) return false;
  if (readOnly && /\.(?:set|create|update|delete|add|commit)\(/.test(block)) return false;
  if (!original && !has(section(code, "function receipt(", "function summary("), [
    "ReceiptSchema.safeParse(raw)", "!parsed.success||parsed.data.companyId!==companyId",
  ])) return false;
  const requirements = {
    listCaseMailReceipts: ['.orderBy(FieldPath.documentId()).limit(26)', 'returndb.runTransaction(asynctx=>{constpage=awaittx.get(query);',
      'page.docs.slice(0,25).map(doc=>summary(doc.id,receipt(doc.data(),companyId)))'],
    getCaseMailReceipt: ['!snap.exists||snap.data()?.companyId!==companyId', 'candidate.companyId!==companyId',
      'candidate.receiptId!==input.receiptId', 'candidate.messageId!==record.messageId', 'candidate.sourceFingerprint!==record.sourceFingerprint',
      'job.companyId!==companyId', 'job.mailIntake?.receiptId!==input.receiptId', 'job.mailIntake?.candidateId!==candidateSnap.id',
      'savedTarget.companyId!==companyId', 'savedTarget.receiptId!==input.receiptId', 'savedTarget.candidateId!==candidateSnap.id',
      'caseMailTargetReader(tx,companyId,input.receiptId)', 'readCaseMailResolution(tx,companyId,input.receiptId,candidateSnap.id)'],
    getCaseMailTargetPreview: ['readTargetContext(tx,companyId,input)', 'readTargetResolution(tx,companyId,input,current)'],
    confirmCaseMailTarget: ['readTargetContext(tx,companyId,input)', 'current.saved.reviewVersion!==input.reviewVersion',
      'current.saved.actorUid!==session.uid', 'current.view.state!=="available"||current.reviewVersion!==input.reviewVersion',
      'tx.set(current.candidateRef,{targetBinding:binding},{merge:true})',
      'tx.set(current.auditRef,{companyId,actorUid:session.uid,action:"caseMail.target.confirm"'],
    holdCaseMailTarget: ['readTargetContext(tx,companyId,input)', 'audit.companyId!==companyId', 'audit.jobId!==input.jobId',
      'audit.reviewVersion!==input.reviewVersion', 'current.view.state!=="confirmed"||current.reviewVersion!==input.reviewVersion||!current.saved||current.job.mailTargetHold!=null',
      'tx.set(current.jobRef,caseMailTargetHoldPatch(current.job,hold,now),{merge:true})',
      'tx.set(auditRef,{companyId,actorUid:session.uid,action:"caseMail.target.hold"'],
    resolveCaseMailTargetHold: ['readTargetContext(tx,companyId,input)', 'readTargetResolution(tx,companyId,input,current)',
      'if(!resolution)fail();', 'resolution.saved.actorUid!==session.uid', 'resolution.saved.reviewVersion!==input.reviewVersion',
      '!resolution.view.canResolve||resolution.view.reviewVersion!==input.reviewVersion',
      'tx.set(current.jobRef,', 'tx.set(current.candidateRef,{targetResolution:saved},{merge:true})',
      'tx.set(resolution.auditRef,{companyId,actorUid:session.uid,action:"caseMail.target.resolve"',
      'publishable:false,recruitmentStopped:true'],
    confirmCaseMailReview: ['readCaseMailResolution(tx,companyId,input.receiptId,input.candidateId)',
      'if(view.jobId!==input.jobId)fail();', '!view.canConfirm||view.reviewVersion!==input.reviewVersion',
      'if((awaittx.get(auditRef)).exists)fail();', 'tx.set(jobRef,', 'publishable:false,recruitmentStopped:true',
      'tx.set(auditRef,{companyId,actorUid:session.uid,action:"caseMail.review.confirm"'],
  };
  if (!has(block, requirements[name])) return false;
  if (!readOnly) {
    const expectedWrites = name === "resolveCaseMailTargetHold" ? 3 : 2;
    const writes = [...block.matchAll(/\b([A-Za-z0-9_.]+)\.(set|create|update|delete|add|commit)\(/g)];
    if (writes.filter(m => m[1] === "tx" && m[2] === "set").length !== expectedWrites
        || writes.some(m => !(m[1] === "tx" && m[2] === "set") && !(m[1] === "FieldValue" && m[2] === "delete"))) return false;
  }
  if (!original && !["listCaseMailReceipts", "getCaseMailReceipt"].includes(name)) {
    const context = section(code, "async function readTargetContext(", "export const getCaseMailTargetPreview");
    if (!has(context, [
      'awaittx.getAll(', 'rawReceipt.companyId!==companyId', 'rawCandidate.companyId!==companyId', 'job.companyId!==companyId',
      'candidate.receiptId!==input.receiptId', 'candidate.messageId!==record.messageId',
      'saved.companyId!==companyId', 'audit.companyId!==companyId', 'parsed.data.companyId!==companyId',
      'binding.companyId!==companyId', 'owner.companyId!==companyId', 'originReceipt.companyId!==companyId', 'originCandidate.companyId!==companyId',
      'feature?.caseMailIntakeEnabled!==true', 'principal.companyId!==companyId', 'principal.uid!==record.ingestedBy',
      'principal.active!==true', 'principal.revision!==record.principalRevision',
      'caseMailTargetReader(tx,companyId,input.receiptId)',
    ]) || /\btx\.(?:set|create|update|delete)\(/.test(context)) return false;
  }
  if (["getCaseMailReceipt", "getCaseMailTargetPreview", "confirmCaseMailTarget", "holdCaseMailTarget", "resolveCaseMailTargetHold"].includes(name)) {
    const reader = compact(sourceFile("functions/src/case-mail-collision.ts").split("export function caseMailTargetReader(")[1] ?? "");
    if (!has(reader, ['db.collection("jobs").where("companyId","==",companyId)', 'job.companyId!==companyId',
      'days.size>=5', '.limit(201)', 'page.docs.slice(0,200)', 'items.length>=10'])) return false;
  }
  if (["getCaseMailTargetPreview", "resolveCaseMailTargetHold"].includes(name)) {
    const resolution = section(code, "async function readTargetResolution(", "export const resolveCaseMailTargetHold");
    if (!has(resolution, ['resolved.companyId!==companyId', 'audit.companyId!==companyId',
      'principal.companyId!==companyId', 'principal.active!==true', 'feature?.caseMailIntakeEnabled!==true',
      'caseMailResolutionIssue(input.jobId,job,source', 'lock.companyId!==companyId', 'lock.jobId!==input.jobId',
      'caseMailReviewAccepted(', 'caseMailRecordKey("case-mail-target-resolution-v1"'])) return false;
  }
  if (["getCaseMailReceipt", "confirmCaseMailReview"].includes(name)) {
    const resolutionSource = sourceFile("functions/src/case-mail-resolution.ts");
    const resolution = section(resolutionSource, "export async function readCaseMailResolution(", "export const confirmCaseMailReview");
    if (!has(resolution, ['receipt.companyId!==companyId', 'candidate.companyId!==companyId', 'candidate.receiptId!==receiptId',
      'job.companyId!==companyId', 'job.mailIntake?.receiptId!==receiptId', 'job.mailIntake?.candidateId!==candidateId',
      'owner.companyId!==companyId', 'principal.companyId!==companyId', 'principal.active!==true',
      'principal.revision!==receipt.principalRevision', 'feature?.caseMailIntakeEnabled!==true',
      'candidate.heldChange?.revision!==receipt.revision', 'lock.companyId!==companyId', 'lock.jobId!==jobId',
      'caseMailResolutionIssue(jobId,job,source', 'caseMailRecordKey(receipt,candidate,job,source??null,lock??null,principal,feature?.caseMailIntakeEnabled)'])) return false;
  }
  if (name === "holdCaseMailTarget" && !has(compact(sourceFile("functions/src/case-mail-target-hold.ts")),
    ['publishable:false,recruitmentStopped:true', 'mailTargetHold:hold,mailIntakeReviewRequired:true'])) return false;
  return true;
}

const checkers = {
  listCaseMailReceipts: () => checkCaseMail("listCaseMailReceipts"),
  getCaseMailReceipt: () => checkCaseMail("getCaseMailReceipt"),
  getCaseMailTargetPreview: () => checkCaseMail("getCaseMailTargetPreview"),
  confirmCaseMailTarget: () => checkCaseMail("confirmCaseMailTarget"),
  holdCaseMailTarget: () => checkCaseMail("holdCaseMailTarget"),
  resolveCaseMailTargetHold: () => checkCaseMail("resolveCaseMailTargetHold"),
  confirmCaseMailReview: () => checkCaseMail("confirmCaseMailReview"),

  submitPilotOutcome: () => checkPilotExpansionMutation("submitPilotOutcome"),
  decidePilotExpansion: () => checkPilotExpansionMutation("decidePilotExpansion"),
  getPilotReadiness: () => checkReadiness("getPilotReadiness"),
  getPilotExpansionReview: () => checkReadiness("getPilotExpansionReview"),
  getProductionControlStatus: () => checkReadiness("getProductionControlStatus"),
  getProductionSloDashboard: () => checkReadiness("getProductionSloDashboard"),
  inspectSetupWizard: () => checkSetupAudit("inspectSetupWizard"),
  saveSetupWizardDraft: () => checkSetupAudit("saveSetupWizardDraft"),
  getLoginInviteCandidates: () => checkSetupAudit("getLoginInviteCandidates"),
  sendLoginInvites: () => checkSetupAudit("sendLoginInvites"),
  previewMonthSheetCreation: () => checkSetupAudit("previewMonthSheetCreation"),
  createMonthSheetSafe: () => checkSetupAudit("createMonthSheetSafe"),
  getMonthCreationHistory: () => checkSetupAudit("getMonthCreationHistory"),
  previewSheetRowCreation: () => checkSetupAudit("previewSheetRowCreation"),
  listSheetWriteReviewRecords: () => checkSetupAudit("listSheetWriteReviewRecords"),
  runGasAudit: () => checkSetupAudit("runGasAudit"),
  scanGasUploadSafety: () => checkSetupAudit("scanGasUploadSafety"),
  exportGasAuditMarkdown: () => checkSetupAudit("exportGasAuditMarkdown"),
  getAutomationRegistry: () => checkExternalHandoff("getAutomationRegistry"),
  saveAutomationRegistry: () => checkExternalHandoff("saveAutomationRegistry"),
  cancelAutomationRegistryAttempt: () => checkExternalHandoff("cancelAutomationRegistryAttempt"),
  listHeldMailApplications: () => checkExternalHandoff("listHeldMailApplications"),
  getHeldMailApplication: () => checkExternalHandoff("getHeldMailApplication"),
  recheckHeldMailApplication: () => checkExternalHandoff("recheckHeldMailApplication"),
  cancelHeldMailApplicationReview: () => checkExternalHandoff("cancelHeldMailApplicationReview"),
  previewCaseMailCampaignRegistration: () => checkExternalHandoff("previewCaseMailCampaignRegistration"),
  registerCaseMailCampaign: () => checkExternalHandoff("registerCaseMailCampaign"),
  cancelCaseMailCampaignRegistration: () => checkExternalHandoff("cancelCaseMailCampaignRegistration"),
  getCaseMailImportSnapshot: () => checkExternalHandoff("getCaseMailImportSnapshot"),
  listAutomationNoticeReceipts: () => checkExternalHandoff("listAutomationNoticeReceipts"),
  getAutomationNoticeHandoff: () => checkExternalHandoff("getAutomationNoticeHandoff"),
  receiveCaseMailApplication: () => checkExternalHandoff("receiveCaseMailApplication"),
  receiveAutomationNoticeReceipt: () => checkExternalHandoff("receiveAutomationNoticeReceipt"),
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
  loginGateway: checkLoginGateway,
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

checkers.retrySafeSheetWrites = () => {
  try { assertRetryWorkerSource(sourceFile); return true; } catch { return false; }
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
  const label = name === "retrySafeSheetWrites" ? "SCHEDULED_SOURCE" : "APP_LEVEL_AUTH";
  console.log(`${label}_${name}=${passed ? "PASS" : "FAIL"}`);
}
console.log(`APP_CHECK_ENFORCED=${appCheckEnforced ? "true" : "false"}`);
console.log("APP_CHECK_HANDLING=Firebase Auth, company boundaries, user-owned push tokens, scoped preview tokens, or trusted event identity checks are enforced by function type.");
if (requestedFunctions.includes("retrySafeSheetWrites")) console.log("SCHEDULED_RUNTIME_IAM=NOT_VERIFIED_BY_SOURCE_GUARD");
console.log(`SOURCE_GUARD_STATUS=${allPass ? "PASS" : "FAIL"}`);

if (requirePass && !allPass) process.exitCode = 1;
