import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { staffRevocationCases } from "./fixtures/staff-revocation-cases.mjs";

const baseline = process.argv[2];
const dependencyRoot = process.env.LKC_TEST_DEPENDENCY_ROOT;
assert.ok(baseline && dependencyRoot);
const require = createRequire(path.join(dependencyRoot, "package.json"));
const { Timestamp } = require("firebase-admin/firestore");
const candidate = fs.readFileSync("storage.rules", "utf8").replaceAll("\r\n", "\n");
const original = fs.readFileSync(baseline, "utf8").replaceAll("\r\n", "\n");
const role = { role: "staff", companyId: "company-a", staffId: "staff-revocation" };
const uid = "synthetic-uid";
const active = { companyId: role.companyId, staffId: role.staffId, active: true };
const maxBytes = 50 * 1024 * 1024;

function createModel(rules) {
  const helpers = [...rules.matchAll(/^    function [\w]+\([^)]*\) \{[\s\S]*?^    \}/gm)].map(match => match[0]).join("\n");
  const createGrant = /match \/staging\/\{companyId\}\/\{uid\}\/\{submissionId\}\/\{fileId\}\/\{fileName\} \{[\s\S]*?allow create: if ([\s\S]*?);/.exec(rules)?.[1];
  assert.ok(createGrant);
  assert.match(rules, /allow read, update, delete: if false;/);
  assert.match(rules, /match \/\{allPaths=\*\*\} \{\s*allow read, write: if false;/);
  const source = (helpers + "\n(" + createGrant + ")")
    .replace(/\/databases\/\(default\)\/documents\/(authIdentities|staffProfiles)\/\$\((uid|staffId)\)/g,
      (_match, collection, id) => '("' + collection + '/" + ' + id + ')')
    .replace(/([\w.]+)\.matches\('([^']*)'\)/g,
      (_match, value, pattern) => 'matches(' + value + ', ' + JSON.stringify(pattern) + ')')
    .replace(/fileName\.matches\(([\s\S]*?)\)/g, (_m, expression)=>'matches(fileName,'+expression+')')
     .replace(/([\w.]+) is (timestamp|int|string|map)/g, (_match, value, type) => 'types.' + type + '(' + value + ')');
  return (identity, claims, options = {}) => {
    const reads = [];
    const request = {
      auth: options.anonymous ? null : { uid: options.authUid ?? uid, token: { ...role, ...claims } },
      time: Timestamp.fromMillis(10_000),
      resource: { size: options.size ?? 100, contentType: options.contentType ?? "image/png", metadata: options.metadata ?? {} },
    };
    const companyId=options.pathCompany??role.companyId, submissionId=options.submissionId??"submission-demo";
    const fileId=options.fileId??"file-demo",fileName=options.fileName??"legacy.png";
    if(identity&&!options.fixedGrant)identity={
      ...identity,submissionUploadGrants:{[fileId]:{
        storagePath:["staging",companyId,uid,submissionId,fileId,fileName].join("/"),
        size:request.resource.size,contentType:request.resource.contentType,contentSha256:null,
        expiresAt:Timestamp.fromMillis(10_001),
      }},
    };
    const profile = options.profile === undefined ? active : options.profile;
    const documents = { ["authIdentities/" + uid]: identity, ["staffProfiles/" + role.staffId]: profile };
    let allowed;
    try {
      allowed = runInNewContext(source, {
        request, companyId, uid, fileName, submissionId, fileId,
        firestore: { get(documentPath) { reads.push(documentPath); return { data: documents[documentPath] }; } },
        timestamp: { value: Timestamp.fromMillis },
        types: { timestamp: value => value instanceof Timestamp, int: Number.isSafeInteger, string: value => typeof value === "string", map: value => value !== null && typeof value === "object" && !Array.isArray(value) },
        matches: (value, pattern) => new RegExp("^(?:" + pattern + ")$").test(value),
      }, { timeout: 500 });
    } catch (error) {
      if (error.name !== "TypeError") throw error;
      allowed = false;
    }
    assert.ok(reads.length <= 2, "at most two Firestore document accesses per evaluation");
    return { allowed: allowed === true, reads };
  };
}

const previous = createModel(original);
const proposed = createModel(candidate);
const cases = staffRevocationCases((seconds, nanos) => new Timestamp(seconds, nanos)).map(item => ({
  ...item, allowed: item.identity !== null && item.allowed,
}));
for (const [name, options, claims = {}] of [
  ["signed-out request", { anonymous: true }],
  ["different Firebase uid", { authUid: "other-uid" }],
  ["different company path", { pathCompany: "company-b" }],
  ["missing staff profile", { profile: null }],
  ["inactive staff profile", { profile: { ...active, active: false } }],
  ["profile from another company", { profile: { ...active, companyId: "company-b" } }],
  ["admin role", {}, { role: "admin" }],
  ["staffId is a path", {}, { staffId: "staff/path" }],
  ["zero bytes", { size: 0 }],
  ["file too large", { size: maxBytes + 1 }],
  ["invalid type", { contentType: "text/plain" }],
]) cases.push({ name, identity: active, claims, allowed: false, options });
cases.push({ name: "PDF at size limit", identity: active, claims: {}, allowed: true,
  options: { size: maxBytes, contentType: "application/pdf" } });

const session='device_'+'a'.repeat(28),other='device_'+'b'.repeat(28);
const a='a'.repeat(48),b='b'.repeat(48);
const current={...active,deviceBoundAuthRequired:true};
for(const [name,credentials,claims,allowed,profile=current] of [
  ['bound device can upload',[a,b],{crewDeviceSession:session,crewDeviceGeneration:a},true],
  ['same UID other device is unaffected',[null,b],{crewDeviceSession:other,crewDeviceGeneration:b},true],
  ['stopped device storage create is denied',[null,b],{crewDeviceSession:session,crewDeviceGeneration:a},false],
  ['old generation fails on same device',[b,b],{crewDeviceSession:session,crewDeviceGeneration:a},false],
  ['missing bound claim',[a,b],{},false],
  ['one bound claim on legacy profile',[a,b],{crewDeviceSession:session},false,active],
  ['map missing',[undefined,undefined],{crewDeviceSession:session,crewDeviceGeneration:a},false],
  ['mixed device/generation',[a,b],{crewDeviceSession:other,crewDeviceGeneration:a},false],
  ['untrusted path claim',[a,b],{crewDeviceSession:'../path',crewDeviceGeneration:a},false],
]) cases.push({name,identity:{...active,deviceCredentials:{[session]:credentials[0],[other]:credentials[1]}},claims,allowed,options:{profile,fileName:claims.crewDeviceSession&&claims.crewDeviceGeneration
    ?claims.crewDeviceSession+'-'+claims.crewDeviceGeneration+'-'+'c'.repeat(32)+'-synthetic.png':undefined}});
cases.push({name:'right credential cannot create the other device path',identity:{...active,deviceCredentials:{[session]:a,[other]:b}},
 claims:{crewDeviceSession:other,crewDeviceGeneration:b},allowed:false,options:{profile:current,fileName:session+'-'+a+'-'+'c'.repeat(32)+'-synthetic.png'}});
cases.push({name:'unbound credential cannot create a bound path',identity:{...active},claims:{},allowed:false,
 options:{fileName:session+'-'+a+'-'+'c'.repeat(32)+'-synthetic.png'}});
const uploadName='genuine-file.png', pathBase='staging/'+role.companyId+'/'+uid+'/submission-demo/file-demo/';
const validGrant={storagePath:pathBase+uploadName, size:100, contentType:'image/png', contentSha256:'a'.repeat(64), expiresAt:Timestamp.fromMillis(10_001)};
for(const [name,override,options,allowed] of [
 ['issued exact file',{}, {}, true],
 ['no recorded grant',null,{},false],
 ['different file id',{}, {fileId:'different'},false],
 ['different submission',{}, {submissionId:'another'},false],
 ['unregistered name',{}, {fileName:'not-issued.png'},false],
 ['other declared size',{}, {size:99},false],
 ['other declared type',{}, {contentType:'image/jpeg'},false],
 ['digest missing',{}, {metadata:{}},false],
 ['digest changed',{}, {metadata:{lkcContentSha256:'b'.repeat(64)}},false],
 ['expired at boundary',{expiresAt:Timestamp.fromMillis(10_000)}, {}, false],
 ['malformed expiry',{expiresAt:10001},{},false],
 ['legacy issued without digest',{contentSha256:null},{metadata:{}},true],
]){
 const stored=override===null?active:{...active,submissionUploadGrants:{'file-demo':{...validGrant,...override}}};
 cases.push({name,identity:stored,claims:{},allowed,
  options:{fixedGrant:true,fileName:uploadName,metadata:{lkcContentSha256:'a'.repeat(64)},...options}});
}

const results = cases.map(item => {
  const now = proposed(item.identity, item.claims, item.options);
  assert.equal(now.allowed, item.allowed, item.name);
  if (item.allowed) assert.deepEqual(now.reads, ["authIdentities/" + uid, "staffProfiles/" + role.staffId]);
  const before = previous(item.identity, item.claims, item.options);
  return { name: item.name, expectedAllowed: item.allowed, candidateAllowed: now.allowed, previousAllowed: before.allowed, firestoreDocumentReads: now.reads.length };
});
const report = {
  passed: results.length, results, scope: "Storage rules predicate model derived from the rules source; no Firebase Rules parser, emulator, IAM change or network request.",
  requiredFirestoreDocuments: ["authIdentities", "staffProfiles"],
};
fs.writeFileSync("release-evidence/storage-session-model.json", JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ passed: report.passed, previousAllowedSelectedNegative: results.filter(x => !x.expectedAllowed && x.previousAllowed).length }));
