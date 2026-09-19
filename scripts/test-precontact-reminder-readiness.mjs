import assert from "node:assert/strict";
import {setup} from "./notification-test-harness.mjs";
const results=[],observedBefore=[];
const slots=[
 ["three-days","2026-09-11T09:00:00+09:00","2026-09-14"],
 ["day-before-morning","2026-09-13T08:00:00+09:00","2026-09-14"],
 ["day-before-noon","2026-09-13T12:00:00+09:00","2026-09-14"],
 ["day-before-deadline","2026-09-13T15:00:00+09:00","2026-09-14"]
];
function fixture(at,dateKey,flag){
 const h=setup(at),job={companyId:"company-a",assignedStaffId:"staff-a",assignedStaffName:"Synthetic Staff",status:"assigned",dateKey,storeName:"Synthetic Store",
  ...(flag?{[flag]:true}:{}),submissionStatus:{report:{completed:true},salesFloor:{completed:true}},netPrint:{items:[]}};
 h.state.records.set("notificationSettings/company-a",{enabled:true,importantAnnouncementHour:2});
 h.state.records.set("jobs/synthetic-job",job);
 return {h,job,schedule:()=>h.load("./reminder-scheduler").scheduleOperationalReminders(),
  tasks:()=>h.load("./staff-tasks").getMyTasks({auth:{uid:"synthetic-staff",token:{companyId:"company-a",staffId:"staff-a",role:"staff"}},data:{}}),
  notices:()=>[...h.state.records].filter(([key,value])=>key.startsWith("notificationQueue/")&&["precontact_reminder","precontact_late"].includes(value.category)).map(([,value])=>value)};
}
async function test(name,run){try{await run();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.stack});}}
await test("ready assignment retains the existing reminder and task",async()=>{
 const f=fixture(slots[0][1],slots[0][2]);await f.schedule();assert.equal(f.notices().length,1);
 const task=(await f.tasks()).tasks.find(task=>task.kind==="precontact");assert.equal(task.title,"事前連絡を送ってください");assert.equal(typeof task.dueAtMs,"number");assert.deepEqual(f.h.state.sent,[]);
});
for(const [flag,reason] of [["sourceMissing","取込状況"],["applicationUnconfirmed","担当確認待ち"],["assignmentUnresolved","担当者の照合待ち"]])for(const [slot,at,dateKey] of slots)await test(flag+" / "+slot,async()=>{
 const f=fixture(at,dateKey,flag),waiting=(await f.tasks()).tasks.find(task=>task.kind==="precontact");await f.schedule();
 observedBefore.push({flag,slot,taskTitle:waiting?.title,priority:waiting?.priority,dueAtMs:waiting?.dueAtMs,queued:f.notices().length,late:f.h.state.records.get("jobs/synthetic-job").preContactLate===true});
 assert.equal(f.notices().length,0,"確認前に事前連絡の催促を予約しない");assert.notEqual(f.h.state.records.get("jobs/synthetic-job").preContactLate,true,"確認前に締切超過を記録しない");
 assert.match(waiting.title,new RegExp(reason));assert.equal(waiting.priority,"normal");assert.equal(waiting.dueAtMs,null);
 f.h.state.records.get("jobs/synthetic-job")[flag]=false;
 const ready=(await f.tasks()).tasks.find(task=>task.kind==="precontact");assert.equal(ready.title,"事前連絡を送ってください");assert.equal(typeof ready.dueAtMs,"number");
 await f.schedule();assert.equal(f.notices().length,1);assert.equal(f.notices()[0].category,slot==="day-before-deadline"?"precontact_late":"precontact_reminder");
 assert.equal(f.h.state.records.get("jobs/synthetic-job").preContactLate===true,slot==="day-before-deadline");
 await f.schedule();assert.equal(f.notices().length,1,"同じ時刻の再予約で通知を重複しない");assert.deepEqual(f.h.state.sent,[]);
});

for(const [name,change] of [
 ["confirmation-pending",job=>{job.applicationUnconfirmed=true;}],
 ["reassigned",job=>{job.assignedStaffId="other-staff";}],
 ["work-date-changed",job=>{job.dateKey="2026-09-15";}],
 ["company-changed",job=>{job.companyId="other-company";}],
 ["cancelled",job=>{job.cancelled=true;job.status="cancelled";}],
 ["contact-submitted",job=>{job.preContact={temperature:36.7,arrivalTime:"09:30"};}]
])await test("queue read race: "+name,async()=>{
 const f=fixture(slots[3][1],slots[3][2]);let changed=false,expected;
 f.h.state.onRead=async path=>{if(!changed&&path.startsWith("notificationQueue/")){changed=true;change(f.h.state.records.get("jobs/synthetic-job"));expected=JSON.stringify(f.h.state.records.get("jobs/synthetic-job"));}};
 await f.schedule();assert.equal(changed,true);assert.equal(f.notices().length,0);assert.notEqual(f.h.state.records.get("jobs/synthetic-job").preContactLate,true);
 assert.equal(JSON.stringify(f.h.state.records.get("jobs/synthetic-job")),expected);assert.ok(f.h.state.transactionRetries>0);assert.deepEqual(f.h.state.sent,[]);
});
await test("queue retry builds the notice from the current store and staff display",async()=>{
 const f=fixture(slots[3][1],slots[3][2]);let changed=false;
 f.h.state.onRead=async path=>{if(!changed&&path.startsWith("notificationQueue/")){changed=true;Object.assign(f.h.state.records.get("jobs/synthetic-job"),{storeName:"Updated Store",assignedStaffName:"Updated Staff"});}};
 await f.schedule();assert.equal(f.notices().length,1);assert.equal(f.notices()[0].body,"Updated Staff / Updated Store");assert.ok(f.h.state.transactionRetries>0);assert.deepEqual(f.h.state.sent,[]);
});
await test("failed queue commit saves no late marker and a later retry commits both",async()=>{
 const f=fixture(slots[3][1],slots[3][2]),before=JSON.stringify(f.h.state.records.get("jobs/synthetic-job"));
 f.h.state.suppressExpectedErrors=true;f.h.state.onBeforeCommit=writes=>{if(writes.some(([path])=>path.startsWith("notificationQueue/")))throw Error("synthetic precontact queue commit failure");};
 await f.schedule();assert.equal(f.notices().length,0);assert.equal(JSON.stringify(f.h.state.records.get("jobs/synthetic-job")),before);assert.equal(f.h.state.errors.length,1);
 f.h.state.onBeforeCommit=null;f.h.state.suppressExpectedErrors=false;await f.schedule();
 assert.equal(f.notices().length,1);assert.equal(f.h.state.records.get("jobs/synthetic-job").preContactLate,true);assert.equal(f.h.state.errors.length,1);assert.deepEqual(f.h.state.sent,[]);
});

for(const [at,dateKey,expectedCount,category] of [
 ["2026-09-24T10:45:00+09:00","2026-09-18",2,"submission_reminder"],
 ["2026-09-24T11:00:00+09:00","2026-09-18",4,"submission_overdue"],
 ["2026-05-07T10:45:00+09:00","2026-05-01",2,"submission_reminder"],
 ["2027-01-04T10:45:00+09:00","2026-12-31",2,"submission_reminder"],
 ["2026-09-19T10:45:00+09:00","2026-09-18",0,null],
 ["2026-09-21T10:45:00+09:00","2026-09-18",0,null],
 ["2099-09-21T10:45:00+09:00","2099-09-20",0,null]
])await test("business-day submission reminders "+at,async()=>{
 const f=fixture(at,dateKey);f.job.submissionStatus={};f.job.preContact={temperature:36.5,arrivalTime:"09:30"};
 await f.schedule();const notices=[...f.h.state.records].filter(([key,value])=>key.startsWith("notificationQueue/")&&value.category.startsWith("submission_")).map(([,value])=>value);
 assert.equal(notices.length,expectedCount);if(category)assert.ok(notices.every(n=>n.category===category));assert.deepEqual(f.h.state.sent,[]);
 await f.schedule();assert.equal([...f.h.state.records].filter(([key,value])=>key.startsWith("notificationQueue/")&&value.category.startsWith("submission_")).length,expectedCount);
});
await test("unpublished calendar keeps submission tasks visible without false lateness",async()=>{
 const f=fixture("2099-09-21T11:00:00+09:00","2099-09-20");f.job.submissionStatus={};f.job.preContact={temperature:36.5,arrivalTime:"09:30"};
 const tasks=(await f.tasks()).tasks.filter(t=>t.kind==="report"||t.kind==="sales_floor");
 assert.equal(tasks.length,2);assert.ok(tasks.every(t=>t.dueAtMs===null&&t.priority==="normal"&&t.body.includes("提出期限は確認中")));assert.deepEqual(f.h.state.sent,[]);
});

for(const flag of ['sourceMissing','applicationUnconfirmed','assignmentUnresolved'])for(const time of ['2026-09-24T10:45:00+09:00','2026-09-24T11:00:00+09:00'])await test('pending '+flag+' suppresses print and submission prompts '+time,async()=>{const f=fixture(time,'2026-09-18',flag);f.job.submissionStatus={};f.job.preContact={temperature:36.5,arrivalTime:'09:30'};f.job.netPrint={items:[{number:'12345678',printed:false}],updatedAt:f.h.Timestamp.fromMillis(Date.parse(time)-3*86400000)};await f.schedule();assert.equal([...f.h.state.records.keys()].filter(k=>k.startsWith('notificationQueue/')).length,0);const tasks=(await f.tasks()).tasks;assert.equal(tasks.length,1);assert.equal(tasks[0].kind,'precontact');assert.equal(tasks[0].priority,'normal');assert.equal(tasks[0].dueAtMs,null);f.job[flag]=false;await f.schedule();assert.ok([...f.h.state.records.keys()].some(k=>k.startsWith('notificationQueue/')));assert.deepEqual(f.h.state.sent,[]);});
for(const kind of ['submission','print'])for(const [name,change] of [
 ['pending',j=>{j.applicationUnconfirmed=true;}],['source-missing',j=>{j.sourceMissing=true;}],
 ['unresolved',j=>{j.assignmentUnresolved=true;}],['reassigned',j=>{j.assignedStaffId='other-staff';}],
 ['date-changed',j=>{j.dateKey='2026-09-25';}],['company-changed',j=>{j.companyId='company-b';}],
 ['cancelled',j=>{j.cancelled=true;}],['returned-to-open',j=>{j.status='open';}],
 ['revision-changed',j=>{j.revision=1;}],['invalid-revision',j=>{j.revision=-1;}],
 ['completed',j=>{j.submissionStatus={report:{completed:true},salesFloor:{clientSubmitted:true}};j.netPrint.items.forEach(i=>i.printed=true);}],
])await test(kind+' reminder transaction race '+name,async()=>{
 const at='2026-09-24T11:00:00+09:00',f=fixture(at,'2026-09-18');f.job.preContact={temperature:36.5,arrivalTime:'09:30'};
 if(kind==='submission')f.job.submissionStatus={};else f.job.netPrint={updatedAt:f.h.Timestamp.fromMillis(Date.parse(at)-3*86400000),items:[{number:'12345678'}]};
 let changed=false;f.h.state.onRead=async path=>{if(!changed&&path.startsWith('notificationQueue/')){changed=true;const j=f.h.state.records.get('jobs/synthetic-job');if(!j.netPrint)j.netPrint={items:[]};change(j);}};
 await f.schedule();assert.equal(changed,true);assert.equal([...f.h.state.records.keys()].filter(k=>k.startsWith('notificationQueue/')).length,0);assert.ok(f.h.state.transactionRetries>0);assert.deepEqual(f.h.state.sent,[]);
});
await test('print revision changed while scheduling does not remind for replaced documents',async()=>{
 const at='2026-09-24T11:00:00+09:00',f=fixture(at,'2026-09-18');f.job.preContact={temperature:36.5,arrivalTime:'09:30'};f.job.netPrint={updatedAt:f.h.Timestamp.fromMillis(Date.parse(at)-3*86400000),items:[{number:'12345678'}]};let changed=false;
 f.h.state.onRead=async p=>{if(!changed&&p.startsWith('notificationQueue/')){changed=true;f.h.state.records.get('jobs/synthetic-job').netPrint.updatedAt=f.h.Timestamp.now();}};
 await f.schedule();assert.equal(changed,true);assert.equal([...f.h.state.records.keys()].filter(k=>k.startsWith('notificationQueue/')).length,0);assert.ok(f.h.state.transactionRetries>0);
});
await test('submission completion between staff and admin enqueue suppresses the obsolete admin notice',async()=>{
 const f=fixture('2026-09-24T11:00:00+09:00','2026-09-18');f.job.preContact={temperature:36.5,arrivalTime:'09:30'};f.job.submissionStatus={report:{completed:true}};let changed=false;
 f.h.state.onBeforeCommit=writes=>{if(!changed&&writes.length===0&&[...f.h.state.records].some(([p,d])=>p.startsWith('notificationQueue/')&&d.targetStaffId)){changed=true;f.h.state.records.get('jobs/synthetic-job').submissionStatus.salesFloor={completed:true};}};
 // 最初の予約が確定した直後、次の案件読込より前に提出を完了する。
 const prior=f.h.state.onRead;f.h.state.onRead=async p=>{await prior?.(p);if(!changed&&p==='jobs/synthetic-job'&&[...f.h.state.records].some(([p,d])=>p.startsWith('notificationQueue/')&&d.targetStaffId)){changed=true;f.h.state.records.get('jobs/synthetic-job').submissionStatus.salesFloor={completed:true};}};
 await f.schedule();const notices=[...f.h.state.records].filter(([p])=>p.startsWith('notificationQueue/')).map(([,d])=>d);assert.equal(changed,true);assert.equal(notices.length,1);assert.equal(notices[0].targetStaffId,'staff-a');assert.deepEqual(f.h.state.sent,[]);
});
const passed=results.filter(result=>result.passed).length;console.log(JSON.stringify({passed,total:results.length,results,observedBefore,scope:"Actual getMyTasks and scheduleOperationalReminders with synthetic Firestore/clock; queue generation only, no notification delivery"},null,2));process.exitCode=passed===results.length?0:1;
