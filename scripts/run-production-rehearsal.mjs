import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildProductionRehearsalCommands } from "./production-rehearsal-core.mjs";

const args=process.argv.slice(2);const configArg=args[args.indexOf("--config")+1];
if(!args.includes("--preview")){console.error("安全のため--previewだけを許可します。実行は各工程の承認後に行ってください。");process.exit(1);}
if(!configArg){console.error("--config is required");process.exit(1);}
const config=JSON.parse(await readFile(resolve(process.cwd(),configArg),"utf8"));const plan=buildProductionRehearsalCommands(config);
console.log(`PRODUCTION REHEARSAL PREVIEW: PASS (${plan.steps.length} steps)`);
console.log(`release=${plan.releaseId}`);console.log(`source=${plan.sourceProjectId}`);console.log(`restore=${plan.restoreProjectId}`);console.log(`fingerprint=${plan.fingerprint}`);
for(const step of plan.steps)console.log(`${step.order}. ${step.label}: ${step.command}`);
console.log("このpreviewは外部変更を実行していません。");
