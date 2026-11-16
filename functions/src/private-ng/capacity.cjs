'use strict';
// Conservative local resource ceiling; no record deletion/retention decisions.
const LIMIT=512*1024,RESERVE=64*1024;
function size(value){const raw=JSON.stringify(value);if(typeof raw!=='string')throw Error('CAPACITY_VALUE_UNSUPPORTED');return Buffer.byteLength(raw,'utf8')*4+4096;}
function assertCapacity(value,reserve=0){if(!Number.isSafeInteger(reserve)||reserve<0||size(value)+reserve>LIMIT)throw Object.assign(Error('CAPACITY_REVIEW_REQUIRED'),{code:'CAPACITY_REVIEW_REQUIRED'});}
function recordSize(record){const {capacityBaseBytes,...plain}=record;return size(plain);}
function reserveFor(record){if(['CLOSED','ABORTED'].includes(record.status))return 0;if(!Number.isSafeInteger(record.capacityBaseBytes))return RESERVE;const growth=Math.max(0,recordSize(record)-record.capacityBaseBytes);if(growth>RESERVE)throw Error('CAPACITY_RESERVATION_EXHAUSTED');return RESERVE-growth;}
function assertJournalCapacity(value){const reserve=Object.values(value.records??{}).reduce((n,r)=>n+reserveFor(r),0);assertCapacity(value,reserve);}
module.exports={LIMIT,RESERVE,size,recordSize,reserveFor,assertCapacity,assertJournalCapacity};
