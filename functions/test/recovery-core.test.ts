import { decideRecovery } from "../src/recovery-core";
function equal(a: unknown,b: unknown,m:string){if(a!==b)throw new Error(m);}
equal(decideRecovery({appAvailable:true,firestoreAvailable:true,sheetsAvailable:false,writeQueueHealthy:false,authAvailable:true,dataMismatchDetected:false}).level,"L2","sheet outage");
equal(decideRecovery({appAvailable:true,firestoreAvailable:false,sheetsAvailable:true,writeQueueHealthy:true,authAvailable:true,dataMismatchDetected:false}).level,"L3","firestore outage");
console.log("recovery core tests passed");
