import PdfFilePreview from "./PdfFilePreview";
import SubmissionImageViewer from "./SubmissionImageViewer";
import { useEffect, useRef, useState } from "react";

export type PreviewFile = {
  id: string;
  submissionId: string;
  driveName: string;
  originalName: string;
  contentType: string;
  previewUrl: string | null;
};

type Props = {
  file: PreviewFile;
  onRefreshPreview: (file: PreviewFile) => Promise<string | null>;
  className?: string;
};

export default function SubmissionPreviewImage(props: Props) {
  const { file } = props;
  // Replace state in the same commit as the file, before any passive effect.
  return <SubmissionPreviewContent key={JSON.stringify([file.submissionId, file.id, file.previewUrl, file.contentType])} {...props}/>;
}

function SubmissionPreviewContent({ file, onRefreshPreview, className = "history-preview" }: Props) {
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">(file.previewUrl ? "loading" : "error");
  const [src, setSrc] = useState<string | null>(file.previewUrl);
  const [refreshing, setRefreshing] = useState(false);
  const refreshVersion = useRef(0);
  const refreshPending = useRef(false);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const restorePreviewFocus = useRef(false);

  // Identity changes remount this component. Do not reset loading in a passive
  // effect: a cached image can finish loading before that effect runs.
  useEffect(() => () => { refreshVersion.current += 1; }, []);

  useEffect(() => {
    if (!restorePreviewFocus.current) return;
    const container = previewContainerRef.current;
    if (document.activeElement === document.body) container?.focus({preventScroll:true});
    else if (!container?.contains(document.activeElement)) restorePreviewFocus.current = false;
    if (!refreshing) restorePreviewFocus.current = false;
  }, [src, loadState, refreshing]);

  const previewLabel = "提出ファイルのプレビュー: " + (file.driveName?.trim() || file.originalName?.trim() || "ファイル名確認中");

  if(file.contentType==="application/pdf")return <PdfFilePreview key={JSON.stringify([file.submissionId,file.id])} url={file.previewUrl} name={file.driveName||file.originalName||"報告書PDF"} onRefresh={()=>onRefreshPreview(file)}/>;
  if (!file.contentType.startsWith("image/")) {
    return (
      <div ref={previewContainerRef} tabIndex={-1} role="group" aria-label={previewLabel} className={className}>
        <span>{file.contentType.includes("pdf") ? "PDF" : "FILE"}</span>
      </div>
    );
  }

  async function retryPreview() {
    if (refreshPending.current) return;
    restorePreviewFocus.current = Boolean(previewContainerRef.current?.contains(document.activeElement));
    refreshPending.current = true;
    const version = refreshVersion.current;
    setRefreshing(true);
    setSrc(null);
    setLoadState("loading");
    try {
      const nextUrl = await onRefreshPreview(file);
      if (version !== refreshVersion.current) return;
      if (typeof nextUrl !== "string" || !nextUrl.trim()) {
        setLoadState("error");
        return;
      }
      setSrc(nextUrl);
    } catch {
      if (version === refreshVersion.current) setLoadState("error");
    } finally {
      if (version === refreshVersion.current) {
        refreshPending.current = false;
        setRefreshing(false);
      }
    }
  }

  if (!src) {
    return (
      <div ref={previewContainerRef} tabIndex={-1} role="group" aria-label={previewLabel} className={`${className} preview-placeholder`} aria-busy={refreshing}>
        <span role="status">{refreshing ? "画像を確認しています…" : "プレビューを取得できません"}</span>
        <button type="button" className="secondary" disabled={refreshing} onClick={() => void retryPreview()}>
          {refreshing ? "再取得中…" : "画像を再読み込み"}
        </button>
      </div>
    );
  }

  return (
    <div ref={previewContainerRef} tabIndex={-1} role="group" aria-label={previewLabel} className={`${className} preview-frame`}>
      {loadState === "loading" && <div className="preview-skeleton" aria-hidden="true" />}
      {loadState === "error" ? (
        <div className="preview-error">
          <p>画像を読み込めませんでした</p>
          <button type="button" className="secondary" disabled={refreshing} onClick={() => void retryPreview()}>
            {refreshing ? "再取得中…" : "再読み込み"}
          </button>
        </div>
      ) : (
        <><img
          src={src}
          alt={file.driveName || file.originalName}
          loading="lazy"
          decoding="async"
          className={loadState === "loaded" ? "preview-image loaded" : "preview-image"}
          onLoad={() => setLoadState("loaded")}
          onError={() => setLoadState("error")}
        />
        {loadState==="loaded"&&<SubmissionImageViewer src={src} name={file.driveName||file.originalName}/>}</>
      )}
    </div>
  );
}
