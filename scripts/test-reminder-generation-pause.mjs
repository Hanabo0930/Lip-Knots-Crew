import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {setup} from './notification-test-harness.mjs';
let cloudCalls=0;
http.request=https.request=globalThis.fetch=()=>{cloudCalls++;throw Error('REAL_NETWORK_FORBIDDEN');};
const results=[];
for(const compiled of [false,true])for(const app of ['staging','production',undefined])for(const mode of [undefined,'paused','invalid','','ACTIVE','active']){
 const env={...(app===undefined?{}:{APP_ENVIRONMENT:app}),...(mode===undefined?{}:{LKC_NOTIFICATION_DELIVERY_MODE:mode})};
 const name=`${compiled?'compiled':'source'} ${String(app)} ${String(mode)}`;
 try{
  const h=setup('2026-09-13T08:00:00+09:00',env,compiled);
  h.state.records.set('jobs/job-a',{companyId:'company-a',assignedStaffId:'staff-a',assignedStaffName:'Synthetic Staff',dateKey:'2026-09-14',revision:2,status:'assigned',storeName:'Synthetic Store',preContact:null,submissionStatus:{report:{completed:true},salesFloor:{completed:true}},netPrint:{items:[]}});
  h.state.records.set('notificationSettings/company-a',{enabled:true,importantAnnouncementHour:2});
  const before=JSON.stringify([...h.state.records]),reads=h.state.queryReads;
  await h.load('./reminder-scheduler').scheduleOperationalReminders();
  const paused=mode==='paused'||mode==='invalid'||mode===''||mode==='ACTIVE'||(mode===undefined&&app==='staging');
  if(paused){assert.equal(JSON.stringify([...h.state.records]),before);assert.equal(h.state.queryReads,reads);}
  else{assert.ok(h.state.queryReads>reads);assert.equal([...h.state.records.keys()].filter(k=>k.startsWith('notificationQueue/')).length,1);}
  assert.equal(h.state.sent.length,0);
  results.push({name,passed:true});
 }catch(error){results.push({name,passed:false,error:error.message});}
}
assert.equal(cloudCalls,0);
const failed=results.filter(r=>!r.passed);console.log(JSON.stringify({reminderGenerationPauseTests:results.length,passed:results.length-failed.length,failed,cloudCalls,realMessages:0}));if(failed.length)process.exitCode=1;
