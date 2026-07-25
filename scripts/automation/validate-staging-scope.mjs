import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(scriptDirectory, "../../config/automation/staging-safety.json");
export const safetyConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));

function parseCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sameSet(actual, expected) {
  return actual.length === expected.length
    && actual.every((entry) => expected.includes(entry))
    && new Set(actual).size === actual.length;
}

function validateSourceRef(sourceRef) {
  if (safetyConfig.allowedSourceRefs.includes(sourceRef)) return;
  if (
    /^(cursor|automation)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(sourceRef)
    && !sourceRef.includes("..")
    && !sourceRef.endsWith("/")
  ) return;
  throw new Error(`SOURCE_REF_NOT_ALLOWED:${sourceRef}`);
}

export function validatePlan(plan) {
  const mode = String(plan.mode ?? "ci");
  const project = String(plan.project ?? safetyConfig.projectId);
  const region = String(plan.region ?? safetyConfig.region);
  const sourceRef = String(plan.sourceRef ?? "main");

  if (project !== safetyConfig.projectId) throw new Error(`PROJECT_NOT_ALLOWED:${project}`);
  if (region !== safetyConfig.region) throw new Error(`REGION_NOT_ALLOWED:${region}`);
  if (/prod(uction)?/i.test(project)) throw new Error(`PRODUCTION_PROJECT_REJECTED:${project}`);
  validateSourceRef(sourceRef);

  if (mode === "ci") {
    return { mode, project, region, sourceRef };
  }

  if (mode === "invoker-diagnose") {
    const services = parseCsv(plan.services);
    if (!sameSet(services, safetyConfig.invokerDiagnosticServices)) {
      throw new Error(`DIAGNOSTIC_SERVICES_NOT_EXACT:${services.join(",")}`);
    }
    return { mode, project, region, sourceRef, services };
  }

  if (mode === "invoker-apply") {
    const services = parseCsv(plan.services);
    if (!sameSet(services, safetyConfig.invokerMutableServices)) {
      throw new Error(`MUTABLE_SERVICES_NOT_EXACT:${services.join(",")}`);
    }
    if (plan.confirmation !== safetyConfig.confirmations.invokerApply) {
      throw new Error("INVOKER_CONFIRMATION_REJECTED");
    }
    return { mode, project, region, sourceRef, services };
  }

  if (mode === "functions-deploy") {
    const functions = parseCsv(plan.functions);
    if (!functions.length) throw new Error("FUNCTION_LIST_EMPTY");
    if (new Set(functions).size !== functions.length) throw new Error("FUNCTION_LIST_HAS_DUPLICATES");
    const rejected = functions.filter((name) => !safetyConfig.allowedFunctions.includes(name));
    if (rejected.length) throw new Error(`FUNCTIONS_NOT_ALLOWED:${rejected.join(",")}`);
    if (plan.confirmation !== safetyConfig.confirmations.functionsDeploy) {
      throw new Error("FUNCTIONS_CONFIRMATION_REJECTED");
    }
    return { mode, project, region, sourceRef, functions };
  }

  throw new Error(`MODE_NOT_ALLOWED:${mode}`);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`UNEXPECTED_ARGUMENT:${argument}`);
    const [rawKey, inlineValue] = argument.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      values[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`MISSING_VALUE:${argument}`);
    values[key] = next;
    index += 1;
  }
  return values;
}

function main() {
  try {
    const plan = validatePlan(parseArguments(process.argv.slice(2)));
    console.log("GUARD_STATUS=PASS");
    console.log(`GUARD_MODE=${plan.mode}`);
    console.log(`GUARD_PROJECT=${plan.project}`);
    console.log(`GUARD_REGION=${plan.region}`);
    console.log(`GUARD_SOURCE_REF=${plan.sourceRef}`);
    if (plan.services) console.log(`GUARD_SERVICES=${plan.services.join(",")}`);
    if (plan.functions) console.log(`GUARD_FUNCTIONS=${plan.functions.join(",")}`);
  } catch (error) {
    console.error("GUARD_STATUS=FAIL");
    console.error(`GUARD_ERROR=${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}

