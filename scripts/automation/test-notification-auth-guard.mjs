import assert from 'node:assert/strict';import fs from 'node:fs';import {runInNewContext} from 'node:vm';
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/\r\n/g,'\n');const guard=read('scripts/automation/check-function-auth-guards.mjs').replace(/^import .*;\n/gm,'');const source=read('functions/src/notifications.ts'),core=read('functions/src/notification-core.ts');let cases=0;
function run(value=source,shared=core){const lines=[],process={argv:['node','guard','--functions','processNotificationQueue','--require-pass'],exitCode:0,exit:c=>{throw Error('unexpected exit '+c);}};runInNewContext(guard,{process,console:{log:x=>lines.push(x),error:x=>lines.push(x)},execFileSync:(cmd,args)=>{assert.equal(cmd,'git');const path=args[1].split(':').at(-1);assert.ok(['functions/src/notifications.ts','functions/src/notification-core.ts'].includes(path));return path.endsWith('/notification-core.ts')?shared:value;}},{timeout:3000});return{passed:lines.includes('SOURCE_GUARD_STATUS=PASS'),exitCode:process.exitCode};}
assert.deepEqual(run(),{passed:true,exitCode:0});cases++;
for(const [before,after]of [
 ['const mode = process.env.LKC_NOTIFICATION_DELIVERY_MODE;','const mode = "active";'],
 ['if (mode !== undefined && mode !== "active") return true;','if (mode !== undefined && mode !== "active") return false;'],
 ['return process.env.APP_ENVIRONMENT === "staging" && mode !== "active";','return false;'],
 ['export function notificationDeliveryPaused','function notificationDeliveryPaused'],
 ['const mode = process.env.LKC_NOTIFICATION_DELIVERY_MODE;','return false; const mode = process.env.LKC_NOTIFICATION_DELIVERY_MODE;'],
 ]){assert.ok(core.includes(before),'shared target absent '+before);assert.deepEqual(run(source,core.replace(before,after)),{passed:false,exitCode:1},before);cases++;}
for(const [before,after]of [
 ['from "./notification-core"','from "./other"'],
 ['async (event) => {\n    if (notificationDeliveryPaused()) return;','async (event) => {'],
 ['): Promise<void> {\n  if (notificationDeliveryPaused()) return;','): Promise<void> {'],
 ['"notificationQueue/{queueId}"','"other/{queueId}"'],
 ['if (data.status !== "queued") return;','if (false) return;'],
 ['if (deliverAt > Date.now() + 5_000) return;','if (false) return;'],
 ['dispatchQueueDocument(snap.ref)','dispatchQueueDocument(event.ref)'],
 ['getProductionOperationalState(pendingData.companyId)','getProductionOperationalState("other")'],
 ['if (current.status !== "queued") return null;','if (false) return null;'],
 ['.where("companyId", "==", data.companyId)','.where("companyId", "==", "other")'],
 ['.where("active", "==", true)','.where("active", "==", false)'],
 ['query.limit(1000)','query.limit(10000)'],
 ]){assert.ok(source.includes(before),'target absent '+before);assert.deepEqual(run(source.replace(before,after)),{passed:false,exitCode:1},before);cases++;}
console.log(JSON.stringify({notificationGuardTests:cases,functions:['processNotificationQueue'],cloudOperations:false}));
