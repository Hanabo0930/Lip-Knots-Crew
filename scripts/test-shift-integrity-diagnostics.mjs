import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { diagnoseShiftIntegrity } from './diagnose-shift-integrity.mjs';
const job = { id:'job-a', companyId:'c', assignedStaffId:'s', dateKey:'2026-09-20', status:'assigned', cancelled:false, displayName:'DO_NOT_COPY', email:'DO_NOT_COPY', basePay:123456789 };
const lock = { id:'c_s_2026-09-20', companyId:'c', staffId:'s', dateKey:'2026-09-20', jobId:'job-a', active:true };
const base = () => ({companyId:'c',complete:{jobs:true,locks:true},jobs:[{...job}],locks:[{...lock}]});
let passed=0;
function test(name,fn){try{fn();passed++;}catch(error){throw new Error(name,{cause:error});}}
function code(input,expected){assert.ok(diagnoseShiftIntegrity(input).findings.some(f=>f.code===expected));}
test('healthy and immutable',()=>{const input=base(),before=structuredClone(input); const report=diagnoseShiftIntegrity(input);assert.equal(report.status,'consistent');assert.deepEqual(input,before);assert.ok(!JSON.stringify(report).includes('DO_NOT_COPY'));assert.ok(!JSON.stringify(report).includes('123456789'));});
test('complete empty',()=>assert.equal(diagnoseShiftIntegrity({...base(),jobs:[],locks:[]}).status,'consistent'));
test('unknown completeness',()=>assert.equal(diagnoseShiftIntegrity({...base(),complete:{}}).status,'unverified'));
test('missing lock',()=>code({...base(),locks:[]},'MISSING_LOCK'));
test('partial lock snapshot',()=>{const r=diagnoseShiftIntegrity({...base(),complete:{jobs:true},locks:[]});assert.equal(r.counts.error,0);assert.equal(r.status,'unverified');});
test('inactive lock',()=>code({...base(),locks:[{...lock,active:false}]},'INACTIVE_ASSIGNED_LOCK'));
test('owner mismatch',()=>code({...base(),locks:[{...lock,jobId:'other'}]},'LOCK_OWNER_MISMATCH'));
test('duplicate assignment',()=>code({...base(),jobs:[job,{...job,id:'job-b'}]},'DUPLICATE_ASSIGNMENT'));
test('orphan',()=>code({...base(),jobs:[]},'ORPHAN_ACTIVE_LOCK'));
test('partial jobs',()=>{const r=diagnoseShiftIntegrity({...base(),complete:{locks:true},jobs:[]});assert.equal(r.counts.error,0);assert.equal(r.status,'unverified');});
test('cancelled active lock',()=>code({...base(),jobs:[{...job,cancelled:true}]},'ACTIVE_LOCK_FOR_INACTIVE_JOB'));
test('open active lock',()=>code({...base(),jobs:[{...job,status:'open'}]},'ACTIVE_LOCK_FOR_INACTIVE_JOB'));
test('wrong assignment',()=>code({...base(),jobs:[{...job,assignedStaffId:'other'}]},'LOCK_ASSIGNMENT_MISMATCH'));
test('bad metadata',()=>code({...base(),locks:[{...lock,dateKey:'2026-09-21'}]},'INVALID_LOCK_METADATA'));
test('ambiguous active',()=>code({...base(),locks:[{...lock,active:'true'}]},'AMBIGUOUS_LOCK_STATE'));
test('invalid actual date',()=>code({...base(),jobs:[{...job,dateKey:'2026-02-30'}]},'INVALID_ASSIGNMENT'));
test('staff missing',()=>code({...base(),jobs:[{...job,assignedStaffId:null}]},'INVALID_ASSIGNMENT'));
test('foreign company rejected',()=>assert.throws(()=>diagnoseShiftIntegrity({...base(),jobs:[{...job,companyId:'other'}]})));
test('duplicate IDs rejected',()=>assert.throws(()=>diagnoseShiftIntegrity({...base(),locks:[lock,lock]})));
test('malformed input rejected',()=>assert.throws(()=>diagnoseShiftIntegrity({companyId:'c',jobs:[{}],locks:[]})));
test('order independent',()=>{const input={...base(),jobs:[job,{...job,id:'job-b'}]};assert.deepEqual(diagnoseShiftIntegrity(input),diagnoseShiftIntegrity({...input,jobs:input.jobs.toReversed()}));});
test('large consistent snapshot',()=>{const input={...base(),jobs:[],locks:[]};for(let i=0;i<10000;i++){input.jobs.push({...job,id:`job-${i}`,assignedStaffId:`s${i}`});input.locks.push({...lock,id:`c_s${i}_2026-09-20`,staffId:`s${i}`,jobId:`job-${i}`});}assert.equal(diagnoseShiftIntegrity(input).status,'consistent');});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lkc-integrity-'));
const inputPath=path.join(temp,'input.json'),outputPath=path.join(temp,'report.json');
const invoke=()=>spawnSync(process.execPath,['scripts/diagnose-shift-integrity.mjs','--input',inputPath,'--output',outputPath],{encoding:'utf8'});
try {
 test('CLI missing-lock report',()=>{fs.writeFileSync(inputPath,JSON.stringify({...base(),locks:[]}));const r=invoke();assert.equal(r.status,2);assert.ok(!r.stdout.includes('job-a'));assert.equal(JSON.parse(fs.readFileSync(outputPath)).status,'attention_required');});
 test('CLI refuses overwrite',()=>{const before=fs.readFileSync(outputPath,'utf8');assert.equal(invoke().status,1);assert.equal(fs.readFileSync(outputPath,'utf8'),before);});
}finally{for(const file of [inputPath,outputPath]) if(fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(temp);}
console.log(`Shift integrity diagnostics: ${passed} cases passed.`);