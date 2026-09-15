import {useEffect,useRef,useState} from "react";
export default function AdminImageViewer({src,name}:{src:string;name:string}){
  const dialog=useRef<HTMLDialogElement>(null);
  const [open,setOpen]=useState(false);
  const [zoom,setZoom]=useState(100);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{setOpen(false);setZoom(100);setFailed(false);},[src]);
  useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close();},[open]);
  return <>
    <button type="button" className="ghost compact" aria-label={`${name}を拡大`} onClick={()=>{setZoom(100);setFailed(false);setOpen(true);}}>画像を拡大</button>
    <dialog ref={dialog} className="image-viewer" onClose={()=>setOpen(false)} aria-label={`画像の拡大表示: ${name}`}>
      {open&&<><div className="image-viewer-toolbar"><strong>{name}</strong><button type="button" className="ghost" autoFocus onClick={()=>dialog.current?.close()}>拡大表示を閉じる</button></div>
      <label className="image-viewer-zoom">表示倍率 {zoom}%<input type="range" min="100" max="300" step="50" value={zoom} onChange={event=>setZoom(Number(event.target.value))}/></label>
      <div className="image-viewer-scroll" tabIndex={0} aria-label="拡大画像のスクロール領域">
        {failed?<p role="status">画像を読み込めませんでした。拡大表示を閉じて画像を再取得してください。</p>:<img src={src} alt={name} style={{width:`${zoom}%`}} onError={()=>setFailed(true)}/>}
      </div></>}
    </dialog>
  </>;
}