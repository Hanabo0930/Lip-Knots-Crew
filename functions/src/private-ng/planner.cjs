'use strict';
// Isolated reviewed-input planner derived from pinned synthetic comparator.
// Explicit source scope replaces fixture-only identifiers; does not confer execution authority.
const {createHash}=require('node:crypto');
const SCHEMA='LKC_REVIEWED_NG_ONLY_PROPOSAL_V1',MASTER='マスターデータ';
const NG_KEYS=['schema','companyId','staffId','authority','state','keywords','sourceHash','revision'];
function need(value,code){if(!value)throw Object.assign(Error(code),{code});}
function canonical(value){
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'){need(Number.isFinite(value),'INVALID_SNAPSHOT_NUMBER');return JSON.stringify(value);}
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  need(value&&Object.prototype.toString.call(value)==='[object Object]'&&(Object.getPrototypeOf(value)===null||Object.getPrototypeOf(Object.getPrototypeOf(value))===null),'INVALID_SNAPSHOT_VALUE');
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const clone=value=>JSON.parse(canonical(value));
const withoutNg=data=>Object.fromEntries(Object.entries(data).filter(([key])=>key!=='ngCompanies'));
function sourceProjection(source,config){
  return {config,spreadsheetId:source.spreadsheetId,sheetName:source.sheetName,headerRow:source.headerRow,
    header:source.header,readEndIndex:source.readEndIndex,configVersion:source.configVersion,
    complete:source.complete,identityIndexComplete:source.identityIndexComplete,
    identityRows:source.identityRows,ngCells:source.ngCells};
}
function sourceVersion(source,config){return hash(sourceProjection(source,config));}
function createComparator({ng,identity,modelPins,scope}){
  need(scope && typeof scope.companyId==='string' && scope.companyId.length>0 && typeof scope.spreadsheetId==='string' && scope.spreadsheetId.length>0,'EXPLICIT_SOURCE_SCOPE_REQUIRED');
  need(ng&&identity&&modelPins,'PURE_MODELS_REQUIRED');
  function propose(input){
    try{
      need(input?.mode==='NG_ONLY_REVIEW_INPUT_V1'&&input.companyId===scope.companyId,'EXACT_COMPANY_SCOPE_REQUIRED');
      const {companyId,targetStaffId,current,config,source}=input;
      need(current?.exists===true&&current.id===targetStaffId&&current.data,'EXISTING_TARGET_REQUIRED');
      const data=current.data;
      for(const v of [config?.configVersion,source?.configVersion,data.sync?.configVersion]) need(typeof v==='string'&&v.trim().length>0,'CONFIG_VERSION_REQUIRED');
      need(data.companyId===companyId&&config?.companyId===companyId,'COMPANY_MISMATCH');
      need(typeof current.updateTime==='string'&&Number.isFinite(Date.parse(current.updateTime)),'DOCUMENT_VERSION_REQUIRED');
      need(data.active===true&&data.sourceMissing!==true,'EXISTING_STAFF_NOT_ACTIVE');
      need(typeof data.displayName==='string'&&identity.normalizeStaffName(data.displayName).length>0,'SYNTHETIC_IDENTITY_ONLY');
      const name=identity.normalizeStaffName(data.displayName);
      need(data.normalizedName===name&&identity.createStaffId(companyId,data.displayName)===targetStaffId,'EXISTING_ID_BINDING_MISMATCH');
      need(config.enabled===true,'EXISTING_IMPORT_STOPPED');
      need(config.spreadsheetId===scope.spreadsheetId&&source?.spreadsheetId===config.spreadsheetId,'SOURCE_BOOK_MISMATCH');
      need(config.activeSheets?.includes(MASTER)&&!config.excludedSheets?.includes(MASTER)&&source.sheetName===MASTER,'SOURCE_EXCLUDED');
      need(Number.isSafeInteger(source.headerRow)&&source.headerRow>0,'SOURCE_HEADER_ROW_INVALID');
      need(source.complete===true&&source.identityIndexComplete===true&&input.peerCoverageComplete===true,'IDENTITY_COVERAGE_UNKNOWN');
      need(source.configVersion===config.configVersion&&data.sync?.configVersion===config.configVersion,'CONFIG_VERSION_CHANGED');
      need(Array.isArray(data.sourceRefs)&&data.sourceRefs.some(r=>r.spreadsheetId===source.spreadsheetId&&r.sheetName===MASTER&&r.headerRow===source.headerRow),'EXISTING_MASTER_BINDING_REQUIRED');
      need(Array.isArray(input.identityPeers)&&input.identityPeers.every(p=>p.companyId===companyId),'PEER_COMPANY_MISMATCH');
      const peers=input.identityPeers.filter(p=>p.normalizedName===name);
      need(peers.length===1&&peers[0].id===targetStaffId,'EXISTING_NAME_COLLISION');
      need(Array.isArray(source.identityRows)&&source.identityRows.every(r=>typeof r.displayName==='string'&&identity.normalizeStaffName(r.displayName).length>0),'SYNTHETIC_SOURCE_ONLY');
      const matches=source.identityRows.filter(r=>identity.normalizeStaffName(r.displayName)===name);
      need(matches.length===1,'SOURCE_NAME_COLLISION_OR_MISSING');
      const row=matches[0];
      need(Number.isSafeInteger(row.row)&&row.row>source.headerRow&&row.manualInactive===false,'SOURCE_STAFF_EXCLUDED_OR_UNKNOWN');
      need(identity.createStaffId(companyId,row.displayName)===targetStaffId,'SOURCE_ID_CHANGED');
      const cells=source.ngCells?.filter(c=>c.row===row.row);
      need(cells?.length===1&&cells[0].observed===true&&Object.hasOwn(cells[0],'value'),'NG_NOT_OBSERVED');
      const cell=cells[0];
      need((cell.kind==='BLANK'&&cell.value==='')||(cell.kind==='TEXT'&&typeof cell.value==='string'&&cell.value.length>0),'NG_OBSERVATION_INVALID');
      need(Array.isArray(source.header)&&Number.isSafeInteger(source.readEndIndex)&&source.readEndIndex>=10,'NG_RANGE_UNKNOWN');
      const raw=Array(11).fill('');raw[10]=cell.value;
      const observation=ng.observeStaffNgCell(MASTER,source.header,raw,source.readEndIndex);
      need(observation.state==='OBSERVED','NG_HEADER_OR_CELL_UNVERIFIED');
      const value=clone(ng.mergeStaffNg([{sourceRef:{spreadsheetId:source.spreadsheetId,sheetName:MASTER},ngCompanyObservation:observation}],companyId,targetStaffId));
      ng.staffNgRevision({...data,ngCompanies:value},companyId,targetStaffId);
      const version=sourceVersion(source,config);
      need(source.version===version&&source.recheckVersion===version,'SOURCE_VERSION_CHANGED');
      need(Number.isFinite(Date.parse(source.observedAt))&&Number.isFinite(Date.parse(source.recheckedAt))&&Date.parse(source.recheckedAt)>=Date.parse(source.observedAt),'SOURCE_OBSERVATION_TIME_INVALID');
      const priorPresent=Object.hasOwn(data,'ngCompanies'),prior=priorPresent?data.ngCompanies:null;
      if(priorPresent){
        need(prior&&typeof prior==='object'&&Object.keys(prior).every(k=>NG_KEYS.includes(k)),'UNREVIEWED_EXISTING_NG_FIELDS');
        need(prior.companyId===companyId&&prior.staffId===targetStaffId,'EXISTING_NG_IDENTITY_MISMATCH');
        try{ng.staffNgRevision(data,companyId,targetStaffId);}catch{need(false,'EXISTING_NG_REVIEW_REQUIRED');}
      }
      const changed=hash(prior)!==hash(value),after={...clone(data),ngCompanies:value};
      need(hash(withoutNg(data))===hash(withoutNg(after)),'NON_NG_DIFF_FORBIDDEN');
      const impacts=[];
      for(const job of input.jobs??[]){
        need(job.companyId===companyId,'JOB_COMPANY_MISMATCH');
        if(job.assignedStaffId!==targetStaffId)continue;
        if(job.cancelled===true||job.status==='cancelled'){impacts.push({jobId:job.id,reason:'CANCELLED_JOB_UNCHANGED'});continue;}
        if(changed&&job.applicationUnconfirmed===true&&job.staffApplicationCheck?.ngRevision)impacts.push({jobId:job.id,reason:'PENDING_APPLICATION_RECHECK_REQUIRED_NO_REPLAY'});
        try{ng.checkStaffNg(after,job,companyId,targetStaffId);}catch(e){impacts.push({jobId:job.id,reason:e.code==='STAFF_NG_MATCH'?'EXISTING_JOB_NG_CONFLICT_REVIEW_NO_CANCEL':'JOB_TARGET_UNVERIFIED_NO_ACTION'});}
      }
      const plan={schema:SCHEMA,status:changed?'PROPOSAL':'NOOP',target:{collection:'staffProfiles',id:targetStaffId,companyId},
        changes:changed?[{field:'ngCompanies',value}]:[],
        preconditions:{documentExists:true,updateTime:current.updateTime,documentHash:hash(data),sourceVersion:version,
          configHash:hash(config),identityHash:hash({targetStaffId,name,sourceBook:source.spreadsheetId,sourceRow:row.row}),modelPins:clone(modelPins)},
        observations:{kind:cell.kind,observedAt:source.observedAt,recheckedAt:source.recheckedAt,
          sourceVersionKind:'CONTENT_DIGEST_NOT_GOOGLE_REVISION',ageExpiryPolicy:'NOT_IMPLEMENTED_OR_CHOSEN',
          rowHintMoved:!data.sourceRefs.some(r=>r.spreadsheetId===source.spreadsheetId&&r.sheetName===MASTER&&r.row===row.row)},
        preservation:{nonNgHashBefore:hash(withoutNg(data)),nonNgHashAfter:hash(withoutNg(after)),
          genericSyncTimestampChanged:false,createsOrDeletesStaff:false,emailIndexOrAuthOrActiveChanged:false},
        review:{removesAllExistingRestrictions:!!prior?.keywords?.length&&value.keywords.length===0,impacts},
        rollback:{priorNgPresent:priorPresent,priorNg:clone(prior),expectedAppliedNgHash:hash(value),
          instruction:'STOP_NEW_APPLICATIONS_FIRST; RESTORE_ONLY_PRIOR_NG_IF_EXPECTED_CURRENT_FIELD_AND_DOCUMENT_VERSION_STILL_MATCH; OTHERWISE_HOLD'},
        liveWriteReady:false,authority:'EXACT_SOURCE_SCOPE; EXTERNAL_OWNER_AUTHORIZATION_STILL_REQUIRED'};
      return {...plan,planHash:hash(plan)};
    }catch(e){return {schema:SCHEMA,status:'HOLD',reason:e.code??'INVALID_SNAPSHOT',changes:[],liveWriteReady:false};}
  }
  function verify(plan,input){
    try{
      need(plan?.schema===SCHEMA&&['PROPOSAL','NOOP'].includes(plan.status),'NO_PROPOSAL');
      const {planHash,...body}=plan;need(hash(body)===planHash,'PROPOSAL_TAMPERED');
      need(plan.changes.every(c=>c.field==='ngCompanies')&&plan.changes.length<=1,'NON_NG_DIFF_FORBIDDEN');
      const fresh=propose(input);need(['PROPOSAL','NOOP'].includes(fresh.status),'FRESH_SNAPSHOT_HELD');
      need(fresh.planHash===planHash,'SNAPSHOT_OR_DIFF_CHANGED');
      return {matches:true,liveWriteReady:false,reason:'EXACT_SNAPSHOT_REVALIDATED_NO_WRITE_AUTHORITY'};
    }catch(e){return {matches:false,liveWriteReady:false,reason:e.code??'INVALID_SNAPSHOT'};}
  }
  return {propose,verify};
}
module.exports={createComparator,sourceVersion,hash};
