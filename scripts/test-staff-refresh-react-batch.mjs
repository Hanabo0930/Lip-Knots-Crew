import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const require = createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT || process.cwd(), 'package.json'));
// These are local test renderers; no application, Firebase module or browser is loaded.
const priorNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = require('react'), {createRoot} = require('react-dom/client');
const {act} = React, ts = require('typescript');
const source = fs.readFileSync(process.env.LKC_TEST_STAFF_APP || 'apps/staff/src/App.tsx', 'utf8');
function section(a, b) {
  const start = source.indexOf(a), end = source.indexOf(b, start);
  assert.ok(start >= 0 && end > start, 'Production React boundary must exist');
  return source.slice(start, end);
}
const loader = section('  async function loadPrimaryBusinessData(', '  async function loadOpenJobs(');
const fileState = section('  const [files,', '  const [draftHydrating');
const jobsState = section('  const [myJobs,', '  const [selectedJob,');
const hydration = section('  useEffect(()=>{\n    setSubmissionConfirmed(false);', '  const draftSavePaused=');
const save = section('  useEffect(()=>{\n    if(!draftKey||draftHydrating', '  useEffect(()=>{ if(!pushEnabled)');
const deferred = () => {let resolve;const promise = new Promise(yes => {resolve = yes;});return {promise, resolve};};

async function scenario({name, restoredFiles, nextRows, expectedId, expectedCount, expectedLoads}) {
  const originals = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let root;
  try {
    const doc = {nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null};
    const win = {document: doc, HTMLIFrameElement: class {}, event: undefined};
    doc.defaultView = win;
    globalThis.window = win;globalThis.document = doc;globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.fetch = () => assert.fail('External network is forbidden');
    const host = {nodeType: 1, tagName: 'DIV', ownerDocument: doc,
      namespaceURI: 'http://www.w3.org/1999/xhtml', addEventListener() {}, removeEventListener() {}, textContent: ''};
    const draft = deferred(), rows = deferred(), disk = new Map([['owner:A', restoredFiles]]), loads = [], saves = [];
    let api, last;
    const ctx = {useState: React.useState, useRef: React.useRef, useEffect: React.useEffect, Promise, setTimeout, clearTimeout,
      staffId: 'staff', companyId: 'company', user: {uid: 'owner'}, initial: {id: 'A', applicationUnconfirmed: false}, rows,
      firebaseConfigured: false, demoJobs: [{id: 'A', applicationUnconfirmed: false}], demoTasks: [],
      nextShiftJob: values => values.find(value => value.applicationUnconfirmed !== true) ?? null,
      saveBusinessSnapshot() {}, isPending: () => false, getSubmittedDraftReceipt: () => null,
      setSubmissionConfirmed() {}, setDraftCleanup() {}, setMessage() {}, showSubmissionMessage() {},
      loadDraft: async key => {loads.push(key);return key === 'owner:A' ? draft.promise : disk.get(key) ?? [];},
      saveDraft: async (key, values) => {saves.push({key, count: values.length});disk.set(key, values);},
      expose: value => {api = value;last = {selectedJob: value.selectedJob?.id ?? null, files: value.files.length, key: value.draftKey};}};
    vm.createContext(ctx);
    const code = `globalThis.Probe=function Probe(){
      ${jobsState}
      const [selectedJob,setSelectedJob]=useState(initial);
      ${fileState}
      const [draftHydrating,setDraftHydrating]=useState(false);
      const authLoadVersionRef=useRef(1),tasksReadVersionRef=useRef(0),pastShiftVersionRef=useRef(0);
      const hydratedDraftKeyRef=useRef(''),draftHydratingRef=useRef(false),skipNextDraftSaveRef=useRef(false),previewContextRef=useRef('');
      const draftKey=selectedJob&&myJobs.some(job=>job.id===selectedJob.id)?'owner:'+selectedJob.id:'';
      previewContextRef.current=draftKey;
      const fetchTasks=async()=>[];const fetchMyJobs=()=>{pastShiftVersionRef.current++;return rows.promise;};
      ${loader}
      ${hydration}
      const draftSavePaused=false;
      ${save}
      expose({loadPrimaryBusinessData,setFiles,selectedJob,files,draftKey});return null;
    }`;
    vm.runInContext(ts.transpileModule(code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText, ctx);
    root = createRoot(host);
    await act(async () => {root.render(React.createElement(ctx.Probe));});
    assert.deepEqual(loads, ['owner:A']);
    const pending = api.loadPrimaryBusinessData();
    // A cache hydration and the live response settle within the same automatic batch.
    await act(async () => {draft.resolve(restoredFiles);rows.resolve(nextRows);await pending;});
    const observed = {selectedJob: last.selectedJob, files: last.files, key: last.key, loads: [...loads], saves: [...saves]};
    assert.equal(last.selectedJob, expectedId, JSON.stringify(observed));
    assert.equal(last.files, expectedCount, JSON.stringify(observed));
    assert.deepEqual(loads, expectedLoads);
    return {name, passed: true, observed};
  } finally {
    if (root) await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);else delete globalThis[key];
    }
  }
}

const file = {name: 'synthetic-restored-A.pdf', size: 321, type: 'application/pdf'};
const cases = [
  {name: 'cached draft A and live replacement B settle in one React batch', restoredFiles: [file],
    nextRows: [{id: 'B', applicationUnconfirmed: false}], expectedId: null, expectedCount: 1, expectedLoads: ['owner:A']},
  {name: 'same confirmed job keeps the restored draft in one React batch', restoredFiles: [file],
    nextRows: [{id: 'A', applicationUnconfirmed: false, storeName: 'Updated synthetic store'}], expectedId: 'A', expectedCount: 1, expectedLoads: ['owner:A']},
  {name: 'empty cached draft preserves normal live fallback in one React batch', restoredFiles: [],
    nextRows: [{id: 'B', applicationUnconfirmed: false}], expectedId: 'B', expectedCount: 0, expectedLoads: ['owner:A', 'owner:B']},
];
const results = [];
try {
  for (const data of cases) {
    try {results.push(await scenario(data));}
    catch (error) {results.push({name: data.name, passed: false, error: error.message});}
  }
} finally {
  if (priorNodeEnv === undefined) delete process.env.NODE_ENV;else process.env.NODE_ENV = priorNodeEnv;
}
console.log(JSON.stringify({passed: results.every(value => value.passed), count: results.length,
  scope: 'Actual React 19/ReactDOM hooks with production state/loader/effects; null render to in-memory host, no full App or browser', results}, null, 2));
process.exitCode = results.every(value => value.passed) ? 0 : 1;
