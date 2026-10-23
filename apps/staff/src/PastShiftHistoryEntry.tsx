import { useEffect, useState } from "react";

type HistoryComponent = typeof import("./PastShiftHistory").default;

const PastShiftHistoryEntry: HistoryComponent = props => {
  const [History, setHistory] = useState<HistoryComponent | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(false);
    void import("./PastShiftHistory").then(module => {
      if (active) setHistory(() => module.default);
    }).catch(() => {
      if (active) setLoadError(true);
    });
    return () => { active = false; };
  }, [attempt]);

  if (History) return <History {...props}/>;
  return <section className="past-shift-history" aria-label="年別の過去のシフト">
    <h3>過去のシフト</h3>
    {loadError ? <div role="alert">
      <p>過去のシフト画面を読み込めませんでした。通信状態を確認して再試行してください。</p>
      <button className="secondary" onClick={() => setAttempt(current => current + 1)}>過去のシフト画面を再読込</button>
    </div> : <p role="status">過去のシフト画面を読み込んでいます…</p>}
  </section>;
};

export default PastShiftHistoryEntry;
