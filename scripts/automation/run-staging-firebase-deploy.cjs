"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const VERSION = "15.24.0";

// CLIの新規callableが行う公開IAM付与を、既存の配備後Cloud Run設定へ委ねる。
// 対象外・想定外の付与要求は拒否し、元のIAM書込関数へは転送しない。
function installInvokerAdapter(run, plan, log = console.log) {
  if (plan.project !== "lip-knots-crew-staging" || plan.region !== "asia-northeast1"
    || !Array.isArray(plan.functions) || !plan.functions.length
    || plan.functions.some(name => !/^[A-Za-z][A-Za-z0-9]*$/.test(name))) throw Error("INVALID_INVOKER_PLAN");
  if (typeof run.setInvokerCreate !== "function") throw Error("CLI_INVOKER_CONTRACT_CHANGED");
  const services = new Set(plan.functions.filter(name => !["finalizeStagedUpload", "processNotificationQueue"].includes(name)).map(name => name.toLowerCase()));
  run.setInvokerCreate = async (projectId, serviceName, invokers) => {
    const prefix = "projects/" + plan.project + "/locations/" + plan.region + "/services/";
    if (projectId !== plan.project || typeof serviceName !== "string" || !serviceName.startsWith(prefix)
      || !services.has(serviceName.slice(prefix.length))
      || !Array.isArray(invokers) || invokers.length !== 1 || invokers[0] !== "public") {
      throw Error("UNEXPECTED_INVOKER_CREATE_REQUEST");
    }
    log("INVOKER_CREATE_DEFERRED_TO_VERIFIED_STAGING_HELPER=" + serviceName.slice(prefix.length));
  };
}

function resolveCli(searchPath = process.env.PATH ?? "", io = fs) {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "firebase");
    if (!io.existsSync(candidate)) continue;
    const binary = io.realpathSync(candidate);
    if (!binary.replace(/\\/g, "/").endsWith("/firebase-tools/lib/bin/firebase.js")) throw Error("UNEXPECTED_FIREBASE_BINARY");
    const root = path.resolve(path.dirname(binary), "../..");
    const pkg = JSON.parse(io.readFileSync(path.join(root, "package.json"), "utf8"));
    if (pkg.name !== "firebase-tools" || pkg.version !== VERSION) throw Error("UNEXPECTED_FIREBASE_VERSION");
    return {root, binary};
  }
  throw Error("PINNED_FIREBASE_CLI_NOT_FOUND");
}

async function main() {
  const {validatePlan} = await import(pathToFileURL(path.join(__dirname, "validate-staging-scope.mjs")).href);
  const plan = validatePlan({
    mode: "functions-deploy", project: process.env.LKC_PROJECT_ID,
    region: process.env.LKC_REGION, sourceRef: process.env.LKC_SOURCE_REF,
    functions: process.env.LKC_FUNCTIONS, confirmation: process.env.LKC_CONFIRMATION,
  });
  const source = fs.realpathSync(process.env.LKC_SOURCE_DIRECTORY ?? "");
  if (!fs.statSync(path.join(source, "firebase.json")).isFile()) throw Error("INVALID_SOURCE_DIRECTORY");
  const {assertNotificationDeliveryPaused} = await import(pathToFileURL(path.join(__dirname, "validate-staging-notification-pause.mjs")).href);
  assertNotificationDeliveryPaused(plan, source);
  const cli = resolveCli();
  const run = require(path.join(cli.root, "lib/gcp/run.js"));
  installInvokerAdapter(run, plan);
  process.chdir(source);
  process.argv = [process.execPath, cli.binary, "deploy", "--only", plan.functions.map(name => "functions:" + name).join(","),
    "--project", plan.project, "--non-interactive"];
  require(cli.binary);
}
module.exports = {installInvokerAdapter, resolveCli, VERSION};
if (require.main === module) main().catch(error => {console.error(error.message);process.exitCode = 1;});