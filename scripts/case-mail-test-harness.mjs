import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const require = createRequire(import.meta.url), ts = require("typescript");
const { Timestamp } = require("firebase-admin/firestore");
const { HttpsError } = require("firebase-functions/v2/https");
const companyId = "synthetic-company";
const clone = value => value instanceof Timestamp ? value : Array.isArray(value) ? value.map(clone) :
  value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value;
const plain = value => JSON.parse(JSON.stringify(value));
function harness() {
  const records = new Map(), modules = new Map(); let serial = 0;
  const h = { records, commits: [], attempts: 0, beforeCommit: null, failCommit: false, loseResponse: false };
  const ref = (name, id = String(++serial).padStart(8, "0") + "synthetic") => ({
    id, path: name + "/" + id, get: async function () { return snap(this); }, set: async function(data, options) { apply([{ref:this,data,merge:options?.merge}]); },
  });
  const snap = ref => { const value = clone(records.get(ref.path)); return { ref, id: ref.id, exists: records.has(ref.path), data: () => clone(value) }; };
  function apply(writes) {
    const next = new Map(records);
    for (const write of writes) {
      const value = write.merge ? { ...next.get(write.ref.path) } : {};
      for (const [key, field] of Object.entries(write.data)) {
        assert.notEqual(field, undefined, "undefined write");
        if (field?.__delete) delete value[key];
        else if (field?.__increment) value[key] = (value[key] ?? 0) + field.__increment;
        else value[key] = clone(field);
      }
      next.set(write.ref.path, value);
    }
    records.clear(); for (const [key, value] of next) records.set(key, value);
    h.commits.push(writes);
  }
  const query = (name, filters = [], limit = Infinity, order = null, start = null) => ({
    doc: id => ref(name, id),
    add: async data => { const target = ref(name); apply([{ ref: target, data }]); return target; },
    where: (key, op, value) => query(name, [...filters, [key, op, value]], limit, order, start),
    limit: value => query(name, filters, value, order, start),
    orderBy: field => { assert.equal(field, "__name__"); return query(name, filters, limit, field, start); },
    startAfter: value => query(name, filters, limit, order, value),
    get: async function () { return this._read(); },
    _read: () => {
      const docs = [...records].filter(([key, data]) => key.startsWith(name + "/") && filters.every(([field, op, value]) =>
        op === "==" ? data[field] === value : data[field]?.toMillis?.() <= value?.toMillis?.()))
        .filter(([key]) => start === null || key.slice(name.length + 1) > start)
        .sort(([left], [right]) => order ? left < right ? -1 : left > right ? 1 : 0 : 0)
        .slice(0, limit).map(([key]) => snap(ref(name, key.slice(name.length + 1))));
      return { docs, empty: docs.length === 0 };
    },
  });
  const db = {
    collection: name => query(name),
    doc: full => { const split = full.lastIndexOf("/"); return ref(full.slice(0, split), full.slice(split + 1)); },
    getAll: async (...refs) => refs.map(snap),
    batch: () => { const writes = []; return { set: (ref, data, options) => writes.push({ ref, data: clone(data), merge: options?.merge }), commit: async () => apply(writes) }; },
    runTransaction: async callback => {
      for (let attempt = 0; attempt < 12; attempt++) {
        h.attempts++;
        const reads = new Map(), writes = [], queryReads = [];
        const tx = { get: async ref => {
          assert.equal(writes.length, 0, "transaction read after write");
          if (!ref.path) { const result = await ref.get(); queryReads.push({ query: ref, before: JSON.stringify(result.docs.map(doc => [doc.ref.path, doc.data()])) }); return result; }
          reads.set(ref.path, JSON.stringify(records.get(ref.path))); return snap(ref);
        }, set: (ref, data, options) => writes.push({ ref, data: clone(data), merge: options?.merge }) };
        tx.update = (ref, data) => writes.push({ref,data:clone(data),merge:true});
        tx.getAll = async (...refs) => Promise.all(refs.map(item => tx.get(item)));
        const result = await callback(tx); await h.beforeCommit?.({ attempt, reads, writes });
        let queryChanged = false;
        for (const item of queryReads) if (JSON.stringify(item.query._read().docs.map(doc => [doc.ref.path, doc.data()])) !== item.before) queryChanged = true;
        if (queryChanged || [...reads].some(([key, value]) => JSON.stringify(records.get(key)) !== value)) continue;
        if (h.failCommit) throw Error("synthetic failure before commit");
        apply(writes);
        if (h.loseResponse) { h.loseResponse = false; throw Error("synthetic lost response"); }
        return result;
      }
      throw Error("synthetic contention");
    },
  };
  const boundaries = {
    "./firebase": { db },
    "./system-safety": { assertProductionOperational: async company => assert.equal(company, companyId), getProductionOperationalState: async () => ({ operational: true }) },
    "firebase-functions/v2/https": { HttpsError, onCall: (...args) => args.at(-1) },
    "firebase-functions/v2/firestore": { onDocumentWritten: (...args) => args.at(-1) },
    googleapis: {google:{auth:{GoogleAuth:class{}},sheets:()=>{assert.ok(h.sheets,"Sheets boundary not configured");return h.sheets;}}},
    "./production-metrics": {incrementProductionMetrics:async()=>{}},
    "firebase-functions/v2/scheduler": { onSchedule: (...args) => args.at(-1) },
    "firebase-admin/firestore": { Timestamp, FieldPath: { documentId: () => "__name__" }, FieldValue: { delete: () => ({ __delete: true }), increment: n => ({ __increment: n }), serverTimestamp: () => Timestamp.now() } },
    "node:crypto": require("node:crypto"), zod: require("zod"),
  };
  function load(name) {
    if (Object.hasOwn(boundaries, name)) return boundaries[name];
    if (/^\.\.\/case-mail-runtime\/(preview|adapter|provider)\.cjs$/.test(name)) return require(fileURLToPath(new URL("../functions/" + name.slice(3), import.meta.url)));
    assert.match(name, /^\.\/[a-z0-9-]+$/, "external dependency refused");
    if (modules.has(name)) return modules.get(name);
    const source = fs.readFileSync(new URL("../functions/src/" + name.slice(2) + ".ts", import.meta.url), "utf8");
    const exports = {}; modules.set(name, exports);
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { exports, require: load, Date, console, process: { env: { LKC_SHEET_WRITE_MODE: "active" } } }, { timeout: 5000 });
    return exports;
  }
  const management = load("./job-management"), key = load("./case-mail-job-creation").caseMailRecordKey;
  const auth = { uid: "synthetic-admin", token: { role: "admin", companyId } };
  const input = { workDate: "2026-10-10", clientName: "合成取引先", storeName: "合成店舗", makerName: "合成メーカー",
    menuName: "試食", entryTime: "09:30", workTime: "10:00～18:00", slots: 1, basePay: null, publicationMode: "draft", publishAt: null };
  const command = { mailIntake: { receiptId: "receipt-1", candidateId: "candidate-1", expectedReceiptRevision: 1, expectedRevision: 1, operationId: "operation-1" } };
  const paths = { receipt: "caseMailIntakeReceipts/receipt-1", candidate: "caseMailIntakeCandidates/candidate-1",
    feature: "companyFeatureSettings/" + companyId, mapping: "companies/" + companyId + "/sheetMappings/shift",
    principal: "automationIngestPrincipals/" + key(companyId, "synthetic-ingester") };
  records.set(paths.receipt, { version: 1, companyId, messageId: "message-1", revision: 1, status: "ready",
    verification: "verified", structuralComplete: true, kind: "new", sourceFingerprint: "a".repeat(64),
    ingestedBy: "synthetic-ingester", producerId: "synthetic-producer", principalRevision: "principal-1",
    candidateIds: ["candidate-1"], parts: [{ partId: "body", sha256: "b".repeat(64) }] });
  records.set(paths.candidate, { version: 1, companyId, receiptId: "receipt-1", messageId: "message-1",
    revision: 1, status: "ready", sourceFingerprint: "a".repeat(64), importVersion: 1,
    source: { partId: "body", rowKey: "row-1", unitIndex: 0, sha256: "b".repeat(64) }, input });
  records.set(paths.principal, { companyId, uid: "synthetic-ingester", active: true, producerId: "synthetic-producer", revision: "principal-1" });
  records.set(paths.feature, { caseMailJobCreationEnabled: true, adminJobCreationSourceReady: true });
  records.set(paths.mapping, { enabled: true, rowCreation: { enabled: true }, spreadsheetId: "synthetic-sheet" });
  return Object.assign(h, { command, paths, key, input, auth, load,
    create: (data = command, user = auth) => management.createAdminJobGroup({ data, auth: user }),
    publish: (data, user = auth) => management.updateJobPublication({ data, auth: user }),
    schedule: () => management.publishScheduledJobs(),
    list: name => [...records].filter(([key]) => key.startsWith(name + "/")).map(([path, data]) => ({ path, ...data })),
  });
}

export { harness, clone, plain, companyId, Timestamp };
