import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, rm, realpath, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {
  backupCurrentPair, capturePromotion, createHostingReader, decodePromotionManifestArchive,
  loadVerifiedPromotionManifest, planVersionRestore, readManifestArchive, releaseHostingVersion,
  requireCurrentMain, restoreVersionPair, validateHostingOperation, validatePromotionEvidence,
  promotionManifestDigest, requireRestoreRetrySafety, validateRestoreRetryEvidence, requireNoFeeSourcePath, requireKnownPromotionResult, loadKnownPromotionResult,
  verifyCapturedLive,
} from "./restore-staging-hosting.mjs";

const project="lip-knots-crew-staging", region="asia-northeast1", repository="Hanabo0930/Lip-Knots-Crew";
const sha="ec55200aae1b7d931d60534b2bf3cb5281c9f510";
const fixture=()=>({
  schemaVersion:1,operation:"promote",projectId:project,region,sourceSha:sha,
  promotionRunId:"123456789",runAttempt:1,promotionResult:"success",
  staff:{siteId:project,previousVersion:"f93933bc547d6406",promotedVersion:"043a8353391bb75f"},
  admin:{siteId:project+"-admin",previousVersion:"f0fa3d0b5aed7f44",promotedVersion:"051025b12d917c6c"},
});
const metadata=(site,id)=>({name:`sites/${site}/versions/${id}`,status:"FINALIZED"});
function statefulReader(m=fixture()){
  const state={staff:m.staff.promotedVersion,admin:m.admin.promotedVersion};
  const calls=[];
  const label=site=>site===project?"staff":"admin";
  const reader={
    channel:async(site,channel)=>({release:{version:metadata(site,channel==="live"?state[label(site)]:channel.startsWith("rb-")?m[label(site)].previousVersion:m[label(site)].promotedVersion)}}),
    version:async(site,id)=>metadata(site,id),
    createBackup:async(site,channel)=>{calls.push(["createBackup",site,channel]);},
    release:async(site,channel,id)=>{calls.push(["release",site,channel,id]); if(channel==="live")state[label(site)]=id;},
    deleteTemporaryChannel:async(site,channel)=>{calls.push(["delete",site,channel]);},
  };
  return {reader,state,calls};
}
const snapshots=m=>Object.fromEntries(["staff","admin"].map(label=>[label,{
  liveSiteId:m[label].siteId,liveVersion:m[label].promotedVersion,
  previousVersion:metadata(m[label].siteId,m[label].previousVersion),
}]));
const evidence=m=>{
 const blob=Buffer.from("synthetic artifact");
 return {repository,restoreRunId:m.promotionRunId,manifest:m,blob,
 run:{id:Number(m.promotionRunId),repository:{full_name:repository},name:"Staging Hosting Promote",
 path:".github/workflows/staging-hosting-promote.yml",display_title:"promote staging Hosting",
 head_branch:"main",head_sha:sha,status:"completed",conclusion:"success",event:"workflow_run",run_attempt:1},
 artifact:{id:123,size_in_bytes:blob.length,name:"staging-hosting-promote-"+sha,expired:false,
 workflow_run:{id:Number(m.promotionRunId),head_sha:sha},digest:"sha256:"+createHash("sha256").update(blob).digest("hex")}};
};

export async function runVersionRestoreTests({repoRoot,pythonExecutable="python3"}){
 let cases=0;
 const test=async(name,fn)=>{try{await fn();cases++;}catch(e){throw new Error(name+": "+e.message,{cause:e});}};
 const reject=async(name,mutate,error)=>test(name,()=>{
  const m=fixture(),s=snapshots(m);mutate(m,s);assert.throws(()=>planVersionRestore(m,s),new RegExp(error));
 });
 await test("immutable exact pair and input preservation",()=>{
  const m=fixture(),s=snapshots(m),original=JSON.stringify({m,s}),p=planVersionRestore(m,s);
  assert.equal(p.requests.length,2);assert.equal(p.requests[0].source,project+"@"+m.staff.previousVersion);
  assert.equal(p.requests[1].target,project+"-admin:live");assert.ok(Object.isFrozen(p.requests[0]));
  assert.equal(JSON.stringify({m,s}),original);
 });
 for(const [name,mutate,error] of [
  ["production",m=>{m.projectId="lip-knots-crew";},"ENVIRONMENT_REJECTED"],
  ["region",m=>{m.region="us-central1";},"ENVIRONMENT_REJECTED"],
  ["schema",m=>{m.schemaVersion=2;},"MANIFEST_SCHEMA_REJECTED"],
  ["wrong operation",m=>{m.operation="readiness";},"MANIFEST_SCHEMA_REJECTED"],
  ["unfixed source",m=>{m.sourceSha="main";},"SOURCE_SHA_REJECTED"],
  ["missing run",m=>{m.promotionRunId=null;},"PROMOTION_RUN_REJECTED"],
  ["missing attempt",m=>{m.runAttempt=0;},"RUN_ATTEMPT_REJECTED"],
  ["not successful",m=>{m.promotionResult="prepared";},"SUCCESSFUL_PROMOTION_REQUIRED"],
  ["site swap",m=>{m.admin.siteId=m.staff.siteId;},"SITE_PAIR_REJECTED"],
  ["path version",m=>{m.admin.previousVersion="../live";},"VERSION_REJECTED"],
  ["numeric version",m=>{m.admin.previousVersion=1234567890123456;},"VERSION_REJECTED"],
  ["same pair",m=>{m.staff.previousVersion=m.staff.promotedVersion;},"VERSION_PAIR_REJECTED"],
  ["live site mismatch",(_,s)=>{s.admin.liveSiteId="prod";},"LIVE_SITE_REJECTED"],
  ["third live",(_,s)=>{s.admin.liveVersion="1111111111111111";},"LIVE_CHANGED_SINCE_PROMOTION"],
  ["deleted version",(_,s)=>{s.admin.previousVersion.status="DELETED";},"VERSION_NOT_FINALIZED"],
  ["other resource",(_,s)=>{s.admin.previousVersion.name="sites/other/versions/f0fa3d0b5aed7f44";},"VERSION_RESOURCE_REJECTED"],
  ["missing second site",(m)=>{delete m.admin;},"SITE_PAIR_REJECTED"],
 ])await reject(name,mutate,error);

 for(const [mode,confirmation] of [["promote","PROMOTE_LKC_STAGING_HOSTING"],["readiness","CHECK_LKC_STAGING_HOSTING_READINESS"],["restore","RESTORE_LKC_STAGING_HOSTING"]]){
  await test("manual "+mode,()=>assert.equal(validateHostingOperation({operation:mode,confirmation,eventName:"workflow_dispatch",projectId:project,region,sourceRef:"main"}),mode));
  await test("wrong confirmation "+mode,()=>assert.throws(()=>validateHostingOperation({operation:mode,confirmation:"wrong",eventName:"workflow_dispatch",projectId:project,region,sourceRef:"main"}),/CONFIRMATION_REJECTED/));
  if(mode!=="promote")await test("automatic "+mode+" blocked",()=>assert.throws(()=>validateHostingOperation({operation:mode,confirmation,eventName:"workflow_run",projectId:project,region,sourceRef:"main"}),/MANUAL_OPERATION_REQUIRED/));
 }
 await test("non-main blocked",()=>assert.throws(()=>validateHostingOperation({operation:"readiness",confirmation:"CHECK_LKC_STAGING_HOSTING_READINESS",eventName:"workflow_dispatch",projectId:project,region,sourceRef:"branch"}),/ENVIRONMENT_REJECTED/));
 await test("unknown operation",()=>assert.throws(()=>validateHostingOperation({operation:"deploy",confirmation:"x",eventName:"workflow_dispatch",projectId:project,region,sourceRef:"main"}),/OPERATION_REJECTED/));
 await test("valid provenance",()=>{const e=evidence(fixture());assert.equal(validatePromotionEvidence(e),e.manifest);});
 for(const [name,mutate,error] of [
  ["foreign repository",e=>{e.repository="other/repo";},"REPOSITORY_REJECTED"],
  ["pending run",e=>{e.run.status="pending";},"PROMOTION_EVIDENCE_REJECTED"],
  ["failed run",e=>{e.run.conclusion="failure";},"PROMOTION_EVIDENCE_REJECTED"],
  ["readiness run",e=>{e.run.display_title="readiness staging Hosting";},"PROMOTION_EVIDENCE_REJECTED"],
  ["foreign workflow",e=>{e.run.path=".github/workflows/other.yml";},"PROMOTION_EVIDENCE_REJECTED"],
  ["foreign branch",e=>{e.run.head_branch="automation/x";},"PROMOTION_EVIDENCE_REJECTED"],
  ["changed source",e=>{e.manifest.sourceSha="1".repeat(40);},"MANIFEST_PROVENANCE_REJECTED"],
  ["different attempt",e=>{e.manifest.runAttempt=2;},"MANIFEST_PROVENANCE_REJECTED"],
  ["expired artifact",e=>{e.artifact.expired=true;},"ARTIFACT_PROVENANCE_REJECTED"],
  ["artifact from another run",e=>{e.artifact.workflow_run.id=222;},"ARTIFACT_PROVENANCE_REJECTED"],
  ["digest missing",e=>{delete e.artifact.digest;},"ARTIFACT_PROVENANCE_REJECTED"],
 ])await test(name,()=>{const e=evidence(fixture());mutate(e);assert.throws(()=>validatePromotionEvidence(e),new RegExp(error));});
 await test("verified loader uses exact run and artifact",async()=>{
  const e=evidence(fixture()),calls=[];
  const result=await loadVerifiedPromotionManifest(e,{github:async(args,encoding)=>{calls.push(args[0]);if(args[0].endsWith("/zip")){assert.equal(encoding,null);return e.blob;}return JSON.stringify(args[0].includes("/artifacts?")?{total_count:1,artifacts:[e.artifact]}:e.run);},archiveReader:(blob,digest)=>readManifestArchive(blob,digest,()=>e.manifest)});
  assert.deepEqual(result,e.manifest);assert.equal(calls.length,3);
 });
 await test("loader rejects duplicate artifacts without download",async()=>{
  const e=evidence(fixture()),calls=[];
  await assert.rejects(()=>loadVerifiedPromotionManifest(e,{github:async(args)=>{calls.push(args[0]);return JSON.stringify(calls.length===1?e.run:{total_count:2,artifacts:[e.artifact,e.artifact]});}}),/ARTIFACT_NOT_UNIQUE/);
  assert.equal(calls.length,2);
 });
 await test("loader rejects incomplete artifact page",async()=>{
  const e=evidence(fixture());let calls=0;
  await assert.rejects(()=>loadVerifiedPromotionManifest(e,{github:async()=>JSON.stringify(++calls===1?e.run:{total_count:101,artifacts:[e.artifact]})}),/ARTIFACT_LIST_INCOMPLETE/);
 });
 await test("loader rejects missing entries and oversized artifact before download",async()=>{
  for(const scenario of ["missing","oversized"]){
   const e=evidence(fixture());let calls=0;
   if(scenario==="oversized")e.artifact.size_in_bytes=9*1024*1024;
   await assert.rejects(()=>loadVerifiedPromotionManifest(e,{github:async()=>JSON.stringify(++calls===1?e.run:{total_count:scenario==="missing"?2:1,artifacts:[e.artifact]})}),scenario==="missing"?/ARTIFACT_LIST_INCOMPLETE/:/ARTIFACT_PROVENANCE_REJECTED/);
   assert.equal(calls,2);
  }
 });
 await test("digest mismatch prevents decode",()=>{
  let decoded=false;assert.throws(()=>readManifestArchive(Buffer.from("x"),"sha256:"+"0".repeat(64),()=>{decoded=true;}),/DIGEST_MISMATCH/);assert.equal(decoded,false);
 });
 await test("archive reads only one bounded manifest",()=>{
  const make=entries=>{
   const r=spawnSync(pythonExecutable,["-c","import sys,json,zipfile,io; d=json.load(sys.stdin); b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); [z.writestr(n,v) for n,v in d]; z.close(); sys.stdout.buffer.write(b.getvalue())"],{input:JSON.stringify(entries),maxBuffer:100000});
   assert.equal(r.status,0);return r.stdout;
  };
  const m=fixture(),blob=make([["restore-manifest.json",JSON.stringify(m)],[".env","NEVER_READ_THIS"]]);
  assert.deepEqual(decodePromotionManifestArchive(blob,{pythonExecutable}),m);
  assert.throws(()=>decodePromotionManifestArchive(make([["restore-manifest.json","{}"],["restore-manifest.json","{}"]]),{pythonExecutable}),/ARCHIVE_REJECTED/);
  assert.throws(()=>decodePromotionManifestArchive(make([["sub/restore-manifest.json","{}"]]),{pythonExecutable}),/ARCHIVE_REJECTED/);
 });

 const options={projectId:project,region,staffSite:project,adminSite:project+"-admin",sourceSha:sha,currentRunId:"777",runAttempt:1,evidenceDir:path.resolve(repoRoot,".hosting-test-evidence")};
 const temp=await mkdtemp(path.join(repoRoot,".hosting-version-test-"));
 options.evidenceDir=temp;
 try{
  for(const scenario of ["success","lost-response","already-restored","partial","first-fails","first-throws","third-before","third-after","readback-fails","authorization-fails"]){
   await test("execution "+scenario,async()=>{
    const m=fixture(),model=statefulReader(m),calls=[];
    if(scenario==="already-restored"||scenario==="partial")model.state.staff=m.staff.previousVersion;
    if(scenario==="already-restored")model.state.admin=m.admin.previousVersion;
    if(scenario==="third-before")model.state.admin="1".repeat(16);
    let mutate=false;
    const reader={...model.reader,channel:async(site,channel)=>{if(mutate&&scenario==="readback-fails")throw Error("synthetic read failure");return model.reader.channel(site,channel);}};
    const execute=async req=>{
     calls.push(req.label);
     if(req.label==="staff"&&scenario==="first-throws")throw Error("synthetic failure");
     if(req.label==="staff"&&scenario==="first-fails")return {code:1,outcome:"rejected"};
     model.state[req.label]=req.restoreVersion;mutate=true;
     if(scenario==="third-after")model.state.admin="1".repeat(16);
     return {code:scenario==="lost-response"?1:0};
    };
    const run=()=>restoreVersionPair(m,options,{reader,executor:execute,authorize:async()=>{if(scenario==="authorization-fails")throw Error("main changed");}});
    if(scenario==="third-before"){await assert.rejects(run,/LIVE_CHANGED/);assert.deepEqual(calls,[]);return;}
    const r=await run();
    if(["third-after","readback-fails","authorization-fails","first-throws"].includes(scenario)){assert.equal(r.status,"blocked");assert.ok(calls.length<=1);}
    else if(scenario==="first-fails"){assert.equal(r.success,false);assert.deepEqual(calls,["staff","admin"]);}
    else{assert.equal(r.success,true);assert.equal(calls.length,scenario==="already-restored"?0:scenario==="partial"?1:2);}
   });
  }
  await test("final pair readback rejects reintroduced recorded promoted version",async()=>{
   const m=fixture(),model=statefulReader(m),calls=[];
   const result=await restoreVersionPair(m,options,{reader:model.reader,executor:async req=>{
    calls.push(req.label);model.state[req.label]=req.restoreVersion;
    if(req.label==="admin")model.state.staff=m.staff.promotedVersion;
    return {code:0};
   }});
   assert.deepEqual(calls,["staff","admin"]);assert.equal(result.success,false);
   assert.equal(result.finalPairRestored,false);assert.equal(result.status,"blocked");assert.equal(result.retryAllowed,false);
  });

  await test("unknown outcome stops and cannot authorize a later run",async()=>{
   const m=fixture(),model=statefulReader(m);let writes=0;
   const result=await restoreVersionPair(m,options,{reader:model.reader,executor:async()=>{writes++;return {code:1,outcome:"unknown"};}});
   assert.equal(writes,1);assert.equal(result.status,"blocked");assert.equal(result.retryAllowed,false);
   assert.equal(result.attempts[0].status,"unknown");
   const run={id:777,run_attempt:1,head_sha:sha};
   assert.throws(()=>validateRestoreRetryEvidence(result,run,m),/RESTORE_PREVIOUS_RESULT_UNKNOWN/);
  });
  await test("known partial failure checkpoint is saved and retryable",async()=>{
   const m=fixture(),model=statefulReader(m);
   const result=await restoreVersionPair(m,options,{reader:model.reader,executor:async req=>{
    if(req.label==="staff"){model.state.staff=req.restoreVersion;return {code:0,outcome:"applied"};}
    return {code:1,outcome:"rejected"};
   }});
   assert.equal(result.success,false);assert.equal(result.retryAllowed,true);
   validateRestoreRetryEvidence(result,{id:777,run_attempt:1,head_sha:sha},m);
   assert.deepEqual(result.attempts.map(a=>a.status),["success","failure"]);
  });
  await test("durable intent exists before actual release",async()=>{
   const m=fixture(),model=statefulReader(m);
   const result=await restoreVersionPair(m,options,{reader:model.reader,executor:async req=>{
    const saved=JSON.parse(await readFile(path.join(temp,"manual-restore-result.json"),"utf8"));
    assert.equal(saved.phase,"write-uncertain");assert.equal(saved.pendingSite,req.label);
    assert.equal(saved.retryAllowed,false);assert.equal(saved.targetPromotionRunId,m.promotionRunId);
    model.state[req.label]=req.restoreVersion;return {code:0,outcome:"applied"};
   }});
   assert.equal(result.success,true);assert.equal(result.retryAllowed,true);
  });
  await test("restore rerun rejected before reading history",async()=>{
   let read=0;
   await assert.rejects(()=>requireRestoreRetrySafety(fixture(),{currentRunId:"778",currentRunAttempt:2},{github:async()=>{read++;}}),/RESTORE_WORKFLOW_RERUN_REJECTED/);
   assert.equal(read,0);
  });
  const priorRun={id:777,repository:{full_name:repository},path:".github/workflows/staging-hosting-promote.yml",
    name:"Staging Hosting Promote",display_title:"restore staging Hosting from "+fixture().promotionRunId,
    event:"workflow_dispatch",head_branch:"main",status:"completed",conclusion:"failure",head_sha:sha,run_attempt:1};
  const safeEvidence={
    schemaVersion:1,operation:"restore",phase:"complete",projectId:project,region,
    currentRunId:"777",runAttempt:1,sourceSha:sha,targetPromotionRunId:fixture().promotionRunId,
    manifestDigest:promotionManifestDigest(fixture()),retryAllowed:true,finalPairKnown:true,
    attempts:[{label:"staff",status:"success",outcome:"applied"},{label:"admin",status:"failure",outcome:"rejected"}],
  };
  for(const scenario of ["none","safe","unknown","missing","expired","running","incomplete","wrong-pair","same-run-rerun","safe-higher","unknown-higher","missing-higher","pending-higher","self"]){
   await test("cross-run retry history "+scenario,async()=>{
    const m=fixture(),blob=Buffer.from("synthetic retry artifact"),run={...priorRun};
    const kind=scenario.replace(/-higher$/u,"");
    if(scenario.endsWith("-higher"))run.id=779;
    if(kind==="self"){run.id=778;run.status="in_progress";}
    const artifact={id:55,size_in_bytes:blob.length,name:"staging-hosting-restore-"+sha,expired:kind==="expired",
      workflow_run:{id:run.id,head_sha:sha},digest:"sha256:"+createHash("sha256").update(blob).digest("hex")};
    const evidence=structuredClone(safeEvidence);
    evidence.currentRunId=String(run.id);
    if(kind==="unknown"){evidence.retryAllowed=false;evidence.attempts[0]={label:"staff",status:"unknown",outcome:"unknown"};}
    if(kind==="wrong-pair")evidence.manifestDigest="0".repeat(64);
    if(kind==="running")run.status="in_progress";
    if(kind==="pending")run.status="queued";
    let calls=0;
    const github=async args=>{
     calls++;
     if(args[0].includes("/workflows/"))return JSON.stringify({total_count:kind==="none"?0:kind==="incomplete"?2:1,workflow_runs:kind==="none"?[]:[run]});
     if(args[0].includes("/artifacts?"))return JSON.stringify({total_count:kind==="missing"?0:1,artifacts:kind==="missing"?[]:[artifact]});
     if(args[0].endsWith("/zip"))return blob;
     throw Error("unexpected read");
    };
    const request=()=>requireRestoreRetrySafety(m,{currentRunId:"778",currentRunAttempt:scenario==="same-run-rerun"?2:1},{
      github,archiveReader:(b,d)=>readManifestArchive(b,d,()=>evidence),
    });
    if(["none","safe","self"].includes(kind)){await request();assert.equal(calls,kind==="safe"?3:1);}
    else await assert.rejects(request);
   });
  }
  await test("forged retry-allowed flag cannot override unknown or unfinished phase",()=>{
   const m=fixture();
   for(const change of [e=>{e.phase="write-uncertain";},e=>{e.attempts[0].outcome="unknown";},e=>{e.currentRunId="99";},e=>{e.runAttempt=2;}]){
    const copy=structuredClone(safeEvidence);change(copy);
    assert.throws(()=>validateRestoreRetryEvidence(copy,priorRun,m));
   }
  });
  await test("no-fee source guard stops before any external API",async()=>{
   await assert.rejects(()=>requireNoFeeSourcePath({projectId:project,region,sourceSha:sha,evidenceDir:temp}),/VERIFIED_NO_FEE_SOURCE_PATH_REQUIRED/);
   const evidence=JSON.parse(await readFile(path.join(temp,"api-readiness.json"),"utf8"));
   assert.equal(evidence.externalApiInvoked,false);assert.equal(evidence.deployedSourceVerified,false);assert.equal(evidence.status,"STOPPED");
  });

  for(const visible of [false,true])await test("unknown promotion cannot rollback or resend even when visible="+visible,async()=>{
   const m=fixture(),execution={...m,staff:{...m.staff,previousVersion:m.staff.promotedVersion,promotedVersion:m.staff.previousVersion},
    admin:{...m.admin,previousVersion:m.admin.promotedVersion,promotedVersion:m.admin.previousVersion}};
   const model=statefulReader(execution),evidenceDir=path.join(temp,"unknown-promotion-"+visible),output=path.join(evidenceDir,"output.txt");
   const opts={...options,currentRunId:undefined,promotionRunId:m.promotionRunId,runAttempt:m.runAttempt,sourceSha:m.sourceSha,mode:"promotion",evidenceDir};
   let writes=0;
   const executor=async req=>{writes++;if(visible)model.state[req.label]=req.restoreVersion;return {code:1,outcome:"unknown"};};
   const result=await restoreVersionPair(execution,opts,{reader:model.reader,executor,githubOutputPath:output});
   assert.equal(writes,1);assert.equal(result.status,"blocked");assert.equal(result.retryAllowed,false);
   assert.equal(result.operation,"promote");assert.equal(result.attempts[0].outcome,"unknown");
   assert.match(await readFile(output,"utf8"),/rollback_allowed=false/u);
   // A delayed successful POST must not permit reversing it or starting another POST.
   model.state.staff=m.staff.promotedVersion;
   await assert.rejects(()=>loadKnownPromotionResult(m,evidenceDir),/PROMOTION_RESULT_UNKNOWN_OR_UNVERIFIED/);
   await assert.rejects(()=>restoreVersionPair(execution,opts,{reader:model.reader,executor}),/PROMOTION_ATTEMPT_ALREADY_RECORDED/);
   assert.equal(writes,1);
   const saved=JSON.parse(await readFile(path.join(evidenceDir,"automatic-rollback-stop.json"),"utf8"));
   assert.equal(saved.externalApiInvoked,false);assert.equal(saved.status,"STOPPED");
  });
  for(const partial of [false,true])await test("known promotion evidence authorizes rollback partial="+partial,async()=>{
   const m=fixture(),execution={...m,staff:{...m.staff,previousVersion:m.staff.promotedVersion,promotedVersion:m.staff.previousVersion},
    admin:{...m.admin,previousVersion:m.admin.promotedVersion,promotedVersion:m.admin.previousVersion}};
   const model=statefulReader(execution),evidenceDir=path.join(temp,"known-promotion-"+partial),output=path.join(evidenceDir,"output.txt");
   const opts={...options,currentRunId:undefined,promotionRunId:m.promotionRunId,runAttempt:m.runAttempt,sourceSha:m.sourceSha,mode:"promotion",evidenceDir};
   const result=await restoreVersionPair(execution,opts,{reader:model.reader,githubOutputPath:output,executor:async req=>{
    if(partial&&req.label==="admin")return {code:1,outcome:"rejected"};
    model.state[req.label]=req.restoreVersion;return {code:0,outcome:"applied"};
   }});
   assert.equal(result.success,!partial);assert.equal(result.finalPairKnown,true);assert.equal(result.retryAllowed,true);
   assert.match(await readFile(output,"utf8"),/rollback_allowed=true/u);
   assert.deepEqual(await loadKnownPromotionResult(m,evidenceDir),result);
   for(const mutate of [
    r=>{r.operation="restore";},r=>{r.currentRunId="99";},r=>{r.runAttempt=2;},r=>{r.sourceSha="0".repeat(40);},
    r=>{r.manifestDigest="0".repeat(64);},r=>{r.phase="write-uncertain";},r=>{r.attempts[0].outcome="unknown";},
    r=>{r.finalPairRestored=!r.finalPairRestored;},r=>{r.status="blocked";},
   ]){const bad=structuredClone(result);mutate(bad);assert.throws(()=>requireKnownPromotionResult(bad,m));}
  });
  for(const failAt of [1,2])await test("known main change before POST permits captured rollback failAt="+failAt,async()=>{
   const m=fixture(),execution={...m,staff:{...m.staff,previousVersion:m.staff.promotedVersion,promotedVersion:m.staff.previousVersion},
    admin:{...m.admin,previousVersion:m.admin.promotedVersion,promotedVersion:m.admin.previousVersion}};
   const model=statefulReader(execution),evidenceDir=path.join(temp,"main-change-"+failAt),output=path.join(evidenceDir,"output.txt");
   const opts={...options,currentRunId:undefined,promotionRunId:m.promotionRunId,runAttempt:m.runAttempt,sourceSha:m.sourceSha,mode:"promotion",evidenceDir};
   let checks=0;const writes=[];
   const result=await restoreVersionPair(execution,opts,{reader:model.reader,githubOutputPath:output,
    authorize:async()=>{if(++checks===failAt)throw Error("SOURCE_SHA_CHANGED_DURING_OPERATION");},
    executor:async req=>{writes.push(req.label);model.state[req.label]=req.restoreVersion;return {code:0,outcome:"applied"};}});
   assert.deepEqual(writes,failAt===1?[]:["staff"]);assert.equal(result.status,"failure");
   assert.equal(result.finalPairKnown,true);assert.equal(result.retryAllowed,true);
   assert.equal(result.attempts[1].outcome,"not-attempted");assert.equal(result.attempts[1].status,"failure");
   assert.match(await readFile(output,"utf8"),/rollback_allowed=true/u);
   assert.deepEqual(await loadKnownPromotionResult(m,evidenceDir),result);
   const rollbackWrites=[];
   const rollback=await restoreVersionPair(m,{...opts,mode:"restore"},{reader:model.reader,executor:async req=>{
    rollbackWrites.push(req.label);model.state[req.label]=req.restoreVersion;return {code:0,outcome:"applied"};}});
   assert.equal(rollback.success,true);assert.deepEqual(rollbackWrites,failAt===1?[]:["staff"]);
  });
  await test("missing and malformed promotion evidence stop before rollback",async()=>{
   const m=fixture(),evidenceDir=path.join(temp,"missing-promotion");
   await assert.rejects(()=>loadKnownPromotionResult(m,evidenceDir),/PROMOTION_RESULT_UNKNOWN_OR_UNVERIFIED/);
   await writeFile(path.join(evidenceDir,"promotion-version-result.json"),"broken JSON");
   await assert.rejects(()=>loadKnownPromotionResult(m,evidenceDir),/PROMOTION_RESULT_UNKNOWN_OR_UNVERIFIED/);
   const saved=JSON.parse(await readFile(path.join(evidenceDir,"automatic-rollback-stop.json"),"utf8"));
   assert.equal(saved.externalApiInvoked,false);assert.equal(saved.status,"STOPPED");
  });
  await test("actual captured rollback and promotion retry stop before SDK authentication",async()=>{
   const m=fixture(),evidenceDir=path.join(temp,"unknown-promotion-false");
   await writeFile(path.join(evidenceDir,"pending-restore-manifest.json"),JSON.stringify({...m,promotionResult:"prepared"}));
   const denySdk="data:text/javascript,"+encodeURIComponent('import Module from "node:module";const original=Module._load;Module._load=function(name,...rest){if(name.startsWith("firebase-tools"))throw new Error("SDK_AUTH_MUST_NOT_BE_REACHED");return original.call(this,name,...rest);};');
   for(const [flag,reason] of [["--restore-capture","PROMOTION_RESULT_UNKNOWN_OR_UNVERIFIED"],["--promote-capture","PROMOTION_ATTEMPT_ALREADY_RECORDED"]]){
    const result=spawnSync(process.execPath,["--import",denySdk,path.join(repoRoot,"scripts/automation/restore-staging-hosting.mjs"),flag,
     "--project",project,"--region",region,"--staff-site",project,"--admin-site",project+"-admin","--source-sha",sha,"--evidence-dir",evidenceDir],{
      cwd:repoRoot,encoding:"utf8",timeout:10000,env:{...process.env,GITHUB_ACTIONS:"true",GITHUB_REPOSITORY:repository,GITHUB_REF:"refs/heads/main",
       GITHUB_REF_NAME:"main",GITHUB_JOB:"promote",GITHUB_WORKFLOW_REF:repository+"/.github/workflows/staging-hosting-promote.yml@refs/heads/main",
       GITHUB_RUN_ID:m.promotionRunId,GITHUB_RUN_ATTEMPT:"1"}});
    assert.equal(result.status,1);assert.match(result.stderr,new RegExp(reason));assert.doesNotMatch(result.stderr,/SDK_AUTH_MUST_NOT_BE_REACHED/);
   }
  });
  await test("actual release adapter same site only and lost response",async()=>{
   const m=fixture(),model=statefulReader(m);
   const request={source:project+"@"+m.staff.previousVersion,target:project+":live",projectId:project,expectedLiveVersion:m.staff.promotedVersion};
   assert.equal((await releaseHostingVersion(request,{reader:model.reader})).code,0);
   assert.equal(model.calls.filter(c=>c[0]==="release").length,1);
   assert.equal((await releaseHostingVersion(request,{reader:model.reader})).code,0);
   assert.equal(model.calls.filter(c=>c[0]==="release").length,1);
   for(const bad of [{projectId:"production"},{target:project+"-admin:live"},{source:project+":rc-"+sha.slice(0,12)},{target:project+":other"}]){
    assert.equal((await releaseHostingVersion({...request,...bad},{reader:model.reader})).code,1);
   }
  });
  await test("release transport outcomes distinguish pre-write rejection and unknown delivery",async()=>{
   const m=fixture();
   const request={source:project+"@"+m.staff.previousVersion,target:project+":live",projectId:project,expectedLiveVersion:m.staff.promotedVersion};
   for(const [error,outcome] of [[{status:403},"rejected"],[{context:{httpErrorCode:409}},"rejected"],[{status:408},"unknown"],[{status:429},"unknown"],[{status:500},"unknown"],[{code:"ETIMEDOUT"},"unknown"]]){
    const model=statefulReader(m);let writes=0;
    const reader={...model.reader,release:async()=>{writes++;throw error;}};
    const result=await releaseHostingVersion(request,{reader});
    assert.equal(result.code,1);assert.equal(result.outcome,outcome);assert.equal(writes,1);
   }
   const model=statefulReader(m);let writes=0;
   const reader={...model.reader,version:async()=>{throw {status:500};},release:async()=>{writes++;}};
   const result=await releaseHostingVersion(request,{reader});
   assert.equal(result.outcome,"not-attempted");assert.equal(writes,0);
  });
  await test("actual legacy CLI refuses mutation even with protected-context environment",()=>{
   const result=spawnSync(process.execPath,[path.join(repoRoot,"scripts/automation/restore-staging-hosting.mjs"),"--project",project,"--channel","rb-123"],{
    cwd:repoRoot,encoding:"utf8",timeout:10000,
    env:{...process.env,GITHUB_ACTIONS:"true",GITHUB_REPOSITORY:repository,GITHUB_REF:"refs/heads/main",GITHUB_REF_NAME:"main",GITHUB_JOB:"promote",GITHUB_WORKFLOW_REF:repository+"/.github/workflows/staging-hosting-promote.yml@refs/heads/main",GITHUB_RUN_ATTEMPT:"1"}
   });
   assert.equal(result.status,1);assert.match(result.stderr,/LEGACY_CHANNEL_RESTORE_DISABLED/);
  });
  await test("backup both live validated before any write",async()=>{
   const m=fixture(),model=statefulReader(m);model.state.staff=m.staff.previousVersion;model.state.admin=m.admin.previousVersion;
   await backupCurrentPair({...options,promotionRunId:m.promotionRunId,rollbackChannel:"rb-"+m.promotionRunId},model.reader);
   assert.equal(model.calls.filter(c=>c[0]==="createBackup").length,2);assert.ok(model.calls.every(c=>!c.includes("live")));
   const broken={...model.reader,channel:async(site,ch)=>site.endsWith("-admin")&&ch==="live"?null:model.reader.channel(site,ch)};
   const writes=model.calls.length;
   await assert.rejects(()=>backupCurrentPair({...options,promotionRunId:m.promotionRunId,rollbackChannel:"rb-"+m.promotionRunId},broken),/VERSION_NOT_FINALIZED/);
   assert.equal(model.calls.length,writes);
  });
  await test("capture and finalization require exact pair",async()=>{
   const m=fixture(),model=statefulReader(m);model.state.staff=m.staff.previousVersion;model.state.admin=m.admin.previousVersion;
   const captureOptions={...options,sourceSha:sha,promotionRunId:m.promotionRunId,runAttempt:1,rollbackChannel:"rb-"+m.promotionRunId,previewChannel:"rc-"+sha.slice(0,12)};
   const captured=await capturePromotion(captureOptions,model.reader);
   assert.equal(captured.promotionResult,"prepared");await verifyCapturedLive(captured,model.reader,"before");
   model.state.staff=m.staff.promotedVersion;model.state.admin=m.admin.promotedVersion;
   assert.equal((await verifyCapturedLive(captured,model.reader,"after")).promotionResult,"success");
   model.state.admin="1".repeat(16);await assert.rejects(()=>verifyCapturedLive(captured,model.reader,"after"),/CAPTURE_LIVE_CHANGED/);
  });
 }finally{
  const resolved=await realpath(temp),root=await realpath(repoRoot);
  assert.ok(resolved.startsWith(root+path.sep)&&path.basename(resolved).startsWith(".hosting-version-test-"));
  await rm(resolved,{recursive:true,force:true});
 }
 await test("current main fenced",async()=>{
  await requireCurrentMain(sha,async()=>JSON.stringify({object:{sha}}));
  await assert.rejects(()=>requireCurrentMain(sha,async()=>JSON.stringify({object:{sha:"1".repeat(40)}})),/SOURCE_SHA_CHANGED/);
 });
 await test("Hosting adapter outbound allowlist excludes Auth IAM mail",async()=>{
  const calls=[];
  const sdk={command:{prepare:async()=>{}},requireAuth:async()=>{},Client:class{
   constructor(o){assert.equal(o.urlPrefix,"https://firebasehosting.googleapis.com");assert.equal(o.apiVersion,"v1beta1");}
   async get(p,o){calls.push(["get",p,o]);return {body:{}};}
   async post(p,b,o){calls.push(["post",p,o]);return {body:{}};}
   async delete(p,o){calls.push(["delete",p,o]);return {body:{}};}
  }};
  const api=await createHostingReader({projectId:project,cwd:repoRoot},{sdk});
  await api.channel(project,"live");await api.version(project,fixture().staff.previousVersion);
  await api.createBackup(project,"rb-123");await api.release(project,"live",fixture().staff.previousVersion);
  await api.deleteTemporaryChannel(project,"rb-123");
  const before=calls.length;
  for(const invoke of [()=>api.release("production","live",fixture().staff.previousVersion),()=>api.createBackup(project,"live"),()=>api.deleteTemporaryChannel(project,"live"),()=>api.channel("other","live"),()=>api.version(project,"../secret")])await assert.rejects(invoke);
  assert.equal(calls.length,before);assert.ok(calls.every(c=>c[1].startsWith("projects/"+project+"/sites/")||c[1].startsWith("sites/"+project+"/versions/")));
  await assert.rejects(()=>createHostingReader({projectId:"production",cwd:repoRoot},{sdk}),/ENVIRONMENT_REJECTED/);
 });
 console.log(`Hosting version restore tests passed (${cases} cases; mocked Hosting/GitHub; 0 cloud calls)`);
 return cases;
}
