'use strict';
const {createCrewWiring}=require('./crew-wiring.cjs');
const {createRuntime}=require('./runtime.cjs');
const {createComparator}=require('./planner.cjs');
const {createFirestorePort}=require('./firestore-port.cjs');
const {firestoreStore}=require('./store.cjs');
const {need}=require('./timestamp.cjs');
// Called server-side only, with existing initialized dependencies and explicit
// journal reference. Does not choose/create storage, register an action, initialize
// a client, construct credentials or start any read/write at module import.
function composeRuntime(options){
  const {db,journalRef,scope,crew,Timestamp,FieldValue,modelPins}=options;
  need(journalRef?.firestore===db&&typeof journalRef.path==='string'&&journalRef.path.split('/').length%2===0,'EXPLICIT_EXISTING_JOURNAL_REFERENCE_REQUIRED');
  need(!['staffProfiles','staffImportConfigs','staffImportRuns','syncLocks','jobs','sheetSyncQueue'].includes(journalRef.path.split('/')[0]),'BUSINESS_OR_EPHEMERAL_JOURNAL_LOCATION_FORBIDDEN');
  need(typeof scope?.projectId==='string'&&db?.projectId===scope.projectId,'DATABASE_PROJECT_SCOPE_MISMATCH');
  const wiring=createCrewWiring(options);
  return composeAuthorizedCore({...options,wiring});
}
// Same inner composition used after the protected owner boundary. Local demo
// fixtures supply synthetic authentication, never an optimistic maintenance gate.
function composeAuthorizedCore(options){
  const {db,journalRef,scope,crew,Timestamp,FieldValue,modelPins,wiring}=options;
  need(journalRef?.firestore===db&&typeof journalRef.path==='string'&&journalRef.path.split('/').length%2===0,'EXPLICIT_EXISTING_JOURNAL_REFERENCE_REQUIRED');
  need(!['staffProfiles','staffImportConfigs','staffImportRuns','syncLocks','jobs','sheetSyncQueue','staffNgMaintenance'].includes(journalRef.path.split('/')[0]),'BUSINESS_OR_EPHEMERAL_JOURNAL_LOCATION_FORBIDDEN');
  need(db.projectId===scope.projectId&&journalRef?.firestore===db,'DATABASE_PROJECT_SCOPE_MISMATCH');
  const binding={operationId:scope.maintenanceOperationId,generation:scope.maintenanceGeneration,ownerUid:scope.ownerUid,staffIds:scope.staffIds};
  return createRuntime({
    ...wiring,clock:options.now,
    maintenanceBinding:binding,
    planner:createComparator({ng:crew.ng,identity:crew.identity,modelPins,scope:{companyId:scope.companyId,spreadsheetId:scope.spreadsheetId}}),
    profiles:createFirestorePort({db,Timestamp,FieldValue,companyId:scope.companyId,staffIds:scope.staffIds,maintenance:{readWriteFence:async()=>{const fence=await crew.maintenance.readPausedWriteFence(scope.companyId,binding);if(options.beforeCommit)await options.beforeCommit();return fence;}}}),
    store:firestoreStore(db,journalRef,{beforeWrite:options.beforeCommit}),
  });
}
module.exports={composeRuntime,composeAuthorizedCore};
