import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const apps = ["staff", "admin"];
const maxChunkBytes = 300 * 1024;
const maxEntryBytes = 150 * 1024;
const failures = [];

for (const app of apps) {
  const assetsDir = join("apps", app, "dist", "assets");
  const files = (await readdir(assetsDir))
    .filter((file) => file.endsWith(".js"));
  const sizes = await Promise.all(files.map(async (file) => ({
    file,
    bytes: (await stat(join(assetsDir, file))).size,
  })));

  const largest = sizes.reduce(
    (current, item) => item.bytes > current.bytes ? item : current,
    { file: "", bytes: 0 }
  );
  const entry = sizes.find((item) => item.file.startsWith("index-"));

  if (largest.bytes > maxChunkBytes) {
    failures.push(
      `${app}: ${largest.file} is ${formatKb(largest.bytes)}KB ` +
      `(limit ${formatKb(maxChunkBytes)}KB)`
    );
  }
  if (!entry) {
    failures.push(`${app}: entry chunk was not found`);
  } else if (entry.bytes > maxEntryBytes) {
    failures.push(
      `${app}: ${entry.file} is ${formatKb(entry.bytes)}KB ` +
      `(entry limit ${formatKb(maxEntryBytes)}KB)`
    );
  }

  console.log(
    `${app}: entry ${formatKb(entry?.bytes ?? 0)}KB, ` +
    `largest ${formatKb(largest.bytes)}KB, ${sizes.length} chunks`
  );
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("bundle size checks passed");

function formatKb(bytes) {
  return (bytes / 1024).toFixed(1);
}
