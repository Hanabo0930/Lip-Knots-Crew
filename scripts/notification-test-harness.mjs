import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT
  ? new URL('package.json', 'file:///'+process.env.LKC_TEST_DEPENDENCY_ROOT.replace(/\\/g,'/').replace(/\/$/,'')+'/')
  : import.meta.url);
const ts = require('typescript');
const { Timestamp: RealTimestamp } = require('firebase-admin/firestore');

export function setup(at = '2026-09-11T21:59:00+09:00', environment = {}, compiled = false, actualOperationalGate = false) {
  const state = { queryReads: 0, now: Date.parse(at), records: new Map(), sent: [], metrics: [], revokedUids: [], transactionRetries: 0, operational: true, failSend: false, errors: [], suppressExpectedErrors: false };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  }
  const Timestamp = new Proxy(RealTimestamp, { get: (target, key) => key === 'now' ? () => RealTimestamp.fromMillis(state.now) : Reflect.get(target, key) });
  const copy = value => value instanceof RealTimestamp ? value : Array.isArray(value) ? Array.from(value, copy) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, copy(v)])) : value;
  const write = (path, values, merge = true) => {
    const next = merge ? copy(state.records.get(path) ?? {}) : {};
    for (const [key, value] of Object.entries(values)) next[key] = value?.increment !== undefined ? (next[key] ?? 0) + value.increment : copy(value);
    state.records.set(path, next);
  };
  let ids = 0;
  const ref = path => ({ path, id: path.split('/').at(-1), get: async () => { const snap = snapshot(path); await state.onRead?.(path); return snap; }, set: async (values, options) => { await state.onSet?.(path, values); write(path, values, options?.merge === true); } });
  const snapshot = path => { const data = copy(state.records.get(path)); return { id: path.split('/').at(-1), ref: ref(path), exists: data !== undefined, data: () => data }; };
  const scalar = value => value instanceof RealTimestamp ? value.toMillis() : value;
  const query = (name, filters = [], limit = Infinity, order = null, after = null) => ({
    doc: id => ref(name + '/' + (id ?? 'synthetic-' + ++ids)),
    add: async values => { const path = name + '/synthetic-' + ++ids; write(path, values, false); return ref(path); },
    where: (key, op, value) => query(name, [...filters, [key, op, value]], limit, order, after),
    limit: count => query(name, filters, count, order, after),
    orderBy: (key, direction) => query(name, filters, limit, [key, direction], after),
    startAfter: doc => query(name, filters, limit, order, doc),
    get: async () => {
      state.queryReads++;
      state.onQuery?.({name,limit,after:after?.id,order});
      if (name === 'pushTokens') state.onResolve?.();
      let entries = [...state.records].filter(([path, data]) => path.startsWith(name + '/') && filters.every(([key, op, value]) => op === '==' ? scalar(data[key]) === scalar(value) : op === '<=' ? scalar(data[key]) <= scalar(value) : op === '>=' ? scalar(data[key]) >= scalar(value) : assert.fail('Unsupported operator ' + op)));
      const compare = (a,b) => {
        const left=order?scalar(a[1][order[0]]):null, right=order?scalar(b[1][order[0]]):null;
        const direction=order?.[1]==='desc'?-1:1;
        return ((left<right?-1:left>right?1:0)||a[0].localeCompare(b[0]))*direction;
      };
      entries.sort(compare);
      if (after) entries = entries.filter(entry => compare(entry, [after.ref.path, after.data()]) > 0);
      const docs = entries.slice(0, limit).map(([path]) => snapshot(path));
      if (name === 'deviceSessions') await state.onDevicesRead?.(docs);
      if (name === 'notificationQueue' && filters.some(([key]) => key === 'quietDeferred')) await state.onDeferred?.(docs);
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });
  const db = { collection: name => query(name), runTransaction: async callback => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const writes = [], reads = new Map();
      const get = async reference => {
        assert.equal(writes.length, 0, 'Firestore reads must precede writes');
        const snap = await reference.get();
        if (typeof snap.data === 'function') reads.set(reference.path, JSON.stringify(snap.data()));
        return snap;
      };
      const result = await callback({
        get,
        getAll: (...refs) => Promise.all(refs.map(get)),
        create: (reference, values) => writes.push([reference.path, values, false]),
        set: (reference, values, options) => writes.push([reference.path, values, options?.merge === true]),
        update: (reference, values) => writes.push([reference.path, values, true]),
      });
      await state.onBeforeCommit?.(writes);
      if ([...reads].some(([path, before]) => JSON.stringify(state.records.get(path)) !== before)) { state.transactionRetries++; continue; }
      writes.forEach(([path, values, merge]) => { if (!merge) assert.ok(!state.records.has(path), 'create conflict'); write(path, values, merge); });
      await state.onAfterCommit?.(writes);
      return result;
    }
    throw Error('Synthetic transaction retry limit');
  }, batch: () => { const writes = []; return { set: (reference, values) => writes.push([reference.path, values]), commit: async () => { assert.ok(writes.length <= 500, 'Firestore batch write limit'); writes.forEach(args => write(...args)); } }; } };
  const boundaries = {
    'node:crypto': crypto,
    'node:util': { isDeepStrictEqual },
    zod: require('zod'),
    'firebase-functions/params': { defineString: () => ({ value: () => 'synthetic-admin@example.invalid' }) },
    'firebase-functions/v2/https': { HttpsError: require('firebase-functions/v2/https').HttpsError, onCall: fn => fn },
    'firebase-admin/firestore': { Timestamp, FieldValue: { serverTimestamp: Timestamp.now, increment: value => ({ increment: value }) } },
    'firebase-functions/v2/firestore': { onDocumentCreated: (_, fn) => fn },
    'firebase-functions/v2/scheduler': { onSchedule: (_, fn) => fn },
    './firebase': { db, auth: { revokeRefreshTokens: async uid => { await state.onRevoke?.(uid); state.revokedUids.push(uid); } }, messaging: { sendEachForMulticast: async input => {
      state.sent.push(copy(input)); state.onSend?.(); if (state.failSend) throw Error('Synthetic FCM failure');
      return state.response?.(input.tokens.length) ?? { successCount: input.tokens.length, failureCount: 0, responses: input.tokens.map(() => ({ success: true })) };
    } } },
    './system-safety': { assertProductionOperational: async () => { if (!state.operational) throw Error('Synthetic operation stopped'); }, getProductionOperationalState: async () => { state.onOperational?.(); return { operational: state.operational, reason: 'synthetic' }; } },
    './production-metrics': { incrementProductionMetrics: async (...args) => { state.metrics.push(args); } },
  };
  const moduleConsole = { ...console, error: (...args) => { state.errors.push(args); if (!state.suppressExpectedErrors) console.error(...args); } };
  const modules = {};
  function load(name) {
    if (boundaries[name] && !(actualOperationalGate && name === "./system-safety")) return boundaries[name];
    assert.ok(['./case-list-publication-state', './case-mail-preparation-core', './assignment-preparation-core', './netprint-state-core', './sheet-write-core', './resubmissions', './submission-integrity', './operational-reminder', './notification-core', './notifications', './notification-time', './japan-business-day', './push-delivery', './devices', './push-tokens', './utils', './case-id', './device-authentication', './reminder-scheduler', './staff-tasks', './task-core', './staff-session', './system-safety'].includes(name), name);
    if (modules[name]) return modules[name];
    const exports = {}; modules[name] = exports;
    const source = fs.readFileSync('functions/' + (compiled ? 'lib/' : 'src/') + name.slice(2) + (compiled ? '.js' : '.ts'), 'utf8');
    runInNewContext(compiled ? source : ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: load, Date: Clock, console: moduleConsole, process: { env: { ...environment } } });
    return exports;
  }
  const core = load('./notification-core'), worker = load('./notifications');
  const input = { companyId: 'company-a', targetStaffId: 'staff-a', title: '合成通知', body: '合成検証', category: 'general', dedupeKey: 'synthetic' };
  state.records.set('staffProfiles/staff-a', { companyId: 'company-a', active: true });
  state.records.set('pushTokens/target', { companyId: 'company-a', staffId: 'staff-a', active: true, token: 'synthetic-target' });
  return { state, core, input, load, setTime: at => { state.now = Date.parse(at); }, enqueue: overrides => core.enqueueNotification({ ...input, ...overrides }), document: id => state.records.get('notificationQueue/' + id), trigger: id => worker.processNotificationQueue({ data: snapshot('notificationQueue/' + id) }), event: id => { const data = snapshot('notificationQueue/' + id); return () => worker.processNotificationQueue({ data }); }, tick: () => worker.dispatchDueNotifications(), Timestamp };
}
