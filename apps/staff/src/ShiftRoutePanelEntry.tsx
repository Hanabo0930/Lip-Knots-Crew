import { useEffect, useState } from "react";

type Panel = typeof import("./ShiftRoutePanel").default;

const ShiftRoutePanelEntry: Panel = props => {
  const [Route, setRoute] = useState<Panel | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void import("./ShiftRoutePanel").then(({ default: Panel }) => {
      if (active) setRoute(() => Panel);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, []);

  if (Route) return <Route {...props} />;
  return <div className="route-panel">
    <strong>店舗への行き方</strong>
    {failed
      ? <p role="alert">経路を表示できません。通信状態を確認して画面を再読み込みしてください。</p>
      : <p role="status">経路の表示を準備しています。</p>}
  </div>;
};

export default ShiftRoutePanelEntry;
