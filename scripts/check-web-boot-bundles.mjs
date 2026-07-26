import { readFile, readdir } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";

const apps = ["staff", "admin"];
const failures = [];

verifyCycleDetector();

for (const app of apps) {
  const distRoot = resolve("apps", app, "dist");
  const indexHtml = await readFile(join(distRoot, "index.html"), "utf8");
  const entrySource = findEntrySource(indexHtml);

  if (!entrySource) {
    failures.push(`${app}: module entry script was not found`);
    continue;
  }
  if (!/<div\s+id=["']root["']\s*><\/div>/u.test(indexHtml)) {
    failures.push(`${app}: React root element was not found`);
    continue;
  }

  const modules = await collectJavaScriptFiles(distRoot);
  const graph = new Map();

  for (const modulePath of modules) {
    const source = await readFile(join(distRoot, ...modulePath.split("/")), "utf8");
    const dependencies = [];

    for (const specifier of findStaticImports(source)) {
      if (!specifier.startsWith(".")) continue;
      const dependency = posix.normalize(posix.join(posix.dirname(modulePath), specifier));
      if (!modules.has(dependency)) {
        failures.push(`${app}: ${modulePath} imports missing ${dependency}`);
        continue;
      }
      dependencies.push(dependency);
    }

    graph.set(modulePath, [...new Set(dependencies)]);
  }

  const entryPath = posix.normalize(entrySource.replace(/^\/+/u, ""));
  if (!graph.has(entryPath)) {
    failures.push(`${app}: entry module ${entryPath} was not emitted`);
    continue;
  }

  const cycle = findCycle(graph, entryPath);
  if (cycle) {
    failures.push(`${app}: circular boot imports detected: ${cycle.join(" -> ")}`);
    continue;
  }

  console.log(`${app}: ${entryPath}, ${reachableCount(graph, entryPath)} boot modules, no circular imports`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("web boot bundle checks passed");

function findEntrySource(html) {
  const scripts = html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+\.js)["'][^>]*>/gu);
  return scripts.next().value?.[1] ?? null;
}

function findStaticImports(source) {
  const imports = [];
  const pattern = /\b(?:from\s*|import\s*)["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

async function collectJavaScriptFiles(root) {
  const files = new Set();
  await walk(root);
  return files;

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.add(relative(root, absolute).split(sep).join("/"));
      }
    }
  }
}

function findCycle(graph, start) {
  const visited = new Set();
  const active = new Set();
  const path = [];

  function visit(modulePath) {
    if (active.has(modulePath)) {
      return [...path.slice(path.indexOf(modulePath)), modulePath];
    }
    if (visited.has(modulePath)) return null;

    visited.add(modulePath);
    active.add(modulePath);
    path.push(modulePath);

    for (const dependency of graph.get(modulePath) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }

    path.pop();
    active.delete(modulePath);
    return null;
  }

  return visit(start);
}

function reachableCount(graph, start) {
  const visited = new Set();
  const pending = [start];

  while (pending.length) {
    const modulePath = pending.pop();
    if (visited.has(modulePath)) continue;
    visited.add(modulePath);
    pending.push(...(graph.get(modulePath) ?? []));
  }

  return visited.size;
}

function verifyCycleDetector() {
  const circular = new Map([
    ["entry.js", ["firebase.js"]],
    ["firebase.js", ["shared.js"]],
    ["shared.js", ["firebase.js"]],
  ]);
  const acyclic = new Map([
    ["entry.js", ["firebase.js"]],
    ["firebase.js", ["shared.js"]],
    ["shared.js", []],
  ]);

  if (!findCycle(circular, "entry.js") || findCycle(acyclic, "entry.js")) {
    throw new Error("web boot cycle detector self-test failed");
  }
}
