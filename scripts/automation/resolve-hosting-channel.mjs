import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function valueAfter(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

function channelIdFrom(value) {
  const raw = String(value ?? "");
  const match = raw.match(/(?:^|\/)channels\/([^/]+)$/u);
  return match?.[1] ?? raw;
}

export function extractChannels(document) {
  const channels = [];
  const seen = new Set();

  function visit(value) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const channelId = channelIdFrom(
      value.channelId || value.channel || value.name || "",
    );
    const url = value.url || value.webUrl || value.defaultUrl || "";
    if (
      /^[a-z0-9][a-z0-9-]{1,39}$/u.test(channelId)
      && typeof url === "string"
      && url.startsWith("https://")
    ) {
      channels.push({ channelId, url });
    }
    Object.values(value).forEach(visit);
  }

  visit(document);
  return channels;
}

export function resolveChannelUrl(document, { channelId, siteId }) {
  const matches = extractChannels(document)
    .filter((channel) => channel.channelId === channelId);
  if (matches.length !== 1) {
    throw new Error(`CHANNEL_NOT_UNIQUELY_RESOLVED:${siteId}:${matches.length}`);
  }
  const url = new URL(matches[0].url);
  if (url.protocol !== "https:") throw new Error(`CHANNEL_URL_NOT_HTTPS:${siteId}`);
  if (!url.hostname.endsWith(".web.app") && !url.hostname.endsWith(".firebaseapp.com")) {
    throw new Error(`CHANNEL_URL_HOST_REJECTED:${siteId}`);
  }
  if (!url.hostname.startsWith(`${siteId}--`) && url.hostname !== `${siteId}.web.app`) {
    throw new Error(`CHANNEL_URL_SITE_MISMATCH:${siteId}`);
  }
  return url.origin;
}

// Only channel:list's documented result is evidence. Do not recursively copy
// release users, Hosting config, or other fields from the CLI response.
export function resolveChannelMetadata(document, { channelId, siteId, now = Date.now() }) {
  if (typeof siteId !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(siteId)
    || typeof channelId !== "string" || !/^[a-z0-9][a-z0-9-]{1,39}$/u.test(channelId) || channelId === "live"
    || !Number.isFinite(now)) {
    throw new Error("CHANNEL_METADATA_SCOPE_REJECTED");
  }
  if (document?.status !== "success" || !Array.isArray(document.result?.channels)) {
    throw new Error("CHANNEL_METADATA_RESPONSE_REJECTED");
  }
  const channelName = `sites/${siteId}/channels/${channelId}`;
  const projectPrefix = "projects/lip-knots-crew-staging/";
  const matches = document.result.channels.filter((channel) =>
    channelIdFrom(channel?.name) === channelId);
  if (matches.length !== 1) throw new Error("CHANNEL_METADATA_NOT_UNIQUELY_RESOLVED");
  const channel = matches[0];
  if (channel.name !== channelName && channel.name !== projectPrefix + channelName) {
    throw new Error("CHANNEL_METADATA_RESOURCE_REJECTED");
  }
  // Bind the preview URL to this channel as well as this site. A live URL or
  // another preview's URL must not attest to the selected channel's version.
  if (typeof channel.url !== "string") throw new Error("CHANNEL_METADATA_URL_REJECTED");
  let url;
  try { url = new URL(channel.url); } catch { throw new Error("CHANNEL_METADATA_URL_REJECTED"); }
  const hostPrefix = `${siteId}--${channelId}-`;
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || url.pathname !== "/" || url.search || url.hash
    || !url.hostname.startsWith(hostPrefix)
    || !/^[a-z0-9]+\.web\.app$/u.test(url.hostname.slice(hostPrefix.length))) {
    throw new Error("CHANNEL_METADATA_URL_REJECTED");
  }

  const expireTime = channel.expireTime ?? null;
  let expiryStatus = "UNCONFIRMED";
  if (expireTime !== null) {
    const timestamp = typeof expireTime === "string" ? Date.parse(expireTime) : NaN;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(expireTime)
      || !Number.isFinite(timestamp)
      || new Date(timestamp).toISOString().slice(0, 19) !== expireTime.slice(0, 19)) {
      throw new Error("CHANNEL_METADATA_EXPIRY_REJECTED");
    }
    expiryStatus = timestamp > now ? "ACTIVE" : "EXPIRED";
  }

  const release = channel.release;
  if (release != null && (typeof release !== "object" || Array.isArray(release))) {
    throw new Error("CHANNEL_METADATA_RELEASE_REJECTED");
  }
  if (release?.name != null) {
    const name = typeof release.name === "string" && release.name.startsWith(projectPrefix)
      ? release.name.slice(projectPrefix.length) : release.name;
    const prefixes = [`${channelName}/releases/`, `sites/${siteId}/releases/`];
    if (typeof name !== "string" || !prefixes.some((prefix) =>
      name.startsWith(prefix) && /^[a-zA-Z0-9_-]+$/u.test(name.slice(prefix.length)))) {
      throw new Error("CHANNEL_METADATA_RELEASE_REJECTED");
    }
  }
  const version = release?.version === "" ? null : release?.version;
  if (version != null && (typeof version !== "object" || Array.isArray(version))) {
    throw new Error("CHANNEL_METADATA_VERSION_REJECTED");
  }
  const versionName = version?.name == null || version.name === "" ? null : version.name;
  if (versionName !== null) {
    const prefix = `sites/${siteId}/versions/`;
    const id = typeof versionName !== "string" ? ""
      : versionName.startsWith(prefix) ? versionName.slice(prefix.length)
        : versionName.startsWith(projectPrefix + prefix) ? versionName.slice((projectPrefix + prefix).length) : "";
    // Match the existing fixed-version restore contract; never expand short IDs.
    if (!/^[a-f0-9]{16}$/u.test(id)) throw new Error("CHANNEL_METADATA_VERSION_REJECTED");
  }
  const versionStatus = version?.status === "" ? null : version?.status ?? null;
  if (versionStatus !== null
    && !["VERSION_STATUS_UNSPECIFIED", "CREATED", "FINALIZED", "DELETED", "ABANDONED"].includes(versionStatus)) {
    throw new Error("CHANNEL_METADATA_VERSION_STATUS_REJECTED");
  }
  return {
    siteId, channelId, channelName: channel.name, url: url.origin,
    expireTime, expiryStatus, versionName, versionStatus,
    versionConfirmed: versionName !== null && versionStatus === "FINALIZED",
  };
}

async function readChannelDocument(file) {
  const content = await readFile(file, "utf8");
  try { return JSON.parse(content); } catch {
    // JSON.parse errors can contain excerpts of fields that are not evidence.
    throw new Error("CHANNEL_METADATA_JSON_REJECTED");
  }
}

async function main() {
  const channelId = valueAfter("--channel");
  const staffSite = valueAfter("--staff-site");
  const adminSite = valueAfter("--admin-site");
  const staffChannelsPath = valueAfter("--staff-channels-json");
  const adminChannelsPath = valueAfter("--admin-channels-json");
  const outputPath = valueAfter("--github-output");
  const evidenceDir = valueAfter("--evidence-dir");
  if (!channelId || !staffSite || !adminSite || !staffChannelsPath || !adminChannelsPath) {
    throw new Error("CHANNEL_RESOLUTION_ARGUMENTS_REQUIRED");
  }

  const [staffDocument, adminDocument] = await Promise.all([
    readChannelDocument(staffChannelsPath),
    readChannelDocument(adminChannelsPath),
  ]);
  const metadata = evidenceDir ? {
    schemaVersion: 1,
    staff: resolveChannelMetadata(staffDocument, { channelId, siteId: staffSite }),
    admin: resolveChannelMetadata(adminDocument, { channelId, siteId: adminSite }),
  } : null;
  const staffUrl = metadata?.staff.url ?? resolveChannelUrl(staffDocument, { channelId, siteId: staffSite });
  const adminUrl = metadata?.admin.url ?? resolveChannelUrl(adminDocument, { channelId, siteId: adminSite });
  if (staffUrl === adminUrl) throw new Error("CHANNEL_URLS_NOT_SEPARATED");

  if (metadata) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "channel-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  if (outputPath) {
    await appendFile(
      outputPath,
      `staff_url=${staffUrl}\nadmin_url=${adminUrl}\n`,
      "utf8",
    );
  }
  console.log("STAGING_HOSTING_CHANNEL_RESOLUTION=PASS");
  console.log(`STAGING_HOSTING_CHANNEL=${channelId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("STAGING_HOSTING_CHANNEL_RESOLUTION=FAIL");
    console.error(`STAGING_HOSTING_CHANNEL_ERROR=${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
