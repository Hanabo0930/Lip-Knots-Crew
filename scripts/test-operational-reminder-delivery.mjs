import assert from 'node:assert/strict';
import { setup } from './notification-test-harness.mjs';
const results=[];
async function test(name,run){try{await run();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.stack});}}
function fixture(kind,env={}){
 const at=kind==='precontact'?'2026-09-13T08:00:00+09:00':'2026-09-24T10:45:00+09:00';
 const h=setup(at,env),job={companyId:'company-a',assignedStaffId:'staff-a',assignedStaffName:'Synthetic Staff',dateKey:kind==='precontact'?'2026-09-14':'2026-09-18',revision:2,status:'assigned',storeName:'Synthetic Store',
  preContact:kind==='precontact'?null:{temperature:36.5,arrivalTime:'09:00'},submissionStatus:{report:{completed:true},salesFloor:{completed:true}},netPrint:{items:[]}};
 if(kind==='report')job.submissionStatus.report.completed=false;
 if(kind==='sales-floor')job.submissionStatus.salesFloor.completed=false;
 if(kind==='netprint')job.netPrint={updatedAt:h.Timestamp.fromMillis(Date.parse(at)-3*86400000),items:[{number:'12345678',printed:false}]};
 h.state.records.set('jobs/job-a',job);h.state.records.set('notificationSettings/company-a',{enabled:true,importantAnnouncementHour:2});
 return {h,job,schedule:()=>h.load('./reminder-scheduler').scheduleOperationalReminders(),queues:()=>[...h.state.records].filter(([p])=>p.startsWith('notificationQueue/')).map(([p,d])=>({id:p.split('/')[1],data:d}))};
}
const mutations=[['staff',j=>j.assignedStaffId='staff-b'],['company',j=>j.companyId='company-b'],['date',j=>j.dateKey='2026-09-25'],['revision',j=>j.revision++],['source',j=>j.sourceMissing=true],['pending',j=>j.applicationUnconfirmed=true],['identity',j=>j.assignmentUnresolved=true],['cancel',j=>j.cancelled=true],['status',j=>j.status='open'],['complete',j=>{j.preContact={temperature:36.5,arrivalTime:'09:00'};j.submissionStatus={report:{completed:true},salesFloor:{clientSubmitted:true}};j.netPrint.items.forEach(i=>i.printed=true);}]];
for(const kind of ['precontact','report','sales-floor','netprint']){
 await test(kind+' current reminder sends once with private context excluded',async()=>{const f=fixture(kind);await f.schedule();await f.schedule();const [q]=f.queues();assert.equal(f.queues().length,1);assert.equal(q.data.reminderContext.kind,kind);await f.h.trigger(q.id);await f.h.trigger(q.id);assert.equal(f.h.state.sent.length,1);assert.equal(f.h.document(q.id).status,'completed');assert.equal(f.h.state.sent[0].data.reminderContext,undefined);});
 for(const stage of ['queued','tokens-resolved'])for(const [name,mutate]of mutations)await test(kind+' '+stage+' '+name,async()=>{
  const f=fixture(kind);await f.schedule();const [q]=f.queues();
  const change=()=>mutate(f.h.state.records.get('jobs/job-a'));
  if(stage==='queued')change();else f.h.state.onResolve=change;
  await f.h.trigger(q.id);assert.equal(f.h.state.sent.length,0);assert.equal(f.h.document(q.id).status,'superseded');assert.equal(f.h.document(q.id).supersededReason,'reminder_no_longer_current');
 });
 await test(kind+' cancelled and restored revision reserves a new notice without reviving the old one',async()=>{const f=fixture(kind);await f.schedule();const old=f.queues()[0];f.h.state.records.get('jobs/job-a').revision+=2;await f.schedule();await f.schedule();assert.equal(f.queues().length,2);for(const q of f.queues())await f.h.trigger(q.id);assert.equal(f.h.document(old.id).status,'superseded');assert.equal(f.h.state.sent.length,1);});
}
await test('print replacement after enqueue suppresses the old document prompt',async()=>{const f=fixture('netprint');await f.schedule();f.h.state.records.get('jobs/job-a').netPrint.updatedAt=f.h.Timestamp.now();await f.h.trigger(f.queues()[0].id);assert.equal(f.h.state.sent.length,0);});
for(const invalid of [null,{}, {version:1,jobId:'bad/id'}, {version:2}, {version:1,jobId:'job-a',staffId:'staff-a',dateKey:'2026-09-14',revision:-1,kind:'precontact'}])await test('invalid context '+JSON.stringify(invalid),async()=>{const f=fixture('precontact');await f.schedule();const q=f.queues()[0];f.h.document(q.id).reminderContext=invalid;await f.h.trigger(q.id);assert.equal(f.h.state.sent.length,0);assert.equal(f.h.document(q.id).status,'superseded');});
for(const stage of ['claim','tokens-resolved'])for(const remaining of [0,1,2])await test('quiet digest '+stage+' remaining '+remaining,async()=>{
 const h=setup('2026-09-13T23:00:00+09:00'),ids=[];
 for(let i=0;i<2;i++){
  h.state.records.set('jobs/job-'+i,{companyId:'company-a',assignedStaffId:'staff-a',dateKey:'2026-09-14',revision:1,status:'assigned'});
  ids.push((await h.enqueue({category:'precontact_reminder',dedupeKey:'job-'+i,reminderContext:{version:1,jobId:'job-'+i,staffId:'staff-a',dateKey:'2026-09-14',revision:1,kind:'precontact'}})).queueId);
 }
 const change=()=>{for(let i=remaining;i<2;i++)h.state.records.get('jobs/job-'+i).preContact={temperature:36.5,arrivalTime:'09:00'};};
 if(stage==='claim')change();else h.state.onResolve=change;
 h.setTime('2026-09-14T07:00:00+09:00');await h.tick();
 const digests=[...h.state.records.values()].filter(d=>d.category==='quiet_digest');assert.equal(digests.length,1);
 assert.equal(h.state.sent.length,remaining?1:0);if(remaining)assert.equal(h.state.sent[0].data.body,remaining+'件のお知らせ・対応事項があります。');else assert.equal(digests[0].status,'superseded');
 assert.ok(ids.every(id=>h.document(id).status==='bundled'),'元の予約履歴を削除しない');
});
await test('paused delivery preserves reminder documents and does not inspect jobs or consume queues',async()=>{const active=fixture('report');await active.schedule();const f=fixture('report',{APP_ENVIRONMENT:'staging',LKC_NOTIFICATION_DELIVERY_MODE:'paused'});for(const [key,value] of active.h.state.records)f.h.state.records.set(key,value);assert.equal(f.queues().length,1);const before=JSON.stringify([...f.h.state.records]);f.h.state.onRead=()=>{throw Error('should not read while paused');};await f.h.trigger(f.queues()[0].id);await f.h.tick();assert.equal(JSON.stringify([...f.h.state.records]),before);assert.equal(f.h.state.sent.length,0);});
await test('print notice uses the remaining count after partial completion',async()=>{const f=fixture('netprint');f.job.netPrint.items.push({number:'87654321',printed:false});await f.schedule();f.h.state.onResolve=()=>{f.h.state.records.get('jobs/job-a').netPrint.items[0].printed=true;};await f.h.trigger(f.queues()[0].id);assert.equal(f.h.state.sent.length,1);assert.equal(f.h.state.sent[0].data.body,'1件の資料をできるだけ早く印刷してください。');});
for(const mode of ['current','reassigned','pending','replaced-same-ms','removed','printed'])await test('netprint registration notice '+mode,async()=>{const f=fixture('netprint');f.job.netPrint.writeOperationId='operation-a';const input={category:'netprint_updated',dedupeKey:'registration',title:'ネットプリント番号が届きました',reminderContext:{version:1,kind:'netprint-update',jobId:'job-a',staffId:'staff-a',dateKey:f.job.dateKey,revision:2,printUpdatedAtMs:f.job.netPrint.updatedAt.toMillis(),printWriteOperationId:'operation-a'}};const {queueId}=await f.h.enqueue(input);if(mode==='reassigned')f.job.assignedStaffId='other';if(mode==='pending')f.job.applicationUnconfirmed=true;if(mode==='replaced-same-ms')f.job.netPrint.writeOperationId='operation-b';if(mode==='removed'){f.job.netPrint.items=[];f.h.document(queueId).title='ネットプリント番号が取り消されました';}if(mode==='printed')f.job.netPrint.items[0].printed=true;await f.h.trigger(queueId);assert.equal(f.h.state.sent.length,['current','removed'].includes(mode)?1:0);});
await test('print reminder notices also reject a same-millisecond document replacement',async()=>{const f=fixture('netprint');f.job.netPrint.writeOperationId='operation-a';await f.schedule();f.h.state.onResolve=()=>{f.h.state.records.get('jobs/job-a').netPrint.writeOperationId='operation-b';};await f.h.trigger(f.queues()[0].id);assert.equal(f.h.state.sent.length,0);assert.equal(f.h.document(f.queues()[0].id).status,'superseded');});

function replacementFixture(at='2026-09-24T10:45:00+09:00',env={}){
 const h=setup(at,env),job={companyId:'company-a',assignedStaffId:'staff-a',dateKey:'2026-09-18',revision:3,status:'assigned',submissionStatus:{report:{completed:true}}};
 const request={companyId:'company-a',staffId:'staff-a',jobId:'job-a',type:'report',status:'open'};
 h.state.records.set('jobs/job-a',job);h.state.records.set('resubmissionRequests/request-a',request);
 return {h,job,request,enqueue:()=>h.enqueue({category:'resubmission_request',dedupeKey:'request-a',route:'/resubmissions/request-a',reminderContext:{version:1,kind:'resubmission',jobId:'job-a',staffId:'staff-a',dateKey:'2026-09-18',revision:3,requestId:'request-a',requestType:'report'}})};
}
await test('resubmission notice sends for open request even when original submission is completed',async()=>{const f=replacementFixture(),q=await f.enqueue();await f.h.trigger(q.queueId);await f.h.trigger(q.queueId);assert.equal(f.h.state.sent.length,1);assert.equal(f.h.state.sent[0].data.reminderContext,undefined);assert.equal(f.request.status,'open');});
const replacementMutations=[
 ['job staff',f=>f.job.assignedStaffId='other'],['job company',f=>f.job.companyId='other'],['job date',f=>f.job.dateKey='2026-09-19'],['job revision',f=>f.job.revision++],['job cancelled',f=>f.job.cancelled=true],['job status',f=>f.job.status='cancelled'],
 ...['sourceMissing','applicationUnconfirmed','assignmentUnresolved'].map(flag=>[flag,f=>f.job[flag]=true]),
 ['job missing',f=>f.h.state.records.delete('jobs/job-a')],['request missing',f=>f.h.state.records.delete('resubmissionRequests/request-a')],
 ...['companyId','staffId','jobId','type'].map(field=>['request '+field,f=>f.request[field]='other']),
 ...['submitted','completed','unknown'].map(status=>['request '+status,f=>f.request.status=status]),
];
for(const stage of ['queued','tokens-resolved'])for(const [name,change]of replacementMutations)await test('resubmission '+stage+' '+name,async()=>{const f=replacementFixture(),q=await f.enqueue();if(stage==='queued')change(f);else f.h.state.onResolve=()=>change(f);await f.h.trigger(q.queueId);assert.equal(f.h.state.sent.length,0);assert.equal(f.h.document(q.queueId).status,'superseded');});
for(const [name,change]of [
 ['bad request ID',q=>q.reminderContext.requestId='bad/path'],['missing request ID',q=>delete q.reminderContext.requestId],['bad request type',q=>q.reminderContext.requestType='other'],['missing request type',q=>delete q.reminderContext.requestType],
 ['wrong category',q=>q.category='other'],['wrong route',q=>q.route='/resubmissions/other'],['admin target',q=>{delete q.targetStaffId;q.targetRole='admin';}]
])await test('resubmission malformed queue '+name,async()=>{const f=replacementFixture(),q=await f.enqueue();change(f.h.document(q.queueId));await f.h.trigger(q.queueId);assert.equal(f.h.state.sent.length,0);assert.equal(f.h.document(q.queueId).status,'superseded');});
for(const stage of ['before-digest','tokens-resolved'])for(const status of ['open','submitted','completed'])await test('resubmission quiet digest '+stage+' '+status,async()=>{const f=replacementFixture('2026-09-23T23:00:00+09:00'),q=await f.enqueue();const second={...f.request};f.h.state.records.set('resubmissionRequests/request-b',second);await f.h.enqueue({category:'resubmission_request',dedupeKey:'request-b',route:'/resubmissions/request-b',reminderContext:{...f.h.document(q.queueId).reminderContext,requestId:'request-b'}});const change=()=>{f.request.status=status;second.status=status;};if(stage==='before-digest')change();else f.h.state.onResolve=change;f.h.setTime('2026-09-24T07:00:00+09:00');await f.h.tick();assert.equal(f.h.state.sent.length,status==='open'?1:0);assert.equal(f.h.document(q.queueId).status,'bundled');});
await test('paused resubmission notice stays unchanged without reading job or request',async()=>{const f=replacementFixture(undefined,{APP_ENVIRONMENT:'staging',LKC_NOTIFICATION_DELIVERY_MODE:'paused'}),q=await f.enqueue(),before=JSON.stringify([...f.h.state.records]);f.h.state.onRead=()=>{throw Error('paused read');};await f.h.trigger(q.queueId);await f.h.tick();assert.equal(JSON.stringify([...f.h.state.records]),before);assert.equal(f.h.state.sent.length,0);});


// 実際の依頼作成・提出済み・管理者完了APIが作る値を、そのまま配信処理へ渡す。
for(const timing of ['immediate','quiet'])for(const status of ['open','submitted','completed'])await test('resubmission producer-consumer '+timing+' '+status,async()=>{
 const h=setup(timing==='quiet'?'2026-09-23T23:00:00+09:00':'2026-09-24T10:00:00+09:00');
 h.state.records.set('jobs/job-a',{companyId:'company-a',assignedStaffId:'staff-a',dateKey:'2026-09-18',revision:3,status:'assigned'});
 const api=h.load('./resubmissions'),auth={uid:'admin-a',token:{companyId:'company-a',role:'admin'}},requests=[];
 for(const type of ['report','sales_floor']){
  const request=await api.createResubmissionRequest({auth,data:{jobId:'job-a',type,reasons:['その他'],note:'合成再提出指示'}});requests.push(request);
  if(status!=='open'){
   const submissionId='replacement-'+type;
   h.state.records.set('submissions/'+submissionId,{companyId:'company-a',staffId:'staff-a',jobId:'job-a',type,resubmissionRequestId:request.requestId,totalFiles:2,completedFiles:2,status:'completed',jobStatusApplied:true});
   await api.markResubmissionSubmitted({requestId:request.requestId,submissionId,submittedAt:h.Timestamp.now()});
   if(status==='completed')await api.completeResubmissionRequest({auth,data:request});
  }
 }
 const queues=[...h.state.records].filter(([key])=>key.startsWith('notificationQueue/')).map(([key,data])=>({id:key.split('/')[1],data}));assert.equal(queues.length,2);
 for(const q of queues){assert.equal(q.data.reminderContext.revision,3);assert.equal(q.data.reminderContext.requestId,q.data.dedupeKey);await h.trigger(q.id);}
 if(timing==='quiet'){assert.equal(h.state.sent.length,0);h.setTime('2026-09-24T07:00:00+09:00');await h.tick();}
 assert.equal(h.state.sent.length,status==='open'?(timing==='quiet'?1:2):0);
 if(status==='open')for(const sent of h.state.sent){assert.deepEqual(Array.from(sent.tokens),['synthetic-target']);assert.equal(sent.data.reminderContext,undefined);}
 for(const request of requests)assert.equal(h.state.records.get('resubmissionRequests/'+request.requestId).status,status);
 for(const q of queues)assert.equal(h.document(q.id).status,timing==='quiet'?'bundled':status==='open'?'completed':'superseded');
});
await test('resubmission producer-consumer paused keeps actual new request and queue',async()=>{
 const h=setup('2026-09-24T10:00:00+09:00',{APP_ENVIRONMENT:'staging',LKC_NOTIFICATION_DELIVERY_MODE:'paused'});
 h.state.records.set('jobs/job-a',{companyId:'company-a',assignedStaffId:'staff-a',dateKey:'2026-09-18',revision:3,status:'assigned'});
 const request=await h.load('./resubmissions').createResubmissionRequest({auth:{uid:'admin-a',token:{companyId:'company-a',role:'admin'}},data:{jobId:'job-a',type:'report',reasons:['その他']}});
 const key=[...h.state.records.keys()].find(key=>key.startsWith('notificationQueue/')),before=JSON.stringify([...h.state.records]);
 await h.trigger(key.split('/')[1]);await h.tick();assert.equal(h.state.sent.length,0);assert.equal(JSON.stringify([...h.state.records]),before);assert.equal(h.state.records.get('resubmissionRequests/'+request.requestId).status,'open');
});

const passed=results.filter(r=>r.passed).length;console.log(JSON.stringify({passed,total:results.length,results,scope:'actual scheduler and delivery handlers; synthetic Firestore and FCM only'},null,2));process.exitCode=passed===results.length?0:1;
