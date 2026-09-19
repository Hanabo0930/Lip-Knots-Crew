import assert from "node:assert/strict";
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { validatePlan, safetyConfig } from "./validate-staging-scope.mjs";
const read = path => fs.readFileSync(new URL("../../" + path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const guard = read("scripts/automation/check-function-auth-guards.mjs").replace(/^import .*;\n/gm, "");
const names = ["listCaseMailReceipts", "getCaseMailReceipt", "getCaseMailTargetPreview",
  "confirmCaseMailTarget", "holdCaseMailTarget", "resolveCaseMailTargetHold", "confirmCaseMailReview"];
const sources = Object.fromEntries(["review", "resolution", "collision", "target-hold"].map(module =>
  ["functions/src/case-mail-" + module + ".ts", read("functions/src/case-mail-" + module + ".ts")]));
let cases = 0;
function run(name, change) {
  const files = { ...sources }, lines = [];
  change?.(files);
  const process = { argv: ["node", "guard", "--functions", name, "--require-pass"], exitCode: 0,
    exit(code) { throw new Error("Unexpected exit " + code); } };
  runInNewContext(guard, { process, console: { log: line => lines.push(line), error: line => lines.push(line) },
    execFileSync(command, args) {
      assert.equal(command, "git"); assert.equal(args[0], "show");
      const path = args[1].slice(args[1].indexOf(":") + 1);
      assert.ok(Object.hasOwn(files, path), path);
      return files[path];
    },
  }, { timeout: 3000 });
  return { passed: lines.includes("SOURCE_GUARD_STATUS=PASS"), exitCode: process.exitCode };
}
// 書式差を許容しつつ、実在する条件を1か所ずつ壊す。元ソースは変更しない。
function reject(name, before, after, module = name === "confirmCaseMailReview" ? "resolution" : "review", section = name) {
  const path = "functions/src/case-mail-" + module + ".ts", source = sources[path];
  let start = 0, end = source.length;
  if (Array.isArray(section)) {
    start = source.indexOf(section[0]);
    end = section[1] ? source.indexOf(section[1], start) : source.length;
    assert.ok(start >= 0 && end > start, section.join(" -> "));
  } else if (section) {
    start = source.search(new RegExp("export const " + section + "\\s*="));
    assert.ok(start >= 0, section);
    end = source.indexOf("\n});", start) + 4;
    assert.ok(end > start, section);
  }
  const block = source.slice(start, end);
  const pattern = new RegExp([...before.replace(/\s/g, "")].map(char => char.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&")).join("\\s*"));
  assert.ok(pattern.test(block), name + ": missing mutation " + before);
  const mutated = block.replace(pattern, () => after);
  assert.deepEqual(run(name, files => { files[path] = source.slice(0, start) + mutated + source.slice(end); }),
    { passed: false, exitCode: 1 }, name + ": " + before);
  cases++;
}
for (const name of names) {
  assert.deepEqual(run(name), { passed: true, exitCode: 0 }, name); cases++;
  reject(name, "requireAdmin(request)", "unverified(request)");
  reject(name, "companyFromClaims(session.token)", "request.data.companyId");
  reject(name, "const session=requireAdmin(request)", 'await db.collection("unscoped").get(); const session=requireAdmin(request)');
  reject(name, "requireAdmin(request)", "/* requireAdmin(request) */ unverified(request)");
  reject(name, 'from "./utils"', 'from "./unverified-utils"', undefined, null);
  if (name === "confirmCaseMailReview") {
    reject(name, "input.expectedCompanyId !== companyId", "false");
    reject(name, "input.expectedActorUid !== session.uid", "false");
  } else {
    reject(name, "scope(input,companyId,session.uid);", "");
    reject(name, "input.expectedCompanyId !== companyId", "false", "review", null);
    reject(name, "input.expectedActorUid !== uid", "false", "review", null);
  }
}
for (const name of names.slice(0, 3))
  reject(name, "return db.runTransaction", 'await db.collection("bad").add({}); return db.runTransaction');
for (const name of names.slice(3)) {
  reject(name, "await assertProductionOperational(companyId);", "");
  reject(name, "tx.set(", "outside.set(");
  reject(name, "actorUid:session.uid", "actorUid:input.actorUid");
}
reject("listCaseMailReceipts", '.where("companyId","==",companyId)', "");
reject("listCaseMailReceipts", ".limit(26)", ".limit(2600)");
for (const token of ["snap.data()?.companyId !== companyId", "candidate.companyId !== companyId",
  "job.companyId !== companyId", "candidate.receiptId !== input.receiptId",
  "savedTarget.companyId !== companyId"]) reject("getCaseMailReceipt", token, "false");
for (const name of names.slice(2, 6)) {
  for (const token of ["rawReceipt.companyId!==companyId", "rawCandidate.companyId!==companyId",
    "job.companyId!==companyId", "saved.companyId!==companyId", "audit.companyId!==companyId",
    "owner.companyId!==companyId", "originReceipt.companyId!==companyId", "originCandidate.companyId!==companyId",
    "principal.companyId!==companyId", "principal.active!==true", "principal.revision!==record.principalRevision"])
    reject(name, token, "false", "review", ["async function readTargetContext(", "export const getCaseMailTargetPreview"]);
}
for (const name of names.slice(1, 6)) {
  reject(name, '.where("companyId","==",companyId)', "", "collision", ["export function caseMailTargetReader(", null]);
  reject(name, "job.companyId!==companyId", "false", "collision", ["export function caseMailTargetReader(", null]);
}
for (const name of ["getCaseMailReceipt", "confirmCaseMailReview"]) {
  for (const token of ["receipt.companyId !== companyId", "candidate.companyId !== companyId",
    "owner.companyId !== companyId", "principal.companyId !== companyId", "principal.active !== true",
    "candidate.heldChange?.revision !== receipt.revision", "lock.companyId !== companyId"])
    reject(name, token, "false", "resolution", null);
}
for (const name of ["getCaseMailTargetPreview", "resolveCaseMailTargetHold"]) {
  reject(name, "resolved.companyId!==companyId", "false", "review", null);
  reject(name, "lock.companyId!==companyId", "false", "review", null);
}
reject("confirmCaseMailTarget", "current.reviewVersion!==input.reviewVersion", "false");
reject("holdCaseMailTarget", "current.reviewVersion!==input.reviewVersion", "false");
reject("resolveCaseMailTargetHold", "resolution.view.reviewVersion!==input.reviewVersion", "false");
reject("confirmCaseMailReview", "view.reviewVersion!==input.reviewVersion", "false");
reject("holdCaseMailTarget", "publishable:false,recruitmentStopped:true", "publishable:true,recruitmentStopped:false", "target-hold", null);
reject("resolveCaseMailTargetHold", "publishable:false,recruitmentStopped:true", "publishable:true,recruitmentStopped:false");
reject("confirmCaseMailReview", "publishable:false,recruitmentStopped:true", "publishable:true,recruitmentStopped:false");
// 認証ガードへの登録だけで配備許可を拡張しない。許可拡張時は別工程でこの期待値も審査する。
for (const name of names) {
  assert.equal(safetyConfig.allowedFunctions.includes(name), false);
  assert.throws(() => validatePlan({ mode: "functions-deploy", functions: name,
    confirmation: safetyConfig.confirmations.functionsDeploy }), /FUNCTIONS_NOT_ALLOWED/);
  cases++;
}
const integrity = read("scripts/automation/check-deploy-source-integrity.mjs")
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "").replace(/\nmain\(\);\s*$/, "");
const classify = runInNewContext(integrity + "\nclassifyChangedPath;", {});
for (const [path, expected] of [
  ["functions/src/case-mail-review.ts", "allowed"],
  ["functions/case-mail-runtime/provider.cjs", "outside-allowlist"],
  ["apps/admin/src/CaseMailIntakeEntry.tsx", "outside-allowlist"],
  ["scripts/automation/check-function-auth-guards.mjs", "protected"],
  [".github/workflows/release-candidate.yml", "protected"],
  ["config/automation/staging-safety.json", "protected"],
]) { assert.equal(classify(path), expected); cases++; }
console.log(JSON.stringify({ caseMailAuthGuardTests: cases, functions: names, cloudOperations: false,
  deploymentAllowed: false, source: "working-tree fixtures through the formal git-show guard" }));
