import {useEffect,useState} from "react";
type FilePreview={id:string;submissionId:string;previewUrl:string|null;contentType:string;driveName:string;originalName:string};
export default function AdminSubmissionPreview({file,busy,onReload}:{file:FilePreview;busy:boolean;onReload:()=>Promise<void>}){
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[file.id,file.submissionId,file.previewUrl]);
  if(!file.contentType.startsWith("image/"))return <div className="pdf-preview">{file.contentType.includes("pdf")?"PDF":"FILE"}</div>;
  if(!file.previewUrl||failed)return <div className="admin-preview-error"><p>画像を読み込めませんでした</p><button type="button" className="ghost" disabled={busy} onClick={()=>{void onReload().then(()=>setFailed(false),()=>setFailed(true));}}>画像を再取得</button></div>;
  return <img src={file.previewUrl} alt={file.driveName||file.originalName} loading="lazy" decoding="async" onError={()=>setFailed(true)}/>;
}
