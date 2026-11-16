/** Concrete lazy composition using the existing repository access paths. Not exported from Functions index. */
import { db } from './firebase';
import { createGasIdentityRuntimePorts,gasHandoffSettings } from './case-list-gas-handoff';
import { readCaseListMonthlySnapshot } from './case-list-monthly-reader';
import { hashCaseList } from './case-list-source-core';
import { getProductionOperationalState } from './system-safety';
import { createCrewSyncPorts } from './case-list-gas-crew-ports';
import { createApprovedSentAccess } from './case-list-approved-sent-access';
import { createGasOwnerAuthContext } from './case-list-owner-context';
import { createOwnerReviewService } from './case-list-owner-review-runtime';
import type { ReadPorts,SentReadPolicy } from './case-list-gas-read-ports';
type Data=Record<string,any>;
// CJS sources remain in src in the existing Functions package; tsc emits TS to lib.
const {createRpcService}=require('../src/case-list-gas-sync-rpc-core.cjs');
const {createSyncRpcHandler}=require('../src/case-list-gas-sync-rpc-http.cjs');
const {createAsyncJournal}=require('../src/case-list-gas-async-journal.cjs');
const {createFirestoreTransactionTransport,JOURNAL_NAMESPACE,POLICY_NAMESPACE}=require('../src/case-list-gas-journal-firestore.cjs');
const {withFreshPrincipal}=require('../src/case-list-gas-handoff-core.cjs');
const {groupDigest}=require('../src/case-list-gas-sent-readback.cjs');
function need(x:unknown,c:string):asserts x{if(!x)throw Object.assign(Error(c),{code:c});}
export type RuntimePolicy={enabled:boolean;sentReadPolicy?:SentReadPolicy;pilotCaseId?:string};
export function createSyncRuntimeHandler(policy:RuntimePolicy,overrides?:Data){
 // Missing enablement/identity/resource settings cannot acquire credentials or open a writer.
 return async(req:Data,res:Data)=>{
  try{
  if(policy.enabled!==true){res.status(503).json({status:'HOLD',code:'SYNC_RUNTIME_DISABLED',businessEnabled:false});return;}
  const config=overrides?.config??gasHandoffSettings(),identity=overrides?.identity??createGasIdentityRuntimePorts(),authorization=req.headers?.authorization;
  const now=overrides?.now??(()=>Date.now()),database=overrides?.db??db,baseAuth={...identity,config,now};
  need(!['FORMAL_PREVIEW','FORMAL_CONFIRM'].includes(req.body?.action),'FIREBASE_OWNER_REVIEW_REQUIRED');
  const auth=req.body?.action==='READINESS_ONLY'&&!req.body?.payload?.ownerApprovalRef?baseAuth:createGasOwnerAuthContext(baseAuth,req.body,{db:database,now});
  // Validate real issuer/audience/provider/role conditions before constructing any resource reader.
  const currentActor:Data=await withFreshPrincipal(auth,authorization,async(actor:Data)=>actor);
  // Known missing/wrong reader policy stops before BEGIN/formal work. Auth-only
  // readiness and read-only observation of existing evidence need no SENT permit.
  const needsReadPolicy=!['READINESS_ONLY','OBSERVE'].includes(req.body?.action);
  if(needsReadPolicy){
    const readPolicy=policy.sentReadPolicy;
    need(readPolicy?.enabled===true&&readPolicy.companyId===currentActor.companyId&&
      readPolicy.ownerUid===currentActor.uid&&readPolicy.mailbox===currentActor.email&&
      typeof readPolicy.principalRevision==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(readPolicy.principalRevision),
      'SENT_READ_POLICY_REQUIRED');
  }
  const transport=createFirestoreTransactionTransport({isolatedProposal:true,runTransaction:(fn:any,options?:Data)=>database.runTransaction(fn,options),journalRef:(id:string)=>database.collection(JOURNAL_NAMESPACE).doc(id),policyRef:(id:string)=>database.collection(POLICY_NAMESPACE).doc(id),now});
  const journal=createAsyncJournal({transport,getCurrentActor:()=>withFreshPrincipal(auth,authorization,async(actor:Data)=>({uid:actor.uid,companyId:actor.companyId}))});
  const operational=overrides?.operational??(async(companyId:string)=>(await getProductionOperationalState(companyId)).operational);
  const {formal}=createOwnerReviewService(auth,{db:database,store:overrides?.formalStore,now,operational});
  const access=createApprovedSentAccess({db:database,now,operational});
  async function currentMailActor(actor:Data){return withFreshPrincipal(auth,authorization,async(fresh:Data)=>{need(fresh.uid===actor.uid&&fresh.companyId===actor.companyId,'SENT_OWNER_CHANGED');return fresh;});}
  const reads:ReadPorts=overrides?.reads??{
   now,hash:hashCaseList,readMonthly:(companyId,caseId)=>readCaseListMonthlySnapshot(companyId,caseId,{includeDependencies:true}),sentPolicy:policy.sentReadPolicy,
   readMailConfig:async companyId=>{const data=(await database.collection('caseMailReceiverConfigs').doc(companyId).get()).data();need(data&&data.companyId===companyId,'SENT_READ_CONFIG_REQUIRED');return data as any;},
   assertMailReaderReady:async(config,actor)=>access.assertReaderReady(config,await currentMailActor(actor)),
   assertMailAccess:async(config,actor,scope)=>access.assertMessageAccess(config,await currentMailActor(actor),scope),
   createMailAuth:(serviceAccountEmail,unused)=>{const {createCaseMailCloudAuth}=require('./case-mail-cloud-auth');return createCaseMailCloudAuth(serviceAccountEmail,unused);},
   createGmailReader:getAccessToken=>{const {GmailReadClient}=require('../case-mail-runtime/read-mail.cjs');return new GmailReadClient({obtainAccessToken:getAccessToken});}
  };
  if(needsReadPolicy){
   const purpose=policy.sentReadPolicy!,reader=await reads.readMailConfig(currentActor.companyId);
   need(reader.companyId===currentActor.companyId&&reader.mailbox===purpose.mailbox&&
     reader.principalRevision===purpose.principalRevision,'SENT_READ_PRINCIPAL_CHANGED');
   need(typeof reads.assertMailReaderReady==='function','SENT_READER_READY_PORT_REQUIRED');
   await reads.assertMailReaderReady(reader,currentActor as any);
  }
  const crew=createCrewSyncPorts({auth,authorization,reads,readFormal:formal.readFormal,now});
  const book=(overrides?.book??(await database.collection('sheetImportConfigs').doc(config.companyId).get()).data()?.spreadsheetId);need(typeof book==='string'&&book,'SOURCE_BOOK_REQUIRED');
  const service=createRpcService({isolatedProposal:true,requireOwnerAuthorization:true,auth,journal,book,now,operational,groupDigest,formal,...crew,pilotCaseId:policy.pilotCaseId});
  return createSyncRpcHandler(service)(req,res);
  }catch(error){const e=error as Data,code=/^[A-Z][A-Z0-9_]{1,100}$/.test(e.code??'')?e.code:'SYNC_RUNTIME_HOLD';res.status([400,401,403,409,503].includes(e.status)?e.status:503).json({status:'HOLD',code,businessEnabled:false});}
 };
}
