import assert from 'node:assert/strict';
import {setup} from './notification-test-harness.mjs';
const cases=[],modes=[undefined,'paused','invalid','','PAUSED',' active'];
for(const mode of modes)for(const via of ['trigger','schedule']){
 const env={APP_ENVIRONMENT:'staging',...(mode===undefined?{}:{LKC_NOTIFICATION_DELIVERY_MODE:mode})};
 const h=setup('2026-09-11T12:00:00+09:00',env),{queueId}=await h.enqueue();
 const before=JSON.stringify([...h.state.records]);
 await (via==='trigger'?h.trigger(queueId):h.tick());
 const passed=h.state.sent.length===0&&h.state.metrics.length===0&&JSON.stringify([...h.state.records])===before;
 cases.push({mode:mode??'unset',via,passed});
}
for(const APP_ENVIRONMENT of [undefined,'development','production'])for(const via of ['trigger','schedule']){
 const h=setup('2026-09-11T12:00:00+09:00',{APP_ENVIRONMENT}),{queueId}=await h.enqueue();
 await(via==='trigger'?h.trigger(queueId):h.tick());
 cases.push({environment:APP_ENVIRONMENT??'unset',via,passed:h.state.sent.length===1&&h.document(queueId).status==='completed'});
}
for(const APP_ENVIRONMENT of ['development','production'])for(const mode of ['paused','invalid']){
 const h=setup('2026-09-11T12:00:00+09:00',{APP_ENVIRONMENT,LKC_NOTIFICATION_DELIVERY_MODE:mode}),{queueId}=await h.enqueue();const before=JSON.stringify([...h.state.records]);await h.trigger(queueId);cases.push({environment:APP_ENVIRONMENT,mode,passed:h.state.sent.length===0&&JSON.stringify([...h.state.records])===before});
}
for(const category of ['general','production_global_kill_switch']){
 const h=setup('2026-09-11T23:00:00+09:00',{APP_ENVIRONMENT:'staging',LKC_NOTIFICATION_DELIVERY_MODE:'paused'}),{queueId}=await h.enqueue({category,bypassQuietHours:true});const before=JSON.stringify([...h.state.records]);await h.trigger(queueId);h.setTime('2026-09-12T07:00:00+09:00');await h.tick();cases.push({category,passed:h.state.sent.length===0&&JSON.stringify([...h.state.records])===before});
}
const h=setup('2026-09-11T12:00:00+09:00',{APP_ENVIRONMENT:'staging',LKC_NOTIFICATION_DELIVERY_MODE:'active'}),{queueId}=await h.enqueue();await h.trigger(queueId);cases.push({mode:'explicit-active-synthetic-only',passed:h.state.sent.length===1});
console.log(JSON.stringify({passed:cases.filter(x=>x.passed).length,total:cases.length,cases,scope:'Synthetic Firestore/FCM only; existing production operational gate remains independently required'},null,2));
assert.ok(cases.every(x=>x.passed),'Notification delivery pause conditions');
