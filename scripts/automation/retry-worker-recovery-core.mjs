export const PROJECT = "lip-knots-crew-staging", REGION = "asia-northeast1", TARGET = "retrySafeSheetWrites";
export const PREFIX = `projects/${PROJECT}/locations/${REGION}`;
export const FUNCTION = `${PREFIX}/functions/${TARGET}`, SERVICE = `${PREFIX}/services/retrysafesheetwrites`;
export const JOB = `${PREFIX}/jobs/firebase-schedule-${TARGET}-${REGION}`;
const fail = code => { throw Error(code); };
export function assertPaused(env) {
  if (env?.APP_ENVIRONMENT !== "staging" || env.EXPECTED_FIREBASE_PROJECT_ID !== PROJECT ||
      env.LKC_SHEET_WRITE_MODE !== "paused" || env.LKC_NOTIFICATION_DELIVERY_MODE !== "paused") fail("RETRY_PAUSE_REQUIRED");
}
export function assertIdentity(identity, projectNumber) {
  if (!/^[0-9]+$/.test(projectNumber) || identity !== `${projectNumber}-compute@developer.gserviceaccount.com`) fail("RETRY_IDENTITY_NOT_VERIFIED");
}
export function assertExistingInvoker(policy, identity) {
  if (!Array.isArray(policy?.bindings)) fail("RETRY_INVOKER_POLICY_UNKNOWN");
  if (policy.bindings.some(b => b.members?.some(m => ["allUsers", "allAuthenticatedUsers"].includes(m)))) fail("RETRY_PUBLIC_BINDING_FOUND");
  if (!policy.bindings.some(b => b.role === "roles/run.invoker" && !b.condition && b.members?.includes(`serviceAccount:${identity}`))) fail("RETRY_EXISTING_INVOKER_REQUIRED");
}
export function assertRecoveryBefore(snapshot) {
  assertIdentity(snapshot.identity, snapshot.projectNumber);
  if (snapshot.fn?.name !== FUNCTION || snapshot.fn.state !== "FAILED" || snapshot.fn.environment !== "GEN_2" ||
      snapshot.fn.buildConfig?.runtime !== "nodejs22" || snapshot.fn.buildConfig?.entryPoint !== TARGET ||
      snapshot.fn.serviceConfig?.service || snapshot.fn.serviceConfig?.revision || snapshot.service !== null || snapshot.job !== null) fail("RETRY_MISSING_RECOVERY_STATE_REQUIRED");
  assertExistingInvoker(snapshot.projectPolicy, snapshot.identity);
}
export function assertEndpoint(endpoint, context) {
  if (endpoint?.id !== TARGET || endpoint.project !== PROJECT || endpoint.region !== REGION || endpoint.platform !== "gcfv2" ||
      endpoint.runtime !== "nodejs22" || endpoint.entryPoint !== TARGET || endpoint.timeoutSeconds !== 300 ||
      endpoint.scheduleTrigger?.schedule !== "every 5 minutes" || endpoint.scheduleTrigger?.timeZone !== "Asia/Tokyo" ||
      Object.keys(endpoint.scheduleTrigger).some(k => !["schedule", "timeZone"].includes(k)) ||
      (endpoint.serviceAccount != null && endpoint.serviceAccount !== context.identity) ||
      ["httpsTrigger", "callableTrigger", "eventTrigger", "taskQueueTrigger", "blockingTrigger"].some(k => endpoint[k] != null) ||
      endpoint.secretEnvironmentVariables?.length) fail("RETRY_ENDPOINT_SCOPE_INVALID");
  assertPaused(endpoint.environmentVariables);
}
export function assertRecoveryPlan(plan, context) {
  const codebases = Object.values(plan ?? {});
  if (codebases.length !== 1) fail("RETRY_SINGLE_CODEBASE_REQUIRED");
  const codebase = codebases[0];
  if (codebase.rolesToAdd?.length || codebase.rolesToRemove?.length || codebase.serviceAccountToCreate || codebase.serviceAccountToDelete || codebase.managedServiceAccount) fail("RETRY_PLAN_IAM_CHANGE_REJECTED");
  const changes = Object.values(codebase.regionalChangesets ?? {});
  if (changes.length !== 1) fail("RETRY_SINGLE_CHANGESET_REQUIRED");
  const change = changes[0];
  if (!Array.isArray(change.endpointsToUpdate) || change.endpointsToUpdate.length !== 1 ||
      !Array.isArray(change.endpointsToCreate) || change.endpointsToCreate.length ||
      !Array.isArray(change.endpointsToDelete) || change.endpointsToDelete.length ||
      !Array.isArray(change.endpointsToSkip) || change.endpointsToSkip.length) fail("RETRY_UPDATE_ONLY_REQUIRED");
  const update = change.endpointsToUpdate[0];
  if (update.deleteAndRecreate || update.unsafe) fail("RETRY_RECREATE_OR_MIGRATION_REJECTED");
  assertEndpoint(update.endpoint, context);
}
export function assertFunctionUpdate(fn, context) {
  if (fn?.name !== FUNCTION || fn.buildConfig?.runtime !== "nodejs22" || fn.buildConfig?.entryPoint !== TARGET ||
      fn.eventTrigger || fn.serviceConfig?.timeoutSeconds !== 300 || fn.serviceConfig?.secretEnvironmentVariables?.length ||
      (fn.serviceConfig?.serviceAccountEmail != null && fn.serviceConfig.serviceAccountEmail !== context.identity)) fail("RETRY_FUNCTION_UPDATE_INVALID");
  assertPaused(fn.serviceConfig.environmentVariables);
}
export function assertReadyFunction(fn, context) {
  assertFunctionUpdate(fn, context);
  if (fn.state !== "ACTIVE" || fn.environment !== "GEN_2" || fn.serviceConfig.service !== SERVICE ||
      fn.serviceConfig.serviceAccountEmail !== context.identity || !/^retrysafesheetwrites-[0-9]+-[a-z0-9]+$/.test(fn.serviceConfig.revision)) fail("RETRY_FUNCTION_NOT_READY");
  const uri = fn.serviceConfig.uri;
  let url; try { url = new URL(uri); } catch { fail("RETRY_FUNCTION_URI_INVALID"); }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".run.app") || url.username || url.password || url.search || url.hash || url.port || !["", "/"].includes(url.pathname)) fail("RETRY_FUNCTION_URI_INVALID");
}
export function assertReadyService(service, fn, context) {
  const revision = fn.serviceConfig.revision, status = service?.status, spec = service?.spec;
  if (service?.metadata?.name !== "retrysafesheetwrites" || status?.latestReadyRevisionName !== revision || status.latestCreatedRevisionName !== revision ||
      !status.conditions?.some(c => c.type === "Ready" && c.status === "True") ||
      status.traffic?.length !== 1 || status.traffic[0].revisionName !== revision || status.traffic[0].percent !== 100 ||
      spec?.template?.spec?.serviceAccountName !== context.identity || spec.template.spec.containers?.length !== 1 ||
      status.url !== fn.serviceConfig.uri ||
      ![undefined, "false"].includes(service.metadata.annotations?.["run.googleapis.com/invoker-iam-disabled"])) fail("RETRY_RUN_NOT_VERIFIED");
  const env = spec.template.spec.containers[0].env ?? [];
  if (new Set(env.map(e => e.name)).size !== env.length) fail("RETRY_RUN_DUPLICATE_ENV");
  assertPaused(Object.fromEntries(env.map(e => [e.name, e.value])));
}
export function assertScheduler(job, fn, context, requireState = false) {
  const target = job?.httpTarget;
  if (job?.name !== JOB || job.schedule !== "every 5 minutes" || job.timeZone !== "Asia/Tokyo" || job.pubsubTarget ||
      target?.uri !== fn.serviceConfig.uri || target.httpMethod !== "POST" || target.oauthToken || target.body ||
      target.oidcToken?.serviceAccountEmail !== context.identity ||
      (target.oidcToken.audience != null && target.oidcToken.audience !== target.uri) ||
      (requireState && !["ENABLED", "PAUSED"].includes(job.state))) fail("RETRY_SCHEDULER_NOT_VERIFIED");
}

// 固定版CLIの接続点にだけ接続する。既存権限の読取で代替し、IAMへ転送しない。
export function installRecoveryAdapters(modules, context, read) {
  assertIdentity(context.identity, context.projectNumber);
  const {run, gcf, scheduler, fabricator, ensureApi, compute, resourceManager, iam, serviceUsage, artifacts} = modules;
  const contracts = [[run, ["setInvokerCreate", "setInvokerUpdate", "setIamPolicy", "updateService", "replaceService"]],
    [gcf, ["updateFunction", "createFunction", "deleteFunction"]], [scheduler, ["createOrReplaceJob", "deleteJob"]],
    [modules, ["createScheduler"]], [fabricator, ["applyPlan"]], [ensureApi, ["check", "ensure", "bestEffortEnsure"]], [compute, ["getDefaultServiceAccount"]],
    [resourceManager, ["setIamPolicy", "addServiceAccountToRoles", "addServiceAccountRoles", "removeServiceAccountRoles"]],
    [iam, ["createServiceAccount", "deleteServiceAccount", "createServiceAccountKey", "getServiceAccount"]],
    [serviceUsage, ["generateServiceIdentity", "generateServiceIdentityAndPoll"]],
    [artifacts, ["checkCleanupPolicy", "setCleanupPolicy", "setCleanupPolicies", "updateRepository", "optOutRepository"]]];
  if (contracts.some(([object, names]) => names.some(name => typeof object?.[name] !== "function"))) fail("RETRY_CLI_CONTRACT_CHANGED");
  const original = {applyPlan: fabricator.applyPlan, update: gcf.updateFunction, schedule: modules.createScheduler, apiCheck: ensureApi.check, getAccount: iam.getServiceAccount};
  const deny = async () => fail("RETRY_UNAUTHORIZED_CLOUD_MUTATION");
  let planVerified = false, functionUpdated = false, schedulerWritten = false;
  const existingInvoker = async (project, service, invokers) => {
    if (!planVerified || project !== PROJECT || service !== SERVICE || invokers?.length !== 1 || invokers[0] !== context.identity) fail("RETRY_INVOKER_REQUEST_INVALID");
    assertExistingInvoker(await read.projectPolicy(), context.identity);
  };
  run.setInvokerCreate = run.setInvokerUpdate = existingInvoker;
  for (const name of ["setIamPolicy", "updateService", "replaceService"]) run[name] = deny;
  for (const name of ["setIamPolicy", "addServiceAccountToRoles", "addServiceAccountRoles", "removeServiceAccountRoles"]) resourceManager[name] = deny;
  for (const name of ["createServiceAccount", "deleteServiceAccount", "createServiceAccountKey"]) iam[name] = deny;
  gcf.createFunction = gcf.deleteFunction = scheduler.deleteJob = deny;
  fabricator.applyPlan = async function(plan) {
    if (planVerified) fail("RETRY_PLAN_ALREADY_APPLIED");
    assertRecoveryPlan(plan, context);
    assertExistingInvoker(await read.projectPolicy(), context.identity);
    planVerified = true;
    return original.applyPlan.call(this, plan);
  };
  gcf.updateFunction = async fn => {
    if (!planVerified) fail("RETRY_PLAN_REQUIRED");
    assertFunctionUpdate(fn, context);
    const result = await original.update(fn); functionUpdated = true; return result;
  };
  scheduler.createOrReplaceJob = async job => {
    if (!functionUpdated) fail("RETRY_FUNCTION_UPDATE_REQUIRED");
    const fn = await read.fn(); assertReadyFunction(fn, context);
    assertReadyService(await read.service(), fn, context);
    await read.assertPrivateService();
    assertExistingInvoker(await read.projectPolicy(), context.identity);
    assertScheduler(job, fn, context);
    if (await read.job() !== null) fail("RETRY_SCHEDULER_ALREADY_EXISTS");
    const result = await original.schedule(job); schedulerWritten = true; return result;
  };
  compute.getDefaultServiceAccount = async number => {
    if (String(number) !== context.projectNumber) fail("RETRY_PROJECT_NUMBER_MISMATCH");
    return context.identity;
  };
  ensureApi.ensure = ensureApi.bestEffortEnsure = async (project, api) => {
    if (![PROJECT, context.projectNumber].includes(String(project))) fail("RETRY_API_PROJECT_MISMATCH");
    if (!await original.apiCheck(project, api, "functions", true)) fail("RETRY_API_ENABLEMENT_NOT_ALLOWED");
  };
  // CLIはGen2で既存service agentにもgenerateを要求する。存在確認だけで代替する。
  serviceUsage.generateServiceIdentity = serviceUsage.generateServiceIdentityAndPoll = async (number, service) => {
    if (String(number) !== context.projectNumber) fail("RETRY_PROJECT_NUMBER_MISMATCH");
    const suffix = {"pubsub.googleapis.com": "gcp-sa-pubsub", "eventarc.googleapis.com": "gcp-sa-eventarc"}[service];
    if (!suffix) fail("RETRY_SERVICE_AGENT_SCOPE_INVALID");
    const email = `service-${context.projectNumber}@${suffix}.iam.gserviceaccount.com`;
    const account = await original.getAccount(PROJECT, email);
    if (account?.email !== email || account.disabled) fail("RETRY_SERVICE_AGENT_MISSING");
    return {done: true, response: {email}};
  };
  // 今回はリポジトリのcleanup設定を変更しない。CLIの任意設定工程だけを省く。
  artifacts.checkCleanupPolicy = async () => ({locationsToSetup: [], locationsWithErrors: []});
  for (const name of ["setCleanupPolicy", "setCleanupPolicies", "updateRepository", "optOutRepository"]) artifacts[name] = deny;
  return {assertCompleted() { if (!planVerified || !functionUpdated || !schedulerWritten) fail("RETRY_RECOVERY_INCOMPLETE"); }};
}
