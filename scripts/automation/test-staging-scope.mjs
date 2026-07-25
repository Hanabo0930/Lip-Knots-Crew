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
];

for (const plan of rejectedPlans) {
  assert.throws(() => validatePlan(plan));
}

console.log(`staging automation safety tests passed (${4 + rejectedPlans.length} cases)`);

