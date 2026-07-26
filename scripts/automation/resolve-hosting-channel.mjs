import { appendFile, readFile } from "node:fs/promises";
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

async function main() {
  const channelId = valueAfter("--channel");
  const staffSite = valueAfter("--staff-site");
  const adminSite = valueAfter("--admin-site");
  const staffChannelsPath = valueAfter("--staff-channels-json");
  const adminChannelsPath = valueAfter("--admin-channels-json");
  const outputPath = valueAfter("--github-output");
  if (!channelId || !staffSite || !adminSite || !staffChannelsPath || !adminChannelsPath) {
    throw new Error("CHANNEL_RESOLUTION_ARGUMENTS_REQUIRED");
  }

  const [staffDocument, adminDocument] = await Promise.all([
    readFile(staffChannelsPath, "utf8").then(JSON.parse),
    readFile(adminChannelsPath, "utf8").then(JSON.parse),
  ]);
  const staffUrl = resolveChannelUrl(staffDocument, { channelId, siteId: staffSite });
  const adminUrl = resolveChannelUrl(adminDocument, { channelId, siteId: adminSite });
  if (staffUrl === adminUrl) throw new Error("CHANNEL_URLS_NOT_SEPARATED");

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
