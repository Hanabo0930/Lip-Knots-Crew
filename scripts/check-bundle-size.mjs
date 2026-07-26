import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const apps = ["staff", "admin"];
const maxChunkBytes = 500 * 1024;
const maxEntryBytes = 350 * 1024;
const maxChunkGzipBytes = 150 * 1024;
const maxEntryGzipBytes = 105 * 1024;
const failures = [];

for (const app of apps) {
  const assetsDir = join("apps", app, "dist", "assets");
  const files = (await readdir(assetsDir))
    .filter((file) => file.endsWith(".js"));
  const sizes = await Promise.all(files.map(async (file) => ({
    file,
    bytes: (await stat(join(assetsDir, file))).size,
    gzipBytes: gzipSync(await readFile(join(assetsDir, file))).length,
  })));

  const largest = sizes.reduce(
    (current, item) => item.bytes > current.bytes ? item : current,
    { file: "", bytes: 0, gzipBytes: 0 }
  );
  const largestGzip = sizes.reduce(
    (current, item) => item.gzipBytes > current.gzipBytes ? item : current,
    { file: "", bytes: 0, gzipBytes: 0 }
  );
  const entry = sizes.find((item) => item.file.startsWith("index-"));

  if (largest.bytes > maxChunkBytes) {
    failures.push(
      `${app}: ${largest.file} is ${formatKb(largest.bytes)}KB ` +
      `(limit ${formatKb(maxChunkBytes)}KB)`
    );
  }
  if (largestGzip.gzipBytes > maxChunkGzipBytes) {
    failures.push(
      `${app}: ${largestGzip.file} transfers as ${formatKb(largestGzip.gzipBytes)}KB gzip ` +
      `(limit ${formatKb(maxChunkGzipBytes)}KB)`
    );
  }
  if (!entry) {
    failures.push(`${app}: entry chunk was not found`);
  } else if (entry.bytes > maxEntryBytes) {
    failures.push(
      `${app}: ${entry.file} is ${formatKb(entry.bytes)}KB ` +
      `(entry limit ${formatKb(maxEntryBytes)}KB)`
    );
  } else if (entry.gzipBytes > maxEntryGzipBytes) {
    failures.push(
      `${app}: ${entry.file} transfers as ${formatKb(entry.gzipBytes)}KB gzip ` +
      `(entry limit ${formatKb(maxEntryGzipBytes)}KB)`
    );
  }

  console.log(
    `${app}: entry ${formatKb(entry?.bytes ?? 0)}KB raw / ` +
    `${formatKb(entry?.gzipBytes ?? 0)}KB gzip, largest ` +
    `${formatKb(largest.bytes)}KB raw / ${formatKb(largestGzip.gzipBytes)}KB gzip, ` +
    `${sizes.length} chunks`
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
