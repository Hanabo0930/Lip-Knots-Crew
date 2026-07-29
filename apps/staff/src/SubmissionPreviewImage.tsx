import { useEffect, useState } from "react";

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

  useEffect(() => {
    setSrc(file.previewUrl);
    setLoadState(file.previewUrl ? "loading" : "error");
  }, [file.previewUrl, file.id]);

  if (!file.contentType.startsWith("image/")) {
    return (
      <div className={className}>
        <span>{file.contentType.includes("pdf") ? "PDF" : "FILE"}</span>
      </div>
    );
  }

  async function retryPreview() {
    setRefreshing(true);
    setLoadState("loading");
    try {
      const nextUrl = await onRefreshPreview(file);
      if (!nextUrl) {
        setLoadState("error");
        return;
      }
      setSrc(nextUrl);
    } catch {
      setLoadState("error");
    } finally {
      setRefreshing(false);
    }
  }

  if (!src) {
    return (
      <div className={`${className} preview-placeholder`}>
        <span>プレビュー準備中</span>
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
