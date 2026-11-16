'use strict';
const {createCrewReadInput}=require('./crew-source-input.cjs');
const {createCrewAuthorize}=require('./crew-authorization.cjs');
const {hash,sourceVersion}=require('./planner.cjs');
const {need,pack,equal}=require('./timestamp.cjs');
const MASTER='マスターデータ';
const copy=x=>JSON.parse(JSON.stringify(x));
/** Server-only composition inside an existing authenticated callable. No endpoint,
 * Firebase app, client, storage location or permission is created here. `crew` is
 * the existing Crew modules named below; request.auth is supplied by onCall.
 * Tests load their actual pinned source with synthetic service dependencies. */
function createCrewWiring({request,scope,ownerPolicy,identityPorts,crew,db,sheets,now}){
  need(scope?.projectId==='lip-knots-crew-staging'&&scope.companyId&&scope.ownerUid&&scope.spreadsheetId&&Array.isArray(scope.staffIds)&&scope.staffIds.length>0&&new Set(scope.staffIds).size===scope.staffIds.length,'EXPLICIT_SERVER_SCOPE_REQUIRED');
  need(Number.isSafeInteger(scope.maxProfiles)&&scope.maxProfiles>0&&Number.isSafeInteger(scope.maxJobs)&&scope.maxJobs>0,'EXPLICIT_READ_BOUNDS_REQUIRED');
  need(ownerPolicy?.projectId===scope.projectId&&ownerPolicy.actualProjectId===scope.projectId&&ownerPolicy.companyId===scope.companyId&&ownerPolicy.ownerUid===scope.ownerUid,'OWNER_POLICY_SCOPE_MISMATCH');
  need(identityPorts&&typeof now==='function'&&db&&sheets,'EXPLICIT_EXISTING_DEPENDENCIES_REQUIRED');
  need(db.projectId===scope.projectId,'DATABASE_PROJECT_SCOPE_MISMATCH');
  const {requireAdmin,companyFromClaims}=crew.utils;
  const session=requireAdmin(request);
  need(companyFromClaims(session.token)===scope.companyId&&session.uid===scope.ownerUid,'CALLABLE_OWNER_COMPANY_MISMATCH');
  crew.sourceCore.assertExecutive(session.token,ownerPolicy.executiveEmails.join(','));
  async function owner(fn){return crew.firebaseOwner.withFirebaseOwnerCallable(request,session,fn,ownerPolicy,identityPorts);}
  return createVerifiedCrewWiring({scope,crew,db,sheets,now,owner});
}
function createVerifiedCrewWiring({scope,crew,db,sheets,now,owner}){need(typeof owner==='function'&&db.projectId===scope.projectId,'VERIFIED_OWNER_AND_DATABASE_SCOPE_REQUIRED');
  const readInput=createCrewReadInput({scope,crew,db,sheets,now,owner});
  const authorize=createCrewAuthorize({scope,owner,now});
  async function checkEnvironment(){
    return owner(async(actor,beforeReturn)=>{
      const result=await crew.maintenance.readPausedEnvironment(scope.companyId,{operationId:scope.maintenanceOperationId,generation:scope.maintenanceGeneration,ownerUid:actor.uid,staffIds:scope.staffIds});
      await beforeReturn();return result;
    });
  }
  return {authorize,readInput,checkEnvironment};
}
module.exports={createCrewWiring,createVerifiedCrewWiring};
