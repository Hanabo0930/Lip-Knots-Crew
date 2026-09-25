import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {localAcceptanceEnvironment,blockNonEmulatorConnections} from './local-firestore-acceptance-safety.mjs';
const environment=localAcceptanceEnvironment(process.env);
const network=blockNonEmulatorConnections(environment.port);
const require=createRequire(import.meta.url);
const adminApp=require('firebase-admin/app');
const adminStore=require('firebase-admin/firestore');
const appApi=require('firebase/app');
const clientApi=require('firebase/firestore');
const app=adminApp.initializeApp({projectId:environment.project});
const seed=adminStore.getFirestore(app), clients=[], results=[];
function client(name,claims) {
  const app=appApi.initializeApp({projectId:environment.project,apiKey:'synthetic-emulator-key'},name);
  const db=clientApi.initializeFirestore(app,{});
  clientApi.connectFirestoreEmulator(db,environment.host,environment.port,claims ? {mockUserToken:{sub:name,...claims}} : {});
  clients.push({app,db});return db;
}
const staff=client('staff-a',{role:'staff',companyId:'company-a',staffId:'staff-a'});
const otherStaff=client('staff-other',{role:'staff',companyId:'company-a',staffId:'staff-other'});
const manager=client('admin-a',{role:'admin',companyId:'company-a'});
const anotherManager=client('admin-other',{role:'admin',companyId:'company-a'});
const managerB=client('admin-b',{role:'admin',companyId:'company-b'});
const staleStaff=client('staff-stale',{role:'staff',companyId:'company-a',staffId:'staff-b'});
const anonymous=client('anonymous');
const read=(db,path)=>clientApi.getDocFromServer(clientApi.doc(db,path));
const list=(db,name,...filters)=>clientApi.getDocsFromServer(clientApi.query(clientApi.collection(db,name),...filters.map(([field,value])=>clientApi.where(field,'==',value))));
const denied=promise=>assert.rejects(promise,error=>error.code==='permission-denied');
async function test(name,fn) {
  try {await fn();results.push({name,passed:true});console.log('PASS '+name);}
  catch(error) {results.push({name,passed:false,error:String(error.stack??error)});console.error('FAIL '+name+' '+error.message);}
}
try {
  // 合成データの準備だけAdmin SDKを使い、判定対象は必ずクライアントSDK経由にする。
  const batch=seed.batch();
  const docs={
    'staffProfiles/staff-a':{companyId:'company-a',active:true},
    'staffProfiles/staff-other':{companyId:'company-a',active:true},
    'staffProfiles/staff-b':{companyId:'company-b',active:true},
    'jobs/open-a':{companyId:'company-a',status:'open',assignedStaffId:null},
    'jobs/open-b':{companyId:'company-b',status:'open',assignedStaffId:null},
    'jobs/assigned-other':{companyId:'company-a',status:'assigned',assignedStaffId:'staff-other'},
    'tasks/own':{companyId:'company-a',staffId:'staff-a'},
    'tasks/other':{companyId:'company-a',staffId:'staff-other'},
    'submissions/own':{companyId:'company-a',staffId:'staff-a'},
    'submissions/own/files/file':{companyId:'company-a',staffId:'staff-a'},
    'submissions/other':{companyId:'company-b',staffId:'staff-a'},
    'announcementReceipts/own':{companyId:'company-a',staffId:'staff-a'},
    'announcementReceipts/same-company-other':{companyId:'company-a',staffId:'staff-other'},
    'announcementReceipts/foreign':{companyId:'company-b',staffId:'staff-a'},
    'announcementReceipts/legacy':{staffId:'staff-a'},
    'deviceSessions/own':{companyId:'company-a',staffId:'staff-a',active:true},
    'deviceSessions/foreign':{companyId:'company-b',staffId:'staff-a',active:true},
    'deviceSessions/legacy':{staffId:'staff-a',active:true},
    'nativeJobCreationReceipts/synthetic-own':{version:1,companyId:'company-a',actorUid:'admin-a',operationId:'synthetic-operation',kind:'create',status:'committed'},
    'sheetSyncQueue/own':{companyId:'company-a',status:'pending'},
    'sheetSyncQueue/foreign':{companyId:'company-b',status:'pending'},
  };
  for (const [path,data] of Object.entries(docs))batch.set(seed.doc(path),data);
  await batch.commit();
  await test('未認証の案件読取を拒否',()=>denied(read(anonymous,'jobs/open-a')));
  await test('自社の公開案件をスタッフが読める',async()=>assert.ok((await read(staff,'jobs/open-a')).exists()));
  await test('他社の公開案件を拒否',()=>denied(read(staff,'jobs/open-b')));
  await test('他人の担当案件を拒否',()=>denied(read(staff,'jobs/assigned-other')));
  await test('本人の対応事項を読める',async()=>assert.ok((await read(staff,'tasks/own')).exists()));
  await test('他人の対応事項を拒否',()=>denied(read(staff,'tasks/other')));
  await test('本人の提出ファイルを読める',async()=>assert.ok((await read(staff,'submissions/own/files/file')).exists()));
  await test('他社の同staffId提出を拒否',()=>denied(read(staff,'submissions/other')));
  await test('管理者が自社の既読記録を読める',async()=>assert.ok((await read(manager,'announcementReceipts/own')).exists()));
  await test('管理者が他社の既読記録を直接読めない',()=>denied(read(manager,'announcementReceipts/foreign')));
  await test('管理者が他社の既読記録を検索できない',()=>denied(list(manager,'announcementReceipts',['companyId','company-b'])));
  await test('管理者の会社条件なし既読一覧を拒否',()=>denied(list(manager,'announcementReceipts')));
  await test('管理者の自社既読一覧は成功',async()=>assert.equal((await list(manager,'announcementReceipts',['companyId','company-a'])).size,2));
  await test('別会社の管理者も自社の既読記録だけ読める',async()=>assert.ok((await read(managerB,'announcementReceipts/foreign')).exists()));
  await test('本人の既読記録を読める',async()=>assert.ok((await read(staff,'announcementReceipts/own')).exists()));
  await test('同社でも他人の既読記録を拒否',()=>denied(read(otherStaff,'announcementReceipts/own')));
  await test('スタッフの他社同staffId既読記録を拒否',()=>denied(read(staff,'announcementReceipts/foreign')));
  await test('会社情報がない旧既読記録を拒否',()=>denied(read(staff,'announcementReceipts/legacy')));
  await test('本人端末の失効監視用データを読める',async()=>assert.ok((await read(staff,'deviceSessions/own')).exists()));
  await test('他社同staffId端末を拒否',()=>denied(read(staff,'deviceSessions/foreign')));
  await test('会社情報がない旧端末を拒否',()=>denied(read(staff,'deviceSessions/legacy')));
  await test('スタッフの会社条件なし端末一覧を拒否',()=>denied(list(staff,'deviceSessions',['staffId','staff-a'])));
  await test('スタッフの本人かつ自社端末一覧は成功',async()=>assert.equal((await list(staff,'deviceSessions',['companyId','company-a'],['staffId','staff-a'])).size,1));
  await test('管理者の自社同期キュー読取は成功',async()=>assert.ok((await read(manager,'sheetSyncQueue/own')).exists()));
  await test('管理者の他社同期キュー読取を拒否',()=>denied(read(manager,'sheetSyncQueue/foreign')));
  await test('スタッフの同期キュー読取を拒否',()=>denied(read(staff,'sheetSyncQueue/own')));
  await test('会社とstaffProfileが不一致の古いclaimを拒否',()=>denied(read(staleStaff,'jobs/open-a')));
  await test('スタッフの業務データ直接書換えを拒否',()=>denied(clientApi.setDoc(clientApi.doc(staff,'jobs/open-a'),{companyId:'company-a',status:'assigned'})));
  await test('管理者の業務データ直接書換えも拒否',()=>denied(clientApi.setDoc(clientApi.doc(manager,'announcementReceipts/own'),{companyId:'company-a',staffId:'staff-a'})));
  // 受領記録は同じ管理者本人でもクライアントから変更できない。
  for(const [role,db] of [['依頼した管理者',manager],['同社の別管理者',anotherManager],['別会社の管理者',managerB],['スタッフ',staff],['未認証',anonymous]]) {
    const path='nativeJobCreationReceipts/synthetic-own';
    await test(role+'の作成受領記録直接読取を拒否',()=>denied(read(db,path)));
    await test(role+'の会社条件付き作成受領記録一覧を拒否',()=>denied(list(db,'nativeJobCreationReceipts',['companyId','company-a'])));
    await test(role+'の作成受領記録新規作成を拒否',()=>denied(clientApi.setDoc(clientApi.doc(db,'nativeJobCreationReceipts/new-'+role),{companyId:'company-a',actorUid:'admin-a',status:'cancelled'})));
    await test(role+'の作成受領記録更新を拒否',()=>denied(clientApi.updateDoc(clientApi.doc(db,path),{status:'cancelled'})));
    await test(role+'の作成受領記録削除を拒否',()=>denied(clientApi.deleteDoc(clientApi.doc(db,path))));
  }
  await seed.doc('staffProfiles/staff-a').update({active:false});
  await test('停止済みスタッフの案件読取を拒否',()=>denied(read(staff,'jobs/open-a')));
  await seed.doc('staffProfiles/staff-a').update({active:true});
  await seed.doc('authIdentities/staff-a').set({active:false,companyId:'company-a',staffId:'staff-a'});
  await test('失効済み本人identityの読取を拒否',()=>denied(read(staff,'tasks/own')));
  await seed.doc('authIdentities/staff-a').set({active:true,companyId:'company-b',staffId:'staff-a'});
  await test('最新identityが別会社なら古いclaimを拒否',()=>denied(read(staff,'tasks/own')));
  await seed.doc('authIdentities/staff-a').set({active:true,companyId:'company-a',staffId:'staff-other'});
  await test('最新identityが別スタッフなら古いclaimを拒否',()=>denied(read(staff,'tasks/own')));
  await seed.doc('authIdentities/staff-a').set({active:true,staffId:'staff-a'});
  await test('会社情報のないidentityを拒否',()=>denied(read(staff,'tasks/own')));
  await seed.doc('authIdentities/staff-a').set({active:true,companyId:'company-a'});
  await test('本人情報のないidentityを拒否',()=>denied(read(staff,'tasks/own')));
  await seed.doc('authIdentities/staff-a').set({active:true,companyId:'company-a',staffId:'staff-a'});
  await test('会社と本人が一致する有効identityは許可',async()=>assert.ok((await read(staff,'tasks/own')).exists()));
  await seed.doc('authIdentities/staff-a').delete();
  await test('identity未作成の既存互換経路は維持',async()=>assert.ok((await read(staff,'tasks/own')).exists()));

} finally {
  for(const {db,app} of clients){await clientApi.terminate(db);await appApi.deleteApp(app);}
  await seed.terminate();await adminApp.deleteApp(app);
  const stats=network.stats();network.restore();
  const result={project:environment.project,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length+(stats.blocked?1:0),network:stats,
    rulesEngine:'real Firestore emulator',authentication:'synthetic emulator claims; actual token verification and deployed Rules not certified',cloudWrites:0,actualMessagesSent:0,results};
  fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({passed:result.passed,failed:result.failed,network:stats,cloudWrites:0}));
  if(result.failed)process.exitCode=1;
}
