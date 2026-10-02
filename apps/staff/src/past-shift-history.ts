import { hasValidDateKey } from "./job-list";

export const PAST_SHIFT_PAGE_SIZE = 50;
export type PastShiftScope = { uid: string; companyId: string; staffId: string; today: string };
export type PastShiftRecord = {
  id: string; dateKey: string; companyId?: string; assignedStaffId?: string;
  status: string; cancelled?: boolean;
};
export type PastShiftRange = PastShiftScope & { year: number; start: string; end: string };
export type PastShiftReader<T, C> = {
  oldest: (scope: PastShiftScope) => Promise<T | null>;
  page: (range: PastShiftRange, cursor: C | null) => Promise<{ row: T; cursor: C }[]>;
};
export type PastShiftState<T> = {
  year: number; years: number[]; rows: T[]; status: "loading" | "ready" | "error";
  loadingMore: boolean; hasMore: boolean; error: string;
};

function checkedScope(scope: PastShiftScope) {
  if ([scope.uid, scope.companyId, scope.staffId].some(value =>
    typeof value !== "string" || !value.trim() || value.length > 200 || /[/\r\n\0]/u.test(value)) ||
    !hasValidDateKey({ dateKey: scope.today })) throw Error("本人のシフト情報を確認できません。");
}
export function pastShiftRange(scope: PastShiftScope, year: number): PastShiftRange {
  checkedScope(scope);
  const currentYear = Number(scope.today.slice(0, 4));
  if (!Number.isInteger(year) || year < 1 || year > currentYear) throw Error("表示する年を選んでください。");
  return { ...scope, year, start: String(year).padStart(4, "0") + "-01-01",
    end: year === currentYear ? scope.today : String(year + 1).padStart(4, "0") + "-01-01" };
}
export function selectedPastShiftYear(today: string, dateKey?: string): number | undefined {
  return typeof dateKey === "string" && hasValidDateKey({ dateKey }) && dateKey < today
    ? Number(dateKey.slice(0, 4)) : undefined;
}
export function initialPastShiftState<T>(today: string): PastShiftState<T> {
  return { year: Number(today.slice(0, 4)), years: [], rows: [], status: "loading",
    loadingMore: false, hasMore: false, error: "" };
}

/** Read-only, owner/year-scoped paging. Neither cached business rows nor financial documents are used. */
export function createPastShiftHistory<T extends PastShiftRecord, C>(
  scope: PastShiftScope, reader: PastShiftReader<T, C>, publish: (state: PastShiftState<T>) => void,
  isCurrent: () => boolean = () => true,
) {
  checkedScope(scope);
  let state = initialPastShiftState<T>(scope.today), cursor: C | null = null;
  let generation = 0, pending = false, stopped = false;
  let preferredYear: () => number | undefined = () => undefined;
  const current = (version: number) => !stopped && generation === version && isCurrent();
  const emit = (next: PastShiftState<T>) => { state = next; if (!stopped && isCurrent()) publish(next); };
  function check(row: T, range?: PastShiftRange) {
    if (!row || typeof row.id !== "string" || !row.id || row.id.includes("/") ||
      row.companyId !== scope.companyId || row.assignedStaffId !== scope.staffId ||
      !hasValidDateKey(row) || row.dateKey >= scope.today ||
      (range && (row.dateKey < range.start || row.dateKey >= range.end))) {
      throw Error("本人・会社・表示年のシフト情報が一致しません。");
    }
  }
  async function read(year: number, append: boolean, version: number) {
    if (!current(version)) return;
    const range = pastShiftRange(scope, year);
    pending = true;
    if (append) emit({ ...state, loadingMore: true, error: "" });
    else { cursor = null; emit({ ...state, year, rows: [], status: "loading", hasMore: false, loadingMore: false, error: "" }); }
    try {
      const entries = range.start === range.end ? [] : await reader.page(range, cursor);
      if (!current(version)) return;
      if (!Array.isArray(entries) || entries.length > PAST_SHIFT_PAGE_SIZE + 1) throw Error("シフトの取得件数を確認できません。");
      const ids = new Set<string>();
      for (const entry of entries) {
        check(entry.row, range);
        if (entry.cursor == null || ids.has(entry.row.id)) throw Error("シフトの読み込み位置を確認できません。");
        ids.add(entry.row.id);
      }
      // Cursor/hasMore follow raw documents, including cancelled/other-status rows.
      const page = entries.slice(0, PAST_SHIFT_PAGE_SIZE);
      cursor = page.at(-1)?.cursor ?? cursor;
      const rows = new Map((append ? state.rows : []).map(row => [row.id, row]));
      for (const { row } of page) {
        if (row.status === "assigned" && row.cancelled !== true) rows.set(row.id, row);
        else rows.delete(row.id);
      }
      // Keep server cursor order, including document-ID ties; locale collation moves rows between display pages.
      const ordered = [...rows.values()];
      emit({ ...state, rows: ordered, status: "ready", loadingMore: false,
        hasMore: entries.length > PAST_SHIFT_PAGE_SIZE, error: "" });
    } catch {
      if (current(version)) emit({ ...state, status: append ? "ready" : "error", loadingMore: false,
        error: "過去のシフトを読み込めませんでした。通信状態を確認して、もう一度読み込んでください。" });
    } finally { if (current(version)) pending = false; }
  }
  async function initialize(preference?: () => number | undefined) {
    if (stopped || !isCurrent()) return;
    if (preference) preferredYear = preference;
    const version = ++generation;
    pending = true; cursor = null;
    emit(initialPastShiftState<T>(scope.today));
    try {
      const first = await reader.oldest(scope);
      if (!current(version)) return;
      if (first) check(first);
      const currentYear = Number(scope.today.slice(0, 4));
      const oldestYear = first ? Number(first.dateKey.slice(0, 4)) : currentYear;
      const years = Array.from({ length: currentYear - oldestYear + 1 }, (_, index) => currentYear - index);
      emit({ ...state, years });
      if (!first) { pending = false; emit({ ...state, status: "ready" }); return; }
      const preferred = preferredYear();
      await read(preferred !== undefined && years.includes(preferred) ? preferred : currentYear, false, version);
    } catch {
      if (current(version)) {
        pending = false;
        emit({ ...state, status: "error", error: "選べる年を読み込めませんでした。もう一度読み込んでください。" });
      }
    }
  }
  return {
    initialize,
    selectYear(year: number) {
      if (stopped || !isCurrent() || !state.years.includes(year)) return;
      if (year === state.year && (pending || state.status === "ready")) return;
      const version = ++generation; pending = false;
      void read(year, false, version);
    },
    loadMore() {
      if (stopped || !isCurrent() || pending || !state.hasMore || cursor == null) return;
      void read(state.year, true, generation);
    },
    retry() {
      if (stopped || !isCurrent() || pending) return;
      if (!state.years.length) { void initialize(); return; }
      if (state.status === "error") { void read(state.year, false, ++generation); return; }
      if (state.error) { void read(state.year, true, generation); return; }
      void read(state.year, false, ++generation);
    },
    dispose() { stopped = true; generation++; },
  };
}
