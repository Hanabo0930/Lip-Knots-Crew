import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validatePlan } from "./validate-staging-scope.mjs";

export const SYNC_FUNCTION = "caseListGasSync";
export const SYNC_SERVICE = "caselistgassync";
export const SYNC_CONFIRMATION = "DEPLOY_LKC_GAS_SYNC_PRIVATE_READINESS";
const PROJECT = "lip-knots-crew-staging", REGION = "asia-northeast1";
const need = (ok, code) => { if (!ok) throw Error(code); };
export function assertSyncPlan(plan) {
  need(plan.mode === "functions-deploy" && plan.project === PROJECT && plan.region === REGION
    && plan.sourceRef === "main" && plan.functions?.length === 1
    && plan.functions[0] === SYNC_FUNCTION, "GAS_SYNC_EXACT_MAIN_PRIVATE_SCOPE_REQUIRED");
}
const compact = s => s.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/)
  .filter(line => !line.trim().startsWith("//")).join("\n").replace(/\s+/g, "");
export function assertSyncSource(read) {
  const required = {
    "functions/src/index.ts": ['export{caseListGasSync}from"./case-list-gas-sync-entry";'],
    "functions/src/case-list-gas-sync-entry.ts": [
      'constmode=env.LKC_GAS_SYNC_MODE??"off";',
      'if(mode==="off")returnhold(response,503,"SYNC_ENTRY_DISABLED");',
      'if(mode!=="read-only"&&mode!=="business")returnhold(response,503,"SYNC_ENTRY_MODE_INVALID");',
      'if(mode==="read-only"&&!["READINESS_ONLY","OBSERVE"].includes(request.body?.action))',
      'invoker:process.env.LKC_GAS_SYNC_PUBLIC_INVOKER==="true"?"public":"private"',
      'returncreateSyncRuntimeHandler(policy,{config:gasHandoffSettings(env)});',
      'region:"asia-northeast1",memory:"256MiB",maxInstances:1',
    ],
    "functions/src/case-list-gas-handoff.ts": [
      'verifier.verifyIdToken({idToken:token,audience})',
      'auth.getUserByProviderUid("google.com",subject)',
      'customClaims:user.customClaims', 'disabled:user.disabled',
      'validSinceMs:user.tokensValidAfterTime?Date.parse(user.tokensValidAfterTime):NaN',
    ],
    "functions/src/case-list-gas-handoff-core.cjs": [
      "PROJECT='lip-knots-crew-staging'", "c?.projectId===PROJECT&&c.actualProjectId===PROJECT",
      "claims.iss===ISSUER&&claims.aud===c.audience", "ISSUER='https://accounts.google.com'",
      "finite(claims.iat)&&finite(claims.exp)", "claims.exp>seconds",
      "finite(claims.auth_time)&&claims.auth_time<=claims.iat",
      "links.length===1&&links[0].uid===claims.sub",
      "user.disabled===false&&user.emailVerified===true",
      "user.tenantId===null", "user.mfaState==='NONE'",
      "finite(user.validSinceMs)&&finite(user.observedAt)",
      "claims.auth_time*1000>=user.validSinceMs",
      "cc.role==='admin'&&cc.companyId===c.companyId&&c.executiveEmails.includes(email(user.email))",
    ],
    "functions/src/case-list-gas-sync-runtime.ts": [
      "constauth=req.body?.action==='READINESS_ONLY'&&!req.body?.payload?.ownerApprovalRef?baseAuth:createGasOwnerAuthContext(baseAuth,req.body,{db:database,now});",
      "constcurrentActor:Data=awaitwithFreshPrincipal(auth,authorization,async(actor:Data)=>actor);",
      "constneedsReadPolicy=!['READINESS_ONLY','OBSERVE'].includes(req.body?.action);",
    ],
    "functions/src/case-list-gas-sync-rpc-core.cjs": [
      "if(q.action==='READINESS_ONLY'){constkeys=Object.keys(q.payload);need(q.sequence===0&&q.operationKey===''&&(keys.length===0||keys.join('|')==='ownerApprovalRef'&&s.auth.ownerContext!==undefined),'RPC_INPUT_INVALID');returnresponse('',{},'READINESS_ONLY',{businessEnabled:false,effects:{mail:0,sheets:0,storage:0}});}",
    ],
  };
  for (const [file, snippets] of Object.entries(required)) {
    const source = compact(read(file));
    need(snippets.every(s => source.includes(s)), "GAS_SYNC_SOURCE_GUARD_REJECTED:" + file);
  }
}
function sourcePaths(source) {
  const root = fs.realpathSync(source), functions = fs.realpathSync(path.join(root, "functions"));
  need(functions.startsWith(root + path.sep), "GAS_SYNC_FUNCTIONS_PATH_REJECTED");
  const file = path.join(functions, ".env." + PROJECT);
  need(fs.readdirSync(functions).every(name => !name.startsWith(".env")
    || [".env.example", ".env.template", ".env." + PROJECT].includes(name)), "GAS_SYNC_EXTRA_DOTENV_REJECTED");
  need(fs.statSync(file).isFile() && fs.realpathSync(file) === file, "GAS_SYNC_DOTENV_PATH_REJECTED");
  return { root, file };
}
function parse(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    need(match && !values.has(match[1]), "GAS_SYNC_DOTENV_FORMAT_REJECTED");
    values.set(match[1], match[2]);
  }
  return values;
}
function validateValues(values) {
  const get = key => values.get(key);
  need(get("APP_ENVIRONMENT") === "staging" && get("EXPECTED_FIREBASE_PROJECT_ID") === PROJECT,
    "GAS_SYNC_ENV_PROJECT_REJECTED");
  for (const key of ["GCLOUD_PROJECT", "GCP_PROJECT"]) need(!get(key) || get(key) === PROJECT, "GAS_SYNC_ENV_PROJECT_REJECTED");
  const mode = get("LKC_GAS_SYNC_MODE") ?? "off";
  need(["off", "read-only"].includes(mode), "GAS_SYNC_BUSINESS_MODE_NOT_AUTHORIZED");
  need((get("LKC_GAS_SYNC_PUBLIC_INVOKER") ?? "false") === "false", "GAS_SYNC_PUBLIC_INVOKER_NOT_AUTHORIZED");
  need((get("LKC_CASE_LIST_EXTERNAL_MODE") ?? "read-only") === "read-only", "GAS_SYNC_EXTERNAL_BUSINESS_NOT_AUTHORIZED");
  need(get("LKC_SHEET_WRITE_MODE") === "paused" && get("LKC_NOTIFICATION_DELIVERY_MODE") === "paused",
    "GAS_SYNC_EXISTING_PAUSES_REQUIRED");
  if (mode === "read-only") {
    need(/^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/.test(get("LKC_GAS_HANDOFF_AUDIENCE") ?? ""), "GAS_SYNC_FIXED_AUDIENCE_REQUIRED");
    need(/^[A-Za-z0-9_-]{1,128}$/.test(get("DEFAULT_COMPANY_ID") ?? ""), "GAS_SYNC_COMPANY_REQUIRED");
    const executives = (get("EXECUTIVE_APPROVER_EMAILS") ?? "").split(",");
    need(executives.length > 0 && executives.length <= 20 && executives.every(s => /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)), "GAS_SYNC_EXECUTIVE_CONFIG_REQUIRED");
  }
  return mode;
}
export function assertPrivateReadiness(plan, source) {
  assertSyncPlan(plan);
  const { root, file } = sourcePaths(source), values = parse(fs.readFileSync(file, "utf8"));
  const mode = validateValues(values);
  need(values.has("LKC_GAS_SYNC_MODE") && values.get("LKC_GAS_SYNC_PUBLIC_INVOKER") === "false",
    "GAS_SYNC_MATERIALIZED_SETTINGS_REQUIRED");
  assertSyncSource(file => fs.readFileSync(path.join(root, file), "utf8"));
  return { mode, publicInvoker: false, businessEnabled: false };
}
export function materializePrivateReadiness(plan, source, input = {}) {
  assertSyncPlan(plan);
  const { root, file } = sourcePaths(source), original = fs.readFileSync(file, "utf8"), values = parse(original);
  validateValues(values); // Never conceal an existing public/business configuration.
  need(["off", "read-only"].includes(input.mode ?? "off"), "GAS_SYNC_BUSINESS_MODE_NOT_AUTHORIZED");
  need(input.publicInvoker === undefined || input.publicInvoker === "false", "GAS_SYNC_PUBLIC_INVOKER_NOT_AUTHORIZED");
  values.set("LKC_GAS_SYNC_MODE", input.mode ?? "off");
  values.set("LKC_GAS_SYNC_PUBLIC_INVOKER", "false");
  values.set("LKC_CASE_LIST_EXTERNAL_MODE", "read-only");
  if (input.audience) {
    need(/^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/.test(input.audience), "GAS_SYNC_FIXED_AUDIENCE_REQUIRED");
    values.set("LKC_GAS_HANDOFF_AUDIENCE", input.audience);
  }
  validateValues(values);
  assertSyncSource(file => fs.readFileSync(path.join(root, file), "utf8"));
  const keys = new Set(["LKC_GAS_SYNC_MODE", "LKC_GAS_SYNC_PUBLIC_INVOKER", "LKC_CASE_LIST_EXTERNAL_MODE", "LKC_GAS_HANDOFF_AUDIENCE"]);
  const retained = original.split(/\r?\n/).filter(line => !keys.has(line.split("=", 1)[0]));
  while (retained.at(-1) === "") retained.pop();
  const text = retained.concat([...keys].filter(k => values.has(k)).map(k => k + "=" + values.get(k))).join("\n") + "\n";
  fs.writeFileSync(file, text, { mode: 0o600 });
  return assertPrivateReadiness(plan, source);
}
export function verifyPrivateService(plan, phase, execute = execFileSync) {
  assertSyncPlan(plan);
  need(["before", "after"].includes(phase), "GAS_SYNC_VERIFY_PHASE_REJECTED");
  function read(args) {
    let text;
    try { text = execute("gcloud", args, { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw Error("GAS_SYNC_PRIVATE_READ_FAILED"); }
    try { return JSON.parse(text); } catch { throw Error("GAS_SYNC_PRIVATE_RESPONSE_INVALID"); }
  }
  const suffix = ["--project", PROJECT, "--region", REGION, "--quiet"];
  const listed = read(["run", "services", "list", "--filter", "metadata.name=" + SYNC_SERVICE, "--limit", "2", "--format=json(metadata.name)", ...suffix]);
  need(Array.isArray(listed) && listed.length <= 1 && listed.every(s => s?.metadata?.name === SYNC_SERVICE), "GAS_SYNC_SERVICE_SCOPE_REJECTED");
  if (!listed.length) {
    need(phase === "before", "GAS_SYNC_DEPLOYED_SERVICE_MISSING");
    return { exists: false, privateVerified: true };
  }
  const service = read(["run", "services", "describe", SYNC_SERVICE, "--format=json(metadata.name,metadata.annotations)", ...suffix]);
  need(service?.metadata?.name === SYNC_SERVICE, "GAS_SYNC_SERVICE_SCOPE_REJECTED");
  const disabled = service.metadata.annotations?.["run.googleapis.com/invoker-iam-disabled"];
  need(disabled === undefined || disabled === "false", "GAS_SYNC_IAM_CHECK_DISABLED");
  const policy = read(["run", "services", "get-iam-policy", SYNC_SERVICE, "--format=json", ...suffix]);
  need(policy && typeof policy.etag === "string" && policy.etag.length > 0
    && (policy.bindings === undefined || Array.isArray(policy.bindings)), "GAS_SYNC_IAM_POLICY_UNVERIFIED");
  need((policy.bindings ?? []).every(b => Array.isArray(b.members)
    && b.members.every(m => typeof m === "string" && !["allUsers", "allAuthenticatedUsers"].includes(m))), "GAS_SYNC_PUBLIC_BINDING_REJECTED");
  return { exists: true, privateVerified: true };
}
async function main() {
  const plan = validatePlan({ mode: "functions-deploy", project: process.env.LKC_PROJECT_ID,
    region: process.env.LKC_REGION, sourceRef: process.env.LKC_SOURCE_REF,
    functions: process.env.LKC_FUNCTIONS, confirmation: process.env.LKC_CONFIRMATION });
  const action = process.argv[2];
  need(process.argv.length === 3, "GAS_SYNC_HELPER_ACTION_REJECTED");
  if (action === "--materialize") {
    const result = materializePrivateReadiness(plan, process.env.LKC_SOURCE_DIRECTORY, {
      mode: process.env.LKC_GAS_SYNC_REQUESTED_MODE ?? "off", audience: process.env.LKC_GAS_SYNC_AUDIENCE,
      publicInvoker: process.env.LKC_GAS_SYNC_PUBLIC_INVOKER,
    });
    console.log("GAS_SYNC_SETTINGS=" + result.mode + ":private:business-disabled");
  } else {
    need(action === "--verify-after", "GAS_SYNC_HELPER_ACTION_REJECTED");
    assertPrivateReadiness(plan, process.env.LKC_SOURCE_DIRECTORY);
    console.log("GAS_SYNC_PRIVATE_READBACK=" + verifyPrivateService(plan, "after").privateVerified);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
