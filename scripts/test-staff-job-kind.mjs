import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const file = "apps/staff/src/App.tsx";
const app = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
const names = ["jobAccent", "jobKind"];
const functions = app.statements.filter(node => ts.isFunctionDeclaration(node) &&
  node.name && names.includes(node.name.text));
assert.equal(functions.length, names.length);
const accents = app.statements.find(node => ts.isVariableStatement(node) &&
  node.declarationList.declarations.some(declaration => declaration.name.getText(app) === "JOB_ACCENTS"));
assert.ok(accents);
const source = [accents, ...functions].map(node => node.getText(app)).join("\n");
const context = {};
runInNewContext(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);

for (const value of [null, undefined, {}, [], 42, false, "", "　 "]) {
  assert.equal(context.jobKind(value), "業務確認中");
  assert.match(context.jobAccent(value), /^#[0-9a-f]{6}$/);
  assert.equal(context.jobAccent(value), context.jobAccent(null));
}
for (const [value, expected] of [["販売（短時間）", "販売"], ["案内(午前)", "案内"], ["  設営  ", "設営"]]) {
  assert.equal(context.jobKind(value), expected);
  assert.equal(context.jobAccent(value), context.jobAccent(value));
}
console.log("Job kind and accent: eight missing/invalid inputs and three normal labels passed.");
