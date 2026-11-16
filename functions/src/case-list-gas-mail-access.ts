import { db } from './firebase';
import { hashText } from './case-id';
import { getProductionOperationalState } from './system-safety';
import type { ExistingMailConfig } from './case-list-gas-read-ports';

type Actor={uid:string;companyId:string;email:string};
function need(x:unknown,code:string):asserts x{if(!x)throw Object.assign(Error(code),{code});}
/** Narrow readonly composition of the existing receiver principal/feature checks.
 * No intake parser/writer is loaded, no flag is enabled, and no new principal is created.
 */
export async function assertExistingMailReadAccess(config:ExistingMailConfig,actor:Actor):Promise<void>{
  need(config.companyId===actor.companyId&&config.mailbox===actor.email,'SENT_READER_COMPANY_OR_MAILBOX_CHANGED');
  need((await getProductionOperationalState(config.companyId)).operational===true,'GLOBAL_STOPPED');
  const principalKey=hashText(JSON.stringify([config.companyId,config.uid]),64);
  await db.runTransaction(async tx=>{
    const [principal,feature]=await Promise.all([
      tx.get(db.collection('automationIngestPrincipals').doc(principalKey)),
      tx.get(db.collection('companyFeatureSettings').doc(config.companyId)),
    ]);
    const current=principal.data();
    need(current&&current.companyId===config.companyId&&current.uid===config.uid&&current.active===true&&
      current.producerId===config.producerId&&current.revision===config.principalRevision,'SENT_READER_PRINCIPAL_CHANGED');
    need(feature.data()?.caseMailIntakeEnabled===true,'SENT_EXISTING_READ_FEATURE_DISABLED');
  },{readOnly:true});
}
