import fs from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const modules = new Map();
function load(name) {
  if (["node:crypto", "zod"].includes(name)) return require(name);
  if (!["./automation-bridge-core", "./automation-recruitment-core"].includes(name)) throw Error("Unexpected bridge dependency");
  if (modules.has(name)) return modules.get(name);
  const filename = new URL("../functions/src/" + name.slice(2) + ".ts", import.meta.url);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} }; modules.set(name, module.exports);
  runInNewContext(compiled, { exports: module.exports, module, require: load, Date }, { filename: filename.pathname });
  return module.exports;
}
export const { prepareAutomationHandoff, reconcileAutomationReceipt, validateAutomationBindings } = load("./automation-bridge-core");
export const { prepareCaseMailCampaign, reconcileCaseMailApplication } = load("./automation-recruitment-core");
