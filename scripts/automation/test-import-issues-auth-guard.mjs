import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const guard=read('scripts/automation/check-function-auth-guards.mjs').replace(/^import .*;\n/gm,'');
const modules={previewStaffImport:'staff-import',syncStaffDirectoryReadOnly:'staff-import',previewShiftImport:'shift-import',syncShiftSheetsReadOnly:'shift-import',retrySheetWriteIssue:'admin-operations',acknowledgeSheetWriteIssue:'admin-operations'};
const sources=Object.fromEntries([...new Set([...Object.values(modules),'sheet-reader'])].map(m=>['functions/src/'+m+'.ts',read('functions/src/'+m+'.ts')]));
let cases=0;
function run(name,change){
 const files={...sources};change?.(files);
 const lines=[],process={argv:['node','guard','--functions',name,'--require-pass'],exitCode:0,exit:code=>{throw Error('Unexpected exit '+code);}};
 runInNewContext(guard,{process,console:{log:x=>lines.push(x),error:x=>lines.push(x)},execFileSync:(cmd,args)=>{assert.equal(cmd,'git');assert.equal(args[0],'show');const path=args[1].slice(args[1].indexOf(':')+1);assert.ok(Object.hasOwn(files,path));return files[path];}},{timeout:3000});
 return {passed:lines.includes('SOURCE_GUARD_STATUS=PASS'),exitCode:process.exitCode};
}
function reject(name,before,after,{whole=false,module=modules[name]}={}){
 const p='functions/src/'+module+'.ts',source=sources[p],start=whole?0:source.indexOf('export const '+name+' =');
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
 ['lease.token !== lock.token','false'],['lease.companyId !== chunk[0]?.companyId','false'],
 ['!(lease.leaseUntil instanceof Timestamp)','false'],['lease.leaseUntil.toMillis() <= Timestamp.now().toMillis()','false'],
])reject('syncShiftSheetsReadOnly',before,after,{whole:true});
for(const [before,after]of [
 ['await assertProductionOperational(companyId);',''],
 ['if (!canManuallyRetrySheetWrite({','if (unchecked({'],
 ['writeVerificationRequired: data.writeVerificationRequired','writeVerificationRequired: false'],
])reject('retrySheetWriteIssue',before,after);
for(const [before,after]of [
 ['sourceWriteVerified: false','sourceWriteVerified: true'],
 ['data.acknowledgedBy === session.uid','true'],
 ['acknowledgedFromStatus: data.status,',''],
 ['if (!["blocked", "dead_letter", "retry_wait", "error", "paused_global"].includes(String(data.status ?? "")))','if (false)'],
])reject('acknowledgeSheetWriteIssue',before,after);
const allowed=JSON.parse(read('config/automation/staging-safety.json')).allowedFunctions;
assert.ok(Object.keys(modules).every(n=>allowed.includes(n)));assert.ok(!allowed.includes('syncStaffDirectoryScheduled')&&!allowed.includes('syncShiftSheetsScheduled'));cases++;
console.log(JSON.stringify({importIssuesAuthGuardTests:cases,functions:Object.keys(modules),cloudOperations:false}));