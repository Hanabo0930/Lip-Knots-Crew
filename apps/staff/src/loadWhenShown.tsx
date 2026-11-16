import { useEffect, useState, type ComponentType } from "react";

export function loadWhenShown<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  loading: string,
): ComponentType<Props> {
  return function DeferredPanel(props: Props) {
    const [Panel, setPanel] = useState<ComponentType<Props> | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
      let active = true;
      void load().then(({ default: Loaded }) => {
        if (active) setPanel(() => Loaded);
      }).catch(() => {
        if (active) setFailed(true);
      });
      return () => { active = false; };
    }, []);

    if (Panel) return <Panel {...props} />;
    if (failed) return <p className="empty" role="alert">
      表示を読み込めませんでした。通信が戻ってから画面を開き直してください。
    </p>;
    return <p role="status">{loading}</p>;
  };
}
