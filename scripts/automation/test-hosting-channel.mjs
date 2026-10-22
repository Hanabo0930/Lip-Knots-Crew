import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveChannelMetadata, resolveChannelUrl } from "./resolve-hosting-channel.mjs";

const staffSite = "lip-knots-crew-staging";
const adminSite = "lip-knots-crew-staging-admin";
const channelId = "rc-02516b6e28e4";
const versionId = "0123456789abcdef";
const now = Date.parse("2026-10-22T12:00:00Z");
const options = { siteId: staffSite, channelId, now };
const fakeSecret = "SYNTHETIC_NOT_EVIDENCE";

function fixture(siteId = staffSite) {
  return {
    status: "success",
    token: fakeSecret,
    result: { channels: [{
      name: `sites/${siteId}/channels/${channelId}`,
      url: `https://${siteId}--${channelId}-abc123.web.app`,
      expireTime: "2026-10-23T12:00:00.123456789Z",
      labels: { private: fakeSecret },
      release: {
        name: `sites/${siteId}/channels/${channelId}/releases/release123`,
        releaseUser: { email: "synthetic@example.invalid" },
        version: {
          name: `sites/${siteId}/versions/${versionId}`,
          status: "FINALIZED",
          config: { private: fakeSecret },
        },
      },
    }] },
  };
}

export async function runChannelMetadataTests({ repoRoot }) {
  let cases = 0;
  const channelOf = (doc) => doc.result.channels[0];
  function rejected(mutate, pattern) {
    const doc = fixture();
    mutate(doc, channelOf(doc));
    assert.throws(() => resolveChannelMetadata(doc, options), pattern);
    cases += 1;
  }

  const expected = {
    siteId: staffSite, channelId,
    channelName: `sites/${staffSite}/channels/${channelId}`,
    url: `https://${staffSite}--${channelId}-abc123.web.app`,
    expireTime: "2026-10-23T12:00:00.123456789Z", expiryStatus: "ACTIVE",
    versionName: `sites/${staffSite}/versions/${versionId}`,
    versionStatus: "FINALIZED", versionConfirmed: true,
  };
  assert.deepEqual(resolveChannelMetadata(fixture(), options), expected);
  cases += 1;
  const prefixed = fixture();
  channelOf(prefixed).name = `projects/${staffSite}/${expected.channelName}`;
  channelOf(prefixed).release.version.name = `projects/${staffSite}/${expected.versionName}`;
  assert.equal(resolveChannelMetadata(prefixed, options).versionName,
    `projects/${staffSite}/${expected.versionName}`);
  cases += 1;
  const unrelated = fixture();
  unrelated.result.channels.push({ name: `sites/${staffSite}/channels/rc-other`, token: fakeSecret });
  assert.deepEqual(resolveChannelMetadata(unrelated, options), expected);
  cases += 1;

  for (const name of [undefined, `sites/${staffSite}/releases/release123`,
    `projects/${staffSite}/sites/${staffSite}/channels/${channelId}/releases/release123`]) {
    const doc = fixture();
    channelOf(doc).release.name = name;
    assert.equal(resolveChannelMetadata(doc, options).versionName, expected.versionName);
    cases += 1;
  }
  for (const name of [`sites/${adminSite}/channels/${channelId}/releases/release123`,
    `sites/${staffSite}/channels/rc-other/releases/release123`,
    `projects/other/sites/${staffSite}/releases/release123`, "", 42]) {
    rejected((_doc, channel) => { channel.release.name = name; }, /RELEASE_REJECTED/u);
  }
  rejected((_doc, channel) => { channel.release = ""; }, /RELEASE_REJECTED/u);

  for (const version of [undefined, null, "", {}, { name: "" }, { name: null, status: "FINALIZED" }]) {
    const doc = fixture();
    channelOf(doc).release.version = version;
    const result = resolveChannelMetadata(doc, options);
    assert.equal(result.versionName, null);
    assert.equal(result.versionConfirmed, false);
    cases += 1;
  }
  const noRelease = fixture();
  delete channelOf(noRelease).release;
  assert.equal(resolveChannelMetadata(noRelease, options).versionConfirmed, false);
  cases += 1;
  for (const status of [undefined, "", "CREATED", "DELETED", "ABANDONED", "VERSION_STATUS_UNSPECIFIED"]) {
    const doc = fixture();
    channelOf(doc).release.version.status = status;
    const result = resolveChannelMetadata(doc, options);
    assert.equal(result.versionName, expected.versionName);
    assert.equal(result.versionConfirmed, false);
    cases += 1;
  }
  for (const expireTime of [undefined, null]) {
    const doc = fixture();
    channelOf(doc).expireTime = expireTime;
    assert.equal(resolveChannelMetadata(doc, options).expiryStatus, "UNCONFIRMED");
    cases += 1;
  }
  for (const expireTime of ["2026-10-22T12:00:00Z", "2026-10-22T11:59:59Z"]) {
    const doc = fixture();
    channelOf(doc).expireTime = expireTime;
    assert.equal(resolveChannelMetadata(doc, options).expiryStatus, "EXPIRED");
    cases += 1;
  }
  for (const expireTime of ["", "tomorrow", "2026-02-30T12:00:00Z", "2026-10-23", 42, {}, "2026-10-23T24:00:00Z"]) {
    rejected((_doc, channel) => { channel.expireTime = expireTime; }, /EXPIRY_REJECTED/u);
  }
  for (const versionName of ["7d6406", versionId, `${expected.versionName}/extra`,
    `sites/${adminSite}/versions/${versionId}`, `projects/other/${expected.versionName}`,
    `sites/${staffSite}/versions/ABCDEF0123456789`, 42, {}]) {
    rejected((_doc, channel) => { channel.release.version.name = versionName; }, /VERSION_REJECTED/u);
  }
  for (const version of [versionId, [], 42]) {
    rejected((_doc, channel) => { channel.release.version = version; }, /VERSION_REJECTED/u);
  }
  rejected((_doc, channel) => { channel.release.version.status = fakeSecret; }, /VERSION_STATUS_REJECTED/u);
  rejected((_doc, channel) => { channel.name = `sites/${adminSite}/channels/${channelId}`; }, /RESOURCE_REJECTED/u);
  rejected((_doc, channel) => { channel.name = `projects/other/${channel.name}`; }, /RESOURCE_REJECTED/u);
  rejected((_doc, channel) => { channel.name = `sites/${staffSite}/channels/rc-other`; }, /NOT_UNIQUELY_RESOLVED/u);
  rejected((doc, channel) => { doc.result.channels.push(structuredClone(channel)); }, /NOT_UNIQUELY_RESOLVED/u);
  rejected((doc, channel) => { doc.result.channels = []; doc.unrelated = channel; }, /NOT_UNIQUELY_RESOLVED/u);
  rejected((doc) => { doc.status = "error"; }, /RESPONSE_REJECTED/u);
  rejected((doc) => { doc.result.channels = {}; }, /RESPONSE_REJECTED/u);
  for (const url of [
    `https://${adminSite}--${channelId}-abc123.web.app`,
    `https://${staffSite}--rc-other-abc123.web.app`,
    `https://${staffSite}.web.app`, `http://${staffSite}--${channelId}-abc123.web.app`,
    `${expected.url}.example.invalid`, `${expected.url}?token=${fakeSecret}`,
    `${expected.url}#${fakeSecret}`, `${expected.url}/path`, `${expected.url}:8443`,
    expected.url.replace("https://", `https://${fakeSecret}@`), "not a URL",
  ]) {
    rejected((_doc, channel) => { channel.url = url; }, /URL_REJECTED/u);
  }
  assert.throws(() => resolveChannelMetadata(fixture(), { ...options, channelId: "live" }), /SCOPE_REJECTED/u);
  cases += 1;

  // Exercise the actual CLI using saved synthetic channel:list responses.
  const temporary = await mkdtemp(path.join(tmpdir(), "lkc-channel-metadata-"));
  try {
    const staffFile = path.join(temporary, "staff.json");
    const adminFile = path.join(temporary, "admin.json");
    const outputFile = path.join(temporary, "github-output");
    const evidenceDir = path.join(temporary, "evidence");
    const admin = fixture(adminSite);
    delete channelOf(admin).release.version;
    const staff = fixture();
    // Unknown nested fields are not channel candidates or artifact fields.
    staff.ignored = structuredClone(channelOf(staff));
    await writeFile(staffFile, JSON.stringify(staff));
    await writeFile(adminFile, JSON.stringify(admin));
    const args = [path.join(repoRoot, "scripts/automation/resolve-hosting-channel.mjs"),
      "--channel", channelId, "--staff-site", staffSite, "--admin-site", adminSite,
      "--staff-channels-json", staffFile, "--admin-channels-json", adminFile];
    const run = (...extra) => spawnSync(process.execPath, [...args, ...extra], { encoding: "utf8" });
    const result = run("--github-output", outputFile, "--evidence-dir", evidenceDir);
    assert.equal(result.status, 0, result.stderr);
    const saved = await readFile(path.join(evidenceDir, "channel-metadata.json"), "utf8");
    const metadata = JSON.parse(saved);
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.staff.versionName, expected.versionName);
    assert.equal(metadata.staff.versionConfirmed, true);
    assert.equal(metadata.admin.siteId, adminSite);
    assert.equal(metadata.admin.versionName, null);
    assert.equal(metadata.admin.versionConfirmed, false);
    assert.doesNotMatch(saved, /SYNTHETIC_NOT_EVIDENCE|synthetic@example|releaseUser|config|token|labels/u);
    assert.deepEqual(await readdir(evidenceDir), ["channel-metadata.json"]);
    assert.equal(await readFile(outputFile, "utf8"),
      `staff_url=${expected.url}\nadmin_url=https://${adminSite}--${channelId}-abc123.web.app\n`);
    cases += 1;

    // Existing callers without evidence retain URL-only behavior.
    await writeFile(staffFile, JSON.stringify(fixture()));
    channelOf(admin).release.version = { name: "" };
    await writeFile(adminFile, JSON.stringify(admin));
    assert.equal(run().status, 0);
    assert.equal(resolveChannelUrl(fixture(), options), expected.url);
    cases += 1;

    channelOf(admin).release.version = { name: expected.versionName, status: "FINALIZED" };
    await writeFile(adminFile, JSON.stringify(admin));
    const rejectedDir = path.join(temporary, "rejected");
    const rejectedOutput = path.join(temporary, "rejected-output");
    const rejectedResult = run("--evidence-dir", rejectedDir, "--github-output", rejectedOutput);
    assert.equal(rejectedResult.status, 1);
    assert.match(rejectedResult.stderr, /VERSION_REJECTED/u);
    await assert.rejects(readFile(path.join(rejectedDir, "channel-metadata.json")), { code: "ENOENT" });
    await assert.rejects(readFile(rejectedOutput), { code: "ENOENT" });
    cases += 1;

    await writeFile(adminFile, `{"token":"${fakeSecret}",BROKEN`);
    const invalidJson = run("--evidence-dir", rejectedDir);
    assert.equal(invalidJson.status, 1);
    assert.match(invalidJson.stderr, /JSON_REJECTED/u);
    assert.doesNotMatch(invalidJson.stdout + invalidJson.stderr, /SYNTHETIC_NOT_EVIDENCE/u);
    cases += 1;
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
    assert.ok(path.basename(temporary).startsWith("lkc-channel-metadata-"));
    await rm(temporary, { recursive: true, force: true });
  }
  const preview = await readFile(path.join(repoRoot, ".github/workflows/staging-hosting-preview.yml"), "utf8");
  const resolverStep = preview.split("      - name: Resolve the two preview URLs")[1]?.split("      - name:")[0];
  const uploadStep = preview.split("      - name: Upload screenshots and machine-readable evidence")[1]?.split("      - name:")[0];
  assert.match(resolverStep, /--evidence-dir "\$LKC_EVIDENCE_DIR"/u);
  assert.match(uploadStep, /if: always\(\)/u);
  assert.match(uploadStep, /path: \$\{\{ env\.LKC_EVIDENCE_DIR \}\}/u);
  cases += 1;
  return cases;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const cases = await runChannelMetadataTests({ repoRoot });
  console.log(`HOSTING_CHANNEL_METADATA=PASS cases=${cases}`);
}
