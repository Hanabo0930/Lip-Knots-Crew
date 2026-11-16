'use strict';
const {hash,sourceVersion}=require('./planner.cjs');const {need,pack,equal}=require('./timestamp.cjs');const MASTER='マスターデータ';
function createCrewReadInput({scope,crew,db,sheets,now,owner}){need(db.projectId===scope.projectId,'DATABASE_PROJECT_SCOPE_MISMATCH');
  const configRef=db.collection('staffImportConfigs').doc(scope.companyId);
  function validateConfig(c){
    need(c?.companyId===scope.companyId&&c.spreadsheetId===scope.spreadsheetId,'SOURCE_CONFIG_SCOPE_MISMATCH');
    need(c.enabled===true&&typeof c.configVersion==='string'&&c.configVersion.trim().length>0,'SOURCE_CONFIG_NOT_ENABLED_OR_VERSIONED');
    need(Array.isArray(c.activeSheets)&&c.activeSheets.length>0&&new Set(c.activeSheets).size===c.activeSheets.length&&Array.isArray(c.excludedSheets),'SOURCE_CONFIG_SELECTION_UNKNOWN');
    need(c.columns?.ngCompanies==='K'&&typeof c.columns.displayName==='string'&&typeof c.columns.email==='string'&&c.sheetAreas&&Number.isSafeInteger(c.headerRow)&&c.headerRow>0&&Number.isSafeInteger(c.dataStartRow)&&c.dataStartRow>c.headerRow,'SOURCE_COLUMN_OR_HEADER_UNKNOWN');
    need(Number.isSafeInteger(c.maxRowsPerSheet)&&c.maxRowsPerSheet>0&&Number.isSafeInteger(c.maxSheetsPerRun)&&c.maxSheetsPerRun>0&&typeof c.readRangeEndColumn==='string'&&crew.parser.columnLetterToIndex(c.readRangeEndColumn)>=10,'SOURCE_RANGE_UNKNOWN');
    const selected=c.activeSheets.filter(n=>!c.excludedSheets.includes(n));
    // This is a HOLD, not an instruction to remove regional tabs/configuration.
    // Existing model has no regional-authority reconciliation contract to invoke.
    need(selected.length===1&&selected[0]===MASTER,'REGIONAL_MASTER_RELATIONSHIP_NOT_ESTABLISHED');
  }
  async function readConfig(){
    const snap=await configRef.get();need(snap.exists,'SOURCE_CONFIG_MISSING');const raw=snap.data();
    // Use the existing importer schema, but do not manufacture missing operational
    // facts through its defaults. Unknown fields are stripped by that same schema.
    need(['companyId','enabled','scheduleEnabled','spreadsheetId','activeSheets','excludedSheets','configVersion','columns','sheetAreas','headerRow','dataStartRow','maxRowsPerSheet','maxSheetsPerRun','readRangeEndColumn','markMissingInactive','revokeRemovedEmailSessions'].every(k=>Object.hasOwn(raw,k)),'EXPLICIT_CONFIG_FIELDS_REQUIRED');
    need(Object.hasOwn(raw.columns??{},'ngCompanies'),'EXPLICIT_NG_COLUMN_REQUIRED');
    const parsed=crew.staffConfig.ConfigSchema.safeParse(raw);need(parsed.success,'EXISTING_IMPORT_CONFIG_SCHEMA_REJECTED');
    const config=parsed.data;validateConfig(config);return {config,version:pack(snap.updateTime)};
  }
  async function query(collection,filters,fields,bound){
    let q=db.collection(collection);for(const [key,value]of filters)q=q.where(key,'==',value);
    const snap=await q.select(...fields).limit(bound+1).get();need(snap.docs.length<=bound,'COMPLETE_'+collection.toUpperCase()+'_COVERAGE_NOT_ESTABLISHED');
    return snap.docs.map(doc=>({id:doc.id,...doc.data()}));
  }
  async function sourcePass(config){
    const descriptors=await crew.reader.listSpreadsheetSheets(sheets,scope.spreadsheetId);
    const targets=crew.reader.selectNamedSheets(descriptors,config.activeSheets,config.excludedSheets,undefined,config.maxSheetsPerRun);
    need(targets.length===1&&targets[0].title===MASTER&&targets[0].rowCount>0&&Number.isSafeInteger(targets[0].rowCount)&&targets[0].rowCount<=config.maxRowsPerSheet,'SOURCE_COMPLETE_SELECTION_REQUIRED');
    const values=await crew.reader.readNamedSheet(sheets,scope.spreadsheetId,targets[0],config.readRangeEndColumn,config.maxRowsPerSheet);
    need(Array.isArray(values)&&values.length<=targets[0].rowCount,'SOURCE_ROWS_OUTSIDE_OBSERVATION');
    const parsed=crew.parser.parseStaffSheet(scope.spreadsheetId,MASTER,values,config);
    const merged=crew.parser.mergeStaffRows(parsed.rows); // same identity/NG aggregation as importer
    return {parsed,merged,header:values[parsed.summary.headerRow-1]??[],values};
  }
  async function readInput(id){
    need(scope.staffIds.includes(id),'STAFF_OUTSIDE_FIXED_SCOPE');
    return owner(async(actor,beforeReturn)=>{
      const first=await readConfig(),observedAt=new Date(now()).toISOString(),a=await sourcePass(first.config);
      const peers=await query('staffProfiles',[['companyId',scope.companyId]],['companyId','normalizedName'],scope.maxProfiles);
      need(peers.every(p=>p.companyId===scope.companyId&&typeof p.normalizedName==='string'),'PROFILE_IDENTITY_PROJECTION_INCOMPLETE');
      const jobs=await query('jobs',[['companyId',scope.companyId],['assignedStaffId',id]],['companyId','assignedStaffId','status','cancelled','applicationUnconfirmed','staffApplicationCheck.ngRevision','clientName','storeName','makerName'],scope.maxJobs);
      need(jobs.every(j=>j.companyId===scope.companyId&&j.assignedStaffId===id),'JOB_SCOPE_MISMATCH');
      const second=await readConfig(),b=await sourcePass(second.config),recheckedAt=new Date(now()).toISOString();
      need(equal(first.version,second.version)&&hash(first.config)===hash(second.config),'SOURCE_CONFIG_CHANGED');
      const project=pass=>({spreadsheetId:scope.spreadsheetId,sheetName:MASTER,headerRow:pass.parsed.summary.headerRow,header:pass.header,readEndIndex:crew.parser.columnLetterToIndex(first.config.readRangeEndColumn),configVersion:first.config.configVersion,complete:true,identityIndexComplete:true,
        identityRows:pass.parsed.rows.map(r=>({row:r.sourceRef.row,displayName:r.displayName,manualInactive:r.manualInactive})),ngCells:pass.parsed.rows.map(r=>{const row=pass.values[r.sourceRef.row-1]??[],raw=row[10],observed=r.ngCompanyObservation?.state==='OBSERVED';return {row:r.sourceRef.row,observed,kind:raw==null||raw===''?'BLANK':'TEXT',value:raw==null?'':raw};})});
      const source=project(a),version=sourceVersion(source,first.config),recheckVersion=sourceVersion(project(b),second.config);
      need(version===recheckVersion,'SOURCE_CHANGED_DURING_OBSERVATION');
      const targets=b.merged.profiles.filter(p=>p.staffId===id);need(targets.length===1&&targets[0].active===true,'SOURCE_TARGET_UNRESOLVED_OR_INACTIVE');
      const sameName=peers.filter(p=>p.normalizedName===targets[0].normalizedName);need(sameName.length===1&&sameName[0].id===id,'EXISTING_PROFILE_IDENTITY_COLLISION');
      crew.ng.staffNgRevision({...targets[0],sourceMissing:false},scope.companyId,id);
      await beforeReturn();
      return {mode:'NG_ONLY_REVIEW_INPUT_V1',companyId:scope.companyId,targetStaffId:id,config:first.config,source:{...source,version,recheckVersion,observedAt,recheckedAt},identityPeers:peers,peerCoverageComplete:true,jobs};
    });
  }

return readInput;}
module.exports={createCrewReadInput};
