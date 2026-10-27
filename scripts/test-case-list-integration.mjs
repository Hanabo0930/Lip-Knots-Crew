import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const suites = ["test-source-core.cjs", "test-source-io.cjs", "test-apply-wiring.cjs", "test-monthly-reader.cjs"];
for (const suite of suites) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./case-list-tests/" + suite, import.meta.url))], { encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  if (result.status !== 0) { process.stderr.write(result.stderr ?? ""); process.exit(result.status ?? 1); }
}
