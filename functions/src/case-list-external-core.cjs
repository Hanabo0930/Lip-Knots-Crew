'use strict';
// Pure external-origin validation. The production runtime binds server-owned
// records, existing authentication/authority guards and the common lease.
// No native ACK or source/monthly writer is created here.
const crypto = require('node:crypto');
const Native = require('./case-list-monthly-controller.cjs');
const FEE = [...Array.from({length:26},(_,i)=>i+18),...Array.from({length:7},(_,i)=>i+47)];
const canonical = value => value === null || ['string','boolean','number'].includes(typeof value)
 ? JSON.stringify(value) : Array.isArray(value) ? '['+value.map(canonical).join(',')+']'
 : '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const isoDate = value => typeof value==='number' && Number.isInteger(value) ? new Date(Date.UTC(1899,11,30)+value*86400000).toISOString().slice(0,10) : value;
const need = (ok,code) => { if(!ok) throw new Error(code); };
const SCHEMA='LK_CREW_EXTERNAL_TRANSFER_SELECTION_V1';
const ACCEPTED='LK_CREW_EXTERNAL_TRANSFER_ACCEPTANCE_V1';
const queueIdentity = q => ({companyId:q.companyId,jobId:q.jobId,operation:q.operation,dateKey:q.dateKey,
 actorUid:q.actorUid,actorStaffId:q.actorStaffId,idempotencyKey:q.idempotencyKey,
 updates:q.updates,expected:q.expected,styles:q.styles??{},caseListAssignment:q.caseListAssignment});
function jobIdentity(j) {
 const result=Object.fromEntries(['companyId','caseId','status','assignedStaffId','assignedStaffName','assignedUid',
 'dateKey','workDate','revision','basePay','publicPayOffer','caseListSource','caseListPublication','caseListManualSelection',
 'clientName','storeName','makerName','menuName','entryTime','workTime','assignedAt'].map(k=>[k,j[k]??null]));
 result.writeIdentity=Object.fromEntries(['queueId','operation','sourceRevision','assignedJobRevision'].map(k=>[k,j.assignmentSheetWrite?.[k]??null]));
 return result;
}
function assertOriginal(r,queueId) {
 const q=r.queue,j=r.job,a=q.caseListAssignment,manual=a?.schema==='LK_CASE_LIST_MANUAL_ASSIGN_V1';
 need(q.operation==='case_list.assign' && a?.queueId===queueId && a.operationId===queueId &&
 q.companyId===j.companyId && q.jobId===r.jobId && a.jobId===r.jobId && a.companyId===j.companyId &&
 a.sourceCaseId===j.caseId && a.staffId===j.assignedStaffId && a.staffId===q.actorStaffId &&
 a.staffName===j.assignedStaffName && q.updates?.staffName===a.staffName &&
 a.dateKey===j.dateKey && q.dateKey===a.dateKey && a.assignedJobRevision===j.revision &&
 a.sourceRevision===j.caseListSource?.sourceRevision && a.expectedJobRevision+1===j.revision,
 'ORIGINAL_ASSIGNMENT_MISMATCH');
 need(j.status==='assigned' && j.cancelled!==true && j.assignmentUnresolved!==true &&
 j.applicationUnconfirmed===true && j.assignmentSheetWrite?.queueId===queueId &&
 j.assignmentSheetWrite?.operation==='case_list.assign' &&
 j.assignmentSheetWrite.assignedJobRevision===j.revision &&
 j.assignmentSheetWrite.sourceRevision===a.sourceRevision,'ORIGINAL_ASSIGNMENT_NOT_PENDING');
 need(r.staff?.companyId===j.companyId && r.staff.active===true &&
 r.staff.displayName===(manual?a.canonicalStaffName:a.staffName) &&
 r.dayLock?.companyId===j.companyId && r.dayLock.jobId===r.jobId &&
 r.dayLock.staffId===a.staffId && r.dayLock.dateKey===a.dateKey && r.dayLock.active===true,
 'STAFF_DAY_OR_COMPANY_MISMATCH');
 need(!r.leaseActive && !r.nativeMonthlyStarted && !r.nativeAccepted,'OTHER_TRANSFER_IN_PROGRESS');
 if(manual) {
  need(a.origin==='SOURCE_MANUAL' && j.assignedUid==null &&
   r.originalRequest?.schema==='LK_CASE_LIST_MANUAL_OBSERVATION_V1' &&
   r.originalRequest.companyId===j.companyId && r.originalRequest.jobId===r.jobId &&
   r.originalRequest.caseId===j.caseId && r.originalRequest.staffId===a.staffId &&
   r.originalRequest.dateKey===a.dateKey && r.originalRequest.observationHash===a.observationHash &&
   r.originalRequest.selected===true && r.originalRequest.queueId===queueId,
   'MANUAL_ORIGINAL_OBSERVATION_MISMATCH');
 } else {
  const original=r.originalRequest;
  need(a.schema==='LK_CASE_LIST_ASSIGN_V1' && a.origin===undefined && j.assignedUid===q.actorUid &&
   original?.kind==='PROTECTED_CREW_QUEUE' && original.queueId===queueId &&
   original.actorUid===q.actorUid && original.actorStaffId===a.staffId &&
   original.createdAt===q.createdAt && hash(original.assignment)===hash(a),'APPLICATION_ORIGINAL_RECEIPT_MISMATCH');
 }
 return manual?'SOURCE_MANUAL':'CREW_APPLICATION';
}
function originalIdentity(r) {
 return {queueHash:hash(queueIdentity(r.queue)),jobHash:hash(jobIdentity(r.job)),
  requestHash:hash(r.originalRequest),staffHash:hash(r.staff),dayHash:hash(r.dayLock),
  approvalHash:hash(r.approval),configHash:hash(r.config),sourceRecordHash:hash(r.originalSourceRecord)};
}
function receiptFrom(row,caseId) {
 let meta;try {meta=JSON.parse(row[19]);}catch {throw Error('LEDGER_METADATA_REQUIRED');}
 need(meta && (['LK_CASE_RESULT_LEDGER_V1','LK_HISTORY_CORE_SNAPSHOT_V1'].includes(meta.schema)&&meta.caseId===caseId ||
 meta.kind==='MONTHLY_TRANSFER'),'LEDGER_METADATA_REQUIRED');
 const transfer=meta.monthlyTransfer??meta,receipt=transfer.selectionAndReadback;
 need(transfer.kind==='MONTHLY_TRANSFER' && transfer.fixedId===caseId &&
 (!transfer.scheduleGroupId || transfer.selectedFixedId===caseId) &&
 receipt?.schema==='LK_CASE_TRANSFER_SELECTION_READBACK_V1','DURABLE_SELECTION_RECEIPT_REQUIRED');
 return {transfer,receipt};
}
function createConnection(s) {
 for(const name of ['authorize','assertAuthority','readProtected','readSheets','transaction','gasDigest','now'])
  need(typeof s[name]==='function','SERVER_BINDING_REQUIRED');
 async function authorized(queueId,uid,token) {
  // This calls the existing assertExecutive implementation in the harness;
  // authenticated token verification remains the deployed callable's job.
  await s.authorize(uid,token);
  const r=await s.readProtected(queueId);
  need(r && token.companyId===r.job.companyId,'AUTH_COMPANY_MISMATCH');
  return r;
 }
 async function select(queueId,uid,token,input) {
  need(input?.clientNameUpConfirmed===true,'EXPLICIT_NAME_UP_CONFIRMATION_REQUIRED');
  const r=await authorized(queueId,uid,token),origin=assertOriginal(r,queueId);
  if(r.externalSelection) {
   need(r.externalSelection.selectedBy===uid && r.externalSelection.queueId===queueId &&
    hash(r.externalSelection.original)===hash(originalIdentity(r)),'SELECTION_CHANGED');
   return {kind:'ALREADY_SELECTED',selection:r.externalSelection};
  }
  // Existing complete authority guard is used BEFORE the Source is archived.
  s.assertAuthority(queueId,r);
  const snapshot=await s.readSheets(queueId,'preview');
  need(snapshot.readStartedAt<=snapshot.observedAt && snapshot.observedAt<=s.now() &&
   s.now()-snapshot.readStartedAt<=60_000,'GAS_PREVIEW_NOT_CURRENT');
  const cells=snapshot.sourceCells,record=r.originalSourceRecord,payload=record?.payload;
  const writable=c=>Object.fromEntries(['userEnteredValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'].filter(k=>Object.hasOwn(c,k)).map(k=>[k,c[k]]));
  const originalCells=origin==='SOURCE_MANUAL'?payload?.sourceSnapshot:payload?.expectedSourceAfter;
  const cellValue=c=>{const v=c?.effectiveValue??c?.userEnteredValue??{};need(!v.errorValue,'SOURCE_FORMULA_ERROR');return v.stringValue??v.numberValue??v.boolValue??'';};
  need(record?.companyId===r.job.companyId && record.queueId===queueId && record.payloadHash===hash(payload) &&
   payload.operationId===queueId && payload.caseId===r.job.caseId && payload.spreadsheetId===r.config.spreadsheetId &&
   payload.stage===(origin==='SOURCE_MANUAL'?'SOURCE_MANUAL_OBSERVED':'SOURCE_INTENT') &&
   Array.isArray(originalCells) && originalCells.length===65 && Array.isArray(cells) && cells.length===65 &&
   canonical(cells.map(writable))===canonical(originalCells) &&
   cellValue(cells[60])===r.job.caseId && cellValue(cells[2])===r.job.assignedStaffName &&
   isoDate(cellValue(cells[1]))===r.job.dateKey && cellValue(cells[0])===false && cellValue(cells[63])===false,
   'ORIGINAL_SOURCE_SNAPSHOT_MISMATCH');
  need(snapshot.sourceIds.filter(id=>id.toLowerCase()===r.job.caseId.toLowerCase()).length===1 &&
   snapshot.sourceControlA===false && snapshot.sourceControlBL===false &&
   snapshot.caseId===r.job.caseId && snapshot.staffName===r.job.assignedStaffName &&
   snapshot.dateKey===r.job.dateKey && snapshot.crewSourceRevision===r.queue.caseListAssignment.sourceRevision &&
   snapshot.spreadsheetId===r.config.spreadsheetId,'CURRENT_PREVIEW_BINDING_MISMATCH');
  const preview=snapshot.gasPreview;
  need(preview?.caseId===r.job.caseId && preview.date===r.job.dateKey &&
   preview.book===r.config.spreadsheetId &&
   preview.sourceHash && preview.ledgerHash && Number.isInteger(preview.sheetId) &&
   [55,56].includes(preview.width),'GAS_PREVIEW_REQUIRED');
  need(/^[a-f0-9]{64}$/.test(preview.approvedProof??'') && /^[a-f0-9]{64}$/.test(preview.checkedProof??''),'EXTERNAL_EXPECTED_GAS_PROOF_REQUIRED');
  need(cells.every(c=>c&&typeof c==='object'&&!c.$unknown),'SOURCE_FULL_ROW_REQUIRED');
  const expectedMapped=Native.mapSource(cells,r.job.caseId,preview.width),expectedFees=FEE.map(i=>cellValue(cells[i+1]));
  need(expectedFees.every(v=>typeof v==='number'&&Number.isFinite(v)),'SOURCE_FINANCIAL_VALUES_REQUIRED');
  const gasSourceHash=hash(cells.map(c=>[c.userEnteredValue??{},c.effectiveValue??{},c.userEnteredFormat??{},c.note??'',c.dataValidation??{},c.textFormatRuns??[],c.chipRuns??[]]));
  need(preview.sourceHash===gasSourceHash && !preview.groupId && !preview.groupHash,'EXTERNAL_SINGLE_CASE_PREIMAGE_REQUIRED');
  const body={schema:SCHEMA,companyId:r.job.companyId,jobId:r.jobId,queueId,caseId:r.job.caseId,
   origin,original:originalIdentity(r),gasPreview:clone(preview),selectedBy:uid,selectedAt:s.now(),
   expectedMapped,expectedFees,sourceSnapshot:clone(cells),clientNameUpConfirmed:true};
  const selection={...body,selectionHash:hash(body)};
  return s.transaction(queueId,async current=>{
   assertOriginal(current,queueId);s.assertAuthority(queueId,current);
   need(s.now()-snapshot.readStartedAt<=60_000,'GAS_PREVIEW_EXPIRED_BEFORE_COMMIT');
   need(hash(originalIdentity(current))===hash(body.original) && !current.externalSelection,'SELECTION_CHANGED');
   return {kind:'SELECT_EXTERNAL',selection,queuePatch:{status:'blocked',errorType:'external_transfer_selected'}};
  });
 }
 async function reconcile(queueId,uid,token) {
  const before=await authorized(queueId,uid,token);
  if(before.externalAcceptance) {
   resolvePrivateRef(before);
   need(before.externalSelection.selectedBy===uid,'COMPLETED_SELECTION_OWNER_CHANGED');
   return {kind:'ALREADY_ACCEPTED',acceptance:before.externalAcceptance};
  }
  const origin=assertOriginal(before,queueId);
  const selection=before.externalSelection,body={...selection};delete body.selectionHash;
  need(selection?.schema===SCHEMA && selection.selectionHash===hash(body) &&
   selection.selectedBy===uid && selection.companyId===before.job.companyId &&
   selection.queueId===queueId && selection.jobId===before.jobId && selection.caseId===before.job.caseId &&
   selection.origin===origin && selection.clientNameUpConfirmed===true &&
   hash(selection.original)===hash(originalIdentity(before)),'PROTECTED_SELECTION_MISMATCH');
  const snap=await s.readSheets(queueId,'archive'),p=selection.gasPreview;
  need(snap.readStartedAt<=snap.observedAt && snap.observedAt<=s.now() &&
   s.now()-snap.readStartedAt<=60_000,'READBACK_NOT_CURRENT');
  need(snap.sourceIndex?.startRow===2 && snap.sourceIndex.rowCount>=1 &&
   snap.sourceIndex.cells.length===snap.sourceIndex.rowCount-1 &&
   canonical(snap.sourceIds)===canonical(snap.sourceIndex.cells.filter(Boolean)), 'SOURCE_INDEX_INCOMPLETE');
  need(Array.isArray(snap.monthInventory) && snap.monthInventory.length===snap.months.length &&
   new Set(snap.monthInventory.map(m=>m.sheetId)).size===snap.monthInventory.length &&
   snap.monthInventory.every(m=>snap.months.filter(n=>n.sheetId===m.sheetId&&n.title===m.title&&n.width===m.width&&n.rowCount===m.rowCount).length===1),
   'MONTH_INVENTORY_INCOMPLETE');
  need(typeof token.email==='string' && snap.ownerEmail===token.email.toLowerCase() && snap.spreadsheetId===before.config.spreadsheetId && snap.sourceIds.every(id=>id.toLowerCase()!==before.job.caseId.toLowerCase()),
   'SOURCE_ARCHIVE_NOT_VERIFIED');
  const rows=snap.ledgerRows.filter(row=>row[0]?.toLowerCase()===before.job.caseId.toLowerCase());
  need(snap.ledgerIndex?.startRow===4 && snap.ledgerIndex.rowCount>=4 &&
   snap.ledgerIndex.cells.length===snap.ledgerIndex.rowCount-3 &&
   snap.ledgerIndex.cells.filter(id=>id?.toLowerCase()===before.job.caseId.toLowerCase()).length===1,'LEDGER_INDEX_INCOMPLETE');
  need(rows.length===1 && rows[0][0]===before.job.caseId,'LEDGER_ID_NOT_UNIQUE');
  const row=rows[0],{transfer,receipt}=receiptFrom(row,before.job.caseId),unhashed={...receipt};delete unhashed.receiptHash;
  need(s.gasDigest(unhashed)===receipt.receiptHash,'RECEIPT_HASH_MISMATCH');
  const t=receipt.target,read=receipt.monthlyReadback;
  need(transfer.book===p.book && transfer.sheetId===p.sheetId &&
   t.book===p.book && t.caseId===p.caseId && t.date===p.date && t.sheetId===p.sheetId && t.width===p.width &&
   receipt.intentRef.key===p.intentKey && receipt.intentRef.groupId===(p.groupId??null) &&
   receipt.preimage.sourceHash===p.sourceHash && receipt.preimage.ledgerHash===p.ledgerHash &&
   receipt.preimage.groupHash===(p.groupHash??null) &&
   receipt.selection.approvedProof===p.approvedProof && receipt.selection.checkedProof===p.checkedProof &&
   receipt.selection.actorHash===s.gasDigest(snap.ownerEmail) &&
   ['OWNER_CONFIRMATION_AT_THIS_CALL','SCOPED_PILOT_AT_THIS_CALL'].includes(receipt.selection.confirmation),
   'RECEIPT_PREVIEW_BINDING_MISMATCH');
  need(Number.isFinite(Date.parse(receipt.intentRef.createdAt)) &&
   Date.parse(receipt.intentRef.createdAt)>=selection.selectedAt &&
   Date.parse(receipt.intentRef.createdAt)<=snap.observedAt &&
   isoDate(row[1])===p.date && row[8]==='手配確定' && row[9]===before.job.assignedStaffName &&
   row[10]==='月別転記済' && row[12]===snap.ownerEmail && row[13]===receipt.recordedAt &&
   row[17]===false,'LEDGER_SELECTION_OR_CANCEL_MISMATCH');
  const hits=snap.months.flatMap(month=>{
   need(month.idIndex.length===month.rowCount && month.headers.length===month.width &&
    [55,56].includes(month.width) && month.headers.at(-1)==='連絡_固定案件ID' &&
    month.headers.filter(h=>h==='連絡_固定案件ID').length===1,'MONTH_INDEX_INCOMPLETE');
   return month.idIndex.flatMap((id,i)=>typeof id==='string' && id.toLowerCase()===p.caseId.toLowerCase()?[{month,row:i+1,id}]:[]);
  });
  need(hits.length===1 && hits[0].id===p.caseId && hits[0].month.sheetId===p.sheetId &&
   hits[0].month.title===p.date.slice(0,4)+'.'+Number(p.date.slice(5,7)) &&
   hits[0].month.width===p.width && hits[0].row>=2,'MONTH_ID_NOT_UNIQUE');
  const hit=hits[0],cells=hit.month.rows.find(r=>r.row===hit.row)?.cells;
  need(Array.isArray(cells) && cells.length===p.width,'MONTH_ROW_NOT_OBSERVED');
  const value=c=>{const v=c?.effectiveValue??c?.userEnteredValue??{};need(!v.errorValue,'MONTH_FORMULA_ERROR');return v.stringValue??v.numberValue??v.boolValue??'';};
  const values=cells.map(value),j=before.job;
  need(values.at(-1)===p.caseId && isoDate(values[0])===p.date && values[1]===j.assignedStaffName &&
   [9,10,11,12,13,14].every((n,i)=>values[n]===[j.clientName,j.storeName,j.makerName,j.menuName,j.entryTime,j.workTime][i]),
   'MONTH_BUSINESS_MISMATCH');
  need([values[27],values[28]].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0) &&
   values[27]+values[28]===j.publicPayOffer.dailyWageJPY,'MONTH_PUBLIC_PAY_MISMATCH');
  const writable=c=>Object.fromEntries(['userEnteredValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'].filter(k=>Object.hasOwn(c,k)).map(k=>[k,c[k]]));
  for(let i=0;i<54;i++)if(![8,17].includes(i))need(canonical(writable(cells[i]))===canonical(selection.expectedMapped.business[i]),'PROTECTED_EXPECTED_MONTH_CONTENT_MISMATCH');
  need(canonical(FEE.map(i=>values[i]))===canonical(selection.expectedFees),'PROTECTED_EXPECTED_FINANCIAL_MISMATCH');
  assertOperationalDefaults(selection,receipt,cells,hit.row,s.expectedDateFormula);
  const placementVerification=Native.verifyPostPlacement({month:{title:hit.month.title,sheetId:p.sheetId},fixedId:p.caseId,
   position:{append:false},assignment:{dateKey:p.date},sourceSnapshot:selection.sourceSnapshot},hit.month,{row:hit.row,fixedId:p.caseId,cells});
  const fees=[...Array.from({length:26},(_,i)=>i+18),...Array.from({length:7},(_,i)=>i+47)];
  const actual={businessHash:s.gasDigest(cells.slice(0,54).map(c=>[c.userEnteredValue??{},c.effectiveValue??{}])),
   writableHash:s.gasDigest(cells.map(c=>Object.fromEntries(['userEnteredValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'].filter(k=>Object.hasOwn(c,k)).map(k=>[k,c[k]])))),
   financialHash:s.gasDigest(fees.map(i=>values[i]))};
  need(read.book===p.book && read.sheetId===p.sheetId && read.caseId===p.caseId && read.date===p.date &&
   read.width===p.width && Object.entries(actual).every(([k,v])=>read[k]===v),'MONTH_READBACK_CHANGED');
  const ackBody={schema:ACCEPTED,companyId:j.companyId,jobId:before.jobId,queueId,caseId:p.caseId,
   assignedJobRevision:j.revision,staffId:j.assignedStaffId,dateKey:j.dateKey,origin,
   selectionHash:selection.selectionHash,receiptHash:receipt.receiptHash,original:selection.original,
   target:{spreadsheetId:p.book,sheetId:p.sheetId,sheetName:hit.month.title,headerRow:1,
    currentRow:hit.row,caseId:p.caseId,caseIdColumn:p.width===56?'BD':'BC',
    bindingHash:hash({schema:'LK_CASE_LIST_SOURCE_BINDING_V1',spreadsheetId:p.book,sheetId:p.sheetId})},
   readback:actual,placementVerification,observedAt:snap.observedAt};
  const acceptance={...ackBody,acceptanceHash:hash(ackBody)};
  return s.transaction(queueId,async current=>{
   assertOriginal(current,queueId);
   need(hash(originalIdentity(current))===hash(selection.original) &&
    hash(current.externalSelection)===hash(selection) && current.queue.status==='blocked' &&
    current.queue.errorType==='external_transfer_selected' && !current.externalAcceptance,'RECONCILIATION_CHANGED');
   need(s.now()-snap.readStartedAt<=60_000 && snap.observedAt<=s.now(),'READBACK_EXPIRED_BEFORE_COMMIT');
   const {spreadsheetId:privateBook,...publicRef}=acceptance.target;
   return {kind:'ACCEPT_EXTERNAL',acceptance,privateRef:acceptance.target,
    jobPatch:{applicationUnconfirmed:false,sourceMissing:false,sourceReady:true,publishable:false,recruitmentStopped:true,
     sheetRef:publicRef,assignmentSheetWrite:{...current.job.assignmentSheetWrite,pending:false,
      externalAck:{schema:ACCEPTED,acceptanceHash:acceptance.acceptanceHash}}},
    queuePatch:{status:'completed'}};
  });
 }
 function resolvePrivateRef(records) {
  const a=records.externalAcceptance,body={...a};delete body.acceptanceHash;
  const selectionBody={...records.externalSelection};delete selectionBody.selectionHash;
  const publicRef={...a?.target};delete publicRef.spreadsheetId;
  need(a?.schema===ACCEPTED && hash(body)===a.acceptanceHash &&
   records.job.applicationUnconfirmed===false && records.job.sourceMissing===false &&
   records.job.externalImportReviewRequired!==true &&
   records.job.cancelled!==true && records.job.assignmentUnresolved!==true &&
   records.job.revision===a.assignedJobRevision && records.job.caseId===a.caseId &&
   records.job.assignedStaffId===a.staffId && records.job.dateKey===a.dateKey &&
   records.job.companyId===a.companyId && records.jobId===a.jobId &&
   records.config.companyId===a.companyId && records.config.spreadsheetId===a.target.spreadsheetId &&
   records.externalSelection?.original?.configHash===hash(records.config) &&
   records.queue.status==='completed' && records.queue.caseListAssignment?.queueId===a.queueId &&
   records.externalSelection?.schema===SCHEMA && hash(selectionBody)===records.externalSelection.selectionHash && records.externalSelection.selectionHash===a.selectionHash &&
   records.externalSelection.companyId===a.companyId && records.externalSelection.jobId===a.jobId &&
   records.externalSelection.queueId===a.queueId && records.externalSelection.caseId===a.caseId &&
   records.externalSelection.original.queueHash===hash(queueIdentity(records.queue)) &&
   records.externalSelection.original.jobHash===hash(jobIdentity(records.job)) &&
   hash(records.externalSelection.original)===hash(a.original) &&
   records.job.assignmentSheetWrite?.externalAck?.schema===ACCEPTED &&
   records.job.assignmentSheetWrite.externalAck.acceptanceHash===a.acceptanceHash &&
   hash(records.job.sheetRef)===hash(publicRef) && !Object.hasOwn(records.job.sheetRef,'spreadsheetId') &&
   hash(records.privateRef)===hash(a.target),'EXTERNAL_PRIVATE_PROOF_MISMATCH');
  return clone(a.target);
 }
 function validateAcceptedSnapshot(records,snap) {
  const ref=resolvePrivateRef(records),a=records.externalAcceptance;
  need(snap.spreadsheetId===ref.spreadsheetId && snap.sourceIndex?.cells.length===snap.sourceIndex.rowCount-1 &&
   snap.sourceIds.every(id=>id.toLowerCase()!==ref.caseId.toLowerCase()),'EXTERNAL_ACCEPTED_SOURCE_REAPPEARED');
  need(snap.ledgerIndex?.cells.length===snap.ledgerIndex.rowCount-3 &&
   snap.ledgerIndex.cells.filter(id=>id?.toLowerCase()===ref.caseId.toLowerCase()).length===1 && snap.ledgerRows.length===1,'EXTERNAL_ACCEPTED_LEDGER_AMBIGUOUS');
  const row=snap.ledgerRows[0],{receipt}=receiptFrom(row,ref.caseId),body={...receipt};delete body.receiptHash;
  need(receipt.receiptHash===a.receiptHash && hash(body)===a.receiptHash && row[0]===ref.caseId &&
   isoDate(row[1])===a.dateKey && row[9]===records.job.assignedStaffName && row[8]==='手配確定' &&
   row[10]==='月別転記済' && row[17]===false,'EXTERNAL_ACCEPTED_LEDGER_CHANGED');
  const targets=snap.months.flatMap(m=>m.idIndex.flatMap((id,i)=>id?.toLowerCase()===ref.caseId.toLowerCase()?[{m,row:i+1,id}]:[]));
  need(targets.length===1 && targets[0].id===ref.caseId && targets[0].m.sheetId===ref.sheetId,'EXTERNAL_ACCEPTED_MONTH_AMBIGUOUS');
  const target=targets[0],cells=target.m.rows.find(r=>r.row===target.row)?.cells;
  const value=c=>{const v=c?.effectiveValue??c?.userEnteredValue??{};need(!v.errorValue,'EXTERNAL_ACCEPTED_FORMULA_ERROR');return v.stringValue??v.numberValue??v.boolValue??'';};
  need(cells && isoDate(value(cells[0]))===a.dateKey && value(cells[1])===records.job.assignedStaffName,'EXTERNAL_ACCEPTED_ASSIGNMENT_CHANGED');
  const writable=c=>Object.fromEntries(['userEnteredValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'].filter(k=>Object.hasOwn(c,k)).map(k=>[k,c[k]]));
  for(const i of [0,1,9,10,11,12,13,14])need(canonical(writable(cells[i]))===canonical(records.externalSelection.expectedMapped.business[i]),'EXTERNAL_ACCEPTED_BUSINESS_CHANGED');
  return {externalAcceptanceHash:a.acceptanceHash,sourceReadStartedAtMs:snap.readStartedAt,observedAt:snap.observedAt};
 }
 return Object.freeze({select,reconcile,resolvePrivateRef,validateAcceptedSnapshot});
}
function assertOperationalDefaults(selection,receipt,cells,row,expectedDateFormula) {
 // Exact V14 defaults are checked separately from immutable business fields.
 // No value from the receipt is promoted to an expected business/money value.
 const stamp=Date.parse(receipt.intentRef.createdAt);need(Number.isFinite(stamp),'TRANSFER_DATE_UNVERIFIED');
 const date=new Date(stamp+9*60*60*1000).toISOString().slice(0,10);
 const day=(Date.parse(date+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000;
 const actual=cells[8],v=actual.effectiveValue??actual.userEnteredValue??{};
 need(typeof expectedDateFormula==='function','LK_STAFF_DATE_FORMULA_IMPLEMENTATION_REQUIRED');
 const formula=expectedDateFormula(row,selection.sourceSnapshot[2].effectiveValue?.stringValue??selection.sourceSnapshot[2].userEnteredValue?.stringValue,day);
 need(typeof formula==='string'&&formula.startsWith('='),'TRANSFER_APPLICATION_DATE_FORMULA_UNVERIFIED');
 const expected={...clone(selection.expectedMapped.business[8]),userEnteredValue:{formulaValue:formula}};
 expected.userEnteredFormat={...(expected.userEnteredFormat??{}),numberFormat:{type:'DATE',pattern:'m/d(ddd)'}};
 const writable=c=>Object.fromEntries(['userEnteredValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'].filter(k=>Object.hasOwn(c,k)).map(k=>[k,c[k]]));
 need(canonical(writable(actual))===canonical(expected),'TRANSFER_APPLICATION_DATE_FORMULA_MISMATCH');
 need(v.numberValue===day && (actual.effectiveFormat??actual.userEnteredFormat)?.numberFormat?.type==='DATE','TRANSFER_APPLICATION_DATE_MISMATCH');
 const material=cells[17],raw=material.effectiveValue??material.userEnteredValue??{},fill=(material.effectiveFormat??material.userEnteredFormat??{});
 const rgb=fill.backgroundColorStyle?.rgbColor??fill.backgroundColor;
 need(raw.stringValue==='作成中' && rgb && Object.entries({red:244/255,green:162/255,blue:97/255}).every(([k,v])=>Math.abs(rgb[k]-v)<0.002),'TRANSFER_MATERIAL_DEFAULT_MISMATCH');
 const expectedMaterial={...clone(selection.expectedMapped.business[17]),userEnteredValue:{stringValue:'作成中'}};
 const {backgroundColor,...format}=expectedMaterial.userEnteredFormat??{};
 expectedMaterial.userEnteredFormat={...format,backgroundColorStyle:{rgbColor:{red:244/255,green:162/255,blue:97/255}}};
 need(canonical(writable(material))===canonical(expectedMaterial),'TRANSFER_MATERIAL_WRITABLE_MISMATCH');
}
module.exports=Object.freeze({createConnection,hash,canonical});

