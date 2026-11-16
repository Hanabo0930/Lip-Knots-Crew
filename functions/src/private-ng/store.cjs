'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {need}=require('./timestamp.cjs');
const {assertJournalCapacity,recordSize}=require('./capacity.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
const empty=()=>({schema:'LKC_NG_JOURNAL_V1',records:{},locks:{}});
function validate(s){need(s?.schema==='LKC_NG_JOURNAL_V1'&&s.records&&s.locks,'JOURNAL_SCHEMA_INVALID');}
function access(transact,read){
  return {
    read:async id=>{const s=await read();validate(s);need(s.records[id],'OPERATION_NOT_FOUND');return copy(s.records[id]);},
    create:async record=>transact(s=>{
      validate(s);need(!s.records[record.id],'OPERATION_EXISTS');
      need(Object.keys(s.records).length<32,'JOURNAL_CAPACITY_REVIEW_REQUIRED');
      for(const m of record.members)need(!s.locks[m.key],'TARGET_LOCKED');
      s.records[record.id]=copy({...record,revision:1});
      s.records[record.id].capacityBaseBytes=recordSize(s.records[record.id]);
      for(const m of record.members)s.locks[m.key]=record.id;
      assertJournalCapacity(s);return s.records[record.id];
    }),
    change:async(id,revision,transform)=>transact(s=>{
      validate(s);const r=s.records[id];need(r&&r.revision===revision,'JOURNAL_CAS_CONFLICT');
      for(const m of r.members)need(s.locks[m.key]===id,'TARGET_LOCK_LOST');
      const next=transform(copy(r));need(next.id===id&&JSON.stringify(next.members.map(m=>m.key))===JSON.stringify(r.members.map(m=>m.key)),'JOURNAL_TARGET_CHANGED');
      s.records[id]=copy({...next,revision:r.revision+1});assertJournalCapacity(s);return s.records[id];
    }),
  };
}
// Local synthetic durability port. A crashed filesystem mutex is NEVER stolen.
// Atomic rename + fsync file; hardware/power-loss and network filesystems are not certified.
function fileStore(directory,{initialize=false}={}){
  fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'journal.json'),mutex=path.join(directory,'journal.mutex');
  if(initialize&&!fs.existsSync(file)){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(empty()));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
  return access(async fn=>{
    try{fs.mkdirSync(mutex);}catch(e){if(e.code==='EEXIST')throw Object.assign(Error('JOURNAL_MUTEX_BUSY_RECONCILE_REQUIRED'),{code:'JOURNAL_MUTEX_BUSY_RECONCILE_REQUIRED'});throw e;}
    try{
      const s=read(),out=fn(s),tmp=path.join(directory,randomUUID()+'.tmp');
      const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(s));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(tmp,file);return copy(out);
    }finally{fs.rmdirSync(mutex);}
  },read);
}
// No SDK initialization, collection selection, provisioning, credentials or calls at import.
// A separately approved journal document must already exist. All claim/state writes share
// one Firestore transaction; transaction retries contain only pure local transformations.
function firestoreStore(db,journalRef,options={}){
  need(typeof db?.runTransaction==='function'&&journalRef?.firestore===db,'EXPLICIT_JOURNAL_REFERENCE_REQUIRED');
  return access(fn=>db.runTransaction(async tx=>{
    const snap=await tx.get(journalRef);need(snap.exists,'JOURNAL_NOT_PROVISIONED');
    const state=snap.data();const result=fn(state);if(options.beforeWrite)await options.beforeWrite();tx.update(journalRef,state);return copy(result);
  }),async()=>{const snap=await journalRef.get();need(snap.exists,'JOURNAL_NOT_PROVISIONED');return snap.data();});
}
module.exports={fileStore,firestoreStore,empty};
