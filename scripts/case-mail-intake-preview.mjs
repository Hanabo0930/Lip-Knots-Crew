import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import runtime from "../functions/case-mail-runtime/preview.cjs";
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const hash = value => createHash("sha256").update(value).digest("hex");
const ensure = (condition, message) => { if (!condition) throw Error(message); };
// 案件入力の既存検証を共用する。Functionsの受付・DB・ネットワークは読み込まない。
const jobSource = fs.readFileSync(new URL("../functions/src/job-management-core.ts", import.meta.url), "utf8");
const jobModule = { exports: {} };
runInNewContext(ts.transpileModule(jobSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { module: jobModule, exports: jobModule.exports }, { timeout: 3000 });
const { normalizeJobInput } = jobModule.exports;

export const prepareCaseMailIntakePreview = runtime.createCaseMailPreview(normalizeJobInput, hash(jobSource));

export function runPreviewCli(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    ensure(["--input", "--out", "--company-id", "--started-at"].includes(key) && !Object.hasOwn(options, key) &&
      args[index + 1] && !args[index + 1].startsWith("--"), "入力・新規出力先・会社ID・開始日時を指定してください。");
    options[key] = args[index + 1];
  }
  ensure(Object.keys(options).length === 4, "必須の引数が不足しています。");
  const stat = fs.statSync(options["--input"]);
  ensure(stat.isFile() && stat.size <= MAX_INPUT_BYTES, "入力ファイルの形式・サイズを確認してください。");
  const source = JSON.parse(fs.readFileSync(options["--input"], "utf8"));
  ensure(source && Object.keys(source).every(key => ["rawMessage", "documents", "processedIds"].includes(key)), "入力ファイルにはメール・添付・処理済みIDだけを指定してください。");
  const result = prepareCaseMailIntakePreview({ ...source, companyId: options["--company-id"], startedAt: options["--started-at"] });
  fs.writeFileSync(options["--out"], JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { state: result.state, candidates: result.candidates.length, persisted: false, dispatch: "disabled" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(runPreviewCli(process.argv.slice(2)))); }
  catch { console.error("解析プレビューを作成できません。引数・入力形式・新規出力先を確認してください。"); process.exitCode = 1; }
}
