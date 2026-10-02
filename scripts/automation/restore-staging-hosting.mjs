import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const allowedProjectId = "lip-knots-crew-staging";
const siteIdPattern = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const rollbackChannelPattern = /^rb-[0-9]{1,20}$/u;

function valueAfter(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

export function validateRestoreOptions({
  projectId,
  staffSite,
  adminSite,
  rollbackChannel,
  evidenceDir,
}) {
  if (projectId !== allowedProjectId) {
    throw new Error(`PROJECT_NOT_ALLOWED:${projectId}`);
  }
  for (const [label, siteId] of [
    ["STAFF", staffSite],
    ["ADMIN", adminSite],
  ]) {
    if (!siteIdPattern.test(siteId)) {
      throw new Error(`${label}_SITE_REJECTED:${siteId}`);
    }
  }
  if (staffSite === adminSite) throw new Error("HOSTING_SITES_NOT_SEPARATED");
  requireValue(staffSite === hostingSites.staff && adminSite === hostingSites.admin, "SITE_PAIR_REJECTED");
  if (!rollbackChannelPattern.test(rollbackChannel)) {
    throw new Error(`ROLLBACK_CHANNEL_REJECTED:${rollbackChannel}`);
  }
  if (!path.isAbsolute(evidenceDir)) {
    throw new Error("EVIDENCE_DIRECTORY_MUST_BE_ABSOLUTE");
  }
  return {
    projectId,
    staffSite,
    adminSite,
    rollbackChannel,
    evidenceDir: path.resolve(evidenceDir),
  };
}

export async function releaseHostingVersion({source, target, projectId, cwd, expectedLiveVersion}, {reader} = {}) {
  let writeAttempted = false;
  try {
    requireValue(projectId === allowedProjectId, "ENVIRONMENT_REJECTED");
    const m = /^([a-z0-9-]+)(?:@([a-f0-9]{16})|:(rb-[0-9]{1,20}))$/u.exec(source);
    const t = /^([a-z0-9-]+):live$/u.exec(target);
    requireValue(m && t && m[1] === t[1] && Object.values(hostingSites).includes(m[1]), "CLONE_TARGET_REJECTED");
    const api = reader ?? await createHostingReader({projectId, cwd});
    const id = m[2] ?? versionId(m[1], (await api.channel(m[1],m[3]))?.release?.version);
    requireValue(versionId(m[1],await api.version(m[1],id)) === id, "RESTORE_TARGET_UNAVAILABLE");
    const live = versionId(m[1],(await api.channel(m[1],"live"))?.release?.version);
    if (live !== id) {
      requireValue(!expectedLiveVersion || live === expectedLiveVersion, "LIVE_CHANGED_SINCE_PROMOTION");
      writeAttempted = true;
      await api.release(m[1],"live",id);
    }
    return {code:0,outcome:"applied",stdout:JSON.stringify({status:"success",version:id})};
  } catch (error) {
    const httpStatus = error?.status ?? error?.context?.httpErrorCode;
    const rejected = Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500 && ![408,429].includes(httpStatus);
    return {code:1,outcome:!writeAttempted?"not-attempted":rejected?"rejected":"unknown",stdout:""};
  }
}

const runFirebaseClone = releaseHostingVersion;

function normalizeAttempt(label, result) {
  const code = Number.isInteger(result?.code) ? result.code : 1;
  return {
    label,
    code,
    status: code === 0 ? "success" : "failure",
    stdout: String(result?.stdout ?? ""),
  };
}

function evidenceContent(attempt) {
  if (attempt.stdout.trim()) return `${attempt.stdout.trim()}\n`;
  return `${JSON.stringify({
    status: attempt.status,
    exitCode: attempt.code,
    cliOutputPresent: false,
  })}\n`;
}

async function writeGitHubOutput(outputPath, values) {
  if (!outputPath) return;
  await appendFile(
    outputPath,
    `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    "utf8",
  );
}

export async function restoreBothSites(
  options,
  {
    executor = runFirebaseClone,
    cwd = process.cwd(),
    githubOutputPath = "",
  } = {},
) {
  const validated = validateRestoreOptions(options);
  await mkdir(validated.evidenceDir, { recursive: true });

  const requests = [
    {
      label: "staff",
      source: `${validated.staffSite}:${validated.rollbackChannel}`,
      target: `${validated.staffSite}:live`,
    },
    {
      label: "admin",
      source: `${validated.adminSite}:${validated.rollbackChannel}`,
      target: `${validated.adminSite}:live`,
    },
  ];
  const attempts = [];

  for (const request of requests) {
    let result;
    try {
      result = await executor({
        ...request,
        projectId: validated.projectId,
        cwd,
      });
    } catch {
      result = { code: 1, stdout: "" };
    }
    attempts.push(normalizeAttempt(request.label, result));
  }

  await Promise.all(
    attempts.map((attempt) => writeFile(
      path.join(validated.evidenceDir, `${attempt.label}-rollback.json`),
      evidenceContent(attempt),
      { encoding: "utf8", mode: 0o600 },
    )),
  );

  const [staff, admin] = attempts;
  const success = attempts.every((attempt) => attempt.code === 0);
  await writeGitHubOutput(githubOutputPath, {
    attempted: "true",
    staff_status: staff.status,
    admin_status: admin.status,
    result: success ? "success" : "failure",
  });

  return {
    success,
    attempts: attempts.map(({ label, code, status }) => ({ label, code, status })),
  };
}

async function main() {
  const result = await restoreBothSites(
    {
      projectId: valueAfter("--project"),
      staffSite: valueAfter("--staff-site"),
      adminSite: valueAfter("--admin-site"),
      rollbackChannel: valueAfter("--channel"),
      evidenceDir: valueAfter("--evidence-dir"),
    },
    {
      githubOutputPath: valueAfter("--github-output"),
    },
  );
  const staff = result.attempts.find((attempt) => attempt.label === "staff");
  const admin = result.attempts.find((attempt) => attempt.label === "admin");
  console.log(`HOSTING_ROLLBACK_STAFF=${staff?.status.toUpperCase() ?? "FAILURE"}`);
  console.log(`HOSTING_ROLLBACK_ADMIN=${admin?.status.toUpperCase() ?? "FAILURE"}`);
  console.log(`HOSTING_ROLLBACK_RESULT=${result.success ? "SUCCESS" : "FAILURE"}`);
  if (!result.success) process.exitCode = 1;
}


const allowedRegion = "asia-northeast1";
const allowedRepository = "Hanabo0930/Lip-Knots-Crew";
const workflowPath = ".github/workflows/staging-hosting-promote.yml";
const hostingSites = Object.freeze({staff: allowedProjectId, admin: allowedProjectId + "-admin"});
const hexVersion = /^[a-f0-9]{16}$/u;
const sourceShaPattern = /^[a-f0-9]{40}$/u;
const decimalId = /^[1-9][0-9]{0,19}$/u;
const confirmations = Object.freeze({
  promote: "PROMOTE_LKC_STAGING_HOSTING",
  readiness: "CHECK_LKC_STAGING_HOSTING_READINESS",
  restore: "RESTORE_LKC_STAGING_HOSTING",
});
function requireValue(condition, code) { if (!condition) throw new Error(code); }
function requireProtectedContext() {
  requireValue(process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REPOSITORY === allowedRepository
    && process.env.GITHUB_REF === "refs/heads/main" && process.env.GITHUB_JOB === "promote"
    && process.env.GITHUB_WORKFLOW_REF === allowedRepository + "/" + workflowPath + "@refs/heads/main", "PROTECTED_WORKFLOW_CONTEXT_REQUIRED");
}
export function validateHostingOperation({operation, eventName, confirmation, projectId, region, sourceRef, runAttempt = 1}) {
  requireValue(projectId === allowedProjectId && region === allowedRegion && sourceRef === "main", "ENVIRONMENT_REJECTED");
  requireValue(Object.hasOwn(confirmations, operation), "OPERATION_REJECTED");
  requireValue(eventName === "workflow_dispatch" || eventName === "workflow_run", "TRIGGER_REJECTED");
  requireValue(eventName !== "workflow_run" || operation === "promote", "MANUAL_OPERATION_REQUIRED");
  requireValue(confirmation === confirmations[operation], "CONFIRMATION_REJECTED");
  requireValue(Number.isSafeInteger(runAttempt) && runAttempt > 0 && (operation === "readiness" || runAttempt === 1),"WORKFLOW_RERUN_REJECTED");
  return operation;
}
function validatePair(manifest) {
  requireValue(manifest?.schemaVersion === 1 && manifest.operation === "promote", "MANIFEST_SCHEMA_REJECTED");
  requireValue(manifest.projectId === allowedProjectId && manifest.region === allowedRegion, "ENVIRONMENT_REJECTED");
  requireValue(typeof manifest.sourceSha === "string" && sourceShaPattern.test(manifest.sourceSha), "SOURCE_SHA_REJECTED");
  requireValue(typeof manifest.promotionRunId === "string" && decimalId.test(manifest.promotionRunId), "PROMOTION_RUN_REJECTED");
  requireValue(Number.isSafeInteger(manifest.runAttempt) && manifest.runAttempt > 0, "RUN_ATTEMPT_REJECTED");
  for (const label of ["staff", "admin"]) {
    const entry = manifest[label];
    requireValue(entry?.siteId === hostingSites[label], "SITE_PAIR_REJECTED");
    requireValue(typeof entry.previousVersion === "string" && typeof entry.promotedVersion === "string"
      && hexVersion.test(entry.previousVersion) && hexVersion.test(entry.promotedVersion), "VERSION_REJECTED");
    requireValue(entry.previousVersion !== entry.promotedVersion, "VERSION_PAIR_REJECTED");
  }
}
function versionId(site, metadata) {
  requireValue(metadata?.status === "FINALIZED", "VERSION_NOT_FINALIZED");
  const prefix = "sites/" + site + "/versions/";
  const projectPrefix = "projects/" + allowedProjectId + "/" + prefix;
  const name = metadata.name;
  requireValue(typeof name === "string", "VERSION_RESOURCE_REJECTED");
  const id = name.startsWith(prefix) ? name.slice(prefix.length) : name.startsWith(projectPrefix) ? name.slice(projectPrefix.length) : "";
  requireValue(hexVersion.test(id), "VERSION_RESOURCE_REJECTED");
  return id;
}
export function planVersionRestore(manifest, snapshots) {
  validatePair(manifest);
  requireValue(manifest.promotionResult === "success", "SUCCESSFUL_PROMOTION_REQUIRED");
  const requests = [], alreadyRestored = [];
  for (const label of ["staff", "admin"]) {
    const entry = manifest[label], s = snapshots?.[label];
    requireValue(s?.liveSiteId === hostingSites[label], "LIVE_SITE_REJECTED");
    requireValue(s.liveVersion === entry.previousVersion || s.liveVersion === entry.promotedVersion, "LIVE_CHANGED_SINCE_PROMOTION");
    requireValue(versionId(entry.siteId, s.previousVersion) === entry.previousVersion, "RESTORE_TARGET_UNAVAILABLE");
    if (s.liveVersion === entry.previousVersion) alreadyRestored.push(label);
    else requests.push(Object.freeze({label, source: entry.siteId + "@" + entry.previousVersion,
      target: entry.siteId + ":live", expectedLiveVersion: entry.promotedVersion, restoreVersion: entry.previousVersion}));
  }
  return Object.freeze({projectId: allowedProjectId, status: requests.length ? "PLANNED" : "ALREADY_RESTORED",
    requests: Object.freeze(requests), alreadyRestored: Object.freeze(alreadyRestored)});
}
export function validatePromotionEvidence({run, artifact, manifest, restoreRunId, repository}) {
  requireValue(repository === allowedRepository, "REPOSITORY_REJECTED");
  requireValue(typeof restoreRunId === "string" && decimalId.test(restoreRunId), "PROMOTION_RUN_REJECTED");
  requireValue(String(run?.id) === restoreRunId && run?.repository?.full_name === repository
    && run.name === "Staging Hosting Promote" && run.path === workflowPath
    && run.head_branch === "main" && run.display_title === "promote staging Hosting" && run.status === "completed" && run.conclusion === "success"
    && ["workflow_run","workflow_dispatch"].includes(run.event), "PROMOTION_EVIDENCE_REJECTED");
  validatePair(manifest);
  requireValue(manifest.promotionResult === "success" && manifest.promotionRunId === restoreRunId
    && manifest.sourceSha === run.head_sha && manifest.runAttempt === run.run_attempt, "MANIFEST_PROVENANCE_REJECTED");
  requireValue(artifact?.name === "staging-hosting-promote-" + run.head_sha && artifact.expired === false
    && String(artifact.workflow_run?.id) === restoreRunId && artifact.workflow_run?.head_sha === run.head_sha
    && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? ""), "ARTIFACT_PROVENANCE_REJECTED");
  return manifest;
}
function runGh(args, encoding = "utf8") {
  const result = spawnSync("gh", ["api", ...args], {encoding, maxBuffer: 8 * 1024 * 1024, stdio:["ignore","pipe","pipe"]});
  requireValue(result.status === 0 && !result.error, "GITHUB_READ_FAILED");
  return result.stdout;
}
export function readManifestArchive(blob, digest, decoder = decodePromotionManifestArchive) {
  requireValue(Buffer.isBuffer(blob) && blob.length > 0 && blob.length <= 8 * 1024 * 1024, "ARTIFACT_SIZE_REJECTED");
  requireValue(digest === "sha256:" + createHash("sha256").update(blob).digest("hex"), "ARTIFACT_DIGEST_MISMATCH");
  return decoder(blob);
}
export function decodePromotionManifestArchive(blob, {pythonExecutable = "python3", memberName = "restore-manifest.json"} = {}) {
  requireValue(["restore-manifest.json","manual-restore-result.json"].includes(memberName), "ARCHIVE_MEMBER_REJECTED");
  // Read only this JSON member; never extract screenshots, environment files or paths.
  const code = [
    "import sys,zipfile,io,json",
    "z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))",
    "members=[i for i in z.infolist() if i.filename==" + JSON.stringify(memberName) + "]",
    "assert len(members)==1 and members[0].file_size<=65536",
    "print(json.dumps(json.loads(z.read(members[0]))))",
  ].join("\n");
  const r = spawnSync(pythonExecutable, ["-c", code], {input:blob, maxBuffer:131072, stdio:["pipe","pipe","pipe"]});
  requireValue(r.status === 0 && !r.error, "RESTORE_MANIFEST_ARCHIVE_REJECTED");
  return JSON.parse(r.stdout.toString("utf8"));
}
export async function loadVerifiedPromotionManifest({repository, restoreRunId}, {github = runGh, archiveReader = readManifestArchive} = {}) {
  requireValue(repository === allowedRepository, "REPOSITORY_REJECTED");
  requireValue(typeof restoreRunId === "string" && decimalId.test(restoreRunId), "PROMOTION_RUN_REJECTED");
  const prefix = "/repos/" + repository + "/actions/runs/" + restoreRunId;
  const run = JSON.parse(await github([prefix]));
  // Reject non-successful/foreign runs before downloading anything.
  requireValue(String(run.id) === restoreRunId && run.repository?.full_name === repository
    && run.name === "Staging Hosting Promote" && run.path === workflowPath && run.display_title === "promote staging Hosting" && run.head_branch === "main"
    && run.status === "completed" && run.conclusion === "success" && ["workflow_run","workflow_dispatch"].includes(run.event), "PROMOTION_EVIDENCE_REJECTED");
  const listing = JSON.parse(await github([prefix + "/artifacts?per_page=100"]));
  requireValue(Number.isInteger(listing.total_count) && listing.total_count <= 100 && Array.isArray(listing.artifacts) && listing.artifacts.length === listing.total_count, "ARTIFACT_LIST_INCOMPLETE");
  const artifacts = (listing.artifacts ?? []).filter(a=>a.name === "staging-hosting-promote-" + run.head_sha);
  requireValue(artifacts.length === 1, "ARTIFACT_NOT_UNIQUE");
  const artifact = artifacts[0];
  requireValue(Number.isSafeInteger(artifact.id) && artifact.id > 0 && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 8 * 1024 * 1024
    && artifact.expired === false && String(artifact.workflow_run?.id) === restoreRunId
    && artifact.workflow_run?.head_sha === run.head_sha
    && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? ""), "ARTIFACT_PROVENANCE_REJECTED");
  const blob = await github(["/repos/" + repository + "/actions/artifacts/" + artifact.id + "/zip"], null);
  requireValue(Buffer.isBuffer(blob) && blob.length === artifact.size_in_bytes,"ARTIFACT_SIZE_MISMATCH");
  const manifest = await archiveReader(blob, artifact.digest);
  return validatePromotionEvidence({run, artifact, manifest, restoreRunId, repository});
}
export async function requireCurrentMain(sourceSha, github = runGh) {
  requireValue(typeof sourceSha === "string" && sourceShaPattern.test(sourceSha), "SOURCE_SHA_REJECTED");
  const ref = JSON.parse(await github(["/repos/" + allowedRepository + "/git/ref/heads/main"]));
  requireValue(ref.object?.sha === sourceSha, "SOURCE_SHA_CHANGED_DURING_OPERATION");
}

export function promotionManifestDigest(manifest) {
  validatePair(manifest);
  const parts = [manifest.schemaVersion,manifest.projectId,manifest.region,manifest.sourceSha,
    manifest.promotionRunId,manifest.runAttempt];
  for (const label of ["staff","admin"]) parts.push(manifest[label].siteId,manifest[label].previousVersion,manifest[label].promotedVersion);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
export function validateRestoreRetryEvidence(result, run, manifest) {
  requireValue(result?.schemaVersion === 1 && result.operation === "restore" && result.phase === "complete"
    && result.projectId === allowedProjectId && result.region === allowedRegion
    && result.currentRunId === String(run.id) && result.runAttempt === run.run_attempt
    && result.sourceSha === run.head_sha && result.targetPromotionRunId === manifest.promotionRunId
    && result.manifestDigest === promotionManifestDigest(manifest), "RESTORE_RETRY_PROVENANCE_REJECTED");
  requireValue(result.retryAllowed === true && result.finalPairKnown === true && Array.isArray(result.attempts)
    && result.attempts.length === 2 && result.attempts.every((a,i)=>a.label === ["staff","admin"][i]
      && ["success","failure","already-restored"].includes(a.status)
      && (a.status==="success" ? a.outcome==="applied" : a.status==="already-restored" ? a.outcome==="not-attempted" : ["rejected","not-attempted"].includes(a.outcome))), "RESTORE_PREVIOUS_RESULT_UNKNOWN");
}
export async function requireRestoreRetrySafety(manifest, {currentRunId,currentRunAttempt}, {
  github = runGh,
  archiveReader = (blob,digest)=>readManifestArchive(blob,digest,b=>decodePromotionManifestArchive(b,{memberName:"manual-restore-result.json"})),
} = {}) {
  validatePair(manifest);
  requireValue(typeof currentRunId === "string" && decimalId.test(currentRunId), "CURRENT_RUN_REJECTED");
  requireValue(currentRunAttempt === 1,"RESTORE_WORKFLOW_RERUN_REJECTED");
  const previous = [];
  let total;
  for (let page=1;page<=10;page++) {
    const list=JSON.parse(await github(["/repos/"+allowedRepository+"/actions/workflows/staging-hosting-promote.yml/runs?event=workflow_dispatch&per_page=100&page="+page]));
    requireValue(Number.isInteger(list.total_count) && list.total_count >= 0 && list.total_count <= 1000
      && Array.isArray(list.workflow_runs), "RESTORE_HISTORY_INCOMPLETE");
    if(total !== undefined)requireValue(total===list.total_count,"RESTORE_HISTORY_CHANGED");
    total=list.total_count;
    const expected=Math.min(100,Math.max(0,total-(page-1)*100));
    requireValue(list.workflow_runs.length === expected,"RESTORE_HISTORY_INCOMPLETE");
    for (const run of list.workflow_runs) {
      if(run.display_title !== "restore staging Hosting from "+manifest.promotionRunId)continue;
      requireValue(Number.isSafeInteger(run.id)&&run.id>0,"RESTORE_HISTORY_REJECTED");
      // Run IDs express creation order; concurrency does not guarantee execution order.
      if(String(run.id)===currentRunId)continue;
      requireValue(run.repository?.full_name===allowedRepository && run.path===workflowPath
        && run.name==="Staging Hosting Promote" && run.event==="workflow_dispatch"
        && run.head_branch==="main" && run.status==="completed"
        && typeof run.head_sha==="string" && sourceShaPattern.test(run.head_sha)
        && Number.isSafeInteger(run.run_attempt) && run.run_attempt>0,"RESTORE_PREVIOUS_RUN_UNRESOLVED");
      previous.push(run);
    }
    if(page*100>=total)break;
  }
  for(const run of previous){
    const data=JSON.parse(await github(["/repos/"+allowedRepository+"/actions/runs/"+run.id+"/artifacts?per_page=100"]));
    requireValue(Number.isInteger(data.total_count)&&data.total_count<=100&&Array.isArray(data.artifacts)
      &&data.artifacts.length===data.total_count,"RESTORE_RETRY_EVIDENCE_REQUIRED");
    const artifacts=data.artifacts.filter(a=>a.name==="staging-hosting-restore-"+run.head_sha);
    requireValue(artifacts.length===1,"RESTORE_RETRY_EVIDENCE_REQUIRED");
    const artifact=artifacts[0];
    requireValue(Number.isSafeInteger(artifact.id)&&artifact.id>0
      &&Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=8*1024*1024
      &&artifact.expired===false&&String(artifact.workflow_run?.id)===String(run.id)
      &&artifact.workflow_run?.head_sha===run.head_sha&&/^sha256:[a-f0-9]{64}$/u.test(artifact.digest??""),"RESTORE_RETRY_EVIDENCE_REQUIRED");
    const blob=await github(["/repos/"+allowedRepository+"/actions/artifacts/"+artifact.id+"/zip"],null);
    requireValue(Buffer.isBuffer(blob)&&blob.length===artifact.size_in_bytes,"ARTIFACT_SIZE_MISMATCH");
    validateRestoreRetryEvidence(await archiveReader(blob,artifact.digest),run,manifest);
  }
}
async function writeAttemptEvidence(file, result) {
  const temporary=file+".tmp";
  await writeFile(temporary,JSON.stringify(result,null,2)+"\n",{mode:0o600});
  await rename(temporary,file);
}
export async function requireNoFeeSourcePath({projectId,region,sourceSha,evidenceDir}) {
  requireValue(projectId===allowedProjectId&&region===allowedRegion,"ENVIRONMENT_REJECTED");
  requireValue(typeof sourceSha==="string"&&sourceShaPattern.test(sourceSha),"SOURCE_SHA_REJECTED");
  requireValue(path.isAbsolute(evidenceDir),"EVIDENCE_DIRECTORY_MUST_BE_ABSOLUTE");
  // GCS read-only source download is not automatically free, especially outside
  // the Free Tier US regions. No paid-read override flag is provided.
  await mkdir(evidenceDir,{recursive:true});
  await writeAttemptEvidence(path.join(evidenceDir,"api-readiness.json"),{
    status:"STOPPED",reason:"VERIFIED_NO_FEE_SOURCE_PATH_REQUIRED",sourceSha,
    externalApiInvoked:false,deployedSourceVerified:false,
  });
  throw new Error("VERIFIED_NO_FEE_SOURCE_PATH_REQUIRED");
}

function validateRuntime({projectId, region, staffSite, adminSite, evidenceDir}) {
  requireValue(projectId === allowedProjectId && region === allowedRegion, "ENVIRONMENT_REJECTED");
  requireValue(staffSite === hostingSites.staff && adminSite === hostingSites.admin, "SITE_PAIR_REJECTED");
  requireValue(path.isAbsolute(evidenceDir), "EVIDENCE_DIRECTORY_MUST_BE_ABSOLUTE");
}
export async function createHostingReader({projectId, cwd = process.cwd()}, {sdk} = {}) {
  requireValue(projectId === allowedProjectId, "ENVIRONMENT_REJECTED");
  const require = createRequire(path.join(cwd, "package.json"));
  const {command, requireAuth, Client} = sdk ?? {
    command:require("firebase-tools/lib/commands/hosting-sites-list").command,
    requireAuth:require("firebase-tools/lib/requireAuth").requireAuth,
    Client:require("firebase-tools/lib/apiv2").Client,
  };
  const options = {project:projectId, nonInteractive:true, json:true, cwd};
  await command.prepare(options); await requireAuth(options);
  const client = new Client({urlPrefix:"https://firebasehosting.googleapis.com", apiVersion:"v1beta1"});
  async function get(resource, fields) {
    return (await client.get(resource, {queryParams:{fields}, retryCodes:[], timeout:12000, skipLog:{body:true,response:true}})).body;
  }
  return {
    async channel(site, channel) {
      requireValue(Object.values(hostingSites).includes(site) && (channel === "live" || /^rb-[0-9]{1,20}$/u.test(channel) || /^rc-[a-f0-9]{12}$/u.test(channel)), "CHANNEL_READ_REJECTED");
      return get("projects/" + projectId + "/sites/" + site + "/channels/" + channel, "name,release(version(name,status))");
    },
    async release(site, channel, id) {
      requireValue(Object.values(hostingSites).includes(site) && (channel === "live" || rollbackChannelPattern.test(channel)) && hexVersion.test(id), "RELEASE_WRITE_REJECTED");
      await client.post("projects/" + projectId + "/sites/" + site + "/channels/" + channel + "/releases", {}, {queryParams:{versionName:"sites/" + site + "/versions/" + id},retryCodes:[],timeout:12000,skipLog:{body:true,response:true}});
    },
    async createBackup(site, channel) {
      requireValue(Object.values(hostingSites).includes(site) && rollbackChannelPattern.test(channel), "BACKUP_WRITE_REJECTED");
      await client.post("projects/" + projectId + "/sites/" + site + "/channels", {ttl:"86400s"}, {queryParams:{channelId:channel},retryCodes:[],timeout:12000,skipLog:{body:true,response:true}});
    },
    async deleteTemporaryChannel(site, channel) {
      requireValue(Object.values(hostingSites).includes(site) && (rollbackChannelPattern.test(channel) || /^rc-[a-f0-9]{12}$/u.test(channel)), "CHANNEL_DELETE_REJECTED");
      await client.delete("projects/" + projectId + "/sites/" + site + "/channels/" + channel,{retryCodes:[],timeout:12000,skipLog:{body:true,response:true}});
    },
    async version(site, id) {
      requireValue(Object.values(hostingSites).includes(site) && hexVersion.test(id), "VERSION_READ_REJECTED");
      return get("sites/" + site + "/versions/" + id, "name,status");
    },
  };
}
export async function readRestoreSnapshots(manifest, reader) {
  validatePair(manifest);
  const pairs = await Promise.all(["staff","admin"].map(async label=>{
    const entry = manifest[label];
    const [live, previousVersion] = await Promise.all([
      reader.channel(entry.siteId, "live"), reader.version(entry.siteId, entry.previousVersion),
    ]);
    return [label, {liveSiteId:entry.siteId, liveVersion:versionId(entry.siteId, live?.release?.version), previousVersion}];
  }));
  return Object.fromEntries(pairs);
}
export async function backupCurrentPair(options, api) {
  validateRuntime(options);
  requireValue(typeof options.promotionRunId === "string" && decimalId.test(options.promotionRunId)
    && options.rollbackChannel === "rb-" + options.promotionRunId, "ROLLBACK_CHANNEL_REJECTED");
  const before={};
  for (const label of ["staff","admin"]) before[label]=versionId(hostingSites[label],(await api.channel(hostingSites[label],"live"))?.release?.version);
  for (const label of ["staff","admin"]) {
    const site=hostingSites[label];
    requireValue(versionId(site,(await api.channel(site,"live"))?.release?.version) === before[label],"BACKUP_LIVE_CHANGED");
    await api.createBackup(site,options.rollbackChannel);
    await api.release(site,options.rollbackChannel,before[label]);
    requireValue(versionId(site,(await api.channel(site,options.rollbackChannel))?.release?.version) === before[label],"BACKUP_READBACK_MISMATCH");
  }
  return before;
}
export async function capturePromotion(options, reader) {
  validateRuntime(options);
  requireValue(typeof options.sourceSha === "string" && sourceShaPattern.test(options.sourceSha), "SOURCE_SHA_REJECTED");
  requireValue(typeof options.promotionRunId === "string" && decimalId.test(options.promotionRunId), "PROMOTION_RUN_REJECTED");
  requireValue(options.rollbackChannel === "rb-" + options.promotionRunId && rollbackChannelPattern.test(options.rollbackChannel), "ROLLBACK_CHANNEL_REJECTED");
  requireValue(options.previewChannel === "rc-" + options.sourceSha.slice(0,12), "PREVIEW_CHANNEL_REJECTED");
  const manifest = {schemaVersion:1, operation:"promote", projectId:allowedProjectId, region:allowedRegion, sourceSha:options.sourceSha,
    promotionRunId:options.promotionRunId, runAttempt:options.runAttempt, promotionResult:"prepared"};
  for (const label of ["staff","admin"]) {
    const site = hostingSites[label];
    const [live, backup, preview] = await Promise.all([
      reader.channel(site,"live"), reader.channel(site,options.rollbackChannel), reader.channel(site,options.previewChannel),
    ]);
    const previousVersion = versionId(site, live?.release?.version);
    requireValue(versionId(site, backup?.release?.version) === previousVersion, "BACKUP_LIVE_MISMATCH");
    manifest[label] = {siteId:site, previousVersion, promotedVersion:versionId(site,preview?.release?.version)};
  }
  validatePair(manifest);
  return manifest;
}
export async function verifyCapturedLive(manifest, reader, phase) {
  validatePair(manifest);
  requireValue(manifest.promotionResult === "prepared" && ["before","after"].includes(phase), "CAPTURE_PHASE_REJECTED");
  for (const label of ["staff","admin"]) {
    const entry=manifest[label], live=await reader.channel(entry.siteId,"live");
    requireValue(versionId(entry.siteId, live?.release?.version) === entry[phase === "before" ? "previousVersion" : "promotedVersion"], "CAPTURE_LIVE_CHANGED");
  }
  return phase === "after" ? {...manifest, promotionResult:"success"} : manifest;
}

function promotionExecutionManifest(manifest) {
  validatePair(manifest);
  const result={...manifest,promotionResult:"success"};
  for(const label of ["staff","admin"])result[label]={...manifest[label],
    previousVersion:manifest[label].promotedVersion,promotedVersion:manifest[label].previousVersion};
  return result;
}
export function requireKnownPromotionResult(result, manifest) {
  validatePair(manifest);
  requireValue(result?.operation==="promote","PROMOTION_RESULT_UNKNOWN_OR_UNVERIFIED");
  validateRestoreRetryEvidence({...result,operation:"restore"},{
    id:manifest.promotionRunId,run_attempt:manifest.runAttempt,head_sha:manifest.sourceSha,
  },promotionExecutionManifest(manifest));
  const allApplied=result.attempts.every(a=>["success","already-restored"].includes(a.status));
  requireValue(["success","failure"].includes(result.status) && typeof result.finalPairRestored==="boolean"
    && result.success===(result.status==="success")
    && result.finalPairRestored===allApplied && result.success===(result.finalPairRestored&&allApplied),"PROMOTION_RESULT_UNKNOWN_OR_UNVERIFIED");
  return result;
}
export async function loadKnownPromotionResult(manifest,evidenceDir) {
  validatePair(manifest);
  requireValue(path.isAbsolute(evidenceDir),"EVIDENCE_DIRECTORY_MUST_BE_ABSOLUTE");
  try{
    const text=await readFile(path.join(evidenceDir,"promotion-version-result.json"),"utf8");
    requireValue(Buffer.byteLength(text,"utf8")<=64*1024,"PROMOTION_RESULT_UNKNOWN_OR_UNVERIFIED");
    return requireKnownPromotionResult(JSON.parse(text),manifest);
  }catch{
    await mkdir(evidenceDir,{recursive:true});
    await writeAttemptEvidence(path.join(evidenceDir,"automatic-rollback-stop.json"),{
      schemaVersion:1,operation:"automatic-rollback",status:"STOPPED",
      reason:"PROMOTION_RESULT_UNKNOWN_OR_UNVERIFIED",projectId:allowedProjectId,region:allowedRegion,
      sourceSha:manifest.sourceSha,promotionRunId:manifest.promotionRunId,runAttempt:manifest.runAttempt,
      externalApiInvoked:false,
    });
    throw new Error("PROMOTION_RESULT_UNKNOWN_OR_UNVERIFIED");
  }
}
async function requireUnusedPromotionAttempt(evidenceDir) {
  try{
    await readFile(path.join(evidenceDir,"promotion-version-result.json"),{encoding:"utf8"});
  }catch(error){
    if(error?.code==="ENOENT")return;
    throw new Error("PROMOTION_ATTEMPT_ALREADY_RECORDED");
  }
  await writeAttemptEvidence(path.join(evidenceDir,"promotion-retry-stop.json"),{
    schemaVersion:1,status:"STOPPED",reason:"PROMOTION_ATTEMPT_ALREADY_RECORDED",externalApiInvoked:false,
  });
  throw new Error("PROMOTION_ATTEMPT_ALREADY_RECORDED");
}

export async function restoreVersionPair(manifest, options, {reader, executor=runFirebaseClone, githubOutputPath="", authorize = async () => {}} = {}) {
  validateRuntime(options);
  if(options.mode==="promotion")await requireUnusedPromotionAttempt(options.evidenceDir);
  const plan=planVersionRestore(manifest,await readRestoreSnapshots(manifest,reader));
  const attempts=[];
  let unsafe=false, finalPairRestored=false, finalPairKnown=false;
  const trace={schemaVersion:1,operation:options.mode==="promotion"?"promote":"restore",projectId:allowedProjectId,region:allowedRegion,
    currentRunId:options.currentRunId??options.promotionRunId??"",runAttempt:options.runAttempt??0,sourceSha:options.sourceSha??"",
    targetPromotionRunId:manifest.promotionRunId,manifestDigest:promotionManifestDigest(manifest)};
  const file=path.join(options.evidenceDir,options.mode==="promotion"?"promotion-version-result.json":"manual-restore-result.json");
  await mkdir(options.evidenceDir,{recursive:true});
  async function checkpoint(phase,pendingSite=null){
    await writeAttemptEvidence(file,{...trace,phase,pendingSite,attempts:[...attempts],retryAllowed:false});
  }
  await checkpoint("started");
  for(const label of ["staff","admin"]){
    let writeSubmitted=false;
    try{
      await authorize();
      const freshPlan=planVersionRestore(manifest,await readRestoreSnapshots(manifest,reader));
      requireValue(!freshPlan.requests.some(r=>attempts.some(a=>a.label===r.label&&["success","already-restored"].includes(a.status))),"LIVE_PREVIOUSLY_RESTORED_CHANGED");
      const request=freshPlan.requests.find(r=>r.label===label);
      if(!request){attempts.push({label,status:"already-restored",outcome:"not-attempted"});await checkpoint("between-sites");continue;}
      // No Hosting CAS. Same-workflow concurrency excludes its own writes only;
      // an external no-other-writer window remains necessary.
      await checkpoint("write-uncertain",label);
      writeSubmitted=true;
      let clone;
      try{clone=await executor({...request,projectId:allowedProjectId,cwd:options.cwd??process.cwd()});}
      catch{clone={code:1,outcome:"unknown"};}
      // An unknown promotion POST may still arrive later; readback cannot authorize reversal.
      if(options.mode==="promotion"&&!["applied","rejected","not-attempted"].includes(clone?.outcome)){
        attempts.push({label,status:"unknown",outcome:"unknown",commandExitCode:Number.isInteger(clone?.code)?clone.code:1});
        unsafe=true;await checkpoint("blocked");break;
      }
      const after=planVersionRestore(manifest,await readRestoreSnapshots(manifest,reader));
      requireValue(!after.requests.some(r=>attempts.some(a=>a.label===r.label&&["success","already-restored"].includes(a.status))),"LIVE_PREVIOUSLY_RESTORED_CHANGED");
      const restored=after.alreadyRestored.includes(label);
      const outcome=restored?"applied":["rejected","not-attempted"].includes(clone?.outcome)?clone.outcome:"unknown";
      attempts.push({label,status:restored?"success":outcome==="unknown"?"unknown":"failure",outcome,
        commandExitCode:Number.isInteger(clone?.code)?clone.code:1});
      if(outcome==="unknown"){unsafe=true;await checkpoint("blocked");break;}
      await checkpoint("between-sites");
    }catch{
      if(options.mode==="promotion"&&!writeSubmitted){
        // No POST was submitted for this or the remaining sites. Final pair readback
        // must still succeed before the pinned same-run rollback can be authorized.
        for(const pending of ["staff","admin"])if(!attempts.some(a=>a.label===pending))
          attempts.push({label:pending,status:"failure",outcome:"not-attempted",reason:"PRE_WRITE_CHECK_FAILED"});
        await checkpoint("pre-write-stopped");break;
      }
      unsafe=true;
      if(!attempts.some(a=>a.label===label))attempts.push({label,status:"blocked",outcome:"unknown"});
      await checkpoint("blocked");
      break;
    }
  }
  if(!unsafe){
    try{
      const finalPlan=planVersionRestore(manifest,await readRestoreSnapshots(manifest,reader));
      requireValue(!finalPlan.requests.some(r=>attempts.some(a=>a.label===r.label&&["success","already-restored"].includes(a.status))),"LIVE_PREVIOUSLY_RESTORED_CHANGED");
      finalPairKnown=true;finalPairRestored=finalPlan.alreadyRestored.length===2;
    }catch{unsafe=true;}
  }
  const retryAllowed=!unsafe&&finalPairKnown&&attempts.length===2&&attempts.every(a=>["applied","rejected","not-attempted"].includes(a.outcome));
  const success=retryAllowed&&finalPairRestored&&attempts.every(a=>["success","already-restored"].includes(a.status));
  const result={...trace,phase:"complete",success,status:success?"success":unsafe?"blocked":"failure",
    initialStatus:plan.status,finalPairRestored,finalPairKnown,retryAllowed,attempts};
  await writeAttemptEvidence(file,result);
  await writeGitHubOutput(githubOutputPath,{attempted:"true",result:result.status,
    rollback_allowed:options.mode==="promotion"&&retryAllowed?"true":"false"});
  return result;
}

async function hostingOperationMain() {
  const operation=valueAfter("--operation","");
  if (!operation) { throw new Error("LEGACY_CHANNEL_RESTORE_DISABLED"); }
  const action = validateHostingOperation({
    operation, eventName:process.env.GITHUB_EVENT_NAME, confirmation:valueAfter("--confirmation"),
    projectId:valueAfter("--project"), region:valueAfter("--region"), sourceRef:process.env.GITHUB_REF_NAME, runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),
  });
  if (process.argv.includes("--guard-only")) { console.log("HOSTING_OPERATION_GUARD=PASS"); return; }
  requireProtectedContext();
  if (action === "readiness") { console.log("HOSTING_READINESS_DISPATCH_GUARD=PASS"); return; }
  if (action === "promote") { console.log("HOSTING_PROMOTION_DISPATCH_GUARD=PASS"); return; }
  requireValue(process.env.GITHUB_REPOSITORY === allowedRepository, "REPOSITORY_REJECTED");
  const options={projectId:valueAfter("--project"),region:valueAfter("--region"),
    staffSite:valueAfter("--staff-site"),adminSite:valueAfter("--admin-site"),evidenceDir:valueAfter("--evidence-dir")};
  validateRuntime(options);
  const manifest=await loadVerifiedPromotionManifest({
    repository:process.env.GITHUB_REPOSITORY,restoreRunId:valueAfter("--restore-run-id"),
  });
  const sourceSha=valueAfter("--source-sha");
  await requireCurrentMain(sourceSha);
  options.sourceSha=sourceSha;
  options.currentRunId=process.env.GITHUB_RUN_ID;
  options.runAttempt=Number(process.env.GITHUB_RUN_ATTEMPT);
  await requireRestoreRetrySafety(manifest,{currentRunId:options.currentRunId,currentRunAttempt:options.runAttempt});
  const reader=await createHostingReader({projectId:allowedProjectId});
  const result=await restoreVersionPair(manifest,options,{reader,githubOutputPath:valueAfter("--github-output"),authorize:()=>requireCurrentMain(sourceSha)});
  console.log("HOSTING_MANUAL_RESTORE_RESULT="+result.status.toUpperCase());
  if(!result.success)process.exitCode=1;
}
async function captureMain() {
  requireProtectedContext();
  const options={projectId:valueAfter("--project"),region:valueAfter("--region"),
    staffSite:valueAfter("--staff-site"),adminSite:valueAfter("--admin-site"),evidenceDir:valueAfter("--evidence-dir"),
    sourceSha:valueAfter("--source-sha"),promotionRunId:process.env.GITHUB_RUN_ID,
    runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),rollbackChannel:valueAfter("--channel"),
    previewChannel:valueAfter("--preview-channel")};
  validateRuntime(options);
  let reader;
  const getReader=async()=>reader??=await createHostingReader({projectId:allowedProjectId});
  const pendingPath=path.join(options.evidenceDir,"pending-restore-manifest.json");
  if(process.argv.includes("--backup")) {
    await backupCurrentPair(options,await getReader());
    await writeGitHubOutput(valueAfter("--github-output"),{ready:"true"});
  } else if(process.argv.includes("--capture")){
    const manifest=await capturePromotion(options,await getReader());
    await mkdir(options.evidenceDir,{recursive:true});
    await writeFile(pendingPath,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});
    await writeGitHubOutput(valueAfter("--github-output"),{
      staff_source:manifest.staff.siteId+"@"+manifest.staff.promotedVersion,
      admin_source:manifest.admin.siteId+"@"+manifest.admin.promotedVersion,
    });
  }else{
    const manifest=JSON.parse(await readFile(pendingPath,"utf8"));
    // Captures are only usable by the same exact workflow run, attempt and source.
    requireValue(manifest.promotionRunId===options.promotionRunId && manifest.runAttempt===options.runAttempt && manifest.sourceSha===options.sourceSha,"CAPTURE_PROVENANCE_REJECTED");
    if (process.argv.includes("--cleanup")) {
      reader=await getReader();
      requireValue(options.previewChannel === "rc-" + manifest.sourceSha.slice(0,12) && options.rollbackChannel === "rb-" + manifest.promotionRunId,"CLEANUP_CHANNEL_REJECTED");
      await verifyCapturedLive(manifest,reader,"after");
      for (const site of Object.values(hostingSites)) for (const channel of [options.previewChannel,options.rollbackChannel]) await reader.deleteTemporaryChannel(site,channel);
      console.log("HOSTING_CHANNEL_CLEANUP=PASS");
      return;
    }
    if (process.argv.includes("--promote-capture") || process.argv.includes("--restore-capture")) {
      const promotion=process.argv.includes("--promote-capture");
      if(promotion)await requireUnusedPromotionAttempt(options.evidenceDir);
      else await loadKnownPromotionResult(manifest,options.evidenceDir);
      reader=await getReader();
      const operationManifest=promotion?promotionExecutionManifest(manifest):{...manifest,promotionResult:"success"};
      if(promotion)await verifyCapturedLive(manifest,reader,"before");
      const result=await restoreVersionPair(operationManifest,{...options,mode:promotion?"promotion":"restore"},{reader,githubOutputPath:valueAfter("--github-output"),authorize:promotion?()=>requireCurrentMain(options.sourceSha):async()=>{}});
      if(!result.success)process.exitCode=1;
      console.log("HOSTING_CAPTURED_PAIR_RESULT="+result.status.toUpperCase());
      return;
    }
    const phase=process.argv.includes("--finalize-capture")?"after":"before";
    const verified=await verifyCapturedLive(manifest,await getReader(),phase);
    if(phase==="after")await writeFile(path.join(options.evidenceDir,"restore-manifest.json"),JSON.stringify(verified,null,2)+"\n",{mode:0o600});
  }
  console.log("HOSTING_RESTORE_CAPTURE=PASS");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const run = process.argv.includes("--no-fee-source-guard") ? () => requireNoFeeSourcePath({projectId:valueAfter("--project"),region:valueAfter("--region"),sourceSha:valueAfter("--source-sha"),evidenceDir:valueAfter("--evidence-dir")}) : process.argv.some(v=>["--backup","--capture","--verify-capture","--finalize-capture","--promote-capture","--restore-capture","--cleanup"].includes(v)) ? captureMain : hostingOperationMain;
  run().catch((error) => {
    // Never echo transport errors, CLI output, credentials or unvalidated input.
    console.error("HOSTING_OPERATION_RESULT=STOPPED_SAFELY");
    console.error("HOSTING_OPERATION_ERROR=" + (error instanceof Error && /^[A-Z_]{1,80}$/u.test(error.message) ? error.message : "INPUT_OR_TRANSPORT_FAILED"));
    process.exitCode = 1;
  });
}
