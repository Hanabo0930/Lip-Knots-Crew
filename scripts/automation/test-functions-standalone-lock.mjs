import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root = path.resolve(new URL('../..', import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'functions/package.json'), 'utf8'));
const rootManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.deepEqual(manifest.overrides ?? {}, rootManifest.overrides ?? {}, 'Standalone Functions must preserve canonical dependency overrides');
const canonical = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const file = path.join(root, 'functions/package-lock.json');
const locked = JSON.parse(fs.readFileSync(file, 'utf8'));
const packageName = key => key.slice(key.lastIndexOf('node_modules/') + 13);
const tuple = (key, entry) => JSON.stringify([packageName(key), entry.version, entry.resolved, entry.integrity]);
const approved = new Set(Object.entries(canonical.packages).filter(([key]) => key.startsWith('node_modules/')).map(([key, value]) => tuple(key, value)));
function validate(lock) {
  assert.equal(lock.lockfileVersion, 3); assert.equal(lock.name, manifest.name); assert.equal(lock.version, manifest.version);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'engines'])
    assert.deepEqual(lock.packages[''][field] ?? {}, manifest[field] ?? {});
  for (const [key, value] of Object.entries(lock.packages)) if (key) {
    assert(key.startsWith('node_modules/') && !value.link && approved.has(tuple(key, value)),
      'Standalone lock introduced an unreviewed dependency: ' + packageName(key) + '@' + value.version);
  }
}
validate(locked);
if (process.argv.includes('--install')) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lkc-functions-lock-ci-'));
  try {
    fs.copyFileSync(path.join(root, 'functions/package.json'), path.join(temp, 'package.json'));
    fs.copyFileSync(file, path.join(temp, 'package-lock.json'));
    const args = ['ci', '--ignore-scripts', '--omit=dev', '--audit=false', '--fund=false', '--prefix', temp];
    const result = spawnSync('npm', args, {encoding: 'utf8', timeout: 180000});
    if (result.status !== 0) {
      console.error((result.stderr ?? '').slice(-3000));
      throw Error('FUNCTIONS_STANDALONE_LOCK_INSTALL_FAILED');
    }
    assert.equal(fs.readFileSync(path.join(temp, 'package-lock.json'), 'utf8'), fs.readFileSync(file, 'utf8'));
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
}
console.log(JSON.stringify({standaloneFunctionDependencies: Object.keys(locked.packages).length - 1,
  versionsAlreadyInCanonicalLock: true, standaloneInstallVerified: process.argv.includes('--install'), cloudOperations: false}));
