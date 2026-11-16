import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const dependency = createRequire(process.env.LKC_TEST_DEPENDENCY_ROOT
  ? join(process.env.LKC_TEST_DEPENDENCY_ROOT, "package.json") : import.meta.url);
const ts = dependency("typescript"), React = dependency("react");
const { renderToStaticMarkup } = dependency("react-dom/server");
const modules = new Map();
const testDb = {};
let firebaseWatch;
const windowEvents = new EventTarget(), documentEvents = new EventTarget();
const navigatorState = { onLine: true };
documentEvents.visibilityState = "visible";
function load(name) {
  if (name === "./firebase") return { db: testDb };
  if (name === "firebase/firestore") return {
    doc: (db, collection, id) => ({ db, collection, id }),
    onSnapshot: (...args) => firebaseWatch(...args),
  };
  if (!name.startsWith("./")) return dependency(name);
  if (modules.has(name)) return modules.get(name);
  assert.match(name, /^\.\/(ShiftRoutePanel|job-list)$/u);
  const file = new URL("../apps/staff/src/" + name.slice(2) + (name === "./ShiftRoutePanel" ? ".tsx" : ".ts"), import.meta.url);
  const source = readFileSync(file, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports = {};
  modules.set(name, exports);
  runInNewContext(compiled, { exports, require: load, URLSearchParams, window: windowEvents, document: documentEvents, navigator: navigatorState }, { timeout: 5000 });
  return exports;
}
const { observeShiftRoute, ShiftRouteDetails, watchShiftRoute, browserShiftRouteConnectivity } = load("./ShiftRoutePanel");
const scope = { jobId: "route-one", companyId: "synthetic-a", staffId: "synthetic-staff-a" };
const job = { id: scope.jobId, companyId: scope.companyId, assignedStaffId: scope.staffId, status: "assigned",
  storeName: "合成 & 店 #1", storeAddress: "架空県テスト市1丁目2-3　合成ビル", storeNearestStation: "架空テスト駅" };

function fixture({ online = true, start = scope } = {}) {
  let listener, stopListening = 0, live = online;
  const subscriptions = [], states = [];
  const watch = (id, receive, fail) => {
    const run = { id, receive, fail, stops: 0 };
    subscriptions.push(run);
    return () => { run.stops++; };
  };
  const stop = observeShiftRoute(start, watch, {
    online: () => live,
    listen(fn) { listener = fn; return () => { stopListening++; }; },
  }, value => states.push(value));
  return {
    states, subscriptions, stop,
    get last() { return subscriptions.at(-1); },
    get state() { return states.at(-1); },
    get cleanup() { return stopListening; },
    emit(fields = {}) { this.last.receive({ fromCache: false, hasPendingWrites: false, job, ...fields }); },
    connect(value) { live = value; listener(); },
  };
}
function html(state) {
  return renderToStaticMarkup(React.createElement(ShiftRouteDetails, { current: state, copyAddress: assert.fail, copying: false }));
}
function endpoints(markup) {
  return [...markup.matchAll(/\shref="([^"]+)"/gu)].map(([, href]) => new URL(href.replaceAll("&amp;", "&")));
}
const cases = [];
function test(name, run) {
  try { run(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, message: error.stack }); }
}

test("confirm only the selected shift and encode the public store information", () => {
  const f = fixture();
  assert.equal(f.last.id, scope.jobId);
  assert.deepEqual(endpoints(html(f.state)), []);
  f.emit({ job: { ...job, uid: "excluded-uid", homeAddress: "excluded-home", dateKey: "2026-11-15", revision: 5 } });
  const result = html(f.state), [map, transit] = endpoints(result);
  const destination = "合成 & 店 #1 架空県テスト市1丁目2-3 合成ビル";
  assert.equal(map.origin, "https://www.google.com");
  assert.equal(map.pathname, "/maps/search/");
  assert.deepEqual([...map.searchParams], [["api", "1"], ["query", destination]]);
  assert.equal(transit.origin, map.origin);
  assert.equal(transit.pathname, "/maps/dir/");
  assert.deepEqual([...transit.searchParams], [["api", "1"], ["destination", destination], ["travelmode", "transit"]]);
  assert.match(result, /最寄駅 架空テスト駅/);
  assert.equal([...result.matchAll(/rel="noopener noreferrer"/gu)].length, 2);
  assert.match(result, /住所をコピー/);
  assert.doesNotMatch(result, /excluded|synthetic-a|route-one/);
  f.stop();
});

for (const [name, invalid] of [
  ["cache", { fromCache: true }],
  ["local write", { hasPendingWrites: true }],
  ["deleted", { job: null }],
  ["other shift", { job: { ...job, id: "route-foreign" } }],
  ["other company", { job: { ...job, companyId: "synthetic-b" } }],
  ["other staff", { job: { ...job, assignedStaffId: "synthetic-staff-b" } }],
  ["open", { job: { ...job, status: "open" } }],
  ["cancelled", { job: { ...job, cancelled: true } }],
  ["missing source", { job: { ...job, sourceMissing: true } }],
  ["unresolved assignment", { job: { ...job, assignmentUnresolved: true } }],
  ["unconfirmed application", { job: { ...job, applicationUnconfirmed: true } }],
  ["mail changes awaiting review", { job: { ...job, mailIntakeReviewRequired: true } }],
  ["source write pending", { job: { ...job, pendingSourceWrite: true } }],
  ["administrative edit pending", { job: { ...job, adminEditSheetWrite: { pending: true } } }],
]) test(name + " removes previously available maps and the copy action", () => {
  const f = fixture();
  f.emit();
  assert.equal(endpoints(html(f.state)).length, 2);
  f.emit(invalid);
  assert.equal(f.state.state, "unavailable");
  const result = html(f.state);
  assert.deepEqual(endpoints(result), []);
  assert.doesNotMatch(result, /住所をコピー|架空県|架空テスト駅/u);
  f.stop();
});

for (const address of [undefined, 123, " ", "確認中", "未入力", "詳細は別途", "－", "https://example.invalid", job.storeName]) {
  test("decline address " + JSON.stringify(address), () => {
    const f = fixture();
    f.emit({ job: { ...job, storeAddress: address } });
    assert.equal(f.state.state, "confirmed");
    const result = html(f.state);
    assert.deepEqual(endpoints(result), []);
    assert.match(result, /店舗住所が未確認/u);
    assert.match(result, /最寄駅 架空テスト駅/u);
    assert.doesNotMatch(result, /住所をコピー/u);
    f.stop();
  });
}

for (const [storeName, storeAddress, station, destination] of [
  [" 店舗A ", " 住所B ", " 駅C ", "店舗A 住所B"],
  [{}, "住所B", {}, "住所B"],
  ["店舗A", {}, null, ""],
  [null, null, null, ""],
  ["　 ", " ", [], ""],
  [42, false, 42, ""],
]) {
  test("route links for " + JSON.stringify([storeName, storeAddress, station]), () => {
    const f = fixture();
    try {
      f.emit({ job: { ...job, storeName, storeAddress, storeNearestStation: station } });
      const result = html(f.state);
      const [map, transit, ...extra] = endpoints(result);
      assert.deepEqual(extra, []);
      if (destination) {
        assert.equal(map.searchParams.get("query"), destination);
        assert.equal(transit.searchParams.get("destination"), destination);
      } else {
        assert.equal(map, undefined);
        assert.equal(transit, undefined);
      }
      assert.equal(result.includes("地図で店舗を見る"), Boolean(destination));
      assert.equal(result.includes("店舗住所が未確認"), !destination);
      assert.equal(result.includes("最寄駅 "), typeof station === "string" && Boolean(station.trim()));
      assert.doesNotMatch(result, /\[object Object\]/u);
    } finally {
      f.stop();
    }
  });
}



test("display a new server address and remove the former store and station", () => {
  const f = fixture();
  f.emit();
  f.emit({ job: { ...job, storeName: "新しい合成店", storeAddress: "架空県テスト市5番地", storeNearestStation: "変更後駅" } });
  const result = html(f.state);
  assert.equal(endpoints(result)[1].searchParams.get("destination"), "新しい合成店 架空県テスト市5番地");
  assert.match(result, /変更後駅/u);
  assert.doesNotMatch(result, /1丁目2-3|架空テスト駅/u);
  f.stop();
});

test("reject cached and late events during loss of connection and recovery", () => {
  const f = fixture({ online: false });
  assert.equal(f.subscriptions.length, 0);
  assert.equal(f.state.state, "unavailable");
  f.connect(true);
  const prior = f.last;
  assert.equal(f.state.state, "checking");
  f.emit({ fromCache: true });
  assert.deepEqual(endpoints(html(f.state)), []);
  f.emit();
  assert.equal(endpoints(html(f.state)).length, 2);
  f.connect(false);
  prior.receive({ job, fromCache: false, hasPendingWrites: false });
  assert.equal(prior.stops, 1);
  assert.deepEqual(endpoints(html(f.state)), []);
  f.connect(true);
  prior.fail();
  assert.equal(f.state.state, "checking");
  f.emit();
  assert.equal(endpoints(html(f.state)).length, 2);
  f.stop();
  assert.equal(f.last.stops, 1);
  assert.equal(f.cleanup, 1);
});

test("permission and teardown close stale callbacks after selecting another shift", () => {
  const first = fixture();
  first.emit();
  first.last.fail();
  assert.deepEqual(endpoints(html(first.state)), []);
  const prior = first.last;
  first.stop();
  const second = fixture({ start: { ...scope, jobId: "route-two" } });
  const before = first.states.length;
  prior.receive({ job, fromCache: false, hasPendingWrites: false });
  assert.equal(first.states.length, before);
  assert.deepEqual(endpoints(html(second.state)), []);
  second.emit({ job: { ...job, id: "route-two", storeAddress: "架空県別店舗6番地" } });
  assert.match(endpoints(html(second.state))[1].searchParams.get("destination"), /別店舗6番地/u);
  second.stop();
});

test("300 active shift details retain only their own route and each listener closes", () => {
  const views = Array.from({ length: 300 }, (_, index) => {
    const scope = { jobId: "shift-" + index, companyId: "synthetic-company-" + index % 2, staffId: "synthetic-staff-" + index };
    const f = fixture({ start: scope });
    const own = { ...job, id: scope.jobId, companyId: scope.companyId, assignedStaffId: scope.staffId,
      storeAddress: "架空県試験町" + index + "番地" };
    return { f, own };
  });
  for (let index = 0; index < views.length; index++) {
    const { f, own } = views[index];
    f.emit({ job: views[(index + 1) % views.length].own });
    assert.deepEqual(endpoints(html(f.state)), []);
    f.emit({ job: own });
    assert.match(endpoints(html(f.state))[1].searchParams.get("destination"), new RegExp(own.storeAddress + "$"));
  }
  for (const { f, own } of views) {
    assert.equal(f.subscriptions.length, 1);
    const before = f.states.length;
    f.stop();
    assert.equal(f.last.stops, 1);
    f.emit({ job: own });
    assert.equal(f.states.length, before);
  }
});

test("shift UI keys the listener by account and job and uses actual Firestore metadata", () => {
  const app = readFileSync(new URL("../apps/staff/src/App.tsx", import.meta.url), "utf8");
  const compact = app.replace(/\s+/gu, "");
  assert.match(compact, /<ShiftRoutePanelkey=\{JSON\.stringify\(\[user\?\.uid\?\?"",companyId,staffId,selectedJob\.id\]\)\}scope=\{\{jobId:selectedJob\.id,companyId,staffId\}\}/u);
  assert.doesNotMatch(app, /selectedJob\.storeAddress|stationSearchUrl|transitRouteUrl/u);
  const entry = readFileSync(new URL("../apps/staff/src/ShiftRoutePanelEntry.tsx", import.meta.url), "utf8");
  assert.match(entry, /import\("\.\/ShiftRoutePanel"\)\.then/u);
  const received = [], fail = () => {};
  let stops = 0;
  firebaseWatch = (ref, options, send, reject) => {
    assert.deepEqual(ref, { db: testDb, collection: "jobs", id: scope.jobId });
    assert.equal(options.includeMetadataChanges, true);
    assert.equal(reject, fail);
    send({ id: job.id, exists: () => true, data: () => ({ ...job, id: "non-authoritative" }),
      metadata: { fromCache: true, hasPendingWrites: false } });
    send({ exists: () => false, metadata: { fromCache: false, hasPendingWrites: true } });
    return () => { stops++; };
  };
  watchShiftRoute(scope.jobId, value => received.push(value), fail)();
  assert.equal(stops, 1);
  assert.equal(received[0].job.id, scope.jobId);
  assert.equal(received[0].fromCache, true);
  assert.equal(received[0].hasPendingWrites, false);
  assert.equal(received[1].job, null);
  assert.equal(received[1].hasPendingWrites, true);
});

test("duplicate connectivity events do not restart the observer", () => {
  const f=fixture();
  f.emit();
  f.connect(true);
  f.connect(true);
  assert.equal(f.subscriptions.length,1);
  assert.equal(endpoints(html(f.state)).length,2);
  f.stop();
});

test("a queued event after teardown cannot reopen the watcher", () => {
  const f=fixture();
  const states=f.states.length;
  f.stop();
  f.connect(false);
  f.connect(true);
  f.stop();
  assert.equal(f.states.length,states);
  assert.equal(f.subscriptions.length,1);
  assert.equal(f.last.stops,1);
  assert.equal(f.cleanup,1);
});

for (const lifecycle of ["visibility","page cache","background offline recovery"]) {
 test("foreground recheck / " + lifecycle, () => {
  assert.equal(typeof browserShiftRouteConnectivity,"function");
  documentEvents.visibilityState="visible";
  navigatorState.onLine=true;
  const subs=[], states=[];
  const stop=observeShiftRoute(scope,(id,receive,fail)=>{
    assert.equal(id,scope.jobId);
    const observer={receive,fail,closed:0};subs.push(observer);
    return ()=>{observer.closed++;};
  },browserShiftRouteConnectivity(),state=>states.push(state));
  const now=()=>states.at(-1);
  const visible=value=>{documentEvents.visibilityState=value;documentEvents.dispatchEvent(new Event("visibilitychange"));};
  const nav=value=>{navigatorState.onLine=value;windowEvents.dispatchEvent(new Event(value?"online":"offline"));};
  const page=type=>windowEvents.dispatchEvent(new Event(type));
  const first=subs[0];
  first.receive({job,fromCache:false,hasPendingWrites:false});
  assert.equal(endpoints(html(now())).length,2);
  if(lifecycle==="page cache")page("pagehide");else visible("hidden");
  assert.equal(first.closed,1);
  assert.deepEqual(endpoints(html(now())),[]);
  first.receive({job,fromCache:false,hasPendingWrites:false});
  assert.deepEqual(endpoints(html(now())),[]);
  if(lifecycle==="background offline recovery"){nav(false);visible("visible");assert.equal(subs.length,1);nav(true);}
  else if(lifecycle==="page cache"){visible("visible");assert.equal(subs.length,1);page("pageshow");}
  else visible("visible");
  assert.equal(subs.length,2);
  assert.equal(now().state,"checking");
  page("pageshow");
  assert.equal(subs.length,2);
  const refreshed=subs[1];
  refreshed.receive({job,fromCache:true,hasPendingWrites:false});
  assert.deepEqual(endpoints(html(now())),[]);
  first.fail();
  first.receive({job,fromCache:false,hasPendingWrites:false});
  assert.deepEqual(endpoints(html(now())),[]);
  refreshed.receive({job:{...job,storeAddress:"架空県変更後7番地"},fromCache:false,hasPendingWrites:false});
  assert.match(endpoints(html(now()))[1].searchParams.get("destination"),/変更後7番地$/u);
  assert.doesNotMatch(html(now()),/1丁目2-3/u);
  stop();
  const rendered=states.length;
  visible("hidden");page("pagehide");visible("visible");page("pageshow");nav(false);nav(true);
  assert.equal(states.length,rendered);
  assert.equal(subs.length,2);
  assert.equal(refreshed.closed,1);
 });
}

console.log(JSON.stringify({ total: cases.length, passed: cases.filter(c => c.passed).length, cases, externalRequests: 0,
  scope: "Actual route observer and React HTML output with synthetic document snapshots; no browser or map-service access" }, null, 2));
if (cases.some(c => !c.passed)) process.exitCode = 1;
