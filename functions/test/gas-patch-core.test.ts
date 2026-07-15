import {
  generatePatchPlan,
  applySafePatches,
  unifiedDiff,
} from "../src/gas-patch-core";
function ok(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}
const source = `function x(){\n  sheet.getRange(2, 19).clearContent();\n}`;
const plan = generatePatchPlan({
  files:[{filename:"Code.gs",source}],
  findings:[
    {id:"a",filename:"Code.gs",line:2,category:"numeric_column",evidence:"getRange(2, 19)",affectedColumns:["S"]},
    {id:"b",filename:"Code.gs",line:2,category:"clear",evidence:"clearContent()",affectedColumns:["S"]},
  ],
});
ok(plan.suggestions.length === 2, "修正案数が違います。");
const auto = plan.suggestions.filter((item)=>item.autoApplicable);
const patched = applySafePatches({source,suggestions:auto});
ok(patched.source.includes("TODO") || auto.length === 0, "安全パッチが反映されません。");
ok(unifiedDiff("Code.gs",source,patched.source).includes("--- a/Code.gs"), "diffがありません。");
console.log("gas patch core tests passed");
