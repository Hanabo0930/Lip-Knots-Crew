'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { runInNewContext } = require('node:vm');

const guard = 'scripts/automation/check-function-auth-guards.mjs';
const read = path => fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const source = read(guard).replace(/^import .*;\n/gm, '');

function check(name, transformPath, transform = text => text) {
  const lines = [];
  const process = {
    argv: ['node', guard, '--functions', name, '--require-pass'],
    exitCode: 0,
    exit(code) { throw Error('Source check exited: ' + code + '\n' + lines.join('\n')); },
  };
  runInNewContext(source, {
    process,
    console: { log: line => lines.push(line), error: line => lines.push(line) },
    execFileSync(command, args) {
      assert.equal(command, 'git');
      assert.equal(args[0], 'show');
      assert(args[1].startsWith('HEAD:'));
      const path = args[1].slice(5);
      assert.match(path, /^[a-zA-Z0-9_.\/-]+$/);
      assert(!path.includes('..'));
      const contents = read(path);
      return path === transformPath ? transform(contents) : contents;
    },
  }, { timeout: 5000 });
  return { passed: lines.includes('SOURCE_GUARD_STATUS=PASS'), exitCode: process.exitCode, lines };
}

const jobs = 'functions/src/jobs.ts';
const tasks = 'functions/src/staff-tasks.ts';
const session = 'functions/src/staff-session.ts';
const auth = 'functions/src/auth.ts';
const gate = 'await readActiveStaffProfile(tx, companyId, staffId, session.uid, session.token.auth_time);';
const mutants = [
  ['applyToJob', jobs, text => text.replace(gate, 'await unverifiedStaff();')],
  ['applyToJob', jobs, text => text.replace(
    '    const staff = ' + gate + '\n    const idempotencySnap = await tx.get(idempotencyRef);',
    '    const idempotencySnap = await tx.get(idempotencyRef);\n    const staff = ' + gate
  )],
  ['getMyTasks', tasks, text => text.replace(gate, '// ' + gate)],
  ['getMyTasks', tasks, text => text.replace('readOnly: true', 'readOnly: false')],
  ['applyToJob', session, text => text.replace('linked?.active !== true', 'false')],
  ['getMyTasks', session, text => text.replace('staff?.active !== true', 'false')],
  ['getMyTasks', session, text => text.replace('revokedAt.nanoseconds > 0', 'false')],
  ['bootstrapSession', auth, text => text.replace('user.disabled || ', '')],
  ['bootstrapSession', auth, text => text.replace('authTime * 1000 < validSince', 'false')],
];

for (const name of ['applyToJob', 'getMyTasks', 'bootstrapSession']) {
  const result = check(name);
  assert.equal(result.passed, true, result.lines.join('\n'));
  assert.equal(result.exitCode, 0);
}
for (const [name, path, transform] of mutants) {
  const original = read(path);
  assert.notEqual(transform(original), original);
  const result = check(name, path, transform);
  assert.equal(result.passed, false, result.lines.join('\n'));
  assert.equal(result.exitCode, 1);
}
console.log(JSON.stringify({ correctSourcesPassed: 3, unsafeMutationsRejected: mutants.length, formalCiInvoked: false }));
