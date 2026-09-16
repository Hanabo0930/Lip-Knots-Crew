import "./test-login-entrypoint-auth-guard.mjs";
import "./test-bootstrap-auth-guard.mjs";
import "./test-pilot-expansion-auth-guard.mjs";
import "./test-readiness-auth-guard.mjs";
import "./test-setup-audit-auth-guard.mjs";
import "./test-staging-firebase-deploy.mjs";
import "./test-external-handoff-auth-guard.mjs";
import "./test-import-issues-auth-guard.mjs";
import "./test-admin-core-auth-guard.mjs";
import './test-staff-journey-auth-guard.mjs';
import './test-business-recovery-auth-guard.mjs';
import './test-resubmission-auth-guard.mjs';
import './test-confirm-application-auth-guard.mjs';
import "./test-transfer-auth-guard.mjs";
import "./test-staging-transfer-mode.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safetyConfig } from "./validate-staging-scope.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");

const expectedFunctions = [
  "bootstrapSession",
  "requestStaffLoginLink",
  "getSubmissionTimeline",
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
  "confirmApplication",
  "createResubmissionRequest",
  "getMyResubmissionRequests",
  "getAdminResubmissionRequests",
  "completeResubmissionRequest",
  "getExpenseReview",
  "saveExpenseReviewDraft",
  "completeExpenseReview",
  "getJobSheetLink",
  "markNetPrintPrinted",
  "adminCancelJob",
  "duplicateAdminJob",
  "createUploadSession",
  "applyToJob",
  "getMyTasks",
  "listMyMailApplications",
  "setSalesFloorClientSubmitted",
  "submitPreContact",
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
  "previewStaffImport",
  "syncStaffDirectoryReadOnly",
  "previewShiftImport",
  "syncShiftSheetsReadOnly",
  "retrySheetWriteIssue",
  "acknowledgeSheetWriteIssue",
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
  "getPilotReadiness",
  "getPilotExpansionReview",
  "getProductionControlStatus",
  "getProductionSloDashboard",
  "submitPilotOutcome",
  "decidePilotExpansion",
  "loginGateway",
];

assert.deepEqual(
  safetyConfig.allowedFunctions,
  expectedFunctions,
  "Functions allowlist must remain exact and ordered",
);

const workflow = read(".github/workflows/staging-functions-deploy.yml");
assert.match(
  workflow,
  /source_ref:[\s\S]*?default:\s*main/,
  "Functions deploy must default to the CI-passing main branch",
);
assert.match(
  workflow,
  /functions:[\s\S]*?default:\s*bootstrapSession/,
  "Functions deploy must default to bootstrapSession only",
);
assert.match(
  workflow,
  /environment:\s*lkc-staging-deploy/,
  "Functions deploy must retain the protected staging environment",
);
assert.match(
  workflow,
  /--functions "\$LKC_FUNCTIONS"/,
  "source authorization must inspect the exact requested Functions",
);
assert.match(
  workflow,
  /LKC_FUNCTIONS_GMAIL_DELEGATED_USER:\s*\$\{\{\s*secrets\.LKC_FUNCTIONS_GMAIL_DELEGATED_USER\s*\}\}/,
  "Functions deploy must preserve the delegated Gmail user from a protected secret",
);
assert.match(
  workflow,
  /printf 'GMAIL_DELEGATED_USER=%s\\n' "\$LKC_FUNCTIONS_GMAIL_DELEGATED_USER"/,
  "Functions dotenv must materialize GMAIL_DELEGATED_USER",
);

const deployScript = read("scripts/automation/deploy-staging-functions.sh");
assert.match(
  deployScript,
  /bootstrapSession\)\s+service_name="bootstrapsession"/,
  "bootstrapSession must map to its exact Cloud Run service",
);
assert.match(
  deployScript,
  /requestStaffLoginLink\)\s+service_name="requeststaffloginlink"/,
  "requestStaffLoginLink must map to its exact Cloud Run service",
);
assert.match(
  deployScript,
  /listMyDevices\)\s+service_name="listmydevices"/,
  "listMyDevices must map to its exact Cloud Run service",
);
for (const [functionName, serviceName] of [
  ["getAutomationRegistry", "getautomationregistry"],
  ["saveAutomationRegistry", "saveautomationregistry"],
  ["cancelAutomationRegistryAttempt", "cancelautomationregistryattempt"],
  ["listHeldMailApplications", "listheldmailapplications"],
  ["getHeldMailApplication", "getheldmailapplication"],
  ["recheckHeldMailApplication", "recheckheldmailapplication"],
  ["cancelHeldMailApplicationReview", "cancelheldmailapplicationreview"],
  ["previewCaseMailCampaignRegistration", "previewcasemailcampaignregistration"],
  ["registerCaseMailCampaign", "registercasemailcampaign"],
  ["cancelCaseMailCampaignRegistration", "cancelcasemailcampaignregistration"],
  ["getCaseMailImportSnapshot", "getcasemailimportsnapshot"],
  ["listAutomationNoticeReceipts", "listautomationnoticereceipts"],
  ["getAutomationNoticeHandoff", "getautomationnoticehandoff"],
  ["receiveCaseMailApplication", "receivecasemailapplication"],
  ["receiveAutomationNoticeReceipt", "receiveautomationnoticereceipt"],
  ["inspectSetupWizard", "inspectsetupwizard"],
  ["saveSetupWizardDraft", "savesetupwizarddraft"],
  ["getLoginInviteCandidates", "getlogininvitecandidates"],
  ["sendLoginInvites", "sendlogininvites"],
  ["previewMonthSheetCreation", "previewmonthsheetcreation"],
  ["createMonthSheetSafe", "createmonthsheetsafe"],
  ["getMonthCreationHistory", "getmonthcreationhistory"],
  ["previewSheetRowCreation", "previewsheetrowcreation"],
  ["listSheetWriteReviewRecords", "listsheetwritereviewrecords"],
  ["runGasAudit", "rungasaudit"],
  ["scanGasUploadSafety", "scangasuploadsafety"],
  ["exportGasAuditMarkdown", "exportgasauditmarkdown"],
  ["getPilotReadiness", "getpilotreadiness"],
  ["getPilotExpansionReview", "getpilotexpansionreview"],
  ["getProductionControlStatus", "getproductioncontrolstatus"],
  ["getProductionSloDashboard", "getproductionslodashboard"],
  ["submitPilotOutcome", "submitpilotoutcome"],
  ["decidePilotExpansion", "decidepilotexpansion"],
  ["loginGateway", "logingateway"],
  ["previewStaffImport", "previewstaffimport"],
  ["syncStaffDirectoryReadOnly", "syncstaffdirectoryreadonly"],
  ["previewShiftImport", "previewshiftimport"],
  ["syncShiftSheetsReadOnly", "syncshiftsheetsreadonly"],
  ["retrySheetWriteIssue", "retrysheetwriteissue"],
  ["acknowledgeSheetWriteIssue", "acknowledgesheetwriteissue"],
  ["applyToJob", "applytojob"],
  ["getMyTasks", "getmytasks"],
  ["listMyMailApplications", "listmymailapplications"],
  ["setSalesFloorClientSubmitted", "setsalesfloorclientsubmitted"],
  ["submitPreContact", "submitprecontact"],
  ["getSheetWriteIssues", "getsheetwriteissues"],
  ["getOperationsDashboard", "getoperationsdashboard"],
  ["getStaffPerformance", "getstaffperformance"],
  ["createAdminJobGroup", "createadminjobgroup"],
  ["updateJobPublication", "updatejobpublication"],
  ["adminEditJobInputs", "admineditjobinputs"],
  ["generateJobExport", "generatejobexport"],
  ["updateNetPrintNumbers", "updatenetprintnumbers"],
  ["adminSetJobCancellation", "adminsetjobcancellation"],
  ["adminRestoreCancelledJob", "adminrestorecancelledjob"],
  ["createUploadSession", "createuploadsession"],
  ["getExpenseReview", "getexpensereview"],
  ["saveExpenseReviewDraft", "saveexpensereviewdraft"],
  ["completeExpenseReview", "completeexpensereview"],
  ["getJobSheetLink", "getjobsheetlink"],
  ["markNetPrintPrinted", "marknetprintprinted"],
  ["adminCancelJob", "admincanceljob"],
  ["duplicateAdminJob", "duplicateadminjob"],
  ["confirmApplication", "confirmapplication"],
  ["createResubmissionRequest", "createresubmissionrequest"],
  ["getMyResubmissionRequests", "getmyresubmissionrequests"],
  ["getAdminResubmissionRequests", "getadminresubmissionrequests"],
  ["completeResubmissionRequest", "completeresubmissionrequest"],
  ["registerDeviceSession", "registerdevicesession"],
  ["heartbeatDeviceSession", "heartbeatdevicesession"],
  ["revokeMyDevice", "revokemydevice"],
  ["revokeAllMyDevices", "revokeallmydevices"],
  ["getStaffDevices", "getstaffdevices"],
  ["adminRevokeStaffDevices", "adminrevokestaffdevices"],
  ["registerPushToken", "registerpushtoken"],
  ["unregisterPushToken", "unregisterpushtoken"],
  ["getPushStatus", "getpushstatus"],
  ["sendTestPush", "sendtestpush"],
]) {
  assert.match(
    deployScript,
    new RegExp(`${functionName}\\)\\s+service_name="${serviceName}"`),
    `${functionName} must map to its exact Cloud Run service`,
  );
}
assert.match(
  deployScript,
  /processNotificationQueue\)\s+service_name=""/,
  "processNotificationQueue must remain a non-public Firestore event trigger",
);
assert.match(
  deployScript,
  /allUsers[\s\S]*allAuthenticatedUsers/,
  "post-deploy verification must reject public IAM bindings",
);

const bootstrapScript = read("scripts/automation/bootstrap-github-wif.sh");
assert.match(
  bootstrapScript,
  /for function_name in \\\n\s+bootstrapSession \\/,
  "WIF bootstrap must discover bootstrapSession runtime and build identities",
);
assert.match(
  bootstrapScript,
  /for function_name in \\\n\s+bootstrapSession \\\n\s+requestStaffLoginLink \\/,
  "WIF bootstrap must discover requestStaffLoginLink runtime and build identities",
);
assert.match(
  bootstrapScript,
  /roles\/datastore\.viewer/,
  "staging observer must be able to verify the sanitized delivery record",
);

const authGuard = read("scripts/automation/check-function-auth-guards.mjs");
assert.match(
  authGuard,
  /bootstrapSession:\s*checkBootstrapSession/,
  "source guard must report bootstrapSession authorization",
);
assert.match(
  authGuard,
  /requestStaffLoginLink:\s*checkRequestStaffLoginLink/,
  "source guard must report requestStaffLoginLink authorization",
);
assert.match(
  authGuard,
  /listMyDevices:\s*checkListMyDevices/,
  "source guard must report listMyDevices authorization",
);
for (const [functionName, checkerName] of [
  ["registerDeviceSession", "checkRegisterDeviceSession"],
  ["heartbeatDeviceSession", "checkHeartbeatDeviceSession"],
  ["revokeMyDevice", "checkRevokeMyDevice"],
  ["revokeAllMyDevices", "checkRevokeAllMyDevices"],
  ["getStaffDevices", "checkGetStaffDevices"],
  ["adminRevokeStaffDevices", "checkAdminRevokeStaffDevices"],
  ["registerPushToken", "checkRegisterPushToken"],
  ["unregisterPushToken", "checkUnregisterPushToken"],
  ["getPushStatus", "checkGetPushStatus"],
  ["sendTestPush", "checkSendTestPush"],
  ["processNotificationQueue", "checkProcessNotificationQueue"],
]) {
  assert.match(
    authGuard,
    new RegExp(`${functionName}:\\s*${checkerName}`),
    `source guard must report ${functionName} authorization`,
  );
}

const staffApp = read("apps/staff/src/App.tsx");
assert.match(
  staffApp,
  /httpsCallable\(activeFunctions,"heartbeatDeviceSession"\)\(\{sessionId:deviceSessionId\}\)/,
  "Staff must call the heartbeat Function for the server-issued device session",
);
assert.match(
  staffApp,
  /DEVICE_HEARTBEAT_INTERVAL_MS=5\*60\*1000/,
  "Staff heartbeat must use the fixed five-minute interval",
);
assert.match(
  staffApp,
  /document\.visibilityState==="visible"[\s\S]*?heartbeat\(\)/,
  "Staff must refresh device activity when the tab becomes visible",
);
const revokedHandler = staffApp.match(/const handleRevoked=async[\s\S]*?(?=\s*const heartbeat=async)/)?.[0];
const heartbeatHandler = staffApp.match(/const heartbeat=async[\s\S]*?(?=\s*const stopWatching=)/)?.[0];
assert.ok(revokedHandler && heartbeatHandler, "Staff revocation and heartbeat handlers must exist");
assert.match(
  heartbeatHandler,
  /if\(code\.endsWith\("permission-denied"\)\)await handleRevoked\(/,
  "A revoked device heartbeat must invoke the revocation handler",
);
assert.match(
  revokedHandler,
  /try\{await signOut\(activeAuth\);revocationCompleted=true;\}/,
  "The revocation handler must sign out before marking revocation completed",
);
assert.match(
  staffApp,
  /stopWatching\?\.\(\)/,
  "Device session monitoring must be cleaned up",
);

const guardedOutput = execFileSync(
  process.execPath,
  [
    "scripts/automation/check-function-auth-guards.mjs",
    "--repository", root,
    "--ref", "HEAD",
    "--functions", expectedFunctions.join(","),
    "--require-pass",
  ],
  { cwd: root, encoding: "utf8" },
);
assert.match(
  guardedOutput,
  /SOURCE_GUARD_STATUS=PASS/,
  "every allowlisted Function must pass its source authorization guard",
);

console.log("Functions automation safety tests passed (device/session scope included)");
