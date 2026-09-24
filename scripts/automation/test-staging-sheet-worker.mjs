import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { assertRetryWorkerSource, assertSheetWorkerRecovery, retryWorkerSourcePins } from './validate-staging-sheet-worker.mjs';
import { safetyConfig, validatePlan } from './validate-staging-scope.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sources = Object.fromEntries(Object.keys(retryWorkerSourcePins).map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lkc-sheet-worker-'));
const plan = {project: 'lip-knots-crew-staging', region: 'asia-northeast1', functions: ['retrySafeSheetWrites']};
const dotenv = path.join(temp, 'functions/.env.' + plan.project);
const base = 'APP_ENVIRONMENT=staging\nEXPECTED_FIREBASE_PROJECT_ID=' + plan.project + '\nLKC_SHEET_WRITE_MODE=paused\nLKC_NOTIFICATION_DELIVERY_MODE=paused\nDUMMY_SECRET=synthetic-never-print\n';
let cases = 0;
function check(fn) { fn(); cases++; }
function populate() {
  for (const [file, source] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(temp, file)), {recursive: true});
    fs.writeFileSync(path.join(temp, file), source);
  }
  fs.writeFileSync(dotenv, base);
  fs.writeFileSync(path.join(temp, 'firebase.json'), '{}');
}
try {
  check(() => assertRetryWorkerSource(file => sources[file]));
  check(() => assertRetryWorkerSource(file => sources[file].replace(/\r?\n/g, '\r\n')));
  for (const file of Object.keys(sources)) {
    check(() => assert.throws(() => assertRetryWorkerSource(name => name === file ? '' : sources[name]), /SOURCE_NOT_REVIEWED/));
    check(() => assert.throws(() => assertRetryWorkerSource(name => { if (name === file) throw Error('private detail'); return sources[name]; }), /^Error: RETRY_WORKER_SOURCE_MISSING$/));
  }
  const worker = 'functions/src/safe-sheet-writes.ts', control = 'functions/src/sheet-write-control.ts', index = 'functions/src/index.ts';
  for (const [file, before, after] of [
    [worker, 'if (sheetWriteExecutionPaused()) return;', 'if (false) return;'],
    [worker, '// 停止中は再試行の予約変更や期限切れ処理も行わない。', 'await db.collection("sheetSyncQueue").get();'],
    [worker, '"sheetSyncQueue"', '"otherQueue"'],
    [worker, '"retry_wait"', '"pending"'],
    [worker, 'from "firebase-functions/v2/scheduler"', 'from "./untrusted"'],
    [worker, 'onSchedule({ schedule:', 'onRequest({ schedule:'],
    [worker, 'schedule: "every 5 minutes"', 'schedule: "every 1 minutes"'],
    [worker, 'timeoutSeconds: 300', 'timeoutSeconds: 300, invoker: "public"'],
    [control, '!== "active"', '=== "paused"'],
    [index, 'region: "asia-northeast1"', 'region: "us-central1"'],
    [index, 'retrySafeSheetWrites } from "./safe-sheet-writes"', 'retrySafeSheetWrites } from "./other"'],
  ]) {
    assert.ok(sources[file].includes(before));
    check(() => assert.throws(() => assertRetryWorkerSource(name => name === file ? sources[name].replace(before, after) : sources[name]), /SOURCE_NOT_REVIEWED/));
  }
  // 既存のソースガードから実際に専用検査が呼ばれることも確認する。
  const guard = fs.readFileSync(path.join(root, 'scripts/automation/check-function-auth-guards.mjs'), 'utf8').replace(/\r\n/g, '\n').replace(/^import .*;\n/gm, '');
  function runGuard(contents) {
    const lines = [], fakeProcess = {argv: ['node', 'guard', '--functions', 'retrySafeSheetWrites', '--require-pass'], exitCode: 0, exit: code => { throw Error('unexpected exit ' + code); }};
    runInNewContext(guard, {process: fakeProcess, console: {log: line => lines.push(line), error: line => lines.push(line)}, assertRetryWorkerSource,
      execFileSync: (cmd, args) => { assert.equal(cmd, 'git'); return contents[args[1].slice(args[1].indexOf(':') + 1)]; }}, {timeout: 3000});
    return {passed: lines.includes('SOURCE_GUARD_STATUS=PASS'), exitCode: fakeProcess.exitCode};
  }
  check(() => assert.deepEqual(runGuard(sources), {passed: true, exitCode: 0}));
  check(() => assert.deepEqual(runGuard({...sources, [control]: sources[control].replace('!== "active"', '=== "paused"')}), {passed: false, exitCode: 1}));
  populate();
  for (const text of [base, base.replace(/\n/g, '\r\n')]) {
    fs.writeFileSync(dotenv, text);
    check(() => { assertSheetWorkerRecovery(plan, temp); assert.equal(fs.readFileSync(dotenv, 'utf8'), text); });
  }
  for (const key of ['APP_ENVIRONMENT', 'EXPECTED_FIREBASE_PROJECT_ID', 'LKC_SHEET_WRITE_MODE', 'LKC_NOTIFICATION_DELIVERY_MODE']) {
    for (const changed of [base.replace(new RegExp('^' + key + '=.*\n', 'm'), ''), base.replace(new RegExp('^' + key + '=.*', 'm'), key + '=active'), base + key + '=paused\n', base + 'export ' + key + '=active\n', base + ' ' + key + ' = active\n']) {
      fs.writeFileSync(dotenv, changed);
      check(() => assert.throws(() => assertSheetWorkerRecovery(plan, temp), /PAUSE_CONFIG_INVALID/));
    }
  }
  for (const value of ['"paused"', 'PAUSED', ' paused', 'paused ', '', 'unknown']) {
    fs.writeFileSync(dotenv, base.replace('LKC_SHEET_WRITE_MODE=paused', 'LKC_SHEET_WRITE_MODE=' + value));
    check(() => assert.throws(() => assertSheetWorkerRecovery(plan, temp), /PAUSE_CONFIG_INVALID/));
  }
  fs.unlinkSync(dotenv);
  check(() => assert.throws(() => assertSheetWorkerRecovery(plan, temp), /PAUSE_CONFIG_MISSING/));
  fs.writeFileSync(dotenv, base);
  for (const name of ['.env', '.env.local', '.env.staging', '.env.other']) {
    const file = path.join(temp, 'functions', name); fs.writeFileSync(file, 'LKC_SHEET_WRITE_MODE=active');
    check(() => assert.throws(() => assertSheetWorkerRecovery(plan, temp), /AMBIGUOUS_DOTENV/)); fs.unlinkSync(file);
  }
  fs.writeFileSync(path.join(temp, 'functions/.env.staging.example'), 'LKC_SHEET_WRITE_MODE=active');
  check(() => assertSheetWorkerRecovery(plan, temp));
  for (const change of [{project: 'other'}, {region: 'us-central1'}, {functions: ['retrySafeSheetWrites', 'bootstrapSession']}, {functions: ['retrySafeSheetWrites', 'retrySafeSheetWrites']}]) {
    check(() => assert.throws(() => assertSheetWorkerRecovery({...plan, ...change}, temp), /SINGLE_STAGING_TARGET_REQUIRED/));
  }
  for (const functions of [['processSafeSheetWrite'], ['retrySafeSheetWrites', 'processSafeSheetWrite']]) {
    check(() => assert.throws(() => assertSheetWorkerRecovery({...plan, functions}, temp), /QUIESCENCE_REQUIRED/));
  }
  check(() => assertSheetWorkerRecovery({...plan, functions: ['bootstrapSession']}, path.join(temp, 'missing')));
  const wf = fs.readFileSync(path.join(root, '.github/workflows/staging-functions-deploy.yml'), 'utf8');
  check(() => { assert.equal(wf.split("printf 'LKC_SHEET_WRITE_MODE=paused\\n'").length, 2); assert.doesNotMatch(wf, /sheet_write_mode:\s*\n/); });
  check(() => {
    const guardJob = wf.slice(wf.indexOf('  guard:'), wf.indexOf('\n  deploy:'));
    const deployJob = wf.slice(wf.indexOf('\n  deploy:'), wf.indexOf('\n  smoke-guard:'));
    assert.ok(guardJob.includes('source_sha: ${{ steps.source-identity.outputs.source_sha }}'));
    assert.ok(guardJob.includes('echo "source_sha=$(git -C source rev-parse HEAD)" >> "$GITHUB_OUTPUT"'));
    assert.ok(deployJob.includes('ref: ${{ needs.guard.outputs.source_sha }}'));
    assert.ok(!deployJob.includes('ref: ${{ inputs.source_ref }}'));
    assert.ok(deployJob.indexOf('DEPLOY_SOURCE_COMMIT_MISMATCH') < deployJob.indexOf('npm ci'));
  });
  const runner = fs.readFileSync(path.join(root, 'scripts/automation/run-staging-firebase-deploy.cjs'), 'utf8');
  check(() => { assert.ok(runner.indexOf('assertSheetWorkerRecovery(plan, source)') < runner.indexOf('const cli = resolveCli()')); assert.ok(runner.includes('validatePlan({')); });
  // 通常の確認語ではretryを通さず、旧workerは引き続き対象外。
  for (const [name, expected] of [['retrySafeSheetWrites', /RETRY_RECOVERY_CONFIRMATION_REJECTED/], ['processSafeSheetWrite', /FUNCTIONS_NOT_ALLOWED/]]) {
    check(() => assert.throws(() => validatePlan({mode: 'functions-deploy', project: plan.project, region: plan.region, sourceRef: 'main', functions: name, confirmation: safetyConfig.confirmations.functionsDeploy}), expected));
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/automation/run-staging-firebase-deploy.cjs')], {encoding: 'utf8', env: {PATH: '', SystemRoot: process.env.SystemRoot ?? '', LKC_PROJECT_ID: plan.project, LKC_REGION: plan.region, LKC_SOURCE_REF: 'main', LKC_FUNCTIONS: name, LKC_CONFIRMATION: safetyConfig.confirmations.functionsDeploy, LKC_SOURCE_DIRECTORY: temp}});
    check(() => { assert.equal(result.status, 1); assert.match(result.stderr, expected); assert.doesNotMatch(result.stdout + result.stderr, /synthetic-never-print|PINNED_FIREBASE_CLI_NOT_FOUND/); });
  }
  // 専用確認語でも停止値が不正ならCLI探索前に拒否する。
  populate();
  for (const value of [base.replace('LKC_SHEET_WRITE_MODE=paused', 'LKC_SHEET_WRITE_MODE=active'), base.replace('LKC_SHEET_WRITE_MODE=paused\n', ''), base + 'LKC_SHEET_WRITE_MODE=paused\n']) {
    fs.writeFileSync(dotenv, value);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/automation/run-staging-firebase-deploy.cjs')], {encoding: 'utf8', env: {PATH: '', SystemRoot: process.env.SystemRoot ?? '', LKC_PROJECT_ID: plan.project, LKC_REGION: plan.region, LKC_SOURCE_REF: 'main', LKC_FUNCTIONS: 'retrySafeSheetWrites', LKC_CONFIRMATION: safetyConfig.confirmations.retryWorkerRecovery, LKC_SOURCE_DIRECTORY: temp}});
    check(() => { assert.equal(result.status, 1); assert.match(result.stderr, /SHEET_WORKER_PAUSE_CONFIG_INVALID/); assert.doesNotMatch(result.stdout + result.stderr, /synthetic-never-print|PINNED_FIREBASE_CLI_NOT_FOUND/); });
  }
  console.log(JSON.stringify({sheetWorkerRecoveryTests: cases, cloudOperations: false, retryOnlyAllowlisted: true}));
} finally {
  if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('lkc-sheet-worker-')) throw Error('Unexpected temp location');
  fs.rmSync(temp, {recursive: true, force: true});
}
