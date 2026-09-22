import assert from 'node:assert/strict';
import net from 'node:net';
import {localAcceptanceEnvironment,allowedConnection,blockNonEmulatorConnections} from './local-firestore-acceptance-safety.mjs';
const base={METADATA_SERVER_DETECTION:'none',GCLOUD_PROJECT:'demo-lkc-accept-test',APP_ENVIRONMENT:'development',FIREBASE_CONFIG:'{"projectId":"demo-lkc-accept-test"}',FIRESTORE_EMULATOR_HOST:'127.0.0.1:18080'};
let cases=0;
assert.equal(localAcceptanceEnvironment({...base,FIREBASE_CONFIG:JSON.stringify({projectId:base.GCLOUD_PROJECT,storageBucket:'synthetic-bucket'})}).port,18080);cases++;
assert.equal(localAcceptanceEnvironment(base).port,18080);cases++;
for(const patch of [
 {METADATA_SERVER_DETECTION:undefined},{METADATA_SERVER_DETECTION:'assume-present'},{GCLOUD_PROJECT:'lip-knots-crew-staging'},{GCLOUD_PROJECT:undefined},{APP_ENVIRONMENT:'staging'},
 {FIRESTORE_EMULATOR_HOST:undefined},{FIRESTORE_EMULATOR_HOST:'firestore.googleapis.com:443'},{FIRESTORE_EMULATOR_HOST:'127.0.0.1:65536'},
 {FIRESTORE_EMULATOR_HOST:'localhost:18080'},{FIRESTORE_EMULATOR_HOST:'http://127.0.0.1:18080'},
 {EXPECTED_FIREBASE_PROJECT_ID:'real-project'},{GCP_PROJECT:'real-project'},{GOOGLE_CLOUD_PROJECT:'real-project'},
 {FIREBASE_CONFIG:'{'},{FIREBASE_CONFIG:'null'},{FIREBASE_CONFIG:'{"projectId":"other"}'},
 {FIREBASE_CONFIG:'{"projectId":"demo-lkc-accept-test","storageBucket":"real"}'},
 {GOOGLE_APPLICATION_CREDENTIALS:'any.json'},{FIREBASE_TOKEN:'synthetic'},{GOOGLE_OAUTH_ACCESS_TOKEN:'synthetic'}
]) {assert.throws(()=>localAcceptanceEnvironment({...base,...patch}));cases++;}
for(const options of [{host:'example.com',port:18080},{host:'127.0.0.1',port:443},{path:'socket'},{host:'127.0.0.1.evil',port:18080}]){assert.equal(allowedConnection(options,18080),false);cases++;}
const guard=blockNonEmulatorConnections(18080);
try {assert.throws(()=>net.connect({host:'example.com',port:443}),/NON_EMULATOR_NETWORK_BLOCKED/);assert.deepEqual(guard.stats(),{allowed:0,blocked:1});cases++;}finally{guard.restore();}
console.log(JSON.stringify({passed:cases,failed:0,externalConnections:0}));

