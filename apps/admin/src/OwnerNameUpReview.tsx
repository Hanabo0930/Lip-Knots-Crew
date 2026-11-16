import {useEffect,useRef,useState} from 'react';
import {httpsCallable} from 'firebase/functions';
import {functions} from './firebase';
import {OWNER_CHANNEL,acceptOwnerPreview,ownerNameUpEntry} from './owner-nameup-channel';
type Data=Record<string,any>;
export default function OwnerNameUpReview({uid}:{uid:string}){
 const [view,setView]=useState<Data|null>(null),[message,setMessage]=useState('シフト表から確認内容を受け取っています。'),[busy,setBusy]=useState(false),[finished,setFinished]=useState(false),[expenses,setExpenses]=useState<Record<string,{travelExpenses:string;communicationExpenses:string}>>({});
 const active=useRef(true),generation=useRef(0),run=useRef(false),peer=useRef<{source:Window;origin:string;nonce:string;preview:Data;fingerprint:string}|null>(null),approval=useRef<Data|null>(null);
 async function call(action:string,payload:Data){if(!functions)throw Error('接続設定を確認してください。');return (await httpsCallable(functions,'acknowledgeSheetWriteIssue')({action,payload})).data as Data;}
 useEffect(()=>{
  active.current=true;const expectedGeneration=++generation.current,isCurrent=()=>active.current&&generation.current===expectedGeneration,entry=ownerNameUpEntry(window.location.href),opener=window.opener;
  peer.current=null;approval.current=null;run.current=false;setView(null);setFinished(false);setExpenses({});
  async function receive(event:MessageEvent){
   if(!isCurrent()||!entry||!acceptOwnerPreview(event,opener,entry.nonce))return;
   const fingerprint=JSON.stringify(event.data.gasPreview);
   if(peer.current){if(peer.current.fingerprint!==fingerprint){run.current=true;setFinished(true);setMessage('表示内容が変わりました。送信せず、シフト表で確認をやり直してください。');}return;}
   peer.current={source:opener!,origin:event.origin,nonce:entry.nonce,preview:event.data.gasPreview,fingerprint};
   setBusy(true);
   try{const out=await call('preview-case-list-gas-send',{gasPreview:event.data.gasPreview});if(!isCurrent())return;if(!out.required||!out.view)throw Error('正式確認を準備できませんでした。');setView(out.view);setMessage('担当者・条件・宛先・本文を確認してください。');setExpenses(Object.fromEntries(out.view.cases.map((c:Data)=>[c.caseId,{travelExpenses:c.travelExpenses??'',communicationExpenses:c.communicationExpenses??''}])));}
   catch{if(isCurrent())setMessage('確認を準備できませんでした。送信はしていません。シフト表の案件と接続状態を確認してください。');}
   finally{if(isCurrent())setBusy(false);}
  }
  async function result(event:MessageEvent){
   const p=peer.current,d=event.data;if(!isCurrent()||!p||!approval.current||event.source!==p.source||event.origin!==p.origin||d?.protocol!==OWNER_CHANNEL||d.type!=='RESULT'||d.nonce!==p.nonce)return;
   try{const out=await call('observe-case-list-gas-send',{reference:approval.current.reference,operationKey:typeof d.operationKey==='string'?d.operationKey:''});if(!isCurrent())return;const completed=out.items.length>0&&out.items.every((i:Data)=>i.state==='ACKED');setMessage(completed?'月別シフトへの転記とアプリの確定を確認しました。':'送信・転記の結果を確認中です。送信ボタンを押し直さず、管理画面の照合結果を確認してください。');}
   catch{if(isCurrent())setMessage('結果の照合を保留しました。送信し直さず、管理画面で確認してください。');}
  }
  window.addEventListener('message',receive);window.addEventListener('message',result);
  return()=>{active.current=false;generation.current++;window.removeEventListener('message',receive);window.removeEventListener('message',result);};
 },[uid]);
 async function send(){
  const p=peer.current,expectedGeneration=generation.current,isCurrent=()=>active.current&&generation.current===expectedGeneration;if(run.current||!p||!view)return;run.current=true;setBusy(true);
  try{
   const confirmation={reviewId:view.reviewId,displayHash:view.displayHash,intent:'CONFIRM_DISPLAYED_AND_SEND',displayedCases:view.cases,displayedMail:view.mail,payOffers:view.cases.map((c:Data)=>({caseId:c.caseId,dailyWageJPY:c.dailyWageJPY,...expenses[c.caseId]}))};
   const out=await call('confirm-case-list-gas-send',{gasPreview:p.preview,confirmation});
   if(!isCurrent())return;if(out.status!=='OWNER_APPROVED_FOR_GAS'||out.actorUid!==uid||out.validUntil<=Date.now())throw Error('確認期限切れ');
   approval.current=out;setFinished(true);setMessage('本人確認を記録しました。シフト表で送信・反映を進めています。このボタンから再送はしません。');
   p.source.postMessage({protocol:OWNER_CHANNEL,type:'APPROVED',nonce:p.nonce,approval:out},p.origin);
  }catch{if(isCurrent()){setFinished(true);setMessage('確認結果を保留しました。送信せず、管理画面で結果を再照合してください。');}}
  finally{if(isCurrent())setBusy(false);}
 }
 const ready=!!view&&view.cases.every((c:Data)=>expenses[c.caseId]?.travelExpenses==='全額支給'&&expenses[c.caseId]?.communicationExpenses==='全額支給');
 return <main className="login"><section><h1>ネームアップの正式確認</h1><p role="status">{message}</p>
  {view?.cases.map((c:Data)=><article key={c.caseId}><h2>{c.date}　{c.staffName}</h2><p>{c.client}／{c.store}／{c.maker}</p><p>{c.content}</p><p>入店：{c.arrival}　実施：{c.execution}　人数：{c.headcount}　日程方式：{c.dateMode}</p><p>給与：{c.dailyWageJPY.toLocaleString()}円</p>{(['travelExpenses','communicationExpenses'] as const).map((key)=><label key={key}>{key==='travelExpenses'?'交通費':'通信費'}<select disabled={busy||finished} value={expenses[c.caseId]?.[key]??''} onChange={e=>setExpenses(old=>({...old,[c.caseId]:{...old[c.caseId],[key]:e.target.value}}))}><option value="">未確認</option><option value="全額支給">全額支給</option></select></label>)}</article>)}
  {view?.mail.groups.map((g:Data,i:number)=><article key={i}><h2>{g.client}</h2><p>宛先：{g.to.join('、')}</p>{g.cc.length>0&&<p>CC：{g.cc.join('、')}</p>}<p>件名：{g.subject}</p><pre style={{whiteSpace:'pre-wrap'}}>{g.body}</pre></article>)}
  <p>表示した入店・実施時間・人数・日程方式・報酬条件とメール内容を、この送信操作で確認します。</p>
  <button onClick={send} disabled={busy||finished||!ready}>{busy?'確認中…':'表示した内容でネームアップ送信'}</button>
 </section></main>;
}
