import {useEffect,useRef,useState} from 'react';
function usablePreviewUrl(value:string|null){try{if(!value)return null;const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}}
type Props={url:string|null;name:string;onRefresh?:()=>Promise<string|null|void>;busy?:boolean};
export default function PdfFilePreview({url,name,onRefresh,busy=false}:Props){
 const [current,setCurrent]=useState(url),[pending,setPending]=useState(false),[failed,setFailed]=useState(false);const version=useRef(0),locked=useRef(false);
 useEffect(()=>{version.current++;locked.current=false;setPending(false);setFailed(false);setCurrent(url);return()=>{version.current++;};},[url,name]);
 async function refresh(){if(locked.current||busy||!onRefresh)return;locked.current=true;setPending(true);setFailed(false);setCurrent(null);const run=version.current;try{const result=await onRefresh();if(run!==version.current)return;if(result!==undefined){setCurrent(result);setFailed(!usablePreviewUrl(result));}}catch{if(run===version.current)setFailed(true);}finally{if(run===version.current){locked.current=false;setPending(false);}}}
 const href=usablePreviewUrl(current);
 return <div className="pdf-file-preview" role="group" aria-label={'PDFの内容確認: '+name} aria-busy={pending||busy}>
  <strong>PDF</strong>
  {href&&!pending?<a className="pdf-open-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={name+'を別タブで開く'}>PDFを開く（別タブ）</a>:<span role="status">{pending?'PDFを確認しています…':failed?'PDFを再取得できませんでした。もう一度お試しください。':'PDFを開くための情報を確認できません。'}</span>}
  {onRefresh?<><button type="button" className="secondary ghost" aria-disabled={pending||busy} onClick={()=>void refresh()}>{pending?'再取得中…':'PDFを再取得'}</button><small>開けない・期限切れの場合は再取得してから、もう一度開いてください。</small></>:<small>開けない場合は、この比較を閉じて開き直してください。</small>}
 </div>;
}