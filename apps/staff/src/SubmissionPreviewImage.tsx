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

export default function SubmissionPreviewImage({ file, onRefreshPreview, className = "history-preview" }: Props) {
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [src, setSrc] = useState<string | null>(file.previewUrl);
  const [refreshing, setRefreshing] = useState(false);
  const refreshVersion = useRef(0);
  const refreshPending = useRef(false);

  useEffect(() => {
    refreshVersion.current += 1;
    refreshPending.current = false;
    setRefreshing(false);
    setSrc(file.previewUrl);
    setLoadState(file.previewUrl ? "loading" : "error");
    return () => { refreshVersion.current += 1; };
  }, [file.previewUrl, file.id, file.submissionId]);

  if (!file.contentType.startsWith("image/")) {
    return (
      <div className={className}>
        <span>{file.contentType.includes("pdf") ? "PDF" : "FILE"}</span>
      </div>
    );
  }

  async function retryPreview() {
    if (refreshPending.current) return;
    refreshPending.current = true;
    const version = refreshVersion.current;
    setRefreshing(true);
    setLoadState("loading");
    try {
      const nextUrl = await onRefreshPreview(file);
      if (version !== refreshVersion.current) return;
      if (!nextUrl) {
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
      <div className={`${className} preview-placeholder`} aria-busy={refreshing}>
        <span role="status">{refreshing ? "画像を確認しています…" : "プレビューを取得できません"}</span>
        <button type="button" className="secondary" disabled={refreshing} onClick={() => void retryPreview()}>
          {refreshing ? "再取得中…" : "画像を再読み込み"}
        </button>
      </div>
    );
  }

  return (
    <div className={`${className} preview-frame`}>
      {(loadState === "loading" || loadState === "idle") && <div className="preview-skeleton" aria-hidden="true" />}
      {loadState === "error" ? (
        <div className="preview-error">
          <p>画像を読み込めませんでした</p>
          <button type="button" className="secondary" disabled={refreshing} onClick={() => void retryPreview()}>
            {refreshing ? "再取得中…" : "再読み込み"}
          </button>
        </div>
      ) : (
        <img
          src={src}
          alt={file.driveName || file.originalName}
          loading="lazy"
          decoding="async"
          className={loadState === "loaded" ? "preview-image loaded" : "preview-image"}
          onLoad={() => setLoadState("loaded")}
          onError={() => setLoadState("error")}
        />
      )}
    </div>
  );
}
