import { loadWhenShown } from "./loadWhenShown";

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
