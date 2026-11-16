'use strict';

const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(__dirname,'../../pilot-gas/ExpensePilotClient.gs'),'utf8');
function gasPilotFixture() {
 const state={properties:new Map(),requests:[],busy:false,failStore:false,discardStore:false,locksReleased:0,reply:null};
 const context={
  Utilities:{getUuid:()=>crypto.randomUUID()},
  PropertiesService:{getUserProperties:()=>({
   getProperty:key=>state.properties.get(key)??null,
   setProperty(key,value){
    if(state.failStore)throw Error('synthetic properties failure');
    if(!state.discardStore)state.properties.set(key,value);
   },
  })},
  LockService:{getUserLock:()=>({
   tryLock(){if(state.busy)return false;state.busy=true;return true;},
   releaseLock(){assert.equal(state.busy,true);state.busy=false;state.locksReleased++;},
  })},
  UrlFetchApp:{fetch(url,options){
   assert.equal(options.followRedirects,false);
   assert.equal(options.validateHttpsCertificates,true);
   assert.equal(options.muteHttpExceptions,true);
   const request={url,method:options.method,authorization:options.headers.Authorization,
    type:options.contentType,payload:JSON.parse(options.payload)};
   state.requests.push(request);
   const reply=state.reply?.(request);
   if(!reply)throw Error('synthetic connection interrupted');
   return {getResponseCode:()=>reply.code,getContentText:()=>JSON.stringify(reply.body)};
  }},
 };
 const create=vm.runInNewContext(source+'\ncreateCrewExpensePilotClient',context);
 return {state,create};
}
module.exports={gasPilotFixture};
