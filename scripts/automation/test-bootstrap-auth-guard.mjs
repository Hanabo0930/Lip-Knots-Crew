import assert from 'node:assert/strict';import fs from 'node:fs';import {runInNewContext} from 'node:vm';
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/\r\n/g,'\n');const guard=read('scripts/automation/check-function-auth-guards.mjs').replace(/^import .*;\n/gm,'');const source=read('functions/src/auth.ts');let cases=0;
function run(value=source){const lines=[],process={argv:['node','guard','--functions','bootstrapSession','--require-pass'],exitCode:0,exit:c=>{throw Error('unexpected exit '+c);}};runInNewContext(guard,{process,console:{log:x=>lines.push(x),error:x=>lines.push(x)},execFileSync:(cmd,args)=>{assert.equal(cmd,'git');assert.equal(args[0],'show');assert.equal(args[1].split(':').at(-1),'functions/src/auth.ts');return value;}},{timeout:3000});return{passed:lines.includes('SOURCE_GUARD_STATUS=PASS'),exitCode:process.exitCode};}
assert.deepEqual(run(),{passed:true,exitCode:0});cases++;
for(const [before,after]of [
 ['requireAuth(request)','unverified(request)'],['requireAdmin(request)','unverified(request)'],['!user.emailVerified','!user.verifiedElsewhere'],['admins.includes(email)','true'],['companyFromClaims(session.token)','input.companyId'],
 ['index.active !== true','!index.active'],['typeof value !== "string"','false'],['!value.trim()','false'],['/[\\/\\\\\\u0000-\\u001f\\u007f]/.test(value)','false'],
 ['!profileSnap.exists','false'],['profileSnap.data()?.active !== true','false'],['profileSnap.data()?.companyId !== index.companyId','false'],
 ['.doc(emailHash(email))','.doc(input.emailHash)'],['.doc(index.staffId)','.doc(input.staffId)'],['companyId: index.companyId','companyId: input.companyId'],['staffId: index.staffId','staffId: input.staffId'],
 ['auth.setCustomUserClaims(session.uid, claims)','auth.setCustomUserClaims(input.uid, claims)'],['companyId: defaultCompanyId.value()','companyId: input.companyId'],
 ]){assert.ok(source.includes(before),'target absent '+before);assert.deepEqual(run(source.replace(before,after)),{passed:false,exitCode:1},before);cases++;}
console.log(JSON.stringify({bootstrapGuardTests:cases,functions:['bootstrapSession'],cloudOperations:false}));
