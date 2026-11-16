import { useEffect, useState, type ComponentType } from "react";

function loadWhenShown<Props extends object>(
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

export const SubmissionImageViewer = loadWhenShown(
  () => import("./SubmissionImageViewer"),
  "画像の拡大表示を準備しています。",
);
export const SubmissionPreviewImage = loadWhenShown(
  () => import("./SubmissionPreviewImage"),
  "提出画像の表示を準備しています。",
);
export const SubmissionHistoryFiles = loadWhenShown(
  () => import("./SubmissionHistoryFiles"),
  "提出済みのファイルを表示する準備をしています。",
);
export const SubmissionProcessingRecovery = loadWhenShown(
  () => import("./SubmissionProcessingRecovery"),
  "提出の処理状況を表示する準備をしています。",
);
