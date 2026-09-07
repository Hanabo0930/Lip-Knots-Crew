import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { diagnoseShiftIntegrity } from './diagnose-shift-integrity.mjs';
const results=[];
for(const count of [1000,10000]){
 const input={companyId:'c',complete:{jobs:true,locks:true},jobs:[],locks:[]};
 for(let i=0;i<count;i++){input.jobs.push({id:`j${i}`,companyId:'c',assignedStaffId:`s${i}`,dateKey:'2026-09-20',status:'assigned'});input.locks.push({id:`c_s${i}_2026-09-20`,companyId:'c',staffId:`s${i}`,dateKey:'2026-09-20',jobId:`j${i}`,active:true});}
 diagnoseShiftIntegrity(input);
 const samples=[];for(let i=0;i<20;i++){const start=performance.now();if(diagnoseShiftIntegrity(input).status!=='consistent')throw Error('Unexpected findings');samples.push(performance.now()-start);}
 const sorted=[...samples].sort((a,b)=>a-b);results.push({jobs:count,locks:count,samplesMs:samples,medianMs:(sorted[9]+sorted[10])/2,p95Ms:sorted[18]});
}
const sourceSha256=createHash('sha256').update(fs.readFileSync(new URL('./diagnose-shift-integrity.mjs',import.meta.url))).digest('hex');
fs.writeFileSync('release-evidence/shift-integrity-benchmark.json',JSON.stringify({sourceSha256,node:process.version,platform:process.platform,scope:'synthetic in-memory diagnosis; excludes input/output and real database access',results},null,2));
console.log(JSON.stringify(results.map(({samplesMs,...summary})=>summary)));