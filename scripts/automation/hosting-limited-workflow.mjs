import assert from "node:assert/strict";
import {appendFile, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {createHostingReader, requireProtectedContext} from "./restore-staging-hosting.mjs";

const project = "lip-knots-crew-staging";
const sites = {staff: project, admin: project + "-admin"};
const labels = ["staff", "admin"];
function requireValue(value, reason) { if (!value) throw new Error(reason); }
function version(site, value) {
  requireValue(value?.status === "FINALIZED", "PILOT_VERSION_NOT_FINALIZED");
  const match = new RegExp("^(?:projects/" + project + "/)?sites/" + site + "/versions/([a-f0-9]{16})$").exec(value.name ?? "");
  requireValue(match, "PILOT_VERSION_RESOURCE_REJECTED");
  return match[1];
}

export async function readPilotHostingPins({sourceSha, previewRunId}, reader) {
  requireValue(/^[a-f0-9]{40}$/u.test(sourceSha) && /^[1-9][0-9]{0,19}$/u.test(previewRunId), "PILOT_PIN_IDENTITY_REQUIRED");
  const result = {schemaVersion: 1, sourceSha, previewRunId, previewVersions: {}, previousVersions: {}};
  for (const label of labels) {
    const site = sites[label];
    result.previewVersions[label] = version(site, (await reader.channel(site, "rc-" + sourceSha.slice(0, 12)))?.release?.version);
    result.previousVersions[label] = version(site, (await reader.channel(site, "live"))?.release?.version);
    requireValue(result.previewVersions[label] !== result.previousVersions[label], "PILOT_ALREADY_LIVE");
  }
  return result;
}

export function validatePilotPins(pins, evidence) {
  requireValue(pins.sourceSha === evidence?.sourceSha && pins.previewRunId === evidence.hosting?.previewRunId, "PILOT_PIN_IDENTITY_MISMATCH");
  for (const key of ["previewVersions", "previousVersions"]) {
    for (const label of labels) {
      requireValue(pins[key][label] === evidence.hosting[key]?.[label], "PILOT_REVIEW_VERSION_MISMATCH");
    }
  }
}

export function validatePilotCapture(pins, manifest, {runId, runAttempt}) {
  requireValue(manifest?.schemaVersion === 1 && manifest.operation === "promote"
    && manifest.promotionResult === "prepared" && manifest.projectId === project && manifest.region === "asia-northeast1"
    && manifest.sourceSha === pins.sourceSha && manifest.promotionRunId === runId
    && manifest.runAttempt === runAttempt, "PILOT_CAPTURE_IDENTITY_MISMATCH");
  for (const label of labels) {
    requireValue(manifest[label]?.siteId === sites[label]
      && manifest[label].promotedVersion === pins.previewVersions[label]
      && manifest[label].previousVersion === pins.previousVersions[label], "PILOT_CAPTURE_VERSION_MISMATCH");
  }
}

async function main() {
  requireProtectedContext();
  requireValue(process.env.LKC_EVIDENCE_POLICY === "limited-staff-pilot", "PILOT_POLICY_REQUIRED");
  const dir = process.env.LKC_EVIDENCE_DIR;
  requireValue(typeof dir === "string" && path.isAbsolute(dir), "PILOT_EVIDENCE_DIRECTORY_REQUIRED");
  const file = path.join(dir, "pilot-hosting-pins.json");
  if (process.argv.includes("--pins")) {
    const pins = await readPilotHostingPins({sourceSha: process.env.LKC_SOURCE_SHA, previewRunId: process.env.LKC_PREVIEW_RUN_ID},
      await createHostingReader({projectId: project}));
    await writeFile(file, JSON.stringify(pins, null, 2) + "\n", {mode: 0o600});
    await appendFile(process.env.GITHUB_OUTPUT,
      `staff_version=${pins.previewVersions.staff}\nadmin_version=${pins.previewVersions.admin}\n` +
      `previous_staff_version=${pins.previousVersions.staff}\nprevious_admin_version=${pins.previousVersions.admin}\n`);
  } else {
    const pins = JSON.parse(await readFile(file, "utf8"));
    requireValue(pins.sourceSha === process.env.LKC_SOURCE_SHA && pins.previewRunId === process.env.LKC_PREVIEW_RUN_ID, "PILOT_PIN_IDENTITY_MISMATCH");
    if (process.argv.includes("--verify-review-pins")) {
      validatePilotPins(pins, JSON.parse(process.env.LKC_LIMITED_EVIDENCE));
      const fresh = await readPilotHostingPins(pins, await createHostingReader({projectId: project}));
      try { assert.deepEqual(fresh, pins); } catch { throw new Error("PILOT_HOSTING_CHANGED"); }
    } else if (process.argv.includes("--verify-capture")) {
      const manifest = JSON.parse(await readFile(path.join(dir, "pending-restore-manifest.json"), "utf8"));
      validatePilotCapture(pins, manifest, {runId: process.env.GITHUB_RUN_ID, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT)});
    } else throw new Error("PILOT_OPERATION_REQUIRED");
  }
  console.log("HOSTING_LIMITED_PINS=VERIFIED");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error("HOSTING_LIMITED_PINS=STOPPED");
    console.error(/^[A-Z_]{1,80}$/u.test(error.message) ? error.message : "PILOT_INPUT_OR_TRANSPORT_FAILED");
    process.exitCode = 1;
  });
}
