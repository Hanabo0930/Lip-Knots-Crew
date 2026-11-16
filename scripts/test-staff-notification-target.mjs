import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';import {createRequire} from 'node:module';import {resolve} from 'node:path';
const ts=createRequire(resolve(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'))('typescript');const scope={exports:{},URL};runInNewContext(ts.transpileModule(readFileSync('apps/staff/src/notification-target.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,scope);const {notificationTarget:target,openNotificationTarget:open}=scope.exports,origin='https://staff.example.test';
for(const route of [undefined,null,12,{},'https://outside.example.test/path','//outside.example.test','javascript:alert(1)','data:text/html,x','https://[','https://user:secret@staff.example.test/shifts/a'])assert.equal(target(route,origin),origin+'/');
for(const route of ['/shifts/a/netprint','/resubmissions/req','/shifts/a?x=1#detail'])assert.equal(target(route,origin),origin+route);assert.equal(target(origin+'/shifts/a',origin),origin+'/shifts/a');
for(const mode of ['no-window','other-work','exact','exact-closed','home','other-origin','list-failure','open-failure']){
 const events=[],destination=origin+(mode==='home'?'/':'/submissions/a/report');
 const make=(url,fail=false)=>({url,navigate:async()=>assert.fail('Existing work window must not be navigated'),
  focus:async()=>{events.push('focus');if(fail)throw Error('closed');}});
 const clients={matchAll:async options=>{
  assert.equal(options.type,'window');assert.equal(options.includeUncontrolled,true);
  if(mode==='list-failure')throw Error('unavailable');
  if(mode==='exact'||mode==='exact-closed')return [make(destination,mode==='exact-closed')];
  if(mode==='home'||mode==='other-work')return [make(origin+'/shifts/other')];
  if(mode==='other-origin')return [make('https://outside.example.test/submissions/a/report')];
  return [];
 },openWindow:async url=>{assert.equal(url,destination);events.push('open');if(mode==='open-failure')throw Error('blocked');}};
 if(mode==='open-failure')await assert.rejects(open(clients,destination),/blocked/);else await open(clients,destination);
 assert.deepEqual(events,mode==='exact'||mode==='home'?['focus']:mode==='exact-closed'?['focus','open']:['open']);
}
const sw=readFileSync('apps/staff/src/sw.ts','utf8');assert.match(sw,/event.waitUntil\(openNotificationTarget\(self.clients,target\)\)/);
console.log('Notification target passed: 14 URL cases, retained-window focus and separate notification opening and waitUntil connection.');


{
  const {staffSystemNotification,staffForegroundNotice}=scope.exports;
  const owner={companyId:'company-a',staffId:'staff-a',uid:'user-a'};
  const confirmed={title:'勤務先・個人予定',body:'合成店舗、非公開メモ、再提出理由',
    category:'submission_reminder',route:'/submissions/job-a/report',crewAudienceCompanyId:'company-a',
    crewAudienceStaffId:'staff-a',crewAudienceUid:''};
  const old={title:confirmed.title,body:confirmed.body,category:confirmed.category,route:confirmed.route};
  const generic='アプリを開いて、対応事項を確認してください。';
  assert.equal(staffForegroundNotice(confirmed,owner),confirmed.title+'：'+confirmed.body);
  assert.equal(staffForegroundNotice(old,owner),generic);
  assert.equal(staffForegroundNotice(undefined,owner),generic);
  assert.equal(staffForegroundNotice({...confirmed,crewAudienceStaffId:'',crewAudienceUid:'user-a'},owner),confirmed.title+'：'+confirmed.body);
  for(const data of [
    {...confirmed,crewAudienceCompanyId:'other-company'},
    {...confirmed,crewAudienceStaffId:'other-staff'},
    {...confirmed,crewAudienceUid:'other-user'},
    {...confirmed,crewAudienceStaffId:''},
    {...confirmed,crewAudienceCompanyId:undefined},
  ])assert.equal(staffForegroundNotice(data,owner),null);
  const notice=staffSystemNotification(confirmed);
  assert.equal(notice.title,'Lip Knots Crew');
  assert.equal(notice.options.body,generic);
  assert.equal(notice.options.data.route,confirmed.route);
  assert.doesNotMatch(JSON.stringify(notice),/非公開メモ|再提出理由|合成店舗|company-a|staff-a|user-a/);

  const start=sw.indexOf('if (messaging) onBackgroundMessage');
  const end=sw.indexOf('self.addEventListener("notificationclick"',start);
  assert.ok(start>=0&&end>start);
  let receive;
  const displayed=[];
  const ctx={messaging:{},staffSystemNotification,onBackgroundMessage:(_service,handler)=>receive=handler,
    self:{registration:{showNotification:async(title,options)=>displayed.push({title,options})}}};
  runInNewContext(ts.transpileModule(sw.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  await receive({data:confirmed});
  await receive({data:old});
  for(const notification of displayed){
    assert.equal(notification.title,notice.title);
    assert.equal(notification.options.body,generic);
    assert.equal(notification.options.data.route,confirmed.route);
  }

  const push=readFileSync('apps/staff/src/push.ts','utf8');
  const begin=push.indexOf('export async function listenForForegroundPush(');
  assert.ok(begin>=0);
  const code=ts.transpileModule(push.slice(begin),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  let callback,current=true,resolveRegistration;
  const foreground=[],labels=[];
  const registration=new Promise(resolve=>resolveRegistration=resolve);
  const client={exports:{},staffSystemNotification,waitForPushWorker:()=>registration,currentPushPermission:()=> 'granted',
    navigator:{serviceWorker:{}},getClientMessaging:async()=>({}),
    loadMessagingSdk:async()=>({onMessage:(_message,onPayload)=>{callback=onPayload;return()=>{};}})};
  runInNewContext(code,client);
  await client.exports.listenForForegroundPush(payload=>{
    const text=staffForegroundNotice(payload.data,owner);
    if(text===null)return false;
    labels.push(text);
    return true;
  },()=>current);
  callback({data:{...confirmed,crewAudienceStaffId:'other-staff'}});
  assert.equal(labels.length,0);
  callback({data:confirmed});
  assert.deepEqual(labels,[confirmed.title+'：'+confirmed.body]);
  current=false;
  resolveRegistration({showNotification:async(title,options)=>foreground.push({title,options})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(foreground.length,0,'No queued foreground OS preview may appear after this session ends');
  callback({data:confirmed});
  assert.equal(labels.length,1);
  current=true;
  callback({data:old});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(labels.at(-1),generic);
  assert.equal(foreground.length,1);
  assert.equal(foreground[0].options.body,generic);
  console.log('Staff notification privacy: verified audience can see detail in app; legacy and background system previews use neutral copy; old account cannot display queued foreground push.');
}
