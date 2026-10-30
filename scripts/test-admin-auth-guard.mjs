import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// The dependencies are the existing, locked local copies; all APIs here are mocks.
const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = readFileSync(new URL('../apps/admin/src/App.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const beginMarker = '      void (async()=>{\n        try{\n          const bootstrap=httpsCallable(activeFunctions,"bootstrapSession");';
const endMarker = '\n      })();\n    });';
const begin = source.indexOf(beginMarker), end = source.indexOf(endMarker, begin);
assert.ok(begin >= 0 && end > begin, 'the actual Admin bootstrap handler must be present');
const asyncBlock = source.slice(begin, end + '\n      })();'.length).replace(/^\s*void /, '');
const compiled = ts.transpileModule(asyncBlock, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function bootstrapScenario(role, { staleAt = '', malformed = false, networkFailure = false, loadFailure = false, holdLoad = false, tokenRole = 'admin', tokenCompany = 'synthetic-company' } = {}) {
  const events = [], messages = [];
  let active = true;
  let releaseLoad;
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  const tokenRefresh = () => { events.push('token-refresh'); if (staleAt === 'refresh') active = false; };
  const current = {
    uid: 'synthetic-admin-identity',
    getIdToken: async () => { tokenRefresh(); return 'synthetic-token'; },
    getIdTokenResult: async force => { assert.equal(force, true); tokenRefresh(); return { claims: { role: tokenRole, companyId: tokenCompany } }; },
  };
  const fakeFunctions = {};
  const scope = {
    current, activeFunctions: fakeFunctions, isCurrentRun: () => active,
    authorizedIdentity: null, resumeAdminReads:null, retryAdminTokenRef:{current:null}, adminAuthorizationReadyRef:{current:true},
    httpsCallable: (target, name) => {
      assert.equal(target, fakeFunctions); assert.equal(name, 'bootstrapSession'); events.push('bootstrap');
      return async () => {
        if (staleAt === 'bootstrap') active = false;
        if (networkFailure) throw new Error('接続できません');
        return { data: malformed ? null : { role, companyId: 'synthetic-company', jobs: [], staff: [] } };
      };
    },
    canApplyAuthResult: guard => guard(),
    resetJobPaging: () => {}, setJobs: () => {}, setSelectedAdminJobId: () => {},
    resetStaffPaging: () => {}, setStaff: () => {},
    loadSheetIssues: async () => { events.push('admin-issues'); if (staleAt === 'loaders') active = false; if (holdLoad) await loadGate; if (loadFailure) throw new Error('一覧の読込に失敗'); },
    loadDashboard: async () => { events.push('admin-dashboard'); },
    loadResubmissions: async () => { events.push('admin-resubmissions'); },
    dashboardMonthRef: { current: '2026-10' },
    setMessage: value => messages.push(String(value)),
    setAdminAuthorizationMessage: value => messages.push(String(value)),
    setAdminAuthorized: value => { if (value) events.push('admin-authorized'); },
    setAdminSessionReady: value => { if (value) events.push('admin-ready'); },
    pushActionVersionRef: { current: 0 },
    scheduleWhenIdle: () => () => {}, cancelDeferredLoads: null,
  };
  scope.checkCurrentToken=()=>{scope.setAdminAuthorized(true);scope.resumeAdminReads?.();};
  const task = runInNewContext(compiled, scope, { timeout: 1000 });
  let whileWaiting;
  if (holdLoad) {
    await new Promise(resolve => setImmediate(resolve));
    whileWaiting = [...events];
    releaseLoad();
  }
  await task;
  await new Promise(resolve=>setImmediate(resolve));
  return { events, messages, ...(whileWaiting ? { whileWaiting } : {}) };
}

const staff = await bootstrapScenario('staff');
const admin = await bootstrapScenario('admin');
const unknown = await bootstrapScenario(undefined);
const malformed = await bootstrapScenario(undefined, { malformed: true });
const staleBootstrap = await bootstrapScenario('admin', { staleAt: 'bootstrap' });
const staleRefresh = await bootstrapScenario('admin', { staleAt: 'refresh' });
const staleLoaders = await bootstrapScenario('admin', { staleAt: 'loaders' });
const offline = await bootstrapScenario('admin', { networkFailure: true });
const partialFailure = await bootstrapScenario('admin', { loadFailure: true });
const pendingLoad = await bootstrapScenario('admin', { holdLoad: true });
const wrongTokenRole = await bootstrapScenario('admin', { tokenRole: 'staff' });
const wrongTokenCompany = await bootstrapScenario('admin', { tokenCompany: 'other-company' });
console.log(JSON.stringify({ stage: 'bootstrap', staff, admin, unknown, malformed, staleBootstrap, staleRefresh, staleLoaders, offline, partialFailure, pendingLoad, wrongTokenRole, wrongTokenCompany }));
for (const [name, result] of [['staff', staff], ['unknown', unknown], ['malformed', malformed], ['wrong-token-role', wrongTokenRole], ['wrong-token-company', wrongTokenCompany]]) {
  assert.deepEqual(result.events.filter(event => event.startsWith('admin-')), [], `${name} must not start Admin loaders or mark the session ready`);
  assert.ok(result.messages.some(message => /管理者/.test(message)), `${name} must receive a clear Admin-account message`);
}
assert.deepEqual(admin.events.filter(event => event.startsWith('admin-')), ['admin-authorized', 'admin-issues', 'admin-dashboard', 'admin-resubmissions', 'admin-ready']);
for (const [name, result] of [['stale-bootstrap', staleBootstrap], ['stale-refresh', staleRefresh], ['offline', offline]]) {
  assert.deepEqual(result.events.filter(event => event.startsWith('admin-')), [], `${name} must not start Admin loaders or mark the session ready`);
}
assert.ok(!staleLoaders.events.includes('admin-ready'), 'an account switch while loaders run must not ready the old session');
assert.deepEqual(staleLoaders.messages, [], 'an old session must not overwrite the new account message');
assert.ok(offline.messages.some(message => /接続/.test(message)), 'connection errors remain visible');
assert.ok(partialFailure.events.includes('admin-ready'), 'an authenticated Admin keeps access when a separate initial read fails');
assert.ok(partialFailure.messages.some(message => /一覧/.test(message)), 'the separate read failure remains visible');
assert.ok(pendingLoad.whileWaiting.includes('admin-authorized'), 'a verified Admin may enter while a separate read is pending');
assert.ok(!pendingLoad.whileWaiting.includes('admin-ready'), 'the existing loading gate remains pending until reads settle');

const renderStart = source.indexOf('  if (firebaseConfigured && !user) {');
const alternateStart = source.indexOf('  if (firebaseConfigured && (!user || !adminAuthorized&&!adminShellRetained)) {');
const gateStart = renderStart >= 0 ? renderStart : alternateStart;
const gateEnd = source.indexOf('\n\n  const unresolved =', gateStart);
assert.ok(gateStart >= 0 && gateEnd > gateStart, 'the actual Admin login gate must be present');
const gate = `(() => { ${source.slice(gateStart, gateEnd)}; return null; })()`;
const gateJs = ts.transpileModule(gate, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
function renderGate({ configured = true, user = null, authorized = false, retained = false, ready = false, message = '', authMessage = '' } = {}) {
  const element = runInNewContext(gateJs, { React, firebaseConfigured: configured, user, adminAuthorized: authorized, adminShellRetained:retained, retryAdminTokenRef:{current:null}, adminSessionReady: ready, message, adminAuthorizationMessage: authMessage, login: () => {}, auth: {}, signOut: () => {} });
  return element ? renderToStaticMarkup(element) : null;
}
assert.match(renderGate(), /管理者Googleアカウント/);
assert.match(renderGate({ user: { uid: 'synthetic-staff' }, authMessage: '管理者アカウントでログインしてください。' }), /管理者アカウント/);
assert.doesNotMatch(renderGate({ user: { uid: 'synthetic-staff' }, message: 'synthetic-private-message' }), /synthetic-private-message/);
assert.match(renderGate({ user: { uid: 'synthetic-admin' } }), /確認中/);
assert.equal(renderGate({ user: { uid: 'synthetic-admin' }, authorized: true, ready: false }), null);
assert.equal(renderGate({ user: { uid: 'synthetic-admin' }, authorized: true, ready: true }), null);
assert.equal(renderGate({ configured: false }), null);
assert.equal(renderGate({user:{uid:'synthetic-admin'},retained:true,authMessage:'synthetic transient error'}),null,'a transient failure does not take the early-return branch that unmounts the shell');
const shellStart=source.indexOf('  return (<>\n');
const shellTagEnd=source.indexOf('aria-hidden={!adminAuthorized||undefined}>',shellStart)+'aria-hidden={!adminAuthorized||undefined}>'.length;
assert.ok(shellStart>=0&&shellTagEnd>shellStart);
const shellJs=ts.transpileModule(`(()=>{${source.slice(shellStart,shellTagEnd)}<input defaultValue="synthetic unsaved input"/></main></>);})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
function retainedShell(authorized){return runInNewContext(shellJs,{React,adminAuthorized:authorized,adminAuthorizationMessage:authorized?'':'synthetic transient error',adminTokenChecking:false,retryAdminTokenRef:{current:()=>{}},auth:{},signOut:()=>{},motionPaused:false,productionBlocked:false});}
const shown=retainedShell(true),blocked=retainedShell(false);
assert.equal(shown.props.children[1].type,blocked.props.children[1].type);
assert.equal(shown.props.children[1].key,blocked.props.children[1].key);
assert.equal(blocked.props.children[1].props.style.display,'none');
assert.equal(blocked.props.children[1].props['aria-hidden'],true);
assert.match(renderToStaticMarkup(blocked),/synthetic unsaved input/);
assert.match(renderToStaticMarkup(blocked),/権限確認を再試行/);
const authEffectStart=source.indexOf('  useEffect(() => {\n    const activeAuth=auth;');
const bootstrapStart=source.indexOf(beginMarker,authEffectStart);
assert.ok(source.slice(authEffectStart,bootstrapStart).includes('setAdminAuthorized(false);'), 'each auth event clears the previous account authorization');
console.log(JSON.stringify({ status: 'PASS', cases: ['admin', 'staff', 'unknown-role', 'malformed-response', 'wrong-token-role', 'wrong-token-company', 'stale-bootstrap', 'stale-token-refresh', 'stale-loaders', 'offline', 'partial-read-failure', 'pending-read', 'signed-out', 'pending-auth', 'admin-authorized', 'demo'], realNetworkCalls: 0 }));
