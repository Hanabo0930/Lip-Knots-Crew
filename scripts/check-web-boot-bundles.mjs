import { readFile, readdir } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const apps = ["staff", "admin"];
const failures = [];

verifyCycleDetector();

for (const app of apps) {
  const pwaUpdateSource = await readFile(resolve("apps", app, "src", "pwa-update.ts"), "utf8");
  verifyPwaUpdateLifecycle(app, pwaUpdateSource);
  verifyPwaUpdateBehavior(app, pwaUpdateSource);
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

function verifyPwaUpdateLifecycle(app, source) {
  const checks = [
    ["uses a time-bounded reload guard", source.includes("RELOAD_GUARD_MS") && source.includes("Date.now() - lastReloadAt < RELOAD_GUARD_MS")],
    ["does not permanently suppress later updates", !source.includes('sessionStorage.setItem(reloadKey, "1")') && source.includes("String(Date.now())")],
    ["activates an already-waiting worker", source.includes("activateWaitingWorker(registration)") && source.includes("registration.waiting.postMessage")],
    ["checks for updates when the app returns", source.includes('document.addEventListener("visibilitychange", checkForUpdates)') && source.includes("registration.update()")],
  ];
  for (const [label, passed] of checks) {
    if (!passed) failures.push(`${app}: PWA update lifecycle ${label}`);
  }
}

function verifyPwaUpdateBehavior(app, source) {
  const now = Date.now();
  const firstUpdate = runPwaUpdateModule(source, null, now);
  const immediateRepeat = runPwaUpdateModule(source, now, now);
  const laterUpdate = runPwaUpdateModule(source, now - 60_000, now);
  const checks = [
    ["activates a waiting worker", firstUpdate.waitingMessages === 1],
    ["checks once immediately and again after foregrounding", firstUpdate.updateChecks === 2],
    ["reloads once for the first controller change", firstUpdate.reloads === 1],
    ["suppresses only an immediate repeat reload", immediateRepeat.reloads === 0],
    ["allows a later release to reload automatically", laterUpdate.reloads === 1],
  ];
  for (const [label, passed] of checks) {
    if (!passed) failures.push(`${app}: executable PWA update check ${label}`);
  }
}

function runPwaUpdateModule(source, previousReloadAt, now) {
  const serviceWorkerEvents = new Map();
  const documentEvents = new Map();
  const storage = new Map();
  if (previousReloadAt !== null) storage.set("reload", String(previousReloadAt));
  let reloads = 0;
  let updateChecks = 0;
  let waitingMessages = 0;
  const registration = {
    installing: null,
    waiting: { postMessage: () => { waitingMessages += 1; } },
    addEventListener: () => undefined,
    update: () => { updateChecks += 1; return Promise.resolve(); },
  };
  const module = { exports: {} };
  const compiled = ts.transpileModule(
    source.replace("import.meta.env.PROD", "true"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  runInNewContext(compiled, {
    Date: { now: () => now },
    Number,
    Promise,
    String,
    document: {
      visibilityState: "visible",
      addEventListener: (name, listener) => documentEvents.set(name, listener),
    },
    exports: module.exports,
    module,
    navigator: {
      serviceWorker: {
        controller: {},
        addEventListener: (name, listener) => serviceWorkerEvents.set(name, listener),
      },
    },
    require: (specifier) => {
      if (specifier !== "virtual:pwa-register") throw new Error(`unexpected PWA import: ${specifier}`);
      return {
        registerSW: (options) => {
          options.onRegisteredSW?.("/sw.js", registration);
          return () => undefined;
        },
      };
    },
    sessionStorage: {
      getItem: () => storage.get("reload") ?? null,
      setItem: (_key, value) => storage.set("reload", String(value)),
    },
    window: { location: { reload: () => { reloads += 1; } } },
  });
  module.exports.registerControlledServiceWorker();
  documentEvents.get("visibilitychange")?.();
  serviceWorkerEvents.get("controllerchange")?.();
  serviceWorkerEvents.get("controllerchange")?.();
  return { reloads, updateChecks, waitingMessages };
}
