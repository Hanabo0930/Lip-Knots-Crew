import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';

const dependencyRoot = process.env.LKC_TEST_DEPENDENCY_ROOT;
assert.ok(dependencyRoot);
const require = createRequire(path.join(dependencyRoot, 'package.json'));
const ts = require('typescript');
const sourceFile = path.resolve('apps/staff/src/sw.ts');
const origin = 'https://synthetic-worker.invalid';
const pageCache = 'lkc-staff-pages';
const unhandled = [];
const recordUnhandled = error => unhandled.push(String(error?.message ?? error));
process.on('unhandledRejection', recordUnhandled);

class ExtendableEvent {
  constructor(type) { this.type = type; this.pending = []; }
  waitUntil(value) {
    const promise = Promise.resolve(value);
    promise.catch(() => {});
    this.pending.push(promise);
  }
  async finish() {
    const errors = [];
    for (let i = 0; i < this.pending.length; i++) {
      try { await this.pending[i]; }
      catch (error) { errors.push(error.message); }
    }
    return errors;
  }
}
class FetchEvent extends ExtendableEvent {
  constructor(request) {
    super('fetch');
    this.request = request;
    this.clientId = 'synthetic-client';
    this.preloadResponse = Promise.resolve(undefined);
  }
  respondWith(value) { this.response = Promise.resolve(value); }
}

function fixture({ manifest = [{ url: "/index.html", revision: "synthetic-revision" }],
  assets = new Map(), buckets = new Map() } = {}) {
  const listeners = new Map(), warnings = [];
  const state = { writeError: null, assetHistoryWriteError: null, offline: false, sequence: 0, networkPaths: [] };
  const asRequest = input => input instanceof Request ? input : new Request(new URL(String(input), origin));
  const caches = {
    async open(name) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const entries = buckets.get(name);
      return {
        async match(input) {
          const request = asRequest(input);
          if (new URL(request.url).pathname === state.failedCacheReadPath) throw Error("synthetic cache read failure");
          return entries.get(request.url)?.clone();
        },
        async put(input, response) {
          if (name === pageCache && state.writeError) throw state.writeError;
          if (state.assetHistoryWriteError && asRequest(input).url.endsWith("/.lkc-staff-asset-generations")) {
            throw state.assetHistoryWriteError;
          }
          entries.set(asRequest(input).url, response.clone());
        },
        async keys() { return [...entries.keys()].map(url => new Request(url)); },
        async delete(input) { return entries.delete(asRequest(input).url); },
      };
    },
    async match(input, options) {
      const names = options?.cacheName ? [options.cacheName] : buckets.keys();
      for (const name of names) {
        const response = await (await this.open(name)).match(input);
        if (response) return response;
      }
    },
    async keys() { return [...buckets.keys()]; },
    async delete(name) { return buckets.delete(name); },
  };
  const fetch = async input => {
    const req = asRequest(input);
    assert.equal(new URL(req.url).origin, origin);
    state.networkPaths.push(new URL(req.url).pathname);
    if (state.offline) throw Error('SYNTHETIC_OFFLINE');
    const file = new URL(req.url).pathname.slice(1);
    if (assets.has(file)) return new Response(assets.get(file));
    if (file.startsWith('assets/')) return new Response('synthetic not found', { status: 404 });
    const html = req.mode === 'navigate' ? 'network html ' + ++state.sequence : 'isolated offline shell';
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const self = {
    __WB_MANIFEST: manifest,
    location: new URL(origin + '/sw.js'),
    registration: { scope: origin + '/', navigationPreload: { enable: async () => {} } },
    clients: { claim: async () => {}, matchAll: async () => [] }, skipWaiting: async () => {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener() {},
    caches, fetch, Request, Response, Headers, URL,
  };
  const context = createContext({
    self, location: self.location, caches, fetch, navigator: { userAgent: 'Synthetic' },
    Request, Response, Headers, URL, URLSearchParams, FetchEvent, ExtendableEvent,
    Error, DOMException, performance, crypto: webcrypto, TextEncoder, TextDecoder, AbortController,
    setTimeout, clearTimeout, process: { env: { NODE_ENV: 'production' } },
    console: { log() {}, warn: message => warnings.push(message), error() {} },
  });
  const modules = new Map();
  const boundaries = {
    'firebase/app': { initializeApp: () => assert.fail('Firebase disabled') },
    'firebase/messaging/sw': { getMessaging: () => assert.fail('Messaging disabled') },
  };
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const contents = fs.readFileSync(file, 'utf8').replaceAll('import.meta.env', '({})');
    const code = ts.transpileModule(contents, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const body = runInContext('(function(require,module,exports){\n' + code + '\n})', context, { filename: file });
    body(specifier => {
      if (Object.hasOwn(boundaries, specifier)) return boundaries[specifier];
      if (!specifier.startsWith('.')) return load(require.resolve(specifier));
      const candidate = path.resolve(path.dirname(file), specifier);
      return load(fs.existsSync(candidate) ? candidate : candidate + '.ts');
    }, module, module.exports);
    return module.exports;
  }
  load(sourceFile);
  const precacheName = load(require.resolve("workbox-core")).cacheNames.precache;
  const dispatch = async event => {
    for (const listener of listeners.get(event.type) ?? []) listener(event);
  };
  return {
    state, warnings,
    async seedPrecache(files) {
      const cache = await caches.open(precacheName);
      for (const [url, bytes] of files) await cache.put(url, new Response(bytes));
    },
    async seedPage(url) { await (await caches.open(pageCache)).put(url, new Response("synthetic")); },
    async precacheURLs() { return (await (await caches.open(precacheName)).keys()).map(request => request.url); },
    async resource(url) {
      const event = new FetchEvent(asRequest(url));
      await dispatch(event);
      const value = await event.response;
      assert.deepEqual(await event.finish(), []);
      return value;
    },
    async boot() {
      for (const type of ['install', 'activate']) {
        const event = new ExtendableEvent(type);
        await dispatch(event);
        assert.deepEqual(await event.finish(), []);
      }
    },
    async navigate(url) {
      const req = asRequest(url);
      Object.defineProperty(req, 'mode', { value: 'navigate' });
      const event = new FetchEvent(req);
      await dispatch(event);
      assert.ok(event.response);
      const response = await event.response;
      const body = await response.text();
      assert.deepEqual(await event.finish(), []);
      await new Promise(resolve => setImmediate(resolve));
      return { status: response.status, body };
    },
    keys() { return [...(buckets.get(pageCache)?.keys() ?? [])]; },
    async saved(page) { return (await (await caches.open(pageCache)).match(page))?.text(); },
  };
}

const results = [];
async function test(name, run) {
  const f = fixture();
  await f.boot();
  await run(f);
  assert.deepEqual(unhandled, [], name);
  results.push(name);
}
try {
  await test('successful navigation saves latest markup without the query', async f => {
    await f.navigate('/shifts?oobCode=synthetic-first');
    const second = await f.navigate('/shifts?oobCode=synthetic-second');
    assert.deepEqual(f.keys(), [origin + '/shifts']);
    assert.equal(await f.saved('/shifts'), second.body);
  });
  for (const error of [Error('SYNTHETIC_CACHE_WRITE_FAILED'), new DOMException('synthetic quota', 'QuotaExceededError')]) {
    await test(error.name + ' leaves the online response usable and settles the cache task', async f => {
      f.state.writeError = error;
      assert.deepEqual(await f.navigate('/shifts?oobCode=synthetic-quota'), { status: 200, body: 'network html 1' });
      assert.equal(f.warnings.length, 1);
      assert.deepEqual(f.keys(), []);
    });
  }
  await test('interrupted cache update preserves previous offline content', async f => {
    const first = await f.navigate('/shifts?oobCode=synthetic-one');
    f.state.writeError = new DOMException('synthetic quota', 'QuotaExceededError');
    const online = await f.navigate('/shifts?oobCode=synthetic-two');
    assert.notEqual(online.body, first.body);
    f.state.offline = true;
    assert.deepEqual(await f.navigate('/shifts?oobCode=synthetic-three'), first);
    assert.deepEqual(f.keys(), [origin + '/shifts']);
  });
  await test('without a cached page the offline shell still opens', async f => {
    f.state.offline = true;
    assert.deepEqual(await f.navigate('/unseen?oobCode=synthetic-offline'), { status: 200, body: 'isolated offline shell' });
  });
} finally {
  process.off('unhandledRejection', recordUnhandled);
}


const hashed = suffix => ({
  install: 'assets/index-' + suffix + '.js',
  attempt: 'assets/submission-attempt-store-' + suffix + '.js',
  upload: 'assets/upload-storage-' + suffix + '.js',
});
const version = (names, name) => ({
  entries: [{ url: '/index.html', revision: 'synthetic-shell-' + name },
    ...Object.values(names).map(url => ({ url, revision: null }))],
  files: new Map(Object.values(names).map(url => [url, Buffer.from(name + ':' + url)])),
});
const assetTests = [];
const old = version(hashed('AAAAAAAA'), 'old'), next = version(hashed('BBBBBBBB'), 'next');
const third = version(hashed('CCCCCCCC'), 'third');
const worker = ({ entries, files }, buckets = new Map()) => fixture({ manifest: entries, assets: files, buckets });
async function expectAssetLoaded(f, asset, bytes) {
  const response = await f.resource('/' + asset);
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
}
function rehashedShell(release) {
  return { ...release, entries: release.entries.map(entry => entry.url === '/index.html'
    ? { ...entry, revision: 'different-worker-shell-revision' } : entry) };
}

{
  const caches = new Map(), first = worker(old, caches);
  await first.boot();
  const current = worker(next, caches);
  await current.boot();
  current.state.offline = true;
  const requestsBefore = current.state.networkPaths.length;
  for (const [file, bytes] of [...old.files, ...next.files]) await expectAssetLoaded(current, file, bytes);
  assert.equal(current.state.networkPaths.length, requestsBefore);
  assetTests.push('two successive releases serve current and immediately preceding bytes offline');
}
{
  const caches = new Map(), legacy = worker(old, caches);
  await legacy.seedPrecache(old.files);
  await legacy.seedPage('/shifts?oobCode=synthetic-old-auth');
  const corrupt = [
    origin + '/assets/legacy-AAAAAAAA.js?oobCode=never-cache',
    'https://other.invalid/assets/foreign-AAAAAAAA.js',
    origin + '/drafts/non-asset-AAAAAAAA.js',
  ];
  await legacy.seedPrecache(new Map(corrupt.map(url => [url, Buffer.from('excluded')])));
  const current = worker(next, caches);
  await current.boot();
  for (const [file, bytes] of old.files) await expectAssetLoaded(current, file, bytes);
  assert.deepEqual(current.keys(), []);
  for (const url of corrupt) {
    assert.equal((await current.precacheURLs()).includes(url), false);
    assert.equal(await current.resource(url), undefined);
  }
  assetTests.push('migration retains old generated assets but removes auth-query and foreign cache keys');
}
{
  const caches = new Map();
  await worker(old, caches).boot();
  await worker(next, caches).boot();
  const workerOnly = worker(rehashedShell(next), caches);
  await workerOnly.boot();
  for (const [file, bytes] of old.files) await expectAssetLoaded(workerOnly, file, bytes);
  const newest = worker(third, caches);
  await newest.boot();
  for (const [file, bytes] of [...next.files, ...third.files]) await expectAssetLoaded(newest, file, bytes);
  for (const file of old.files.keys()) {
    assert.equal((await newest.precacheURLs()).includes(new URL(file, origin).href), false);
    assert.equal((await newest.resource('/' + file)).status, 404);
  }
  assetTests.push('worker-only updates keep the prior build, then an actual third build prunes the oldest');
}
{
  const caches = new Map();
  await worker(old, caches).boot();
  const current = worker(next, caches);
  current.state.assetHistoryWriteError = new DOMException('synthetic disk quota', 'QuotaExceededError');
  await current.boot();
  assert.equal(current.warnings.length, 1);
  assert.doesNotMatch(current.warnings[0], /quota|https?:/u);
  for (const [file, bytes] of [...old.files, ...next.files]) await expectAssetLoaded(current, file, bytes);
  assetTests.push('history quota error leaves both static generations readable without an unhandled error');
}
{
  const caches = new Map();
  const legacy = worker(old, caches);
  await legacy.seedPrecache(old.files);
  await legacy.seedPrecache(new Map([[origin + '/.lkc-staff-asset-generations',
    Buffer.from(JSON.stringify({current:['https://example.invalid/assets/private-AAAAAAAA.js']}))]]));
  const current = worker(next, caches);
  await current.boot();
  for (const [file, bytes] of old.files) await expectAssetLoaded(current, file, bytes);
  assert.equal(await current.resource('https://example.invalid/assets/private-AAAAAAAA.js'), undefined);
  assert.equal(await current.resource(origin + '/.lkc-staff-asset-generations'), undefined);
  assetTests.push('invalid metadata is rebuilt from cached same-origin assets and remains internal');
}

{
  const cache = new Map();
  const legacy = worker(old, cache);
  await legacy.seedPrecache(old.files);
  const asset = [...old.files.keys()][0];
  const current = worker(next, cache);
  await current.boot();
  current.state.failedCacheReadPath = '/' + asset;
  next.files.set(asset, old.files.get(asset));
  try {
    await expectAssetLoaded(current, asset, old.files.get(asset));
    assert.equal(current.state.networkPaths.at(-1), '/' + asset);
  } finally {
    next.files.delete(asset);
  }
  assetTests.push('a cache-read failure falls through to the same-origin asset request');
}

const exactAssets = [];
if (process.env.LKC_SW_MIGRATION_INPUTS) {
  const kit = path.resolve(process.env.LKC_SW_MIGRATION_INPUTS);
  const plan = JSON.parse(fs.readFileSync(path.join(kit, 'NATIVE_INPUT_MANIFEST.json')));
  const earlier = JSON.parse(fs.readFileSync(path.join(kit, 'WORKBOX_BUILD_TRANSITION_MODEL.json')));
  const hash = value => createHash('sha256').update(value).digest('hex');
  function emitted(root) {
    const script = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
    const ast = ts.createSourceFile('sw.js', script, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    const lists = [];
    function visit(node) {
      if (ts.isArrayLiteralExpression(node) && node.elements.length > 5 && node.elements.every(item =>
        ts.isObjectLiteralExpression(item) && item.properties.some(prop => prop.name?.text === 'url') &&
        item.properties.some(prop => prop.name?.text === 'revision'))) lists.push(JSON.parse(node.getText(ast)));
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.equal(lists.length, 1);
    return { entries: lists[0], sha256: hash(script) };
  }
  const oldRoot = path.join(kit, 'staff/previous'), currentRoot = path.resolve('apps/staff/dist');
  const source = emitted(oldRoot), newest = emitted(currentRoot);
  assert.equal(source.sha256, plan.staff.previous.workerSha256);
  const oldBytes = new Map(plan.staff.previous.files.filter(({ file }) => file.startsWith('assets/')).map(({ file, sha256 }) => {
    const bytes = fs.readFileSync(path.join(oldRoot, file));
    assert.equal(hash(bytes), sha256, file);
    return [file, bytes];
  }));
  const currentBytes = new Map(newest.entries.map(({ url }) => {
    const file = url.replace(/^\//u, '');
    return [file, fs.readFileSync(path.join(currentRoot, file))];
  }));
  const buckets = new Map();
  const browser = fixture({ manifest: newest.entries, assets: currentBytes, buckets });
  await browser.seedPrecache(oldBytes);
  await browser.boot();
  browser.state.offline = true;
  const requestsBefore = browser.state.networkPaths.length;
  for (const asset of earlier.coldOldTabImportsNeitherCachedNorInNewDistribution) {
    await expectAssetLoaded(browser, asset, oldBytes.get(asset));
    exactAssets.push({ file: asset, sha256: hash(oldBytes.get(asset)) });
  }
  for (const { file } of plan.staff.current.files.filter(({ file }) => file.startsWith('assets/'))) {
    assert.ok(currentBytes.has(file), 'newer deployment asset must still exist: ' + file);
    await expectAssetLoaded(browser, file, currentBytes.get(file));
  }
  assert.equal(browser.state.networkPaths.length, requestsBefore);
}
assert.deepEqual(unhandled, []);

const report = {
  passed: results.length, results, assetTests, exactAssets, unhandledRejections: unhandled.length,
  sourceSha256: createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex'),
  scope: 'Actual Staff SW TypeScript and installed Workbox modules under synthetic fetch/cache/event primitives',
  browserStarted: false, firebaseRequests: 0,
};
if (process.env.LKC_SW_MODEL_EVIDENCE) {
  const file = process.env.LKC_SW_MODEL_EVIDENCE;
  assert.match(file, /^[a-z0-9-]+\.json$/);
  fs.writeFileSync(path.join('release-evidence', file), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify(report));
