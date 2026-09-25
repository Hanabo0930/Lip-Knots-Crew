import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), option = name => args[args.indexOf(name)+1];
for (const name of ['--java','--jar','--evidence']) if (!args.includes(name) || !option(name) || option(name).startsWith('--')) throw new Error('Required: --java --jar --evidence');
const suite = args.includes('--suite') ? option('--suite') : 'business';
if (!['business','rules','mail','login-cleanup','row-queue','row-success','creation-journey','received-staff-journey','admin-creation-audit'].includes(suite)) throw new Error('UNKNOWN_LOCAL_ACCEPTANCE_SUITE');
const java = path.resolve(option('--java')), jar = path.resolve(option('--jar')), evidence = path.resolve(option('--evidence'));
const expected = JSON.parse(fs.readFileSync(path.join(root,'node_modules/firebase-tools/lib/emulator/downloadableEmulatorInfo.json'),'utf8')).firestore;
if (fs.statSync(jar).size !== expected.expectedSize || crypto.createHash('sha256').update(fs.readFileSync(jar)).digest('hex') !== expected.expectedChecksumSHA256) throw new Error('EMULATOR_BINARY_MISMATCH');
if (suite !== 'rules' && !fs.existsSync(path.join(root,'functions/lib/jobs.js'))) throw new Error('BUILD_FUNCTIONS_FIRST');
if (fs.existsSync(evidence)) throw new Error('USE_NEW_EVIDENCE_DIRECTORY');
fs.mkdirSync(evidence,{recursive:true});
const isolatedHome=path.join(evidence,'isolated-home');fs.mkdirSync(isolatedHome);
const rules = path.join(evidence,'local.rules');
if (suite === 'rules') fs.copyFileSync(path.join(root,'firestore.rules'),rules);
else fs.writeFileSync(rules,"rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }\n");
const reserve = net.createServer();
await new Promise((resolve,reject)=>{reserve.once('error',reject);reserve.listen(0,'127.0.0.1',resolve);});
const port = reserve.address().port;
await new Promise(resolve=>reserve.close(resolve));
const project = 'demo-lkc-accept-' + crypto.randomBytes(5).toString('hex');
const env = {};
for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','TEMP','TMP','WINDIR']) if (process.env[key]) env[key] = process.env[key];
const emulatorLog = fs.openSync(path.join(evidence,'emulator.log'),'wx');
const emulator = spawn(java,['-Djava.net.preferIPv4Stack=true','-Duser.language=en','-Duser.country=US','-jar',jar,'--host','127.0.0.1','--port',String(port),'--project_id',project,'--single_project_mode','true','--single_project_mode_error','true','--rules',rules],{cwd:evidence,env,windowsHide:true,stdio:['ignore',emulatorLog,emulatorLog]});
let exited = false, startError, activeChild;
const interrupt=()=>{activeChild?.kill();if(!exited)emulator.kill();};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
emulator.on('error',error=>{startError=error;exited=true;});emulator.on('exit',()=>{exited=true;});
const ready = () => new Promise(resolve => {
  const request=http.get({host:'127.0.0.1',port,path:'/',timeout:500},response=>{response.resume();resolve(true);});
  request.on('error',()=>resolve(false));request.on('timeout',()=>{request.destroy();resolve(false);});
});
let code=1;
try {
  const deadline=Date.now()+45000;
  while (!await ready()) {
    if (exited || Date.now()>deadline) throw startError ?? new Error('EMULATOR_START_FAILED');
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  if(exited) throw new Error('EMULATOR_EXITED');
  fs.writeFileSync(path.join(evidence,'runtime.json'),JSON.stringify({project,host:'127.0.0.1',port,firestoreVersion:expected.version,jarSha256:expected.expectedChecksumSHA256,realCloud:false,suite,rulesSha256:crypto.createHash('sha256').update(fs.readFileSync(rules)).digest('hex')},null,2)+'\n');
  const log=fs.openSync(path.join(evidence,'tests.log'),'wx');
  const child=spawn(process.execPath,[path.join(root,suite === 'rules' ? 'scripts/test-local-firestore-rules.mjs' : suite === 'mail' ? 'scripts/test-local-case-mail-acceptance.mjs' : suite === 'login-cleanup' ? 'scripts/test-local-login-cleanup.mjs' : suite === 'row-queue' ? 'scripts/test-local-row-queue.mjs' : suite === 'row-success' ? 'scripts/test-local-row-success.mjs' : suite === 'admin-creation-audit' ? 'scripts/test-local-admin-creation-audit.mjs' : suite === 'received-staff-journey' ? 'scripts/test-local-received-staff-journey.mjs' : suite === 'creation-journey' ? 'scripts/test-local-creation-journey.mjs' : 'scripts/test-local-firestore-acceptance.mjs'),path.join(evidence,'result.json')],{
    cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...env,HOME:isolatedHome,USERPROFILE:isolatedHome,APPDATA:isolatedHome,LOCALAPPDATA:isolatedHome,CLOUDSDK_CONFIG:isolatedHome,METADATA_SERVER_DETECTION:'none',APP_ENVIRONMENT:'development',GCLOUD_PROJECT:project,EXPECTED_FIREBASE_PROJECT_ID:project,
      FIREBASE_CONFIG:JSON.stringify({projectId:project,storageBucket:'synthetic-bucket'}),FIRESTORE_EMULATOR_HOST:'127.0.0.1:'+port,
      LKC_SHEET_WRITE_MODE:'paused',LKC_NOTIFICATION_MODE:'paused',LKC_SUBMISSION_TRANSFER_MODE:'paused',LKC_UPLOAD_ACCEPTANCE_MODE:'paused'}});
  activeChild=child;
  for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{fs.writeSync(log,chunk);process.stdout.write(chunk);});
  const timer=setTimeout(()=>child.kill(),180000);
  try { code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',value=>resolve(value??1));}); }
  finally {clearTimeout(timer);fs.closeSync(log);}
} finally {
  if(!exited) {const stopped=new Promise(resolve=>emulator.once('exit',resolve));emulator.kill();await stopped;}
  fs.closeSync(emulatorLog);
  process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
  fs.writeFileSync(path.join(evidence,'shutdown.json'),JSON.stringify({emulatorStopped:exited,exitCode:code})+'\n');
}
process.exitCode=code;

