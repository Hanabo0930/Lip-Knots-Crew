'use strict';
const {need,pack,casVersion,unpack}=require('./timestamp.cjs');
// Snapshot codec is lossless for supported scalar/array/map/Timestamp values.
// Unsupported SDK objects and reserved-key collisions hold rather than stringify silently.
function encode(v,Timestamp){
  if(v instanceof Timestamp)return {__lkcTimestampV1:pack(v)};
  if(v===null||typeof v==='string'||typeof v==='boolean')return v;
  if(typeof v==='number'){need(Number.isFinite(v),'UNSUPPORTED_DOCUMENT_VALUE');return v;}
  if(Array.isArray(v))return v.map(x=>encode(x,Timestamp));
  need(v&&Object.getPrototypeOf(v)===Object.prototype&&!Object.hasOwn(v,'__lkcTimestampV1'),'UNSUPPORTED_DOCUMENT_VALUE');
  return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x,Timestamp)]));
}
function createFirestorePort({db,Timestamp,FieldValue,companyId,staffIds,maintenance}){
  need(db&&typeof Timestamp==='function'&&typeof FieldValue?.delete==='function','EXPLICIT_SDK_DEPENDENCIES_REQUIRED');
  need(typeof companyId==='string'&&companyId&&Array.isArray(staffIds)&&staffIds.length>0&&new Set(staffIds).size===staffIds.length,'EXACT_PROFILE_SCOPE_REQUIRED');
  need(typeof maintenance?.readWriteFence==='function','SHARED_MAINTENANCE_FENCE_REQUIRED');
  const refs=new Map(staffIds.map(id=>{need(typeof id==='string'&&id.length>0&&!id.includes('/'),'INVALID_STAFF_ID');return [id,db.collection('staffProfiles').doc(id)];}));
  function ref(id){need(refs.has(id),'STAFF_OUTSIDE_APPROVED_SCOPE');return refs.get(id);}
  return {
    async read(id){const snap=await ref(id).get();need(snap.exists&&snap.id===id,'EXISTING_PROFILE_REQUIRED');const data=encode(snap.data(),Timestamp);need(data.companyId===companyId,'PROFILE_COMPANY_CHANGED');return {exists:true,id,data,updateTime:casVersion(snap.updateTime)};},
    async update(id,version,field){
      need(field&&typeof field.present==='boolean'&&Object.keys(field).every(k=>['present','value'].includes(k)),'EXACT_NG_FIELD_REQUIRED');
      if(field.present)need(field.value?.companyId===companyId&&field.value?.staffId===id,'NG_IDENTITY_CHANGED');
      const v=casVersion(version);
      const fence=await maintenance.readWriteFence(id);
      casVersion(fence.updateTime);
      const batch=db.batch();
      batch.update(fence.ref,{ngWriteSequence:fence.sequence+1},{lastUpdateTime:fence.updateTime});
      batch.update(ref(id),{ngCompanies:field.present?field.value:FieldValue.delete()},{lastUpdateTime:unpack(v,Timestamp)});
      const results=await batch.commit();
      return {updateTime:casVersion(results[1].writeTime)};
    },
  };
}
module.exports={createFirestorePort,encode};
