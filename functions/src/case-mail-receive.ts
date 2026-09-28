import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { z } from "zod";
import { db } from "./firebase";
import { requireAdmin, companyFromClaims } from "./utils";
import { createGmailCaseMailReceiver } from "./case-mail-gmail";
import { createCaseMailCloudAuth } from "./case-mail-cloud-auth";

const extractorSecret = defineSecret("CASE_MAIL_EXTRACTOR_SECRET");
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const requestSchema = z.object({ messageId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  expectedCompanyId: id, expectedActorUid: id }).strict();
const configSchema = z.object({ companyId: id, uid: id, producerId: id,
  principalRevision: id, mailbox: z.literal("info@lipknots.com"), startedAt: z.iso.datetime({ offset: true }),
  gmailServiceAccountEmail: z.string().max(160),
}).strict();

/** 管理者の明示受信。宛先・認証・解析結果はクライアント入力に含めない。 */
export const receiveCaseMailMessage = onCall({ secrets: [extractorSecret], timeoutSeconds: 540, memory: "512MiB" }, async request => {
  const session = requireAdmin(request), companyId = id.parse(companyFromClaims(session.token));
  const input = requestSchema.safeParse(request.data);
  if (!input.success) throw new HttpsError("invalid-argument", "受信対象のメールIDを確認してください。");
  if (input.data.expectedCompanyId !== companyId || input.data.expectedActorUid !== session.uid) {
    throw new HttpsError("failed-precondition", "ログイン情報が変更されています。画面を開き直してください。");
  }
  if (process.env.APP_ENVIRONMENT !== "staging" || process.env.EXPECTED_FIREBASE_PROJECT_ID !== "lip-knots-crew-staging") {
    throw new HttpsError("failed-precondition", "案件メールの受信は許可済みSTAGING設定が必要です。");
  }
  const parsed = configSchema.safeParse((await db.collection("caseMailReceiverConfigs").doc(companyId).get()).data());
  if (!parsed.success || parsed.data.companyId !== companyId) {
    throw new HttpsError("failed-precondition", "案件メールの受信設定が未有効、または所属が一致しません。");
  }
  const { gmailServiceAccountEmail, ...config } = parsed.data;
  try {
    const dependencies = createCaseMailCloudAuth(gmailServiceAccountEmail, () => extractorSecret.value());
    const result = await createGmailCaseMailReceiver(config, dependencies)({ messageId: input.data.messageId });
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    // 外部応答・認証情報・原文をエラー本文やログへ流さない。
    throw new HttpsError("failed-precondition", "案件メールを受信できませんでした。受信設定と原文を確認し、同じメールで再試行してください。");
  }
});
