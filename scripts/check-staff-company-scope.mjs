import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "apps/staff/src/App.tsx"), "utf8");

assert.doesNotMatch(
  source,
  /where\("companyId","==","lipknots"\)/u,
  "Staff Firestore queries must not hard-code a company ID.",
);
assert.match(
  source,
  /const cid=staffScopeId\(token\.claims\.companyId\)/u,
  "Staff startup must derive the company ID from verified auth claims.",
);
assert.match(
  source,
  /await loadPrimaryBusinessData\(sid,cid,current\.uid\)/u,
  "Staff startup must scope its priority data load to the claimed company.",
);
assert.match(
  source,
  /where\("companyId","==",cid\)/u,
  "Staff Firestore queries must use the claimed company ID.",
);

assert.match(source,/const sid=staffScopeId\(token\.claims\.staffId\)/u,"Staff ID must use the same verified-scope validation.");
assert.match(source,/if\(!cid\|\|!sid\)throw new Error/u,"Invalid scope must stop startup before its data load.");
const helper=source.match(/function staffScopeId\([^\n]+/u)?.[0];
assert.ok(helper,"Actual scope validator must be available.");
const scope={};runInNewContext(ts.transpileModule(helper,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);
for(const value of [null,undefined,false,true,0,1,{},[],["company"],"","  ","company/other","/company"]){assert.equal(scope.staffScopeId(value),"","Invalid scope cannot become a usable ID through string coercion.");}
for(const value of ["company","staff-01","会社ID"," company "]){assert.equal(scope.staffScopeId(value),value,"Valid IDs retain their exact identity.");}
console.log("Staff company scope check passed: verified company/staff claims, scoped query/load, 13 invalid IDs rejected and 4 valid IDs preserved.");
