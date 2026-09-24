import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { assertSheetWorkerRecovery } from "./validate-staging-sheet-worker.mjs";
import { PROJECT, REGION, TARGET, PREFIX, FUNCTION, SERVICE, JOB, assertIdentity, assertRecoveryBefore, assertReadyFunction,
  assertReadyService, assertExistingInvoker, assertScheduler, verifyRecoveryServiceAgents, installRecoveryAdapters } from "./retry-worker-recovery-core.mjs";
const require = createRequire(import.meta.url);
const fail = code => { throw Error(code); };
const FN_FIELDS = "name,state,environment,buildConfig.runtime,buildConfig.entryPoint,serviceConfig.service,serviceConfig.serviceAccountEmail,serviceConfig.revision,serviceConfig.uri,serviceConfig.timeoutSeconds,serviceConfig.secretEnvironmentVariables,serviceConfig.environmentVariables.APP_ENVIRONMENT,serviceConfig.environmentVariables.EXPECTED_FIREBASE_PROJECT_ID,serviceConfig.environmentVariables.LKC_SHEET_WRITE_MODE,serviceConfig.environmentVariables.LKC_NOTIFICATION_DELIVERY_MODE";
// 配列は親フィールドを取得する。子だけの投影はnullや配列欠落になる。
const SERVICE_FIELDS = "metadata.name,metadata.annotations,status,spec.template.spec.serviceAccountName,spec.template.spec.containers";

// 任意コマンドは受け付けず、固定資源の読取だけを実装する。stderrやpolicy本文を表示しない。
export function recoveryReader(execute = (args) => execFileSync("gcloud", args, {encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "pipe"]})) {
  function read(args, optional = false) {
    try { return JSON.parse(execute(args)); }
    catch (error) {
      const message = String(error.stderr ?? "").trim();
      const missingRun = args[0] === "run" && /^ERROR: \(gcloud\.run\.services\.describe\) Cannot find service \[retrysafesheetwrites\]\.?$/.test(message);
      const missingJob = args[0] === "scheduler" && /\bNOT_FOUND\b/.test(message);
      if (optional && (missingRun || missingJob) && !/PERMISSION_DENIED|UNAUTHENTICATED/.test(message)) return null;
      fail("RETRY_METADATA_READ_FAILED");
    }
  }
  const fn = () => read(["functions", "describe", TARGET, "--gen2", `--project=${PROJECT}`, `--region=${REGION}`, `--format=json(${FN_FIELDS})`]);
  const service = () => read(["run", "services", "describe", "retrysafesheetwrites", `--project=${PROJECT}`, `--region=${REGION}`, `--format=json(${SERVICE_FIELDS})`], true);
  const job = () => read(["scheduler", "jobs", "describe", `firebase-schedule-${TARGET}-${REGION}`, `--project=${PROJECT}`, `--location=${REGION}`, "--format=json(name,state,schedule,timeZone,httpTarget.uri,httpTarget.httpMethod,httpTarget.oidcToken,httpTarget.oauthToken,httpTarget.body,pubsubTarget)"], true);
  // etag/versionを含め、bindingがないサービスの有効なpolicyも保持する。
  const projectPolicy = () => read(["projects", "get-iam-policy", PROJECT, "--format=json(bindings,etag,version)"]);
  // CLIのAPI有効化キャッシュを使わず、固定projectの現在の状態を読む。
  const enabledServices = () => read(["services", "list", "--enabled", `--project=${PROJECT}`, "--format=json(config.name,state)"]);
  const assertPrivateService = () => {
    const policy = read(["run", "services", "get-iam-policy", "retrysafesheetwrites", `--project=${PROJECT}`, `--region=${REGION}`, "--format=json(bindings,etag,version)"]);
    if (!policy || typeof policy !== "object" || Array.isArray(policy) || (!Array.isArray(policy.bindings) && policy.bindings !== undefined)) fail("RETRY_RUN_POLICY_UNKNOWN");
    if ((policy.bindings ?? []).some(b => b.members?.some(m => ["allUsers", "allAuthenticatedUsers"].includes(m)))) fail("RETRY_PUBLIC_BINDING_FOUND");
  };
  return {fn, service, job, projectPolicy, enabledServices, assertPrivateService, before() {
    const project = read(["projects", "describe", PROJECT, "--format=json(projectId,projectNumber)"]);
    if (project.projectId !== PROJECT) fail("RETRY_PROJECT_MISMATCH");
    const identity = read(["compute", "project-info", "describe", `--project=${PROJECT}`, "--format=json(defaultServiceAccount)"]).defaultServiceAccount;
    return {projectNumber: String(project.projectNumber), identity, fn: fn(), service: service(), job: job(), projectPolicy: projectPolicy()};
  }};
}
export function loadRecoveryModules(cliRoot) {
  const load = name => require(path.join(cliRoot, "lib", name));
  const {Client} = load("apiv2.js");
  const schedulerClient = new Client({urlPrefix: "https://cloudscheduler.googleapis.com", apiVersion: "v1"});
  // create APIは同名資源があれば409で止まる。CLIのcreateOrReplaceによる上書きを使わない。
  const createScheduler = job => schedulerClient.post(`/${PREFIX}/jobs`, job);
  return {createScheduler, run: load("gcp/run.js"), gcf: load("gcp/cloudfunctionsv2.js"), scheduler: load("gcp/cloudscheduler.js"),
    fabricator: load("deploy/functions/release/fabricator.js").Fabricator.prototype, ensureApi: load("ensureApiEnabled.js"),
    compute: load("gcp/computeEngine.js"), resourceManager: load("gcp/resourceManager.js"), iam: load("gcp/iam.js"),
    serviceUsage: load("gcp/serviceusage.js"), artifacts: load("functions/artifacts.js")};
}
export async function verifyRecoveryAfter(read, context) {
  const fn = await read.fn(); assertReadyFunction(fn, context);
  assertReadyService(await read.service(), fn, context);
  await read.assertPrivateService();
  assertExistingInvoker(await read.projectPolicy(), context.identity);
  assertScheduler(await read.job(), fn, context, true);
  await verifyRecoveryServiceAgents(read, context);
  return {retryRecovery: "paused-configuration-verified", businessInvocation: false, iamWritten: false,
    authentication: "configuration-only-not-invoked", serviceAgents: "api-and-role-bindings-only", sourceSha: context.sourceSha};
}
export async function runRetryWorkerRecovery({cliRoot, plan, source, sourceSha}, dependencies = {}) {
  // この関数へ来る前にも既存validatePlanが必要。内部入口でも独立に再確認する。
  const {validatePlan} = await import("./validate-staging-scope.mjs");
  validatePlan({mode: "functions-deploy", project: plan.project, region: plan.region, sourceRef: plan.sourceRef,
    functions: plan.functions.join(","), confirmation: process.env.LKC_CONFIRMATION});
  if (plan.sourceRef !== "main" || plan.functions.length !== 1 || plan.functions[0] !== TARGET || !/^[0-9a-f]{40}$/.test(sourceSha ?? "")) fail("RETRY_VERIFIED_MAIN_REQUIRED");
  const pkg = JSON.parse(fs.readFileSync(path.join(cliRoot, "package.json"), "utf8"));
  if (pkg.name !== "firebase-tools" || pkg.version !== "15.24.0") fail("RETRY_PINNED_CLI_REQUIRED");
  if (execFileSync("git", ["rev-parse", "HEAD"], {cwd: source, encoding: "utf8"}).trim() !== sourceSha ||
      execFileSync("git", ["diff", "HEAD", "--name-only"], {cwd: source, encoding: "utf8"}).trim()) fail("RETRY_SOURCE_COMMIT_MISMATCH");
  assertSheetWorkerRecovery(plan, source);
  const read = dependencies.read ?? recoveryReader();
  const snapshot = await read.before(); assertRecoveryBefore(snapshot);
  const context = Object.freeze({identity: snapshot.identity, projectNumber: snapshot.projectNumber, sourceSha});
  assertIdentity(context.identity, context.projectNumber);
  const status = installRecoveryAdapters(dependencies.modules ?? loadRecoveryModules(cliRoot), context, read);
  const cwd = process.cwd();
  try {
    process.chdir(source);
    const deploy = dependencies.deploy ?? require(path.join(cliRoot, "lib/commands/deploy.js")).command.runner();
    // 正規command.runnerを使い、CLIの認証・権限・config/only検査を維持する。
    await deploy({project: PROJECT, only: `functions:${TARGET}`, nonInteractive: true});
    status.assertCompleted();
    assertSheetWorkerRecovery(plan, source);
    return await verifyRecoveryAfter(read, context);
  } finally { process.chdir(cwd); }
}
