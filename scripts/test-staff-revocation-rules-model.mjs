import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { AUTH_SECOND, staffRevocationCases } from './fixtures/staff-revocation-cases.mjs';
import { runStaffRevocationClientCases, staffEmulatorToken } from './staff-revocation-client-cases.mjs';

const baselinePath = process.argv[2];
const dependencyRoot = process.env.LKC_TEST_DEPENDENCY_ROOT;
assert.ok(baselinePath && dependencyRoot);
const require = createRequire(path.join(dependencyRoot, 'package.json'));
const ts = require('typescript');
const { Timestamp } = require('firebase-admin/firestore');
const { HttpsError } = require('firebase-functions/v2/https');
const readText = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const role = { role: 'staff', companyId: 'company-a', staffId: 'staff-revocation' };
const staffPath = 'staffProfiles/' + role.staffId;
const personal = { companyId: role.companyId, staffId: role.staffId };
const routes = [
  ['staffProfiles/{profileId}', staffPath],
  ['jobs/{jobId}', 'jobs/revocation-own'],
  ['tasks/{taskId}', 'tasks/revocation-own'],
  ['submissions/{submissionId}', 'submissions/revocation-own'],
  ['files/{fileId}', 'submissions/revocation-own/files/example'],
  ['resubmissionRequests/{requestId}', 'resubmissionRequests/revocation-own'],
  ['announcementReceipts/{receiptId}', 'announcementReceipts/revocation-own'],
  ['deviceSessions/{sessionId}', 'deviceSessions/revocation-own'],
];

function executableRules(rules) {
  const helperNames = [
    'signedIn', 'role', 'companyId', 'staffId', 'sameCompany', 'isAdmin', 'isStaff',
    'identityAuthenticationCurrent', 'currentIdentity', 'requiresDeviceCredential', 'currentDeviceCredential', 'activeIdentity', 'activeStaff',
  ];
  const helpers = helperNames.map(name =>
    new RegExp('^    function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?^    \\}', 'm').exec(rules)?.[0]
  ).filter(Boolean).join('\n');
  // Translate only the Firestore-specific tokens used by these source helpers.
  const compiled = helpers
    .replace(/\/databases\/\$\(database\)\/documents\/(authIdentities|staffProfiles)\/\$\((request\.auth\.uid|staffId\(\))\)/g,
      (_path, collection, id) => `("${collection}/" + ${id})`)
    .replace('revokedAt is timestamp', 'isTimestamp(revokedAt)')
    .replace('authTime is int', 'isInt(authTime)')
    .replace(/([\w.]+)\.matches\('([^']*)'\)/g, (_m,value,pattern)=>'matches('+value+','+JSON.stringify(pattern)+')')
    .replace(/([\w.]+) is (string|map)/g, (_m,value,type)=>'types.'+type+'('+value+')');
  const grants = routes.map(([prefix, documentPath]) => {
    const start = rules.indexOf('match /' + prefix + ' {');
    assert.notEqual(start, -1, prefix);
    const grant = /allow read: if ([\s\S]*?);/.exec(rules.slice(start))?.[1];
    assert.ok(grant, prefix);
    return [documentPath, grant];
  });
  const source = compiled + '\n({' + grants.map(([name, grant]) => JSON.stringify(name) + ':()=>(' + grant + ')').join(',') + '})';
  return (documents, token, uid, documentPath) => {
    const wrap = value => ({ ...value, get: (key, fallback) => Object.hasOwn(value, key) ? value[key] : fallback });
    const sourceData = documents.get(documentPath);
    assert.ok(sourceData, documentPath);
    const check = runInNewContext(source, {
      request: { auth: { uid, token: wrap(token) } }, resource: { data: sourceData }, profileId: role.staffId,
      exists: ref => documents.has(ref),
      get: ref => ({ data: wrap(documents.get(ref)) }),
      isTimestamp: value => value instanceof Timestamp,
      isInt: Number.isSafeInteger,
      types:{string:value=>typeof value==='string',map:value=>value!==null&&typeof value==='object'&&!Array.isArray(value)},
      matches:(value,pattern)=>new RegExp('^(?:'+pattern+')$').test(value),
      timestamp: { value: ms => Timestamp.fromMillis(ms) },
    });
    return check[documentPath]();
  };
}

const previous = executableRules(readText(baselinePath));
const candidate = executableRules(readText('firestore.rules'));
const cases = staffRevocationCases((s, n) => new Timestamp(s, n));
const ownDocs = new Map(routes.map(([, docPath]) => [docPath, personal]));
ownDocs.set(staffPath, { companyId: role.companyId, active: true });
ownDocs.set('jobs/revocation-own', { companyId: role.companyId, assignedStaffId: role.staffId, status: 'assigned' });
const uid = 'synthetic-uid';

const staffCode = ts.transpileModule(readText('functions/src/staff-session.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const staffModule = { exports: {} };
runInNewContext(staffCode, {
  exports: staffModule.exports,
  require: specifier => ({
    './firebase': { db: { collection: name => ({ doc: id => name + '/' + id }) } },
    'firebase-admin/firestore': { Timestamp },
    'firebase-functions/v2/https': { HttpsError },
  })[specifier],
});
const serverGate = staffModule.exports.readActiveStaffProfile;

let matrixAssertions = 0;
for (const { identity, claims, allowed, name } of cases) {
  const docs = new Map(ownDocs);
  if (identity) docs.set('authIdentities/' + uid, identity);
  for (const [, docPath] of routes) {
    assert.equal(candidate(docs, { ...role, ...claims }, uid, docPath), allowed, name + ' ' + docPath);
    matrixAssertions++;
  }
  const tx = { get: async path => ({ exists: docs.has(path), data: () => docs.get(path) }) };
  const server = serverGate(tx, role.companyId, role.staffId, uid, claims.auth_time);
  if (allowed) assert.equal((await server).companyId, role.companyId, name);
  else await assert.rejects(server, error => error.code === 'permission-denied', name);
}
const old = cases.find(scenario => scenario.name === 'reactivated identity with refreshed old token');
const oldState = new Map(ownDocs).set('authIdentities/' + uid, old.identity);
assert.equal(previous(oldState, { ...role, ...old.claims }, uid, 'jobs/revocation-own'), true);
assert.equal(candidate(oldState, { ...role, ...old.claims }, uid, 'jobs/revocation-own'), false);


const sessionA='device_'+'a'.repeat(28),sessionB='device_'+'b'.repeat(28),generationA='a'.repeat(48),generationB='b'.repeat(48);
const grant=(session,generation)=>({crewDeviceSession:session,crewDeviceGeneration:generation});
const bindingScenarios=[
  ['legacy optional',false,{[sessionA]:generationA},{},true],
  ['opted-in legacy rejected',true,{[sessionA]:generationA},{},false],
  ['matching active device',true,{[sessionA]:generationA},grant(sessionA,generationA),true],
  ['stopped device',true,{[sessionA]:null,[sessionB]:generationB},grant(sessionA,generationA),false],
  ['other device remains active',true,{[sessionA]:null,[sessionB]:generationB},grant(sessionB,generationB),true],
  ['replacement generation does not reopen old token',true,{[sessionA]:generationB},grant(sessionA,generationA),false],
  ['paired claims required',true,{[sessionA]:generationA},{crewDeviceSession:sessionA},false],
  ['claim mixing is refused',true,{[sessionA]:generationA,[sessionB]:generationB},grant(sessionA,generationB),false],
  ['claim invalid on legacy profile is refused',false,{[sessionA]:generationA},grant(sessionA,generationB),false],
  ['path-like claim is refused',true,{[sessionA]:generationA},grant('device_../../bad',generationA),false],
  ['claimed null is refused',false,{[sessionA]:generationA},{crewDeviceSession:null},false],
];
let deviceBoundAssertions=0;
for(const [name,required,credentials,claims,allowed] of bindingScenarios){
 const docs=new Map(ownDocs);
 docs.set(staffPath,{...ownDocs.get(staffPath),deviceBoundAuthRequired:required});
 docs.set('authIdentities/'+uid,{...personal,active:true,deviceCredentials:credentials});
 for(const [,docPath]of routes){
  assert.equal(candidate(docs,{...role,...claims},uid,docPath),allowed,name+' '+docPath);
  deviceBoundAssertions++;
 }
 const tx={get:async path=>({exists:docs.has(path),data:()=>docs.get(path)})};
 const result=serverGate(tx,role.companyId,role.staffId,uid,AUTH_SECOND,{deviceClaims:claims});
 if(allowed)assert.equal((await result).companyId,role.companyId);
 else await assert.rejects(result,{code:'permission-denied'});
}
{
 const docs=new Map(ownDocs).set(staffPath,{...ownDocs.get(staffPath),deviceBoundAuthRequired:true});
 assert.equal(candidate(docs,{...role,...grant(sessionA,generationA)},uid,'jobs/revocation-own'),false);
}

const sdkDocs = new Map();
const projectId = 'demo-lkc-accept-revocation';
const seedDoc = id => ({
  id, async set(data) { sdkDocs.set(id, data); },
  async update(data) { sdkDocs.set(id, { ...sdkDocs.get(id), ...data }); },
});
const seed = {
  projectId, doc: seedDoc,
  batch() {
    const writes = [];
    return { set: (ref, data) => writes.push([ref, data]), commit: async () => {
      for (const [ref, data] of writes) await ref.set(data);
    } };
  },
};
const payload = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
const missingAuth = payload(staffEmulatorToken(projectId, uid, AUTH_SECOND, role));
assert.equal(Object.hasOwn(missingAuth, 'auth_time'), false);
const denyUnless = (token, docPath) => {
  if (!candidate(sdkDocs, token, token.sub, docPath)) throw Object.assign(new Error('local rules model deny'), { code: 'permission-denied' });
};
let preparedCasesChecked = 0;
await runStaffRevocationClientCases({
  seed, adminStore: { Timestamp },
  client: (_name, mockUserToken) => payload(mockUserToken),
  read: async (token, docPath) => { denyUnless(token, docPath); return { exists: () => sdkDocs.has(docPath) }; },
  list: async (token, collection, ...constraints) => {
    assert.equal(collection, 'jobs');
    assert.deepEqual(constraints, [['companyId', role.companyId], ['assignedStaffId', role.staffId], ['status', 'assigned']]);
    denyUnless(token, 'jobs/revocation-own');
    return { docs: [{ id: 'revocation-own' }] };
  },
  test: async (name, run) => { await run(); assert.ok(name); preparedCasesChecked++; },
});
assert.equal(preparedCasesChecked, cases.length * (routes.length + 1) + 1);
const report = {
  priorReactivatedTokenWasAllowedByModel: true,
  patchedReactivatedTokenDeniedByModel: true,
  ruleModelAssertions: matrixAssertions,
  deviceBoundAssertions,
  deviceBoundServerCases: bindingScenarios.length,
  actualServerHelperCases: cases.length,
  preparedClientScenariosCheckedAgainstModel: preparedCasesChecked,
  firestoreEmulatorStarted: false,
  liveClientSdkAssertions: 0,
  externalRequests: 0,
  scope: 'Local evaluation of the extracted Rules predicates with simulated request/document primitives. The Client SDK case module was dry-run with synthetic ports.',
};
if (process.env.LKC_RULES_MODEL_EVIDENCE) {
  const file = process.env.LKC_RULES_MODEL_EVIDENCE;
  assert.match(file, /^[a-z0-9-]+\.json$/);
  fs.writeFileSync(path.join('release-evidence', file), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify(report));
