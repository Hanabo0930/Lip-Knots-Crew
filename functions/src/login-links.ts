import { randomBytes, createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { z } from "zod";
import { auth, db } from "./firebase";
import {
  gmailServiceAccountJson,
  mailFrom,
  publicLoginGatewayUrl,
  sendWorkspaceMail,
  staffAppUrl,
} from "./mail-sender";
import {
  companyFromClaims,
  emailHash,
  normalizeEmail,
  requireAdmin,
} from "./utils";
import { assertProductionOperational, getProductionOperationalState } from "./system-safety";
import { incrementProductionMetrics } from "./production-metrics";

const RequestLoginSchema = z.object({
  email: z.string().email().max(254),
});

const CandidateSchema = z.object({
  days: z.number().int().min(1).max(90).default(30),
});

const SendInvitesSchema = z.object({
  staffIds: z.array(z.string().min(1)).min(1).max(100),
  subject: z.string().min(1).max(150),
  introText: z.string().max(3000).default(""),
});

export type LoginInviteBatchInput = {
  companyId: string;
  actorUid: string;
  staffIds: string[];
  subject: string;
  introText: string;
  source?: string;
  shouldContinue?: () => Promise<boolean>;
};

export const requestStaffLoginLink = onCall(
  {
    secrets: [gmailServiceAccountJson],
    timeoutSeconds: 60,
    memory: "512MiB",
  },
  async (request) => {
    const input = RequestLoginSchema.safeParse(request.data ?? {});
    if (!input.success) {
      throw new HttpsError("invalid-argument", "メールアドレスを確認してください。");
    }

    const email = normalizeEmail(input.data.email);
    await enforceLoginRateLimit(email);

    const indexSnap = await db.collection("emailIndex").doc(emailHash(email)).get();
    const index = indexSnap.data() as {
      companyId?: string;
      staffId?: string;
      active?: boolean;
    } | undefined;

    // 登録有無を画面上で推測されないよう、未登録でも同じ応答にします。
    if (indexSnap.exists && index?.active && index.staffId && index.companyId) {
      const profileSnap = await db.collection("staffProfiles").doc(index.staffId).get();
      if (profileSnap.exists && profileSnap.data()?.active === true) {
        try {
          await assertProductionOperational(index.companyId);
          const displayName = String(profileSnap.data()?.displayName ?? "スタッフ");
          await sendLoginLink({
            companyId: index.companyId,
            staffId: index.staffId,
            email,
            displayName,
            subject: "Lip Knots Crew ログインのご案内",
            introText: "",
            source: "self_request",
          });
        } catch (error) {
          console.error("Self login email failed", { emailHash: emailHash(email), error });
        }
      }
    }

    return {
      accepted: true,
      message:
        "登録済みのメールアドレスの場合、ログインメールを送信しました。",
    };
  }
);

export const getLoginInviteCandidates = onCall(async (request) => {
  const session = requireAdmin(request);
  const companyId = companyFromClaims(session.token);
  const input = CandidateSchema.parse(request.data ?? {});
  const today = tokyoDateKey(new Date());
  const through = addDays(today, input.days);

  const jobsSnap = await db.collection("jobs")
    .where("companyId", "==", companyId)
    .where("status", "==", "assigned")
    .where("dateKey", ">=", today)
    .where("dateKey", "<=", through)
    .limit(10000)
    .get();

  const staffIds = [...new Set(
    jobsSnap.docs
      .map((doc) => String(doc.data().assignedStaffId ?? ""))
      .filter(Boolean)
  )];

  const profiles = await getProfiles(staffIds);
  const candidates = profiles
    .filter((profile) => profile.active === true)
    .filter((profile) => !profile.lastLoginAt)
    .filter((profile) => Array.isArray(profile.emails) && profile.emails.length > 0)
    .map((profile) => ({
      staffId: profile.id,
      displayName: String(profile.displayName ?? ""),
      emails: profile.emails as string[],
      areaLabels: Array.isArray(profile.areaLabels) ? profile.areaLabels : [],
      upcomingJobs: jobsSnap.docs.filter(
        (job) => job.data().assignedStaffId === profile.id
      ).length,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "ja"));

  return {
    from: today,
    through,
    count: candidates.length,
    candidates,
  };
});

export const sendLoginInvites = onCall(
  {
    secrets: [gmailServiceAccountJson],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (request) => {
    const session = requireAdmin(request);
    const companyId = companyFromClaims(session.token);
    const input = SendInvitesSchema.parse(request.data ?? {});
    return sendLoginInviteBatch({
      companyId,
      actorUid: session.uid,
      ...input,
      source: "admin_batch",
    });
  }
);

export async function sendLoginInviteBatch(input: LoginInviteBatchInput) {
  await assertProductionOperational(input.companyId);
  const profiles = await getProfiles(input.staffIds);
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const batchRef = db.collection("loginInviteBatches").doc();
  await batchRef.set({
    companyId: input.companyId,
    actorUid: input.actorUid,
    staffIds: input.staffIds,
    subject: input.subject,
    introText: input.introText,
    source: input.source ?? "admin_batch",
    status: "processing",
    startedAt: FieldValue.serverTimestamp(),
  });

  const results = [];
  let aborted = false;
  for (const staffId of input.staffIds) {
    if (!(await getProductionOperationalState(input.companyId)).operational) {
      aborted = true;
      break;
    }
    if (input.shouldContinue && !await input.shouldContinue()) {
      aborted = true;
      break;
    }
    const profile = profilesById.get(staffId);
    if (!profile) {
      results.push({
        staffId,
        displayName: "",
        status: "missing",
        successes: 0,
        failures: 1,
      });
      continue;
    }
    if (profile.active !== true) {
      results.push({
        staffId: profile.id,
        displayName: profile.displayName,
        status: "skipped_inactive",
        successes: 0,
        failures: 1,
      });
      continue;
    }

    const emails = Array.isArray(profile.emails)
      ? [...new Set(profile.emails.map((value: unknown) => normalizeEmail(String(value))))]
        .filter((email) => z.string().email().safeParse(email).success)
      : [];
    let successes = 0;
    let failures = 0;

    for (const email of emails) {
      if (!(await getProductionOperationalState(input.companyId)).operational) {
        aborted = true;
        break;
      }
      try {
        await sendLoginLink({
          companyId: input.companyId,
          staffId: profile.id,
          email,
          displayName: String(profile.displayName ?? "スタッフ"),
          subject: input.subject,
          introText: input.introText,
          source: input.source ?? "admin_batch",
          batchId: batchRef.id,
        });
        successes++;
      } catch (error) {
        failures++;
        console.error("Login invite failed", {
          staffId: profile.id,
          emailHash: emailHash(email),
          error,
        });
      }
    }
    if (!emails.length) failures++;

    results.push({
      staffId: profile.id,
      displayName: profile.displayName,
      status: successes > 0 ? "success" : "failed",
      successes,
      failures,
    });
    if (aborted) break;
  }

  const successStaff = results.filter((item) => item.successes > 0).length;
  const failedStaff = results.filter((item) => item.successes === 0).length;
  const cancelledStaff = input.staffIds.length - results.length;
  await batchRef.set({
    status: aborted ? "aborted" : failedStaff > 0 ? "completed_with_errors" : "completed",
    completedAt: FieldValue.serverTimestamp(),
    successStaff,
    failedStaff,
    cancelledStaff,
    aborted,
    results,
  }, { merge: true });

  return {
    batchId: batchRef.id,
    successStaff,
    failedStaff,
    cancelledStaff,
    aborted,
    results,
  };
}

export const loginGateway = onRequest(async (request, response) => {
  let metricCompanyId = "";
  try {
    const token = String(request.query.token ?? "");
    if (!/^[A-Za-z0-9_-]{30,120}$/.test(token)) {
      renderError(response, "ログインリンクが正しくありません。");
      return;
    }

    const tokenHash = sha256(token);
    const snap = await db.collection("loginGatewayTokens").doc(tokenHash).get();
    if (!snap.exists) {
      renderError(response, "ログインリンクが見つかりません。");
      return;
    }

    const data = snap.data() as {
      companyId?: string;
      actionLink?: string;
      expiresAt?: Timestamp;
      active?: boolean;
    };
    metricCompanyId=String(data.companyId??"");
    if(metricCompanyId)await incrementProductionMetrics(metricCompanyId,{authenticationAttempts:1},"login_gateway");

    if (
      data.active !== true ||
      !data.actionLink ||
      !data.expiresAt ||
      data.expiresAt.toMillis() <= Date.now()
    ) {
      if(metricCompanyId)await incrementProductionMetrics(metricCompanyId,{authenticationFailures:1},"login_gateway_expired");
      renderError(response, "このログインリンクは期限切れです。もう一度送信してください。");
      return;
    }

    await snap.ref.set({
      openedAt: FieldValue.serverTimestamp(),
      openCount: FieldValue.increment(1),
    }, { merge: true });

    response.redirect(302, data.actionLink);
  } catch (error) {
    if(metricCompanyId)await incrementProductionMetrics(metricCompanyId,{authenticationFailures:1},"login_gateway_error");
    console.error("loginGateway failed", error);
    renderError(response, "ログイン処理でエラーが発生しました。");
  }
});

export const cleanupExpiredLoginTokens = onSchedule(
  {
    schedule: "every day 03:30",
    timeZone: "Asia/Tokyo",
    timeoutSeconds: 300,
  },
  async () => {
    const expired = await db.collection("loginGatewayTokens")
      .where("expiresAt", "<", Timestamp.now())
      .limit(500)
      .get();

    const batch = db.batch();
    expired.docs.forEach((doc) => batch.delete(doc.ref));
    if (!expired.empty) await batch.commit();
  }
);

async function sendLoginLink(input: {
  companyId: string;
  staffId: string;
  email: string;
  displayName: string;
  subject: string;
  introText: string;
  source: string;
  batchId?: string;
}): Promise<void> {
  const continueUrl = staffAppUrl.value();
  const actionLink = await auth.generateSignInWithEmailLink(input.email, {
    url: continueUrl,
    handleCodeInApp: true,
  });

  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = sha256(rawToken);
  const expiresAt = Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
  const gatewayBase = publicLoginGatewayUrl.value();

  if (!gatewayBase) {
    throw new Error("PUBLIC_LOGIN_GATEWAY_URLが設定されていません。");
  }

  await db.collection("loginGatewayTokens").doc(tokenHash).set({
    companyId: input.companyId,
    staffId: input.staffId,
    emailHash: emailHash(input.email),
    actionLink,
    active: true,
    expiresAt,
    source: input.source,
    batchId: input.batchId ?? null,
    createdAt: FieldValue.serverTimestamp(),
    openCount: 0,
  });

  const gatewayUrl = `${gatewayBase}?token=${encodeURIComponent(rawToken)}`;
  const intro = input.introText.trim()
    ? `<p style="white-space:pre-wrap">${escapeHtml(input.introText)}</p>`
    : "";
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Yu Gothic',sans-serif;max-width:560px;margin:auto;color:#3f332c">
      <div style="text-align:center;padding:20px 0">
        <div style="font-size:24px;font-weight:800;color:#d8b657">Lip Knots Crew</div>
      </div>
      <div style="border:1px solid #eadfe2;border-radius:20px;padding:24px;background:#fff9fb">
        <p>${escapeHtml(input.displayName)}さん</p>
        ${intro}
        <p>下のボタンを押すだけでログインできます。パスワード入力はありません。</p>
        <p style="text-align:center;margin:28px 0">
          <a href="${escapeHtml(gatewayUrl)}" style="display:inline-block;background:#c97f98;color:white;text-decoration:none;font-weight:800;padding:14px 24px;border-radius:14px">Lip Knots Crewにログイン</a>
        </p>
        <p style="font-size:12px;color:#806f68">このリンクの有効期限は1時間です。心当たりがない場合は開かないでください。</p>
      </div>
    </div>
  `;
  const text = [
    `${input.displayName}さん`,
    "",
    input.introText,
    "",
    "下のURLを開くとLip Knots Crewへログインできます。",
    gatewayUrl,
    "",
    "有効期限は1時間です。",
  ].filter((line) => line !== "").join("\n");

  const deliveryRef = db.collection("loginInviteDeliveries").doc();
  await deliveryRef.set({
    companyId: input.companyId,
    staffId: input.staffId,
    emailHash: emailHash(input.email),
    email: input.email,
    subject: input.subject,
    source: input.source,
    batchId: input.batchId ?? null,
    status: "sending",
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });

  try {
    const sent = await sendWorkspaceMail({
      to: input.email,
      subject: input.subject,
      html,
      text,
    });
    await deliveryRef.set({
      status: "sent",
      gmailMessageId: sent.messageId,
      sentAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    await deliveryRef.set({
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      failedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    throw error;
  }
}

async function enforceLoginRateLimit(email: string): Promise<void> {
  const key = emailHash(email);
  const ref = db.collection("loginLinkRateLimits").doc(key);
  const now = Timestamp.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as {
      minuteWindowAt?: Timestamp;
      minuteCount?: number;
      hourWindowAt?: Timestamp;
      hourCount?: number;
    } | undefined;

    const minuteExpired =
      !data?.minuteWindowAt ||
      now.toMillis() - data.minuteWindowAt.toMillis() >= 60_000;
    const hourExpired =
      !data?.hourWindowAt ||
      now.toMillis() - data.hourWindowAt.toMillis() >= 3_600_000;

    const minuteCount = minuteExpired ? 0 : (data?.minuteCount ?? 0);
    const hourCount = hourExpired ? 0 : (data?.hourCount ?? 0);

    if (minuteCount >= 1 || hourCount >= 5) {
      throw new HttpsError(
        "resource-exhausted",
        "少し時間を置いてから、もう一度お試しください。"
      );
    }

    tx.set(ref, {
      minuteWindowAt: minuteExpired ? now : data?.minuteWindowAt,
      minuteCount: minuteCount + 1,
      hourWindowAt: hourExpired ? now : data?.hourWindowAt,
      hourCount: hourCount + 1,
      updatedAt: now,
    }, { merge: true });
  });
}

async function getProfiles(
  staffIds: string[]
): Promise<Array<FirebaseFirestore.DocumentData & { id: string }>> {
  const unique = [...new Set(staffIds)];
  const result = [];

  for (let index = 0; index < unique.length; index += 250) {
    const refs = unique.slice(index, index + 250)
      .map((id) => db.collection("staffProfiles").doc(id));
    if (!refs.length) continue;
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) result.push({ id: snap.id, ...(snap.data() ?? {}) });
    }
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tokyoDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return tokyoDateKey(date);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function renderError(
  response: import("express").Response,
  message: string
): void {
  response.status(400).send(`
    <!doctype html><html lang="ja"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Lip Knots Crew</title>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Yu Gothic',sans-serif;background:#fff9fb;color:#3f332c;padding:30px">
      <main style="max-width:520px;margin:auto;background:white;border:1px solid #eadfe2;border-radius:22px;padding:28px;text-align:center">
        <h1 style="color:#d8b657">Lip Knots Crew</h1>
        <p>${escapeHtml(message)}</p>
        <a href="${escapeHtml(staffAppUrl.value())}" style="display:inline-block;margin-top:16px;background:#c97f98;color:white;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:800">ログイン画面へ戻る</a>
      </main>
    </body></html>
  `);
}
