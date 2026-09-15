export function submissionStatusLabel(status:string){
  const labels:Record<string,string>={completed:"処理完了",uploading:"アップロード中",waiting_upload:"アップロード待ち",processing:"保存処理中",error:"処理失敗",security_error:"安全確認で停止",paused_global:"運用停止中"};
  return Object.hasOwn(labels,status)?labels[status]:"状態未確認";
}
