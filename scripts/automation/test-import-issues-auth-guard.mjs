import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const guard=read('scripts/automation/check-function-auth-guards.mjs').replace(/^import .*;\n/gm,'');
const modules={previewStaffImport:'staff-import',syncStaffDirectoryReadOnly:'staff-import',previewShiftImport:'shift-import',syncShiftSheetsReadOnly:'shift-import',retrySheetWriteIssue:'admin-operations',acknowledgeSheetWriteIssue:'admin-operations'};
const sources=Object.fromEntries([...new Set([...Object.values(modules),'sheet-reader','case-list-source','case-list-source-core','case-list-monthly-worker'])].map(m=>['functions/src/'+m+'.ts',read('functions/src/'+m+'.ts')]));
sources['functions/src/case-list-monthly-controller.cjs']=read('functions/src/case-list-monthly-controller.cjs');
let cases=0;
function run(name,change){
 const files={...sources};change?.(files);
 const lines=[],process={argv:['node','guard','--functions',name,'--require-pass'],exitCode:0,exit:code=>{throw Error('Unexpected exit '+code);}};
 runInNewContext(guard,{process,console:{log:x=>lines.push(x),error:x=>lines.push(x)},execFileSync:(cmd,args)=>{assert.equal(cmd,'git');assert.equal(args[0],'show');const path=args[1].slice(args[1].indexOf(':')+1);assert.ok(Object.hasOwn(files,path));return files[path];}},{timeout:3000});
 return {passed:lines.includes('SOURCE_GUARD_STATUS=PASS'),exitCode:process.exitCode};
}
function reject(name,before,after,{whole=false,module=modules[name]}={}){
 const p='functions/src/'+module+(module.endsWith('.cjs')?'':'.ts'),source=sources[p],start=whole?0:source.indexOf('export const '+name+' =');
 const marker=module==='admin-operations'?'\n});':'\n);',end=whole?source.length:source.indexOf(marker,start)+marker.length;
 const block=source.slice(start,end);assert.ok(block.includes(before),name+': mutation target '+before);
 assert.deepEqual(run(name,files=>{files[p]=source.slice(0,start)+block.replace(before,after)+source.slice(end);}),{passed:false,exitCode:1},name+': '+before);cases++;
}
for(const [name,module]of Object.entries(modules)){
 assert.deepEqual(run(name),{passed:true,exitCode:0},name);cases++;
 reject(name,'requireAdmin(request)','unverified(request)');
 reject(name,'companyFromClaims(session.token)','request.data.companyId');
 reject(name,'const session = requireAdmin(request);','await db.collection("bad").add({}); const session = requireAdmin(request);');
 if(module!=='admin-operations'){
  const mode=name.startsWith('preview')?'preview':'commit';
  reject(name,'"'+mode+'"','"'+(mode==='preview'?'commit':'preview')+'"');
  reject(name,'if (mode === "commit") await assertProductionOperational(companyId);','',{whole:true});
  reject(name,module==='staff-import'?'stored.companyId !== undefined && stored.companyId !== companyId':'saved?.companyId !== undefined && saved.companyId !== companyId','false',{whole:true});
  reject(name,module==='staff-import'?'ConfigSchema.safeParse({ ...stored, companyId })':"ConfigSchema.safeParse({\n    ...saved,\n    companyId,\n  })",'ConfigSchema.safeParse(stored)',{whole:true});
  reject(name,'spreadsheets.readonly','spreadsheets',{whole:true,module:'sheet-reader'});
 }else{
  reject(name,'snap.data()?.companyId !== companyId','false');
  reject(name,'tx.update(ref,','await ref.update(');
  reject(name,'actorUid: session.uid','actorUid: input.uid');
 }
}
// Check both modes independently: the first mode literal belongs to the new
// route, so mutating just that literal no longer covers the legacy call.
for (const name of ['previewShiftImport','syncShiftSheetsReadOnly']) {
 const mode=name.startsWith('preview')?'preview':'commit',other=mode==='preview'?'commit':'preview';
 reject(name,`executeShiftImport(companyId, "${mode}", input.sheetNames)`,`executeShiftImport(companyId, "${other}", input.sheetNames)`);
 reject(name,`executeCaseListImport(companyId, "${mode}", session.uid, session.token`,`executeCaseListImport(companyId, "${other}", session.uid, session.token`);
 reject(name,'if (input.source === "case-list")','if (input.source === "monthly")');
 reject(name,`executeCaseListImport(companyId, "${mode}", session.uid`,`executeCaseListImport("other-company", "${mode}", session.uid`);
 reject(name,`executeCaseListImport(companyId, "${mode}", session.uid`,`executeCaseListImport(companyId, "${mode}", "untrusted-actor"`);
 reject(name,'session.token as Record<string, unknown>','request.data.token as Record<string, unknown>');
 if(mode==='commit') {
  reject(name,'input.enableCaseList === true','true');
  reject(name,'input.enableCaseListAssignments === true','true');
 }
}
for(const [before,after,module] of [
 ['requireCaseListExecutive(token);','','case-list-source'],
 ['if (enable || enableAssignments) {','if (false) {','case-list-source'],
 ['mode !== "commit" || token.companyId !== companyId || (token.uid ?? token.sub) !== actorUid','false','case-list-source'],
 ['mode !== "commit" || token.companyId !== companyId','false || token.companyId !== companyId','case-list-source'],
 ['token.companyId !== companyId','false','case-list-source'],
 ['(token.uid ?? token.sub) !== actorUid','false','case-list-source'],
 ['const verifiedColumns = enable || enableAssignments ? await readVerifiedMonthIdColumns(snapshot.spreadsheetId) : null;','const verifiedColumns = null;','case-list-source'],
 ['const enforceOperational = (process.env.APP_ENVIRONMENT ?? "development") === "production";','const enforceOperational = false;','case-list-source'],
 ['(await tx.get(db.collection("productionControls").doc(companyId))).data()','null','case-list-source'],
 ['operationalControl?.productionEnabled !== true','false','case-list-source'],
 ['operationalControl?.emergencyLock !== false','false','case-list-source'],
 ['enableAssignments && currentConfig.caseListEnabled !== true && !enable','false','case-list-source'],
 ['if (enable) tx.set(db.collection("sheetImportConfigs").doc(companyId), { caseListEnabled: true','if (true) tx.set(db.collection("sheetImportConfigs").doc(companyId), { caseListEnabled: true','case-list-source'],
 ['if (enableAssignments) tx.set(db.collection("sheetImportConfigs").doc(companyId), { caseListAssignmentsEnabled: true','if (true) tx.set(db.collection("sheetImportConfigs").doc(companyId), { caseListAssignmentsEnabled: true','case-list-source'],
 ['if (mode === "commit") await assertProductionOperational(companyId);','','case-list-source'],
 ['if (mode === "preview") return { ...preview, writes: 0, publications: 0 };','if (mode === "commit") return { ...preview, writes: 0, publications: 0 };','case-list-source'],
 ['if (mode === "preview") return { ...preview, writes: 0, publications: 0 };','await db.collection("unsafe").doc(companyId).set({}); if (mode === "preview") return { ...preview, writes: 0, publications: 0 };','case-list-source'],
 ['config.companyId !== companyId','false','case-list-source'],
 ['configuredCaseListSource(config.spreadsheetId).spreadsheetId','"untrusted-book"','case-list-source'],
 ['token.email_verified !== true','false','case-list-source-core'],
 ['token.role !== "admin"','false','case-list-source-core'],
 ['!emails.includes(token.email.toLowerCase())','false','case-list-source-core'],
]) reject('syncShiftSheetsReadOnly',before,after,{whole:true,module});
for(const [before,after]of [
 ['lease.companyId !== companyId','false'],['lease.token !== token','false'],
 ['!(lease.leaseUntil instanceof Timestamp)','false'],['lease.leaseUntil.toMillis() <= Timestamp.now().toMillis()','false'],
 ['assertStaffImportLease((await tx.get(this.lock.ref)).data(), this.companyId, this.lock.token);',''],
 ['assertStaffImportLease((await lock.ref.get()).data(), companyId, lock.token);',''],
 ['assertStaffImportLease((await tx.get(lock.ref)).data(), companyId, lock.token);',''],
 ['10 * 60 * 1000','8 * 60 * 1000'],
 ['current?.companyId === item.data.companyId','true'],
 ['if (mode === "commit" && (!completeSelection || !completeRows))','if (false)'],
 ['if (failedSheets > 0)','if (false)'],
])reject('syncStaffDirectoryReadOnly',before,after,{whole:true});
for(const [before,after]of [
 ['lease.token !== lock.token','false'],
 ['const sourceReadStartedAtMs = Timestamp.now().toMillis();','const sourceReadStartedAtMs = 0;'],
 ['lock,\n        sourceReadStartedAtMs\n      );','lock,\n        0\n      );'],['lease.companyId !== chunk[0]?.companyId','false'],
 ['!(lease.leaseUntil instanceof Timestamp)','false'],['lease.leaseUntil.toMillis() <= Timestamp.now().toMillis()','false'],
])reject('syncShiftSheetsReadOnly',before,after,{whole:true});
for(const [before,after]of [
 ['await assertProductionOperational(companyId);',''],
 ['if (data.operation === "case_list.assign" || !canManuallyRetrySheetWrite({','if (unchecked({'],
 ['writeVerificationRequired: data.writeVerificationRequired','writeVerificationRequired: false'],
])reject('retrySheetWriteIssue',before,after);
for(const [before,after]of [
 ['sourceWriteVerified: false','sourceWriteVerified: true'],
 ['data.acknowledgedBy === session.uid','true'],
 ['acknowledgedFromStatus: data.status,',''],
 ['if (!["blocked", "dead_letter", "retry_wait", "error", "paused_global"].includes(String(data.status ?? "")))','if (false)'],
])reject('acknowledgeSheetWriteIssue',before,after);
for(const [before,after] of [
 ['input.action === "reconcile-case-list"','false'],
 ['snapshot.data()?.companyId !== companyId','false'],
 ['snapshot.data()?.operation !== "case_list.assign"','false'],
 ['reconcileCaseListMonthlyAssignment(ref, session.uid, session.token)','reconcileCaseListMonthlyAssignment(ref, "untrusted-owner", session.token)'],
 ['reconcileCaseListMonthlyAssignment(ref, session.uid, session.token)','runCaseListMonthlyAssignment(ref)'],
]) reject('acknowledgeSheetWriteIssue',before,after);
for(const [before,after]of [
 ['assertExecutive(owner.token, process.env.EXECUTIVE_APPROVER_EMAILS ?? "");',''],
 ['owner.token.companyId === initial.companyId','true'],
 ['(owner.token.uid ?? owner.token.sub) === owner.actorUid','true'],
 ['const sheets = owner ? null : google.sheets(','const sheets = google.sheets('],
 ['applySourceAssignment: async () => stop("OWNER_RECONCILIATION_GOOGLE_WRITE_FORBIDDEN")','applySourceAssignment: async () => ({ok:true})'],
 ['need(!owner, "OWNER_RECONCILIATION_GOOGLE_WRITE_FORBIDDEN");',''],
 ['result = await core.reconcileSource(request);','result = await core.applySource(request);'],
]) reject('acknowledgeSheetWriteIssue',before,after,{whole:true,module:'case-list-monthly-worker'});
// Every new selection boundary must fail closed independently of read-only
// reconciliation. These mutations remove actual checks, not test-only flags.
for(const [before,after]of [
 ['clientNameUpConfirmed: z.literal(true).optional()','clientNameUpConfirmed: z.boolean().optional()'],
])reject('acknowledgeSheetWriteIssue',before,after,{whole:true});
for(const [before,after]of [
 ['if (!input.reviewKey || input.clientNameUpConfirmed !== true)','if (false)'],
 ['await assertProductionOperational(companyId);',''],
 ['selectCaseListMonthlyTransfer(ref, session.uid, session.token, input.reviewKey, true)','selectCaseListMonthlyTransfer(ref, "untrusted-owner", session.token, input.reviewKey, true)'],
 ['selectCaseListMonthlyTransfer(ref, session.uid, session.token, input.reviewKey, true)','selectCaseListMonthlyTransfer(ref, session.uid, request.data.token, input.reviewKey, true)'],
 ['selectCaseListMonthlyTransfer(ref, session.uid, session.token, input.reviewKey, true)','selectCaseListMonthlyTransfer(ref, session.uid, session.token, "unreviewed", true)'],
 ['selectCaseListMonthlyTransfer(ref, session.uid, session.token, input.reviewKey, true)','selectCaseListMonthlyTransfer(ref, session.uid, session.token, input.reviewKey, false)'],
 ['if (data.operation === "case_list.assign") throw new HttpsError(','if (false) throw new HttpsError('],
])reject('acknowledgeSheetWriteIssue',before,after);
for(const [before,after]of [
 ['assertExecutive(token, process.env.EXECUTIVE_APPROVER_EMAILS ?? "");',''],
 ['(token.uid ?? token.sub) === actorUid && HASH.test(reviewKey) && clientNameUpConfirmed === true','true'],
 ['initial.companyId === token.companyId','true'],
 ['sourceControlHeader !== "キャンセル" || row.cells[0].userEnteredValue?.boolValue === false','true'],
 ['fingerprint(queue) === fingerprint(initial)','true'],
 ['assertCaseListMonthlyAuthority(queueRef.id, queue, job, staff, day, currentConfig, approval)','unchecked(queueRef.id, queue, job, staff, day, currentConfig, approval)'],
 ['queue.caseListPhase.continuationHash === reviewKey','true'],
 ['assertKnownCaseListContinuation(queueRef.id, queue, operation, records, spreadsheetId);',''],
 ['!records.INTENT && !records.MONTHLY_WRITE_STARTED && !records.ACCEPTED','true'],
 ['hashCaseList(writable) === projected.postMonthlyContentHash','true'],
 ['canonical(selectedCatalog) === canonical(projected.postCatalog)','true'],
 ['selectedBy: actorUid, selectedAt: Date.now(), reviewKey','selectedBy: "untrusted", selectedAt: Date.now(), reviewKey'],
 ['const waitForOwner = next === "MONTHLY_PREPARE";','const waitForOwner = false;'],
 ['ownerTransferSelection.selected === true && ownerTransferSelection.clientNameUpConfirmed === true','true'],
 ['authorizeMonthlyTransfer: async () => clone((await authorize()).ownerTransferSelection)','authorizeMonthlyTransfer: async () => request.data'],
])reject('acknowledgeSheetWriteIssue',before,after,{whole:true,module:'case-list-monthly-worker'});
for(const [before,after]of [
 ['assertOwnerTransfer(snapshot,row,intent.assignment,intent.ownerTransfer,services,intent.operationId);',''],
 ["need(typeof services.authorizeMonthlyTransfer==='function','OWNER_TRANSFER_SELECTION_REQUIRED');",''],
 ['selection.selected===true&&selection.clientNameUpConfirmed===true','true'],
 ['selection.sourceContentHash===contentHash(services,row.cells)','true'],
])reject('acknowledgeSheetWriteIssue',before,after,{whole:true,module:'case-list-monthly-controller.cjs'});
reject('retrySheetWriteIssue','data.operation === "case_list.assign" || !canManuallyRetrySheetWrite({','!canManuallyRetrySheetWrite({');
const allowed=JSON.parse(read('config/automation/staging-safety.json')).allowedFunctions;
assert.ok(Object.keys(modules).every(n=>allowed.includes(n)));assert.ok(!allowed.includes('syncStaffDirectoryScheduled')&&!allowed.includes('syncShiftSheetsScheduled'));cases++;
console.log(JSON.stringify({importIssuesAuthGuardTests:cases,functions:Object.keys(modules),cloudOperations:false}));
