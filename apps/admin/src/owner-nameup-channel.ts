const NONCE=/^[a-f0-9]{64}$/;
export const OWNER_CHANNEL='LK_CREW_OWNER_POPUP_V1';
export function ownerNameUpEntry(href:string):{nonce:string}|null{
 try{const u=new URL(href),fragment=new URLSearchParams(u.hash.slice(1));return u.searchParams.get('entry')==='case-list-nameup'&&NONCE.test(fragment.get('nonce')??'')?{nonce:fragment.get('nonce')!}:null;}catch{return null;}
}
export function appsScriptMessageOrigin(origin:string):boolean{
 try{const u=new URL(origin);return u.origin===origin&&u.protocol==='https:'&&(!u.port||u.port==='443')&&(u.hostname==='script.google.com'||/^[a-z0-9-]+-script\.googleusercontent\.com$/.test(u.hostname));}catch{return false;}
}
export function acceptOwnerPreview(event:Pick<MessageEvent,'origin'|'source'|'data'>,opener:Window|null,nonce:string):boolean{
 const d=event.data;
 return !!opener&&event.source===opener&&appsScriptMessageOrigin(event.origin)&&NONCE.test(nonce)&&d?.protocol===OWNER_CHANNEL&&d.type==='PREVIEW'&&d.nonce===nonce&&d.gasPreview&&typeof d.gasPreview==='object'&&JSON.stringify(d).length<=131072;
}
