import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const suites = [
  "../test-admin-owner-publication.mjs", "test-owner-publication-api.cjs", "test-publication-worker.cjs", "../test-admin-recruitment-draft.mjs", "test-recruitment-draft.cjs", "test-source-core.cjs", "test-source-io.cjs", "test-apply-wiring.cjs",
  "test-monthly-compact.cjs", "test-worker-binding.cjs", "test-source-cancellation.cjs", "test-private-ref.cjs",
  "test-post-ack-sync.cjs", "test-public-binding.cjs", "test-owner-reconcile-route.cjs",
  "test-private-job-consumers.cjs",
  "test-worker-hooks.cjs", "test-manual-controller.cjs",
];
for (const suite of suites) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./case-list-tests/" + suite, import.meta.url))], { encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  if (result.status !== 0) { process.stderr.write(result.stderr ?? ""); process.exit(result.status ?? 1); }
}
