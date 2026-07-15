export type WebhookEnvelope = {
  provider:string;
  eventId:string;
  eventType:string;
  createdAt:number;
  payloadHash:string;
};

export function verifyReplayWindow(
  createdAtUnix:number,
  nowUnix:number,
  toleranceSeconds=300
):boolean{
  return Math.abs(nowUnix-createdAtUnix)<=toleranceSeconds;
}

export function stablePayloadHash(payload:string):string{
  let hash=2166136261;
  for(let index=0;index<payload.length;index++){
    hash^=payload.charCodeAt(index);
    hash=Math.imul(hash,16777619);
  }
  return(hash>>>0).toString(16).padStart(8,"0");
}

export function shouldProcessWebhook(input:{
  eventId:string;
  processedEventIds:Set<string>;
  createdAtUnix:number;
  nowUnix:number;
  toleranceSeconds?:number;
}):{process:boolean;reason:string}{
  if(input.processedEventIds.has(input.eventId)){
    return{process:false,reason:"duplicate"};
  }
  if(!verifyReplayWindow(
    input.createdAtUnix,
    input.nowUnix,
    input.toleranceSeconds??300
  )){
    return{process:false,reason:"outside_replay_window"};
  }
  return{process:true,reason:"ok"};
}
