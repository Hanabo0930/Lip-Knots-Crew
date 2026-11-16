'use strict';
// Unregistered handler factory only. No Functions export, invoker policy, SDK or credential creation.
const {PROTOCOL}=require('./case-list-gas-sync-rpc-core.cjs');
const failure=(res,status,code)=>res.status(status).json({protocol:PROTOCOL,status:'HOLD',code,businessEnabled:false});
function createSyncRpcHandler(service){
 return async(req,res)=>{
  res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
  if(req.method!=='POST')return failure(res,405,'RPC_POST_REQUIRED');
  const headers=req.rawHeaders||[],authorizations=[];for(let i=0;i<headers.length;i+=2)if(String(headers[i]).toLowerCase()==='authorization')authorizations.push(headers[i+1]);
  if(authorizations.length!==1||typeof authorizations[0]!=='string'||!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorizations[0]))return failure(res,401,'RPC_BEARER_REQUIRED');
  const contentType=String(req.headers?.['content-type']||'');if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType))return failure(res,415,'RPC_JSON_REQUIRED');
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))return failure(res,400,'RPC_INPUT_INVALID');
  if((req.rawBody?.length||Buffer.byteLength(JSON.stringify(req.body)))>131072)return failure(res,413,'RPC_REQUEST_TOO_LARGE');
  try{const out=await service.handle(authorizations[0],req.body);return res.status(200).json(out);}catch(error){const code=/^[A-Z][A-Z0-9_]{1,100}$/.test(error.code||'')?error.code:'RPC_HANDLER_HOLD';return failure(res,[400,401,403,409,503].includes(error.status)?error.status:409,code);}
 };
}
module.exports={createSyncRpcHandler};
