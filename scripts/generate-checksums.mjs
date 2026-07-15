import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const root = process.cwd();
const outputName = process.argv[2];
const verifyMode = process.argv.includes("--verify");
if (!outputName || outputName.includes("/") || outputName.includes("\\")) {
  console.error("checksum output filename is required");
  process.exit(1);
}

const outputPath = resolve(root, outputName);
const excludedDirectories = new Set(["node_modules", ".git"]);

async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name) || /^test.*-lib$/u.test(entry.name)) continue;
      files.push(...await collect(resolve(directory, entry.name)));
      continue;
    }
    if (!entry.isFile()) continue;
    const absolutePath = resolve(directory, entry.name);
    if (absolutePath !== outputPath) files.push(absolutePath);
  }
  return files;
}

function csv(value) {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const files = (await collect(root)).sort((left, right) =>
  left.localeCompare(right, "en")
);
const rows = ["relative_path,sha256,size_bytes"];
for (const absolutePath of files) {
  const bytes = await readFile(absolutePath);
  const path = relative(root, absolutePath).split(sep).join("/");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const size = (await stat(absolutePath)).size;
  rows.push(`${csv(path)},${sha256},${size}`);
}
const generated = `\uFEFF${rows.join("\n")}\n`;

if (verifyMode) {
  const current = await readFile(outputPath, "utf8");
  if (current !== generated) {
    console.error(`${outputName}: checksum verification failed`);
    process.exit(1);
  }
  console.log(`${outputName}: verified ${files.length} files`);
} else {
  await writeFile(outputPath, generated, "utf8");
  console.log(`${outputName}: wrote ${files.length} files`);
}
