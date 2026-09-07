import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
const script=path.resolve('scripts/automation/build-staging-hosting.sh').replaceAll('\\','/');
let cases=0;
const mock=String.raw`
npm() {
  local app
  if [[ "$*" == 'run build:staging -w @lkc/staff' ]]; then app=staff
  elif [[ "$*" == 'run build:staging -w @lkc/admin' ]]; then app=admin
  else return 90; fi
  touch "$LKC_TEST_DIR/$app"
  # 片方を先に待ってしまう実装ならタイムアウトで失敗する。
  local tries=0
  until [[ -f "$LKC_TEST_DIR/staff" && -f "$LKC_TEST_DIR/admin" ]]; do
    sleep 0.02
    tries=$((tries+1))
    if [[ "$tries" -gt 100 ]]; then return 91; fi
  done
  echo "FINISHED_$app"
  if [[ "$LKC_TEST_FAIL" == "$app" || "$LKC_TEST_FAIL" == both ]]; then return 2; fi
  return 0
}
source "$1"
echo AFTER_BUILD
`;
for(const fail of ['none','staff','admin','both']){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lkc-build-'));
 try {
  const result=spawnSync(bash,['--noprofile','--norc','-c',mock,'test',script],{encoding:'utf8',timeout:20000,env:{...process.env,LKC_TEST_DIR:dir.replaceAll('\\','/'),LKC_TEST_FAIL:fail}});
  assert.ifError(result.error); assert.equal(result.status,fail==='none'?0:1, result.stderr);
  assert.match(result.stdout,/FINISHED_staff/);assert.match(result.stdout,/FINISHED_admin/);
  if(fail==='none'){assert.match(result.stdout,/HOSTING_BUILD_RESULT=SUCCESS/);assert.match(result.stdout,/AFTER_BUILD/);}
  else {assert.match(result.stdout,/HOSTING_BUILD_RESULT=FAILED/);assert.doesNotMatch(result.stdout,/AFTER_BUILD|RESULT=SUCCESS/);}
  cases++;
 } finally {for(const name of ['staff','admin']){const file=path.join(dir,name);if(fs.existsSync(file))fs.unlinkSync(file);}fs.rmdirSync(dir);}
}
const preview=fs.readFileSync('.github/workflows/staging-hosting-preview.yml','utf8');
const promote=fs.readFileSync('.github/workflows/staging-hosting-promote.yml','utf8');
for(const workflow of [preview,promote])assert.match(workflow,/playwright install --with-deps chromium --only-shell/);
assert.match(preview,/bash scripts\/automation\/build-staging-hosting.sh\r?\n\s+npm run test:bundle-size/);
assert.doesNotMatch(promote,/build-staging-hosting.sh|npm run build:staging/);
assert.match(fs.readFileSync('scripts/automation/hosting-browser-check.mjs','utf8'),/chromium.launch\(\{ headless: true \}\)/);
cases++;
console.log(`Hosting build orchestration: ${cases} cases passed; no deploy or cloud access.`);
