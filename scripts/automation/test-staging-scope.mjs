import assert from "node:assert/strict";
import { safetyConfig, validatePlan } from "./validate-staging-scope.mjs";

const base = {
  project: safetyConfig.projectId,
  region: safetyConfig.region,
  sourceRef: "cursor/staging-preview-performance-20260724",
};

assert.equal(validatePlan({ ...base, mode: "ci" }).mode, "ci");

assert.deepEqual(safetyConfig.invokerDiagnosticServices, [
  "getsubmissiontimeline",
  "requeststaffloginlink",
  "getsubmissionprocessingstatus",
  "drivefilepreview",
]);

assert.deepEqual(safetyConfig.invokerMutableServices, [
  "requeststaffloginlink",
  "getsubmissionprocessingstatus",
  "drivefilepreview",
]);

assert.deepEqual(
  validatePlan({
    ...base,
    mode: "invoker-diagnose",
    services: safetyConfig.invokerDiagnosticServices.join(","),
  }).services,
  safetyConfig.invokerDiagnosticServices,
);

assert.deepEqual(
  validatePlan({
    ...base,
    mode: "invoker-apply",
    services: [...safetyConfig.invokerMutableServices].reverse().join(","),
    confirmation: safetyConfig.confirmations.invokerApply,
  }).services,
  [...safetyConfig.invokerMutableServices].reverse(),
);

assert.deepEqual(
  validatePlan({
    ...base,
    mode: "functions-deploy",
    functions: "getSubmissionTimeline,driveFilePreview",
    confirmation: safetyConfig.confirmations.functionsDeploy,
  }).functions,
  ["getSubmissionTimeline", "driveFilePreview"],
);

assert.deepEqual(
  validatePlan({
    ...base,
    sourceRef: "main",
    mode: "functions-deploy",
    functions: "requestStaffLoginLink",
    confirmation: safetyConfig.confirmations.functionsDeploy,
  }).functions,
  ["requestStaffLoginLink"],
);

assert.deepEqual(
  validatePlan({
    ...base,
    sourceRef: "main",
    mode: "functions-deploy",
    functions: "bootstrapSession",
    confirmation: safetyConfig.confirmations.functionsDeploy,
  }).functions,
  ["bootstrapSession"],
);

assert.deepEqual(
  validatePlan({
    ...base,
    sourceRef: "main",
    mode: "functions-deploy",
    functions: "listMyDevices",
    confirmation: safetyConfig.confirmations.functionsDeploy,
  }).functions,
  ["listMyDevices"],
);

assert.deepEqual(
  validatePlan({
    ...base,
    sourceRef: "main",
    mode: "functions-deploy",
    functions: "registerDeviceSession,heartbeatDeviceSession,revokeMyDevice,revokeAllMyDevices,getStaffDevices,adminRevokeStaffDevices",
    confirmation: safetyConfig.confirmations.functionsDeploy,
  }).functions,
  [
    "registerDeviceSession",
    "heartbeatDeviceSession",
    "revokeMyDevice",
    "revokeAllMyDevices",
    "getStaffDevices",
    "adminRevokeStaffDevices",
  ],
);

assert.deepEqual(
  validatePlan({
    ...base,
    sourceRef: "main",
    mode: "functions-deploy",
    functions: "registerPushToken,unregisterPushToken,getPushStatus,sendTestPush,processNotificationQueue",
    confirmation: safetyConfig.confirmations.functionsDeploy,
  }).functions,
  [
    "registerPushToken",
    "unregisterPushToken",
    "getPushStatus",
    "sendTestPush",
    "processNotificationQueue",
  ],
);

assert.equal(
  validatePlan({
    ...base,
    sourceRef: "main",
    mode: "gmail-smoke",
    confirmation: safetyConfig.confirmations.gmailSmoke,
  }).mode,
  "gmail-smoke",
);

assert.deepEqual(
  validatePlan({
    ...base,
    sourceRef: "main",
    mode: "hosting-preview",
    targets: "staff,admin",
    channel: "rc-02516b6e28e4",
  }).targets,
  ["staff", "admin"],
);

assert.equal(
  validatePlan({
    ...base,
    sourceRef: "main",
    mode: "hosting-promote",
    targets: "admin,staff",
    channel: "rc-02516b6e28e4",
    confirmation: safetyConfig.confirmations.hostingPromote,
  }).mode,
  "hosting-promote",
);

const rejectedPlans = [
  { ...base, mode: "ci", project: "lip-knots-crew-production" },
  { ...base, mode: "ci", region: "us-central1" },
  { ...base, mode: "ci", sourceRef: "../../main" },
  { ...base, mode: "invoker-diagnose", services: "drivefilepreview" },
  {
    ...base,
    mode: "invoker-apply",
    services: "getsubmissionprocessingstatus,drivefilepreview",
    confirmation: safetyConfig.confirmations.invokerApply,
  },
  {
    ...base,
    mode: "invoker-apply",
    services: safetyConfig.invokerMutableServices.join(","),
    confirmation: "wrong",
  },
  {
    ...base,
    mode: "functions-deploy",
    functions: "unknownFunction",
    confirmation: safetyConfig.confirmations.functionsDeploy,
  },
  {
    ...base,
    mode: "gmail-smoke",
    confirmation: safetyConfig.confirmations.gmailSmoke,
  },
  {
    ...base,
    sourceRef: "main",
    mode: "gmail-smoke",
    confirmation: "wrong",
  },
  {
    ...base,
    mode: "hosting-preview",
    targets: "staff,admin",
    channel: "rc-02516b6e28e4",
  },
  {
    ...base,
    sourceRef: "main",
    mode: "hosting-preview",
    targets: "staff",
    channel: "rc-02516b6e28e4",
  },
  {
    ...base,
    sourceRef: "main",
    mode: "hosting-promote",
    targets: "staff,admin",
    channel: "rc-../../main",
    confirmation: safetyConfig.confirmations.hostingPromote,
  },
  {
    ...base,
    sourceRef: "main",
    mode: "hosting-promote",
    targets: "staff,admin",
    channel: "rc-02516b6e28e4",
    confirmation: "wrong",
  },
];

for (const plan of rejectedPlans) {
  assert.throws(() => validatePlan(plan));
}

console.log(`staging automation safety tests passed (${13 + rejectedPlans.length} cases)`);

const recoveredFunctions=["confirmApplication","createResubmissionRequest","getMyResubmissionRequests","getAdminResubmissionRequests","completeResubmissionRequest"];
assert.deepEqual(validatePlan({...base, sourceRef:"main", mode:"functions-deploy", functions:recoveredFunctions.join(","), confirmation:safetyConfig.confirmations.functionsDeploy}).functions,recoveredFunctions);
assert.throws(()=>validatePlan({...base,mode:"functions-deploy",functions:[...recoveredFunctions,"retrySafeSheetWrites"].join(","),confirmation:safetyConfig.confirmations.functionsDeploy}),/FUNCTIONS_NOT_ALLOWED:retrySafeSheetWrites/);

const businessRecoveryFunctions=["getExpenseReview","saveExpenseReviewDraft","completeExpenseReview","getJobSheetLink","markNetPrintPrinted","adminCancelJob","duplicateAdminJob"];
assert.deepEqual(validatePlan({...base,sourceRef:"main",mode:"functions-deploy",functions:businessRecoveryFunctions.join(","),confirmation:safetyConfig.confirmations.functionsDeploy}).functions,businessRecoveryFunctions);

assert.deepEqual(validatePlan({...base,sourceRef:"main",mode:"functions-deploy",functions:"createUploadSession,finalizeStagedUpload",confirmation:safetyConfig.confirmations.functionsDeploy}).functions,["createUploadSession","finalizeStagedUpload"]);

const staffJourneyFunctions=["applyToJob","getMyTasks","listMyMailApplications","setSalesFloorClientSubmitted","submitPreContact"];
assert.deepEqual(validatePlan({...base,sourceRef:"main",mode:"functions-deploy",functions:staffJourneyFunctions.join(","),confirmation:safetyConfig.confirmations.functionsDeploy}).functions,staffJourneyFunctions);

const adminCoreFunctions=["getSheetWriteIssues","getOperationsDashboard","getStaffPerformance","createAdminJobGroup","updateJobPublication","adminEditJobInputs","generateJobExport","updateNetPrintNumbers","adminSetJobCancellation","adminRestoreCancelledJob"];
assert.deepEqual(validatePlan({...base,sourceRef:"main",mode:"functions-deploy",functions:adminCoreFunctions.join(","),confirmation:safetyConfig.confirmations.functionsDeploy}).functions,adminCoreFunctions);

const importIssueFunctions=["previewStaffImport","syncStaffDirectoryReadOnly","previewShiftImport","syncShiftSheetsReadOnly","retrySheetWriteIssue","acknowledgeSheetWriteIssue"];
assert.deepEqual(validatePlan({...base,sourceRef:"main",mode:"functions-deploy",functions:importIssueFunctions.join(","),confirmation:safetyConfig.confirmations.functionsDeploy}).functions,importIssueFunctions);
