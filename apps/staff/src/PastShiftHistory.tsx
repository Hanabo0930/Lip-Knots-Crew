import { useEffect, useRef, useState } from "react";
import ShiftJobCards, { type ShiftCardJob } from "./ShiftJobCards";
import {
  createPastShiftHistory, initialPastShiftState, selectedPastShiftYear, type PastShiftReader,
  type PastShiftRecord, type PastShiftScope, type PastShiftState,
} from "./past-shift-history";

type Props<T extends PastShiftRecord & ShiftCardJob, C> = {
  scope: PastShiftScope; scopeVersion: number; selectionRequest: number; reader: PastShiftReader<T, C>; isCurrent: () => boolean;
  selectedId?: string; selectedDateKey?: string; onSelect: (job: T) => void; accent: (menu: string) => string;
  kind: (menu: string) => string; summary: (job: T) => string; submissionSummary: (job: T) => string;
};
type ViewProps<T extends PastShiftRecord & ShiftCardJob> = Omit<Props<T, unknown>, "reader" | "scope" | "scopeVersion" | "isCurrent" | "selectedDateKey" | "selectionRequest"> & {
  state: PastShiftState<T>; page: number; onPage: (page: number) => void;
  onYear: (year: number) => void; onMore: () => void; onRetry: () => void;
};

export function PastShiftHistoryView<T extends PastShiftRecord & ShiftCardJob>({
  state, page, onPage, onYear, onMore, onRetry, ...cards
}: ViewProps<T>) {
  return <section className="past-shift-history" aria-label="年別の過去のシフト">
    <h3>過去のシフト</h3>
    <label className="past-shift-year">表示する勤務日の年
      <select value={state.years.length ? state.year : ""} onChange={event => onYear(Number(event.target.value))}
        disabled={!state.years.length} aria-describedby="past-shift-year-help">
        {!state.years.length && <option value="">年を確認中</option>}
        {state.years.map(year => <option key={year} value={year}>{year}年</option>)}
      </select>
    </label>
    <p>勤務日の年で、保存されているシフトの記録を表示します。勤務実績・支払額の確定を示すものではありません。</p>
    <p id="past-shift-year-help">選べる年は、ご本人の最古の保存済みシフトから今年までです。記録がない年は0件になります。</p>
    <div aria-busy={state.status === "loading" || state.loadingMore}>
      {state.status === "loading" && <p role="status">{state.year}年のシフトを読み込んでいます…</p>}
      {state.status === "ready" && <>
        <p role="status">{state.year}年：読込済み{state.rows.length}件{state.hasMore ? "（続きがあります）" : ""}</p>
        {!state.rows.length && <p>{state.hasMore
          ? "この読込範囲に表示できるシフトはありません。続きも確認できます。"
          : String(state.year) + "年の表示できる過去のシフトはありません。"}</p>}
        {!!state.rows.length && <ShiftJobCards {...cards} jobs={state.rows} page={page} onPageChange={onPage} label={String(state.year) + "年の過去のシフト"}/>}
        {state.hasMore && <button className="secondary" onClick={onMore} disabled={state.loadingMore}>
          {state.loadingMore ? "続きを読み込んでいます…" : "次の記録を50件まで読み込む"}
        </button>}
      </>}
      {state.error && <p role="alert">{state.error}</p>}
    </div>
    <button className="secondary" onClick={onRetry} disabled={state.status === "loading" || state.loadingMore}>
      {state.error ? "もう一度読み込む" : "この年を更新"}
    </button>
    <p>古い日付から読み込みます。給与明細・源泉徴収票は、この一覧には含まれません。</p>
  </section>;
}

export default function PastShiftHistory<T extends PastShiftRecord & ShiftCardJob, C>(props: Props<T, C>) {
  const { scope, scopeVersion, reader } = props;
  const [state, setState] = useState<PastShiftState<T>>(() => initialPastShiftState<T>(scope.today));
  const [page, setPage] = useState(0);
  const guard = useRef(props.isCurrent); guard.current = props.isCurrent;
  const preferredYear = useRef<number | undefined>(undefined);
  preferredYear.current = selectedPastShiftYear(scope.today, props.selectedDateKey);
  const controller = useRef<ReturnType<typeof createPastShiftHistory<T, C>> | null>(null);
  useEffect(() => {
    setPage(0);
    const current = createPastShiftHistory(scope, reader, setState, () => guard.current());
    controller.current = current; void current.initialize(() => preferredYear.current);
    return () => { current.dispose(); if (controller.current === current) controller.current = null; };
  }, [scope.uid, scope.companyId, scope.staffId, scope.today, scopeVersion, reader]);
  useEffect(() => {
    const year = preferredYear.current;
    if (year === undefined || !state.years.includes(year)) return;
    const index = state.rows.findIndex(row => row.id === props.selectedId);
    setPage(year === state.year && index >= 0 ? Math.floor(index / 50) : 0);
    controller.current?.selectYear(year);
  }, [props.selectedId, props.selectedDateKey, state.years, props.selectionRequest]);
  return <PastShiftHistoryView state={state} page={page} onPage={setPage}
    onYear={year => { setPage(0); controller.current?.selectYear(year); }}
    onMore={() => controller.current?.loadMore()} onRetry={() => { setPage(0); controller.current?.retry(); }}
    selectedId={props.selectedId} onSelect={job => { if (guard.current()) props.onSelect(job); }}
    accent={props.accent} kind={props.kind} summary={props.summary} submissionSummary={props.submissionSummary}/>;
}
