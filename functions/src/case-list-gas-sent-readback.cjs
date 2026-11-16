'use strict';
// Pure SENT evidence verifier. OAuth credentials belong exclusively to the injected readonly client.
const crypto=require('node:crypto');
const need=(x,c)=>{if(!x)throw Object.assign(Error(c),{code:c});};
const groupDigest=group=>crypto.createHash('sha256').update(JSON.stringify(group)).digest('hex');
function recipients(raw){
 if(typeof raw!=='string')return null;if(!raw.trim())return [];
 const parts=raw.match(/(?:[^",]|"(?:[^"\\]|\\.)*")+/g)||[];
 const values=parts.map(part=>{const m=/^(?:(?:"(?:[^"\\]|\\.)*"|[^<>@;"]*)\s*<([^<>]+)>|([^<>\s,;]+))$/.exec(part.trim()),address=(m?.[1]||m?.[2]||'').toLowerCase();return /^[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(address)?address:null;});return values.every(Boolean)?values.sort():null;
}
function checkedIdentity(message,group,receipt,{firstPreparedAt,now}){
 need(receipt&&/^[a-f0-9]{64}$/.test(receipt.digest||'')&&/^[a-z0-9_-]{1,160}$/i.test(receipt.messageId||'')&&receipt.digest===groupDigest(group),'SENT_RECEIPT_CHANGED');
 need(message?.id===receipt.messageId&&Array.isArray(message.labelIds)&&message.labelIds.every(x=>typeof x==='string')&&message.labelIds.includes('SENT'),'SENT_MESSAGE_CHANGED');
 need(typeof message.internalDate==='number'||typeof message.internalDate==='string'&&/^[0-9]+$/.test(message.internalDate),'SENT_TIME_UNVERIFIED');
 const sentAt=Number(message.internalDate);need(Number.isSafeInteger(sentAt)&&sentAt>=firstPreparedAt&&sentAt<=now,'SENT_TIME_UNVERIFIED');
 return {p:message.payload,sentAt};
}
function checkedHeaders(p,group,mailbox){
 const h=p?.headers;need(Array.isArray(h),'SENT_MIME_CHANGED');
 const absent=['bcc','reply-to','resent-to','resent-cc','resent-bcc','in-reply-to','references'],read={};
 for(const name of ['from','to','cc','subject',...absent]){const matches=h.filter(x=>typeof x?.name==='string'&&x.name.trim().toLowerCase()===name);need(matches.length<=1&&(!matches.length||typeof matches[0].value==='string'),'SENT_HEADERS_CHANGED');read[name]=matches[0]?.value||'';}
 need(absent.every(k=>!read[k].trim()),'SENT_HEADERS_CHANGED');
 for(const [name,expected]of [['from',[mailbox]],['to',group.to],['cc',group.cc]])need(JSON.stringify(recipients(read[name]))===JSON.stringify(expected.map(x=>x.toLowerCase()).sort()),'SENT_RECIPIENTS_CHANGED');
 const subject=read.subject.replace(/(\?=)\s+(?==\?UTF-8\?B\?)/gi,'$1').replace(/=\?UTF-8\?B\?([^?]+)\?=/gi,(_,word)=>Buffer.from(word,'base64').toString('utf8'));
 need(subject===group.subject,'SENT_BODY_CHANGED');
}
// Metadata is only permission to fetch the known message's body, never a SENT
// confirmation/result. No body property is inspected or returned here.
function verifySentMetadata(message,group,receipt,scope){
 const {p}=checkedIdentity(message,group,receipt,scope);checkedHeaders(p,group,scope.mailbox);
}
function verifySentMessage(message,group,receipt,scope){
 const {p,sentAt}=checkedIdentity(message,group,receipt,scope);
 need(p?.mimeType==='text/plain'&&!p.filename&&!p.parts?.length&&!p.body?.attachmentId,'SENT_MIME_CHANGED');
 checkedHeaders(p,group,scope.mailbox);
 need(typeof p.body?.data==='string'&&p.body.data.length<=131072&&/^[A-Za-z0-9_\-=]*$/.test(p.body.data),'SENT_BODY_CHANGED');
 need(Buffer.from(p.body.data,'base64url').toString('utf8').replace(/\r\n/g,'\n').replace(/\n$/,'')===group.body,'SENT_BODY_CHANGED');
 return {state:'SENT_VERIFIED',digest:receipt.digest,messageId:receipt.messageId,sentAt};
}
module.exports={verifySentMessage,verifySentMetadata,groupDigest};
