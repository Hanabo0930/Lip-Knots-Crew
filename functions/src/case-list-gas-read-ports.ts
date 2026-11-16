// Concrete existing-SDK-shaped adapters. Constructors do not fetch a token or make a request.
type Data=Record<string,any>;
type Actor={uid:string;companyId:string;email:string};
export type SentReadPolicy={enabled:true;companyId:string;ownerUid:string;mailbox:string;principalRevision:string};
export type ExistingMailConfig={companyId:string;uid:string;producerId:string;principalRevision:string;mailbox:string;startedAt:string;gmailServiceAccountEmail:string};
export type ExistingMailAuth={obtainGmailAccessToken(context:Data):Promise<string>};
export type GmailReader={get(path:string,query?:Record<string,string>):Promise<Data>;getMessage(id:string):Promise<Data>};
export type SentMessageScope={operationKey:string;caseId:string;messageId:string;digest:string};
export type ReadPorts={
 now():number;
 readMonthly(companyId:string,caseId:string):Promise<Data>;
 hash(value:unknown):string;
 sentPolicy?:SentReadPolicy;
 readMailConfig(companyId:string):Promise<ExistingMailConfig>;
 assertMailAccess(config:ExistingMailConfig,actor:Actor,scope?:SentMessageScope):Promise<void>;
 assertMailReaderReady?(config:ExistingMailConfig,actor:Actor):Promise<void>;
 createMailAuth(serviceAccountEmail:string,unusedExtractor:()=>string):ExistingMailAuth;
 createGmailReader(getAccessToken:()=>Promise<string>):GmailReader;
};
const observed=require('../src/case-list-assignment-observation.cjs') as {sourcePay(row:Data,dailyWage?:number):unknown[];dependency(expected:unknown,actual:unknown):void};
const sent=require('../src/case-list-gas-sent-readback.cjs') as {
 groupDigest(group:Data):string;
 verifySentMetadata(message:Data,group:Data,receipt:Data,scope:Data):void;
 verifySentMessage(message:Data,group:Data,receipt:Data,scope:Data):Data;
};
const METADATA_FIELDS='id,labelIds,internalDate,payload(headers(name,value))';
const BODY_FIELDS='id,labelIds,internalDate,payload(mimeType,filename,headers(name,value),parts(mimeType),body(data,attachmentId))';
function need(x:unknown,code:string):asserts x{if(!x)throw Object.assign(Error(code),{code});}
const writable=(c:Data)=>Object.fromEntries(['userEnteredValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'].filter(k=>Object.hasOwn(c??{},k)).map(k=>[k,c[k]]));
const value=(c:Data|undefined):any=>{const x=c?.effectiveValue??c?.userEnteredValue??{};return x.stringValue??x.numberValue??x.boolValue??'';};
export function createGasReadPorts(p:ReadPorts){
 async function assertSource(actor:Actor,caseId:string,expected:Data){
  const snapshot=await p.readMonthly(actor.companyId,caseId),rows=snapshot.source?.rows?.filter((r:Data)=>r.caseId===caseId);
  need(snapshot.isolated===false&&rows?.length===1&&rows[0].fullWritable===true&&rows[0].cells?.length===65,'SOURCE_READBACK_INCOMPLETE');
  const cells=rows[0].cells;need(value(cells[60])===caseId&&value(cells[0])===false&&value(cells[63])===false,'SOURCE_CANCELLED_OR_ID_CHANGED');
  observed.sourcePay(rows[0]);observed.dependency(expected?.dependencyHash,snapshot.dependencyHash);
  need(snapshot.catalog?.sourceRevision===(expected?.sourceRevision??expected?.expectedSourceRevision),'SOURCE_OBSERVED_REVISION_CHANGED');
  if(Array.isArray(expected?.sourceSnapshot))need(p.hash(cells.map(writable))===p.hash(expected.sourceSnapshot),'SOURCE_PREIMAGE_CHANGED');
  else need(expected&&snapshot.catalog?.sourceRevision===expected.expectedSourceRevision&&p.hash(cells.map(writable))===expected.sourceWritableHash&&p.hash(cells.map((c:Data)=>({userEnteredValue:c.userEnteredValue??{},effectiveValue:c.effectiveValue??{}})))===expected.observedValuesHash,'SOURCE_PREIMAGE_CHANGED');
  return snapshot;
 }
 async function observeMail(item:Data,r:Data,actor:Actor){
  const policy=p.sentPolicy;need(policy?.enabled===true&&policy.companyId===actor.companyId&&policy.ownerUid===actor.uid&&policy.mailbox===actor.email,'SENT_READ_POLICY_REQUIRED');
  const config=await p.readMailConfig(actor.companyId);need(config.companyId===actor.companyId&&config.mailbox===policy.mailbox&&config.principalRevision===policy.principalRevision,'SENT_READ_PRINCIPAL_CHANGED');
  const group=r.groups?.find((g:Data)=>g.cases.some((c:Data)=>c.id===item.caseId)),receipt=item.receipt??item.sent;
  need(group&&receipt&&receipt.digest===r.prepared.cases.find((c:Data)=>c.id===item.caseId)?.nameUpDigest,'SENT_RECEIPT_REQUIRED');
  need(/^[a-z0-9_-]{1,160}$/i.test(receipt.messageId??'')&&receipt.digest===sent.groupDigest(group),'SENT_RECEIPT_REQUIRED');
  const readScope={operationKey:r.key,caseId:item.caseId,messageId:receipt.messageId,digest:receipt.digest};
  await p.assertMailAccess(config,actor,readScope);
  // Reuse the existing keyless gmail.readonly delegation. An identity token is never used here.
  let token:Promise<string>|undefined;
  try{
   const auth=p.createMailAuth(config.gmailServiceAccountEmail,()=>{throw Error('EXTRACTOR_NOT_USED');});
   const client=p.createGmailReader(()=>token??=(async()=>auth.obtainGmailAccessToken({...config,scope:'https://www.googleapis.com/auth/gmail.readonly'}))());
   const profile=await client.get('profile',{fields:'emailAddress'});need(typeof profile.emailAddress==='string'&&profile.emailAddress.toLowerCase()===policy.mailbox,'SENT_MAILBOX_CHANGED');
   const path='messages/'+receipt.messageId,scope=()=>({mailbox:policy.mailbox,firstPreparedAt:r.firstPreparedAt,now:p.now()});
   const metadata=await client.get(path,{format:'metadata',fields:METADATA_FIELDS});
   sent.verifySentMetadata(metadata,group,receipt,scope());
   const current=await p.readMailConfig(actor.companyId);need(p.hash(current)===p.hash(config),'SENT_READ_PRINCIPAL_CHANGED');await p.assertMailAccess(current,actor,readScope);
   const message=await client.get(path,{format:'full',fields:BODY_FIELDS});const out=sent.verifySentMessage(message,group,receipt,scope());
   const again=await p.readMailConfig(actor.companyId);need(p.hash(again)===p.hash(config),'SENT_READ_PRINCIPAL_CHANGED');await p.assertMailAccess(again,actor,readScope);return out;
  }catch{throw Object.assign(Error('SENT_READBACK_UNAVAILABLE'),{code:'SENT_READBACK_UNAVAILABLE'});}finally{token=undefined;}
 }
 return Object.freeze({assertSource,observeMail});
}
