import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';
const require=createRequire(import.meta.url);
const vite=resolve(dirname(require.resolve('vite/package.json')),'bin/vite.js');
const output=resolve('release-evidence/configured-admin-budget');
// 合成の公開設定でビルドのみ実行する。配信・認証・API呼出・デプロイは行わない。
const env={...process.env,VITE_APP_ENVIRONMENT:'staging',VITE_EXPECTED_FIREBASE_PROJECT_ID:'lip-knots-crew-staging',VITE_FUNCTIONS_REGION:'asia-northeast1',VITE_USE_EMULATORS:'false',VITE_FIREBASE_API_KEY:'fixture-not-a-real-key-00000000000000000',VITE_FIREBASE_PROJECT_ID:'lip-knots-crew-staging',VITE_FIREBASE_AUTH_DOMAIN:'lip-knots-crew-staging.firebaseapp.com',VITE_FIREBASE_STORAGE_BUCKET:'lip-knots-crew-staging.firebasestorage.app',VITE_FIREBASE_MESSAGING_SENDER_ID:'000000000000',VITE_FIREBASE_APP_ID:'1:000000000000:web:0000000000000000000000'};
try{execFileSync(process.execPath,[vite,'build','--mode','staging','--outDir',output],{cwd:resolve('apps/admin'),env,stdio:'pipe'});}catch(error){throw new Error('Configured Admin fixture build failed: '+String(error.stderr??error.message));}
const assets=resolve(output,'assets');
const sizes=readdirSync(assets).filter(name=>name.endsWith('.js')).map(name=>{const bytes=readFileSync(resolve(assets,name));return{name,bytes:bytes.length,gzip:gzipSync(bytes).length};});
const entry=sizes.find(file=>file.name.startsWith('index-'));
assert.ok(entry,'Configured build requires an entry chunk');
assert.ok(entry.bytes<=350*1024,`Configured entry ${entry.bytes} exceeds 350 KiB`);
assert.ok(entry.gzip<=105*1024,'Configured entry exceeds 105 KiB gzip');
for(const file of sizes){assert.ok(file.bytes<=500*1024,`${file.name} exceeds 500 KiB`);assert.ok(file.gzip<=150*1024,`${file.name} exceeds 150 KiB gzip`);}
writeFileSync(resolve(output,'budget.json'),JSON.stringify({fixture:true,mode:'staging',entry,sizes},null,2));
console.log(`Configured Admin budget passed: ${(entry.bytes/1024).toFixed(1)} KiB raw / ${(entry.gzip/1024).toFixed(1)} KiB gzip; synthetic settings, build only.`);
