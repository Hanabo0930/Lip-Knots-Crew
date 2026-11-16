'use strict';
function need(v,c){if(!v)throw Object.assign(Error(c),{code:c});}
function pack(t){
  need(t&&Number.isSafeInteger(t.seconds)&&t.seconds>=-62135596800&&t.seconds<=253402300799&&Number.isInteger(t.nanoseconds)&&t.nanoseconds>=0&&t.nanoseconds<1e9,'INVALID_TIMESTAMP');
  return {seconds:t.seconds,nanoseconds:t.nanoseconds};
}
function casVersion(t){const v=pack(t);need(v.nanoseconds%1000===0,'PRECONDITION_NOT_MICROSECOND_ALIGNED');return v;}
function unpack(t,Timestamp){const v=pack(t);return new Timestamp(v.seconds,v.nanoseconds);}
function equal(a,b){return !!a&&!!b&&a.seconds===b.seconds&&a.nanoseconds===b.nanoseconds;}
// ISO is only for the existing pure planner. CAS uses the exact pair above.
function iso(t){const v=pack(t);return new Date(v.seconds*1000).toISOString().slice(0,19)+'.'+String(v.nanoseconds).padStart(9,'0')+'Z';}
module.exports={pack,casVersion,unpack,equal,iso,need};
