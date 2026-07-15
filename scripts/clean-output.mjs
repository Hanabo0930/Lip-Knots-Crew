import { rm } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

const requested = process.argv[2];
if (!requested) {
  console.error("clean-output: target is required");
  process.exit(1);
}

const workspaceRoot = resolve(process.cwd());
const target = resolve(workspaceRoot, requested);
if (basename(target) !== "dist" || !target.startsWith(`${workspaceRoot}${sep}`)) {
  console.error(`clean-output: unsafe target rejected: ${target}`);
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
console.log(`clean-output: removed ${target}`);
