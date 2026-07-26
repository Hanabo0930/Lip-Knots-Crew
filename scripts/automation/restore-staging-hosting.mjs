import { spawnSync } from "node:child_process";
import {
  appendFile,
  mkdir,
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

function runFirebaseClone({ source, target, projectId, cwd }) {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(
    executable,
    [
      "firebase",
      "hosting:clone",
      source,
      target,
      "--project",
      projectId,
      "--json",
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return {
    code: Number.isInteger(result.status) ? result.status : 1,
    stdout: String(result.stdout ?? ""),
  };
}

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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("HOSTING_ROLLBACK_RESULT=FAILURE");
    console.error(`HOSTING_ROLLBACK_ERROR=${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
