import {shouldProcessWebhook,stablePayloadHash,verifyReplayWindow} from "../src/webhook-core";
function eq(a:unknown,b:unknown,m:string){if(a!==b)throw new Error(m);}
eq(verifyReplayWindow(1000,1100,300),true,"window");
eq(shouldProcessWebhook({eventId:"e1",processedEventIds:new Set(["e1"]),createdAtUnix:1000,nowUnix:1000}).process,false,"duplicate");
eq(shouldProcessWebhook({eventId:"e2",processedEventIds:new Set(),createdAtUnix:1000,nowUnix:2000}).reason,"outside_replay_window","replay");
eq(stablePayloadHash("abc").length,8,"hash");
console.log("webhook core tests passed");
