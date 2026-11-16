import {db} from './firebase';
import {withFirebaseOwnerCallable,firebaseOwnerPolicy} from './case-list-firebase-owner';
import {createReadOnlySheetsClient} from './sheet-reader';
type Data=Record<string,any>;
// Server configuration only. No inferred storage location or request-supplied scope.
export async function createStaffNgDependencies():Promise<Data>{
 const policy=firebaseOwnerPolicy();
 if(policy.projectId!=='lip-knots-crew-staging'||policy.actualProjectId!==policy.projectId||Reflect.get(db,'projectId')!==policy.projectId||!policy.companyId||!policy.ownerUid)throw Error('NG_SERVER_STAGING_SCOPE_REQUIRED');
 const journalPath=process.env.LKC_NG_JOURNAL_DOCUMENT;
 if(typeof journalPath!=='string'||journalPath.length>512||!/^([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)(\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)*$/.test(journalPath)||['staffProfiles','staffImportConfigs','staffImportRuns','syncLocks','jobs','sheetSyncQueue','staffNgMaintenance'].includes((journalPath.split('/')[0]??'')))throw Error('NG_EXPLICIT_EXISTING_PRIVATE_JOURNAL_REQUIRED');
 return {db,scope:{projectId:policy.projectId,companyId:policy.companyId,ownerUid:policy.ownerUid,maxProfiles:500,maxJobs:500},journalRef:db.doc(journalPath),now:()=>Date.now(),withOwner:(request:Data,session:Data,operation:any)=>withFirebaseOwnerCallable(request,session as any,operation),getSheets:createReadOnlySheetsClient};
}

