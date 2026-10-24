// Verification-only service ports. The actual main.tsx, App, React, hooks and stores are mounted.
export const syntheticPorts = `
const listeners=new Set();
const makeUser=uid=>({uid,displayName:'Synthetic staff',emailVerified:true,getIdToken:async()=> 'synthetic-unused-token'});
export const auth={currentUser:makeUser('synthetic-owner-a')};
export const authPersistenceReady=Promise.resolve();
export const firebaseConfigured=true, db={}, functions={}, firebaseApp={};
export const getClientMessaging=async()=>null;
const held=new Map();
window.__fixture={
  pause(name){held.set(name,{});},
  release(name){const h=held.get(name);held.delete(name);h?.resolve?.();},
  entered:[],
  switchOwner(uid){auth.currentUser=makeUser(uid);for(const cb of listeners)cb(auth.currentUser);},
};
export function onAuthStateChanged(_auth,callback){listeners.add(callback);queueMicrotask(()=>{if(listeners.has(callback))callback(auth.currentUser);});return()=>listeners.delete(callback);}
export const getIdTokenResult=async()=>({claims:{companyId:'synthetic-company',staffId:'synthetic-staff'}});
export const isSignInWithEmailLink=()=>false;
export const signInWithEmailLink=async()=>{throw Error('Not part of synthetic test');};
export async function signOut(){auth.currentUser=null;for(const cb of listeners)cb(null);}
export function httpsCallable(_functions,name){return async payload=>{
  window.__fixture.entered.push(name);
  const h=held.get(name);if(h)await new Promise(resolve=>{h.resolve=resolve;});
  return {data:await window.__mockApi({name,payload,uid:auth.currentUser?.uid})};
};}
const date=new Date();date.setDate(date.getDate()+1);
const dateKey=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
export const job={id:'synthetic-job',companyId:'synthetic-company',assignedStaffId:'synthetic-staff',workDate:dateKey,dateKey,clientName:'Synthetic client',makerName:'Synthetic maker',menuName:'Synthetic work',storeName:'Synthetic store',workTime:'10:00-18:00',basePay:10000,status:'assigned',submissionStatus:{},netPrint:{items:[]}};
export const collection=(_db,...path)=>({path});
export const doc=(_db,...path)=>({path});
export const where=(field,op,value)=>({field,op,value});
export const orderBy=(...args)=>({order:args});
export const limit=count=>({limit:count});
export const startAfter=cursor=>({cursor});
export const query=(collection,...filters)=>({collection,filters});
const jobSnapshot=()=>({id:job.id,data:()=>({...job}),exists:()=>true});
export const getDocs=async q=>({docs:q.filters?.some(f=>f.op==='<'||f.field==='status'&&f.value==='open')?[]:[jobSnapshot()],empty:false});
export const getDocsFromServer=getDocs;
export const getDocFromServer=async()=>jobSnapshot();
export const onSnapshot=(_ref,_next)=>()=>{};
export const getStorage=()=>({});
export const connectStorageEmulator=()=>{throw Error('Emulator forbidden in test');};
export const ref=(_storage,path)=>({path});
export const uploadBytesResumable=(target,file)=>({on(_event,progress,reject,done){
  Promise.resolve().then(()=>window.__mockUpload({path:target.path,name:file.name,size:file.size})).then(()=>{progress({bytesTransferred:file.size,totalBytes:file.size});done();},reject);
}});
export const currentPushPermission=()=> 'unsupported';
export const listenForForegroundPush=async()=>null;
export const loadServerPushStatusWithRetry=async()=>({enabled:false});
export const refreshPushNotifications=async()=>({enabled:false});
export const enablePushNotifications=async()=>{throw Error('Push forbidden in test');};
export const disablePushNotifications=async()=>{throw Error('Push forbidden in test');};
export const loadTestPushStatus=async()=>{throw Error('Push forbidden in test');};
export const requestTestPush=async()=>{throw Error('Push forbidden in test');};
export const registerSW=()=>()=>Promise.resolve();
`;

export function fixturePortsPlugin(){
  const id='\0synthetic-service-ports';
  return {name:'isolated-synthetic-service-ports',enforce:'pre',resolveId(source,importer){
    if(source.startsWith('firebase/')||source==='virtual:pwa-register'||
       (importer?.replaceAll('\\','/').includes('/apps/staff/src/')&&['./firebase','./push'].includes(source)))return id;
  },load(source){if(source===id)return syntheticPorts;}};
}
