import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';

// Evaluate the counter used by App, rather than a copy of its implementation.
export function verifyAdminPrecontactCounter(source,{buildJobSearchIndex,filterJobSearchIndex}){
  const matches=[...source.matchAll(/\bconst\s+unresolved\s*=\s*([^;]+);/g)];
  assert.equal(matches.length,1,'App must expose one pending-precontact counter');
  const expression=matches[0][1];
  const count=jobs=>runInNewContext(expression,{jobs,jobSearchIndex:buildJobSearchIndex(jobs),filterJobSearchIndex});
  const base={workDate:'2026-10-15',storeName:'Synthetic store',makerName:'Synthetic maker',clientName:'Synthetic client'};
  const jobs=[{...base,id:'active',status:'assigned'},{...base,id:'flag-cancelled',status:'assigned',cancelled:true},{...base,id:'status-cancelled',status:'cancelled'},{...base,id:'contacted',status:'assigned',preContact:{}},{...base,id:'open',status:'open'}];
  assert.equal(count(jobs),1,'Only active assigned jobs without precontact count');
  assert.equal(count(jobs),filterJobSearchIndex(buildJobSearchIndex(jobs),'','precontact').length,'Home count must match the unsearched precontact list');
  assert.equal(count([]),0);
  assert.equal(count(jobs.filter(job=>job.id.includes('cancelled'))),0);
  assert.equal(count(jobs.filter(job=>job.id==='contacted')),0);
  assert.equal(count([{...base,status:'assigned',cancelled:false}]),1);
  const original=JSON.stringify(jobs);count(jobs);assert.equal(JSON.stringify(jobs),original,'Counting must preserve job data');
  assert.equal((source.match(/\{unresolved\}/g)||[]).length,2,'Both counter displays must use the same derived value');
  return {checks:9,count:1,cloudOperations:false};
}
