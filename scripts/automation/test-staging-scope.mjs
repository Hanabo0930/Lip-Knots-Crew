import assert from "node:assert/strict";
import { safetyConfig, validatePlan } from "./validate-staging-scope.mjs";

const base = {
  project: safetyConfig.projectId,
  region: safetyConfig.region,
  sourceRef: "cursor/staging-preview-performance-20260724",
};

assert.equal(validatePlan({ ...base, mode: "ci" }).mode, "ci");

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

console.log(`staging automation safety tests passed (${6 + rejectedPlans.length} cases)`);
