import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url), modules = new Map(), queries = [];
let records = [], gate = null, fail = null;
const compare = (a, b) => a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const doc = row => ({ id: row.id, data: () => ({ ...row }) });
const sdk = {
  collection: (_, name) => { assert.equal(name, "jobs"); return { name }; },
  where: (field, op, value) => ({ kind: "where", field, op, value }),
  orderBy: (field, direction) => ({ kind: "order", field, direction }),
  startAfter: cursor => ({ kind: "after", cursor }),
  limit: count => ({ kind: "limit", count }),
  query: (collection, ...constraints) => ({ collection, constraints }),
  async getDocsFromServer(query) {
    queries.push(query);
    if (gate?.matches(query)) await gate.promise;
    if (fail?.(query)) throw Error("synthetic transport failure");
    const { constraints } = query;
    let result = records.filter(row => constraints.filter(c => c.kind === "where").every(c =>
      c.op === "==" ? row[c.field] === c.value : c.op === ">=" ? row[c.field] >= c.value : row[c.field] < c.value));
    assert.deepEqual(constraints.find(c => c.kind === "order"), { kind: "order", field: "dateKey", direction: "asc" });
    result.sort(compare);
    const after = constraints.find(c => c.kind === "after");
    if (after) result = result.filter(row => compare(row, after.cursor.data()) > 0);
    return { docs: result.slice(0, constraints.find(c => c.kind === "limit").count).map(doc) };
  },
};
function load(relative) {
  const path = resolve(root, relative);
  if (modules.has(path)) return modules.get(path).exports;
  const module = { exports: {} }; modules.set(path, module);
  const output = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  }}).outputText;
  runInNewContext(output, { module, exports: module.exports, console,
    require: name => name === "firebase/firestore" ? sdk : name.startsWith(".")
      ? load(resolve(dirname(path), name) + (name === "./ShiftJobCards" ? ".tsx" : ".ts")) : require(name),
  }, { filename: path });
  return module.exports;
}
const core = load("apps/staff/src/past-shift-history.ts");
const { firestorePastShiftReader } = load("apps/staff/src/past-shift-reader.ts");
const { localDateKey } = load("apps/staff/src/job-list.ts");
const { shiftPage } = load("apps/staff/src/ShiftJobCards.tsx");
const { PastShiftHistoryView } = load("apps/staff/src/PastShiftHistory.tsx");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
const scope = { uid: "user-self", companyId: "company-self", staffId: "staff-self", today: "2026-10-01" };
const row = (id, dateKey, changes = {}) => ({ id, dateKey, companyId: scope.companyId, assignedStaffId: scope.staffId,
  status: "assigned", workDate: dateKey, menuName: "合成業務", storeName: "合成店舗", workTime: "10:00〜18:00", ...changes });
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); };
const deferred = matches => { let release; const promise = new Promise(resolve => { release = resolve; }); return { matches, promise, release }; };
const lower = q => q.constraints.find(c => c.kind === "where" && c.field === "dateKey" && c.op === ">=")?.value;
const after = q => q.constraints.find(c => c.kind === "after");
function instance(options = {}) {
  const states = [];
  const control = core.createPastShiftHistory(options.scope ?? scope, options.reader ?? firestorePastShiftReader({}),
    state => states.push(state), options.current);
  return { control, states, state: () => states.at(-1) };
}
function html(state, page = 0) {
  return renderToStaticMarkup(React.createElement(PastShiftHistoryView, { state, page,
    onPage: () => {}, onYear: () => {}, onMore: () => {}, onRetry: () => {}, onSelect: () => {},
    accent: () => "#9d4c68", kind: () => "合成業務", summary: () => "シフトの記録", submissionSummary: () => "提出状況未確認" }));
}
const passed = [];
const selected = new RegExp(process.argv.find(arg => arg.startsWith("--match="))?.slice(8) ?? "");
async function test(name, action) {
  if (!selected.test(name)) return;
  records = []; queries.length = 0; gate = null; fail = null;
  await action(); passed.push(name);
}
await test("Tokyo year boundary and leap-day ranges", async () => {
  assert.equal(localDateKey(new Date("2025-12-31T14:59:59Z")), "2025-12-31");
  assert.equal(localDateKey(new Date("2025-12-31T15:00:00Z")), "2026-01-01");
  assert.equal(core.pastShiftRange(scope, 2025).start, "2025-01-01");
  assert.equal(core.pastShiftRange(scope, 2025).end, "2026-01-01");
  assert.equal(core.pastShiftRange(scope, 2026).end, scope.today);
  const january = { ...scope, today: "2026-01-01" };
  assert.equal(core.pastShiftRange(january, 2026).start, core.pastShiftRange(january, 2026).end);
  records = [row("leap", "2024-02-29")];
  const x = instance(); await x.control.initialize(); x.control.selectYear(2024); await tick();
  assert.equal(x.state().rows[0].id, "leap");
  for (const year of [0, 2027, 2025.5, NaN]) assert.throws(() => core.pastShiftRange(scope, year));
});
await test("Year constraints and owner predicates reach the actual query adapter", async () => {
  records = [row("a", "2025-01-01"), row("b", "2025-12-31"), row("c", "2026-01-01"),
    row("today", scope.today), row("future", "2026-12-31"),
    row("foreign-company", "2021-01-01", { companyId: "another-company" }),
    row("foreign-person", "2022-01-01", { assignedStaffId: "another-staff" })];
  const x = instance(); await x.control.initialize();
  assert.equal(JSON.stringify(x.state().years), "[2026,2025]");
  assert.equal(JSON.stringify(x.state().rows.map(r => r.id)), '["c"]');
  x.control.selectYear(2025); await tick();
  assert.equal(JSON.stringify(x.state().rows.map(r => r.id)), '["a","b"]');
  for (const q of queries) {
    assert.ok(q.constraints.some(c => c.field === "companyId" && c.op === "==" && c.value === scope.companyId));
    assert.ok(q.constraints.some(c => c.field === "assignedStaffId" && c.op === "==" && c.value === scope.staffId));
    assert.ok(q.constraints.find(c => c.kind === "limit").count <= 51);
  }
  const q = queries.at(-1);
  assert.ok(q.constraints.some(c => c.field === "dateKey" && c.op === ">=" && c.value === "2025-01-01"));
  assert.ok(q.constraints.some(c => c.field === "dateKey" && c.op === "<" && c.value === "2026-01-01"));
});
await test("No records creates no fictitious year/history; an empty intermediate year stays zero", async () => {
  const empty = instance(); await empty.control.initialize();
  assert.equal(JSON.stringify(empty.state().years), "[2026]");
  assert.equal(empty.state().rows.length, 0); assert.equal(queries.length, 1);
  records = [row("old", "2024-12-31")];
  const gap = instance(); await gap.control.initialize(); gap.control.selectYear(2025); await tick();
  assert.equal(JSON.stringify(gap.state().years), "[2026,2025,2024]");
  assert.equal(gap.state().rows.length, 0); assert.match(html(gap.state()), /2025年の表示できる過去のシフトはありません/);
});
await test("Initially selected old shift opens its saved year without a redundant current-year query", async () => {
  records = [row("old", "2025-01-01"), row("current", "2026-01-01")];
  const x = instance(); await x.control.initialize(() => 2025);
  assert.equal(x.state().year, 2025); assert.equal(x.state().rows[0].id, "old");
  assert.equal(queries.filter(q => lower(q) !== undefined).length, 1);
  assert.equal(lower(queries.at(-1)), "2025-01-01");
});
await test("Selected year changing during discovery uses the latest context and cannot invent older years", async () => {
  records = [row("oldest", "2024-01-01"), row("old", "2025-01-01"), row("current", "2026-01-01")];
  let selectedYear = 2025;
  gate = deferred(q => lower(q) === undefined);
  const x = instance(); const pending = x.control.initialize(() => selectedYear);
  selectedYear = 2024; gate.release(); await pending; gate = null;
  assert.equal(x.state().year, 2024); assert.equal(x.state().rows[0].id, "oldest");
  const invalid = instance(); await invalid.control.initialize(() => 1999);
  assert.equal(invalid.state().year, 2026);
  assert.ok(!invalid.state().years.includes(1999));
});
await test("Same-date cursor paging, double-click exclusion and loaded-page navigation", async () => {
  records = Array.from({ length: 121 }, (_, i) => row("row-" + String(i).padStart(3, "0"), "2026-01-01"));
  const x = instance(); await x.control.initialize();
  assert.equal(x.state().rows.length, 50); assert.equal(x.state().hasMore, true);
  gate = deferred(q => !!after(q));
  const before = queries.length; x.control.loadMore(); x.control.loadMore();
  assert.equal(queries.length, before + 1);
  gate.release(); await tick(); gate = null;
  assert.equal(x.state().rows.length, 100);
  x.control.loadMore(); await tick();
  assert.equal(x.state().rows.length, 121); assert.equal(x.state().hasMore, false);
  assert.equal(new Set(x.state().rows.map(r => r.id)).size, 121);
  assert.equal(shiftPage(x.state().rows, 0).rows[0].id, "row-000");
  assert.equal(shiftPage(x.state().rows, 1).rows[0].id, "row-050");
  assert.equal(shiftPage(x.state().rows, 2).rows.length, 21);
  assert.match(html(x.state(), 1), /前の50件/); assert.match(html(x.state(), 1), /次の50件/);
});
await test("Mixed-case same-date identifiers preserve Firestore cursor order", async () => {
  records = ["A", "Z", "_", "a", "z"].map(id => row(id, "2026-01-01"));
  const x = instance(); await x.control.initialize();
  assert.equal(JSON.stringify(x.state().rows.map(r => r.id)), '["A","Z","_","a","z"]');
});
await test("Cancelled rows advance the raw cursor without falsely declaring an empty year", async () => {
  records = Array.from({ length: 51 }, (_, i) => row("row-" + String(i).padStart(3, "0"), "2026-01-01", { cancelled: i < 50 }));
  const x = instance(); await x.control.initialize();
  assert.equal(x.state().rows.length, 0); assert.equal(x.state().hasMore, true);
  assert.match(html(x.state()), /この読込範囲/);
  x.control.loadMore(); await tick();
  assert.equal(x.state().rows[0].id, "row-050"); assert.equal(x.state().hasMore, false);
});
await test("Year switching ignores old responses and same-year duplicate requests", async () => {
  records = [row("old", "2025-01-01"), row("new", "2026-01-01")];
  const x = instance(); await x.control.initialize();
  gate = deferred(q => lower(q) === "2025-01-01");
  x.control.selectYear(2025); const count = queries.length; x.control.selectYear(2025);
  assert.equal(queries.length, count); assert.equal(x.state().rows.length, 0); assert.equal(x.state().status, "loading");
  x.control.selectYear(2026); await tick();
  gate.release(); await tick(); gate = null;
  assert.equal(x.state().year, 2026); assert.equal(x.state().rows[0].id, "new");
  x.control.selectYear(2023); assert.equal(x.state().year, 2026);
});
await test("An old additional page cannot merge into a newly selected year", async () => {
  records = [row("previous-year", "2025-12-31"), ...Array.from({ length: 55 }, (_, i) =>
    row("current-" + String(i).padStart(3, "0"), "2026-01-01"))];
  const x = instance(); await x.control.initialize();
  gate = deferred(q => !!after(q)); x.control.loadMore(); x.control.selectYear(2025); await tick();
  assert.equal(x.state().year, 2025); assert.equal(x.state().rows.length, 1);
  gate.release(); await tick(); gate = null;
  assert.equal(x.state().rows.length, 1); assert.equal(x.state().rows[0].id, "previous-year");
});
await test("Owner revocation and unmount suppress late results and further reads", async () => {
  records = [row("old", "2025-01-01"), row("new", "2026-01-01")];
  let active = true; const x = instance({ current: () => active }); await x.control.initialize();
  gate = deferred(q => lower(q) === "2025-01-01"); x.control.selectYear(2025);
  const count = x.states.length; active = false; gate.release(); await tick();
  assert.equal(x.states.length, count);
  x.control.dispose(); const reads = queries.length; await x.control.initialize(); x.control.loadMore(); x.control.retry();
  assert.equal(queries.length, reads);
});
await test("First-page and additional-page failures recover without dropping loaded rows or cursor", async () => {
  records = Array.from({ length: 55 }, (_, i) => row("row-" + String(i).padStart(3, "0"), "2026-01-01"));
  fail = q => !!lower(q); const x = instance(); await x.control.initialize();
  assert.equal(x.state().status, "error"); assert.equal(x.state().rows.length, 0); assert.match(html(x.state()), /role="alert"/);
  fail = null; x.control.retry(); await tick(); assert.equal(x.state().rows.length, 50);
  fail = q => !!after(q); x.control.loadMore(); await tick();
  assert.equal(x.state().status, "ready"); assert.equal(x.state().rows.length, 50); assert.ok(x.state().error);
  const failedCursor = after(queries.at(-1)).cursor.id;
  fail = null; x.control.retry(); await tick();
  assert.equal(after(queries.at(-1)).cursor.id, failedCursor);
  assert.equal(x.state().rows.length, 55); assert.equal(x.state().error, "");
});
await test("Year-discovery error is distinct from zero records and retry remains available", async () => {
  fail = () => true; const x = instance(); await x.control.initialize();
  assert.equal(x.state().status, "error"); assert.equal(x.state().years.length, 0);
  assert.match(html(x.state()), /もう一度読み込む/);
  fail = null; x.control.retry(); await tick(); assert.equal(x.state().status, "ready");
});
await test("Foreign owner, wrong year, duplicate and malformed returned rows fail closed", async () => {
  for (const bad of [
    [row("foreign", "2026-01-01", { companyId: "foreign" })],
    [row("foreign", "2026-01-01", { assignedStaffId: "foreign" })],
    [row("wrong-year", "2025-01-01")], [row("invalid", "2026-02-30")],
    [row("dup", "2026-01-01"), row("dup", "2026-01-01")],
  ]) {
    const x = instance({ reader: { oldest: async () => row("old", "2025-01-01"),
      page: async () => bad.map(r => ({ row: r, cursor: r.id })) } });
    await x.control.initialize(); assert.equal(x.state().status, "error"); assert.equal(x.state().rows.length, 0);
  }
  assert.throws(() => instance({ scope: { ...scope, staffId: "other/person" } }));
});
await test("Loading/empty/error and source wording render; untrusted record text is escaped", async () => {
  assert.match(html(core.initialPastShiftState(scope.today)), /読み込んでいます/);
  assert.match(html(core.initialPastShiftState(scope.today)), /勤務実績・支払額の確定を示すものではありません/);
  const x = instance();
  records = [row("escaped", "2026-01-01", { storeName: "<img src=x onerror=alert(1)>" })];
  await x.control.initialize(); const output = html(x.state());
  assert.ok(output.includes("&lt;img")); assert.ok(!output.includes("<img src=x"));
  assert.match(output, /表示する勤務日の年/); assert.match(output, /aria-describedby="past-shift-year-help"/);
});
await test("Screen-only typography/control minima and brand text contrast", async () => {
  const css = readFileSync(resolve(root, "apps/staff/src/styles.css"), "utf8");
  const added = css.slice(css.indexOf("/* Larger text and controls"));
  assert.match(added, /\.past-history-shell \{ font-size:18px/);
  assert.match(added, /min-height:48px; min-width:48px; font-size:18px/);
  assert.match(added, /\.past-shift-history h3 \{ font-size:22px/);
  assert.match(added, /box-sizing:border-box/);
  assert.match(added, /white-space:normal; overflow:visible; text-overflow:clip; overflow-wrap:anywhere/);
  assert.ok(added.split("\n").filter(l => l.includes("{")).every(l => l.startsWith(".past-")));
  const luminance = hex => {
    const rgb = hex.match(/[a-f\d]{2}/gi).map(v => parseInt(v, 16) / 255)
      .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  for (const fg of ["65545f", "493b35", "9d4c68"]) {
    const ratio = (luminance("fff9fb") + 0.05) / (luminance(fg) + 0.05);
    assert.ok(ratio >= 4.5, "Static palette contrast must be at least 4.5:1");
  }
  const indexes = JSON.parse(readFileSync(resolve(root, "firestore.indexes.json"), "utf8"));
  assert.ok(indexes.indexes.some(i => i.collectionGroup === "jobs" && i.queryScope === "COLLECTION" &&
    JSON.stringify(i.fields) === JSON.stringify([
      { fieldPath: "companyId", order: "ASCENDING" }, { fieldPath: "assignedStaffId", order: "ASCENDING" },
      { fieldPath: "dateKey", order: "ASCENDING" },
    ])));
});
console.log(JSON.stringify({ passed: passed.length, scenarios: passed,
  boundary: "Synthetic Firestore query adapter, controller races, React static render and static palette only; no network/browser/DB",
  firestoreRulesRuntimeAccepted: false, realDeviceAccepted: false }));
