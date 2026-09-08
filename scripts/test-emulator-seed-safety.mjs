import assert from 'node:assert/strict';
import { emulatorSeedEnvironment } from './emulator-seed-safety.mjs';
let passed=0;
for(const env of [{},{GCLOUD_PROJECT:'demo-lifecycle',FIRESTORE_EMULATOR_HOST:'localhost:18080',FIREBASE_AUTH_EMULATOR_HOST:'[::1]:19099'}]){assert.match(emulatorSeedEnvironment(env).GCLOUD_PROJECT,/^demo-/);passed++;}
for(const env of [
  {GCLOUD_PROJECT:'lip-knots-crew-staging'}, {GCP_PROJECT:'real-project'}, {GOOGLE_CLOUD_PROJECT:'real-project'},
  {EXPECTED_FIREBASE_PROJECT_ID:'real-project'}, {FIREBASE_CONFIG:'{"projectId":"real-project"}'}, {FIREBASE_CONFIG:'not-json'},
  {APP_ENVIRONMENT:'production'},
  ...['example.com:8080','127.0.0.1.evil:8080','http://127.0.0.1:8080','0.0.0.0:8080','127.0.0.1:0','127.0.0.1:65536','127.0.0.1:8080/path'].flatMap(host=>[{FIRESTORE_EMULATOR_HOST:host},{FIREBASE_AUTH_EMULATOR_HOST:host}]),
]){assert.throws(()=>emulatorSeedEnvironment(env));passed++;}
console.log(`Emulator seed safety: ${passed} cases passed; no SDK initialization or seed execution`);
