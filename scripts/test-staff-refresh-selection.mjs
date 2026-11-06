import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const require = createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT || process.cwd(), 'package.json'));
const ts = require('typescript');
const source = fs.readFileSync(process.env.LKC_TEST_STAFF_APP || 'apps/staff/src/App.tsx', 'utf8');
const compile = value => ts.transpileModule(value, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'Production boundary must exist');
  return source.slice(first, last);
}
const loader = section('  async function loadPrimaryBusinessData(', '  async function loadOpenJobs(');
const jobsState = section('  const [myJobs,', '  const [selectedJob,');
const refresh = section('  async function refreshBusinessData(', '  async function refreshPushStatus(');
const hydration = section('  useEffect(()=>{\n    setSubmissionConfirmed(false);', '  const draftSavePaused=');
const saveEffect = section('  useEffect(()=>{\n    if(!draftKey||draftHydrating', '  useEffect(()=>{ if(!pushEnabled)');
const actionGuard = section('  function isSubmissionActionPending()', '  useEffect(()=>{\n    const scope=');
const change = section('  async function discardFilesBeforeContextChange(', '  async function changeSubmissionJob(');
const openShift = section('  function openShiftJob(', '  const [hasMoreUpcomingShifts');
const mailShift = section('  function viewMailApplicationShift(', '  async function apply(');
const openTask = section('  async function openTask(', '  async function pollSubmissionProcessing(');
const actionSource = fs.readFileSync('apps/staff/src/useAsyncAction.ts', 'utf8');
const job = (id, patch = {}) => ({id, status: 'assigned', companyId: 'company', assignedStaffId: 'staff',
  dateKey: '2099-11-10', applicationUnconfirmed: false, ...patch});
const file = {name: 'synthetic-unsent.pdf', size: 321, type: 'application/pdf'};
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({selected = job('A'), files = [file], saveFails = false, clearFails = false, clearWait = null} = {}) {
  const state = {selected, files, rows: selected ? [selected] : [], messages: [], reads: [], saves: [],
    draftLoads: [], snapshotWrites: [], calls: [], confirms: [], opened: [], clearCalls: [], navigations: [], showPast: false, focus: 0, busy: false};
  const disk = new Map();
  let effectCleanup;
  const key = value => value ? 'company:owner:' + value.id + ':report' : '';
  const ctx = {console, Promise, Map, Set, Error, Date, performance, staffId: 'staff', companyId: 'company', user: {uid: 'owner'},
    authLoadVersionRef: {current: 1}, tasksReadVersionRef: {current: 0}, pastShiftVersionRef: {current: 0},
    submissionFilesRef: {current: files}, myJobsRef: {current: state.rows}, draftHydratingRef: {current: false}, processingSubmission: false,
    businessRefreshInFlightRef: {current: false}, lastBusinessDataRefreshAt: 0, BUSINESS_DATA_REFRESH_INTERVAL_MS: 60000,
    firebaseConfigured: true, businessDataStatus: 'ready', openJobsStatus: 'idle',
    isPending: () => false, isShiftAccessDenied: () => false,
    forgetInaccessibleShifts: () => assert.fail('No access-denied scenario in this fixture'),
    refreshOpenJobs: () => assert.fail('Closed recruitment view must not fetch'),
    fetchTasks: async () => [],
    fetchMyJobs: () => {
      ctx.pastShiftVersionRef.current++;
      return new Promise((resolve, reject) => state.reads.push({resolve, reject}));
    },
    nextShiftJob: rows => rows.find(row => row.applicationUnconfirmed !== true) ?? null,
    setMyJobs: rows => {state.rows = typeof rows === 'function' ? rows(state.rows) : rows;ctx.myJobs = state.rows;ctx.myJobsRef.current = state.rows;}, setTasks: () => {},
    setSelectedJob: update => {state.selected = typeof update === 'function' ? update(state.selected) : update;ctx.selectedJob = state.selected;},
    saveBusinessSnapshot: (...args) => state.snapshotWrites.push(args),
    setBusinessDataStatus: value => {ctx.businessDataStatus = value;}, setBusinessDataSource: () => {},
    setBusinessRefreshMs: () => {}, setBusinessRefreshing: value => {state.busy = value;},
    setHomeLoadedFromCache: () => {}, setMessage: value => {if(typeof value === 'string')state.messages.push(value);},
    hydratedDraftKeyRef: {current: key(selected)}, skipNextDraftSaveRef: {current: false},
    previewContextRef: {current: key(selected)}, navigationVersionRef: {current: 0}, submissionContextVersionRef: {current: 0},
    files, draftKey: key(selected), draftHydrating: false, draftSavePaused: false, selectedJob: selected,
    getSubmittedDraftReceipt: () => null, setDraftCleanup: () => assert.fail('No submitted marker exists'),
    setDraftHydrating: () => {}, setSubmissionConfirmed: () => {},
    setFiles: value => {state.files = typeof value === 'function' ? value(state.files) : value;ctx.files = state.files;ctx.submissionFilesRef.current = state.files;},
    loadDraft: async target => {state.draftLoads.push(target);return disk.get(target) ?? [];},
    saveDraft: async (target, values) => {state.saves.push({target, values});if(saveFails)throw Error('Synthetic quota failure');disk.set(target, values);},
    clearDraft: async target => {state.clearCalls.push(target);if(clearWait)await clearWait;if(clearFails)throw Error('Synthetic draft delete failure');disk.delete(target);},
    setTimeout: () => 1, clearTimeout: () => {},
    showSubmissionMessage: value => {if(value)state.messages.push(value);},
    setUploadState: () => {}, setSubmissionMessage: () => {}, submissionMessage: '',
    useEffect: callback => {effectCleanup = callback();},
    run: async (_name, callback) => callback(),
    confirm: prompt => {state.confirms.push(prompt);return state.confirmed ?? false;},
    requestId: '', submissionType: 'report',
    prepareSubmission: async (type, target) => {state.opened.push({type, target, files: state.files});},
    navigate: next => {state.navigations.push(next);ctx.navigationVersionRef.current++;},
    selectedAssignedJob: selected, myJobs: state.rows, orderAssignedJobs: rows => rows,
    splitAssignedJobs: rows => ({past: rows.filter(row => row.isPast), upcoming: rows.filter(row => !row.isPast)}),
    setShowPastShifts: value => {state.showPast = value;ctx.showPastShifts = value;},
    setShiftFocusRequest: update => {state.focus = typeof update === 'function' ? update(state.focus) : update;},
    showPastShifts: false, upcomingShifts: [], pastShifts: [],
    // Any accidental cloud submission is an immediate test failure.
    httpsCallable: () => assert.fail('External APIs are forbidden'),
  };
  let jobStateCalls = 0;
  const jobStateScope = {firebaseConfigured: false, demoJobs: state.rows, demoTasks: [], useRef: value => ({current: value}),
    useState: initial => [initial, jobStateCalls++ === 0 ? value => {state.rows = value;ctx.myJobs = value;} : () => {}]};
  vm.runInNewContext(compile('globalThis.controls=(()=>{' + jobsState + ';return {setMyJobs,myJobsRef};})();'), jobStateScope);
  Object.assign(ctx, jobStateScope.controls);
  const hook = {exports: {}, require: () => ({useCallback: callback => callback,
    useRef: value => ({current: value}), useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}]})};
  vm.runInNewContext(ts.transpileModule(actionSource, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText, hook);
  Object.assign(ctx, hook.exports.useAsyncAction());
  vm.createContext(ctx);
  vm.runInContext(compile(actionGuard), ctx);
  ctx.submissionEditPending = ctx.isSubmissionActionPending();
  // Freeze the render's files value to reproduce file selection while this read is in flight.
  vm.runInContext(compile('((files)=>{' + loader + refresh + ';globalThis.refreshBusinessData=refreshBusinessData;})(globalThis.files);'), ctx);
  vm.runInContext(compile(saveEffect), ctx);
  const oldSaveCleanup = effectCleanup;
  vm.runInContext(compile(change), ctx);
  vm.runInContext(compile(openShift + mailShift + openTask), ctx);
  async function commit() {
    const assigned = state.rows.find(row => row.id === state.selected?.id) ?? null;
    ctx.selectedAssignedJob = assigned;
    const nextKey = key(assigned);
    ctx.submissionFilesRef.current = state.files;
    if (nextKey !== ctx.draftKey) {
      ctx.previewContextRef.current = nextKey;
      oldSaveCleanup?.();
      ctx.draftKey = nextKey;
      vm.runInContext(compile(hydration), ctx);
      await tick();
    }
  }
  async function refreshRows(rows) {
    const pending = ctx.refreshBusinessData(true);
    assert.ok(state.reads.length > 0, 'Refresh entry point must run');
    state.reads.at(-1).resolve(rows);
    await pending; await commit();
  }
  return {state, ctx, disk, commit, refreshRows};
}

const observations = [], cases = [];
const test = (name, action) => cases.push({name, action});
test('the production files setter mirrors array and functional updates before a React commit', async () => {
  const fragment = section('  const [files,', '  const [draftHydrating');
  const ctx = {useState: initial => [initial, () => {}], useRef: initial => ({current: initial})};
  vm.runInNewContext(compile('globalThis.controls=(()=>{' + fragment + ';return {setFiles,submissionFilesRef};})();'), ctx);
  const selected = [file];ctx.controls.setFiles(selected);
  assert.equal(ctx.controls.submissionFilesRef.current, selected);
  let previous;ctx.controls.setFiles(current => {previous = current;return [];});
  assert.equal(previous, selected);assert.equal(ctx.controls.submissionFilesRef.current.length, 0);
});
test('the production jobs setter mirrors sequential array and functional updates before a React commit', async () => {
  const h = setup();h.ctx.setMyJobs([job('A'), job('B')]);
  h.ctx.setMyJobs(current => current.filter(row => row.id !== 'B'));
  assert.deepEqual(Array.from(h.ctx.myJobsRef.current, row => row.id), ['A']);
  assert.equal(h.ctx.myJobsRef.current, h.state.rows);
});
test('removed selected job does not switch unsent files to another job', async () => {
  const h = setup(), original = h.state.files;
  await h.refreshRows([job('B')]);
  observations.push({scenario: 'selected A removed with unsent file and B available', selectedJob: h.state.selected?.id ?? null,
    retainedFileCount: h.state.files.length, oldDraftSaved: h.disk.has('company:owner:A:report'), draftLoads: h.state.draftLoads});
  assert.equal(h.state.selected, null);assert.equal(h.ctx.draftKey, '');
  assert.equal(h.state.files, original);assert.equal(h.state.draftLoads.length, 0);
  assert.equal(h.state.saves.length, 1);assert.equal(h.state.saves[0].target, 'company:owner:A:report');
  assert.equal(h.disk.get('company:owner:A:report'), original);
});
test('repeated refresh keeps unassigned files until an explicit choice', async () => {
  const h = setup(), original = h.state.files;
  await h.refreshRows([job('B')]);await h.refreshRows([job('C')]);
  assert.equal(h.state.selected, null);assert.equal(h.state.files, original);
  assert.equal(h.state.draftLoads.length, 0);
});
test('draft save failure preserves the on-screen selection and reports the existing recovery guidance', async () => {
  const h = setup({saveFails: true}), original = h.state.files;
  await h.refreshRows([job('B')]);
  assert.equal(h.state.selected, null);assert.equal(h.state.files, original);
  assert.equal(h.state.draftLoads.length, 0);assert.equal(h.disk.has('company:owner:A:report'), false);
  assert.ok(h.state.messages.some(message => /下書きも保存できません/.test(message) && /画面を閉じず/.test(message)));
});
test('selection made after refresh starts is protected by the current files ref', async () => {
  const h = setup({files: []});
  const pending = h.ctx.refreshBusinessData(true);
  h.state.files = [file];h.ctx.files = h.state.files;h.ctx.submissionFilesRef.current = h.state.files;
  h.state.reads[0].resolve([job('B')]);await pending;
  assert.equal(h.state.selected, null);assert.equal(h.state.files[0], file);
});
test('unconfirmed current assignment cannot become the submission target', async () => {
  const h = setup(), original = h.state.files;
  await h.refreshRows([job('A', {applicationUnconfirmed: true}), job('B')]);
  assert.equal(h.state.selected, null);assert.equal(h.ctx.selectedAssignedJob, null);
  assert.equal(h.state.files, original);assert.equal(h.state.draftLoads.length, 0);
});
test('same confirmed job updates metadata without rehydrating or clearing files', async () => {
  const h = setup(), original = h.state.files;
  await h.refreshRows([job('A', {storeName: 'Updated synthetic store'}), job('B')]);
  assert.equal(h.state.selected.id, 'A');assert.equal(h.state.selected.storeName, 'Updated synthetic store');
  assert.equal(h.state.files, original);assert.equal(h.state.draftLoads.length, 0);
});
test('no selected files preserves the existing next-shift selection', async () => {
  const h = setup({files: []});await h.refreshRows([job('B')]);
  assert.equal(h.state.selected.id, 'B');assert.equal(h.state.files.length, 0);
  assert.equal(h.state.draftLoads[0], 'company:owner:B:report');
});
test('initial empty selection still opens the next confirmed shift', async () => {
  const h = setup({selected: null, files: []});await h.refreshRows([job('P', {applicationUnconfirmed: true}), job('B')]);
  assert.equal(h.state.selected.id, 'B');assert.equal(h.state.draftLoads[0], 'company:owner:B:report');
});
test('read failure preserves files and permits a later safe refresh', async () => {
  const h = setup(), original = h.state.files;
  const pending = h.ctx.refreshBusinessData(true);h.state.reads[0].reject(Error('Synthetic offline'));await pending;
  assert.equal(h.state.selected.id, 'A');assert.equal(h.state.files, original);assert.equal(h.state.busy, false);
  await h.refreshRows([job('B')]);assert.equal(h.state.selected, null);assert.equal(h.state.files, original);
});
test('late response from the previous account cannot select a job or touch new-owner files', async () => {
  const h = setup(), otherFiles = [{name: 'other-owner.pdf'}];
  const pending = h.ctx.refreshBusinessData(true);h.ctx.authLoadVersionRef.current++;
  h.state.selected = job('OTHER');h.state.files = otherFiles;h.ctx.submissionFilesRef.current = otherFiles;
  h.state.reads[0].resolve([job('B')]);await pending;
  assert.equal(h.state.selected.id, 'OTHER');assert.equal(h.state.files, otherFiles);
  assert.equal(h.state.snapshotWrites.length, 0);assert.equal(h.state.saves.length, 0);
});
test('choosing another target preserves files on decline and clears only after existing confirmation', async () => {
  const h = setup(), original = h.state.files;await h.refreshRows([job('B')]);
  assert.equal(await h.ctx.startSubmission('report', job('B')), false);
  assert.equal(h.state.files, original);assert.equal(h.state.opened.length, 0);
  h.state.confirmed = true;
  assert.equal(await h.ctx.startSubmission('report', job('B')), true);
  assert.equal(h.state.files.length, 0);assert.equal(h.state.opened[0].target.id, 'B');
  assert.equal(h.state.opened[0].files.length, 0);assert.equal(h.state.confirms.length, 2);
});

for (const saveFails of [false, true]) test('ordinary card/calendar selection cannot discard held files on decline; save failure=' + saveFails, async () => {
  const h = setup({saveFails}), original = h.state.files;await h.refreshRows([job('B')]);
  assert.equal(await h.ctx.openShiftJob(job('B')), false);await h.commit();
  assert.equal(h.state.selected, null);assert.equal(h.state.files, original);
  assert.equal(h.state.confirms.length, 1);assert.equal(h.state.draftLoads.length, 0);
});
test('ordinary selection opens a new draft only after the existing removal confirmation', async () => {
  const h = setup({saveFails: true});await h.refreshRows([job('B')]);h.state.confirmed = true;
  assert.equal(await h.ctx.openShiftJob(job('B'), () => h.ctx.navigate('shifts')), true);await h.commit();
  assert.equal(h.state.confirms.length, 1);assert.equal(h.state.selected.id, 'B');assert.equal(h.state.files.length, 0);
  assert.deepEqual(h.state.draftLoads, ['company:owner:B:report']);assert.deepEqual(h.state.navigations, ['shifts']);
});
test('same-job selection retains files without asking to remove them', async () => {
  const h = setup(), original = h.state.files;
  assert.equal(await h.ctx.openShiftJob(job('A')), true);await h.commit();
  assert.equal(h.state.files, original);assert.equal(h.state.confirms.length, 0);assert.equal(h.state.draftLoads.length, 0);
});
test('failed draft deletion prevents ordinary selection and keeps files', async () => {
  const h = setup({clearFails: true}), original = h.state.files;h.state.confirmed = true;
  assert.equal(await h.ctx.openShiftJob(job('B')), false);await h.commit();
  assert.equal(h.state.selected.id, 'A');assert.equal(h.state.files, original);
  assert.equal(h.state.clearCalls.length, 1);assert.ok(h.state.messages.some(value => /解除できません/.test(value)));
});
for (const [name, patch] of [
  ['removed', null], ['unconfirmed', {applicationUnconfirmed: true}],
  ['another staff member', {assignedStaffId: 'other-staff'}], ['another company', {companyId: 'other-company'}],
  ['cancelled', {cancelled: true}], ['no longer assigned', {status: 'open'}],
]) test('pending selection cannot reopen a target that becomes ' + name + ' during draft deletion', async () => {
  let release;const gate = new Promise(resolve => {release = resolve;});
  const h = setup({clearWait: gate}), original = h.state.files;
  h.ctx.setMyJobs([job('A'), job('B')]);h.state.confirmed = true;
  // Start the refresh first: comparing only its start version cannot detect its later commit.
  const read = h.ctx.refreshBusinessData(true);
  const opening = h.ctx.openShiftJob(job('B'), () => h.ctx.navigate('shifts'));
  h.state.reads.at(-1).resolve([job('A'), ...(patch ? [job('B', patch)] : []), job('C')]);
  await read;await h.commit();release();
  assert.equal(await opening, false);await h.commit();
  assert.equal(h.state.selected.id, 'A');assert.equal(h.state.files, original);
  assert.equal(h.state.navigations.length, 0);assert.equal(h.state.draftLoads.length, 0);
});
test('pending selection uses the current confirmed target metadata after an in-flight refresh', async () => {
  let release;const gate = new Promise(resolve => {release = resolve;});
  const h = setup({clearWait: gate});h.ctx.setMyJobs([job('A'), job('B')]);h.state.confirmed = true;
  const read = h.ctx.refreshBusinessData(true), opening = h.ctx.openShiftJob(job('B'));
  h.state.reads.at(-1).resolve([job('A'), job('B', {storeName: 'Current synthetic B'})]);
  await read;await h.commit();release();assert.equal(await opening, true);await h.commit();
  assert.equal(h.state.selected.storeName, 'Current synthetic B');assert.equal(h.state.files.length, 0);
});
for (const stale of ['auth', 'context', 'navigation']) test('pending ordinary selection rejects stale ' + stale + ' and duplicate clicks', async () => {
  let release;const gate = new Promise(resolve => {release = resolve;});
  const h = setup({clearWait: gate}), original = h.state.files;h.state.confirmed = true;
  h.ctx.setMyJobs([job('A'), job('B'), job('C')]);
  const pending = h.ctx.openShiftJob(job('B'));
  assert.equal(await h.ctx.openShiftJob(job('C')), false);
  h.ctx[stale === 'auth' ? 'authLoadVersionRef' : stale === 'context' ? 'submissionContextVersionRef' : 'navigationVersionRef'].current++;
  release();assert.equal(await pending, false);
  assert.equal(h.state.selected.id, 'A');assert.equal(h.state.files, original);assert.equal(h.state.confirms.length, 1);
});
test('hiding a selected past shift uses the same confirmation before choosing an upcoming shift', async () => {
  const a = job('A', {isPast: true}), h = setup({selected: a}), original = h.state.files;
  h.ctx.setMyJobs([a, job('B')]);
  h.ctx.showPastShifts = true;h.state.showPast = true;h.ctx.pastShifts = [a];h.ctx.upcomingShifts = [job('B')];
  h.ctx.togglePastShifts();await tick();await h.commit();
  assert.equal(h.state.selected.id, 'A');assert.equal(h.state.files, original);assert.equal(h.state.showPast, true);
  h.state.confirmed = true;h.ctx.togglePastShifts();await tick();await h.commit();
  assert.equal(h.state.selected.id, 'B');assert.equal(h.state.files.length, 0);assert.equal(h.state.showPast, false);
});
test('mail application shift navigation waits for accepted selection', async () => {
  const h = setup(), original = h.state.files;await h.refreshRows([job('B')]);
  h.ctx.viewMailApplicationShift('B');await tick();
  assert.equal(h.state.files, original);assert.equal(h.state.navigations.length, 0);
  h.state.confirmed = true;h.ctx.viewMailApplicationShift('B');await tick();await h.commit();
  assert.equal(h.state.selected.id, 'B');assert.deepEqual(h.state.navigations, ['shifts']);
});
for (const kind of ['precontact', 'netprint']) test('task shortcut ' + kind + ' navigates only after accepted selection', async () => {
  const h = setup(), original = h.state.files;await h.refreshRows([job('B')]);
  await h.ctx.openTask({jobId: 'B', kind});assert.equal(h.state.files, original);assert.equal(h.state.navigations.length, 0);
  h.state.confirmed = true;await h.ctx.openTask({jobId: 'B', kind});await h.commit();
  assert.equal(h.state.selected.id, 'B');assert.deepEqual(h.state.navigations, ['shifts']);
});
test('shift notification consumes its route only after selection is accepted', async () => {
  const h = setup(), original = h.state.files;await h.refreshRows([job('B')]);
  const start = source.indexOf('  const shiftNotification=');
  const line = source.slice(start, source.indexOf('  });', start)).split('\n').find(value => value.trim().startsWith('onOpen:'));
  assert.ok(line);const expression = line.trim().slice('onOpen:'.length).replace(/,$/, '');
  vm.runInContext(compile('globalThis.onNotification=' + expression + ';'), h.ctx);
  let consumed = 0;
  assert.equal(await h.ctx.onNotification(job('B'), () => {consumed++;}), false);
  assert.equal(consumed, 0);assert.equal(h.state.files, original);assert.equal(h.state.navigations.length, 0);
  h.state.confirmed = true;assert.equal(await h.ctx.onNotification(job('B'), () => {consumed++;}), true);
  assert.equal(consumed, 1);assert.deepEqual(h.state.navigations, ['shifts']);
});

function buttonClick({label, ref}) {
  const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches = [];
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'button') {
      const attrs = node.openingElement.attributes.properties;
      const reference = attrs.find(value => ts.isJsxAttribute(value) && value.name.getText(tree) === 'ref');
      const text = node.children.filter(ts.isJsxText).map(value => value.text.trim()).join('');
      if ((label && text === label) || (ref && reference?.initializer?.expression?.getText(tree) === ref)) {
        const click = attrs.find(value => ts.isJsxAttribute(value) && value.name.getText(tree) === 'onClick');
        assert.ok(click?.initializer?.expression);matches.push(click.initializer.expression.getText(tree));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);assert.equal(matches.length, 1);return matches[0];
}
for (const [name, descriptor] of [['home', {label: 'シフトを開く'}], ['application result', {ref: 'applicationResultButtonRef'}]])
  test('actual ' + name + ' button callback navigates only after accepted file removal', async () => {
    const h = setup(), original = h.state.files;await h.refreshRows([job('B')]);
    h.ctx.nextShift = job('B');h.ctx.acceptedApplicationJob = job('B');
    vm.runInContext(compile('globalThis.buttonClick=' + buttonClick(descriptor) + ';'), h.ctx);
    h.ctx.buttonClick();await tick();await h.commit();
    assert.equal(h.state.files, original);assert.equal(h.state.navigations.length, 0);
    h.state.confirmed = true;h.ctx.buttonClick();await tick();await h.commit();
    assert.equal(h.state.selected.id, 'B');assert.equal(h.state.files.length, 0);
    assert.deepEqual(h.state.navigations, ['shifts']);assert.equal(h.state.confirms.length, 2);
  });

const results = [];
for (const {name, action} of cases) {
  try {await action();results.push({name, passed: true});}
  catch (error) {results.push({name, passed: false, error: error.message});}
}
console.log(JSON.stringify({passed: results.every(row => row.passed), count: results.length, observations, results}, null, 2));
process.exitCode = results.every(row => row.passed) ? 0 : 1;
