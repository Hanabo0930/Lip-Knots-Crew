import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative} from 'node:path';
export function candidateIdentity(root){
 const baseline=JSON.parse(readFileSync(resolve(root,'scripts/fixtures/submission-candidate-inputs.json'),'utf8'));
 const paths=Object.keys(baseline.files).filter(p=>p.startsWith('apps/')||p.startsWith('functions/src/'));
 for(const p of ['apps/staff/src/submission-namespace.ts','functions/src/submission-acceptance-context.ts'])if(!paths.includes(p))paths.push(p);
 const files=Object.fromEntries(paths.sort().map(p=>[p,createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex')]));
 return {baseHead:baseline.baseHead,priorCandidate:baseline.priorCandidate,productFiles:files,productIdentitySha256:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
}
