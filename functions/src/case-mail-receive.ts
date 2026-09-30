import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { warn } from "firebase-functions/logger";
import { caseMailFailureReason, caseMailFailurePhase } from "./case-mail-diagnostics";
import { db } from "./firebase";
import { requireAdmin, companyFromClaims } from "./utils";
import { createGmailCaseMailReceiver } from "./case-mail-gmail";
import { assertCaseMailReceiverEnabled } from "./case-mail-intake";
import { createCaseMailCloudAuth } from "./case-mail-cloud-auth";

// 関数単位の秘密バインドに限定し、無関係な関数の配備時に解決させない。
const extractorSecretName = "lkcm-extractor-bearer";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const requestSchema = z.object({ messageId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  expectedCompanyId: id, expectedActorUid: id }).strict();
const configSchema = z.object({ companyId: id, uid: id, producerId: id,
  principalRevision: id, mailbox: z.literal("info@lipknots.com"), startedAt: z.iso.datetime({ offset: true }),
  gmailServiceAccountEmail: z.string().max(160),
}).strict();

const pageSchema = z.object({ expectedCompanyId: id, expectedActorUid: id,
  cursor: z.string().min(1).max(2048).regex(/^[^\s\x00-\x1f]+$/).optional() }).strict();
const options = { secrets: [extractorSecretName], timeoutSeconds: 540, memory: "512MiB" as const };
async function receiverFor(request: Parameters<typeof requireAdmin>[0], input: {expectedCompanyId:string;expectedActorUid:string}) {
  const session = requireAdmin(request), companyId = id.parse(companyFromClaims(session.token));
  if (input.expectedCompanyId !== companyId || input.expectedActorUid !== session.uid) {
    throw new HttpsError("failed-precondition", "ログイン情報が変更されています。画面を開き直してください。");
  }
  if (process.env.APP_ENVIRONMENT !== "staging" || process.env.EXPECTED_FIREBASE_PROJECT_ID !== "lip-knots-crew-staging") {
    throw new HttpsError("failed-precondition", "案件メールの受信は許可済みSTAGING設定が必要です。");
  }
  const parsed = configSchema.safeParse((await db.collection("caseMailReceiverConfigs").doc(companyId).get()).data());
  if (!parsed.success || parsed.data.companyId !== companyId) {
    throw new HttpsError("failed-precondition", "案件メールの受信設定が未有効、または所属が一致しません。");
  }
  const { gmailServiceAccountEmail, ...storedConfig } = parsed.data;
  // ミリ秒より細かい開始日時は切り上げ、開始前のメールを取得対象へ広げない。
  const subMillisecond = (storedConfig.startedAt.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "").slice(3);
  const startedAt = new Date(Date.parse(storedConfig.startedAt) + (/[1-9]/.test(subMillisecond) ? 1 : 0)).toISOString();
  const config = { ...storedConfig, startedAt };
  await assertCaseMailReceiverEnabled(config);
  const dependencies = createCaseMailCloudAuth(gmailServiceAccountEmail, () => process.env[extractorSecretName] ?? "");
  return { config, dependencies, receive: createGmailCaseMailReceiver(config, dependencies) };
}
type ReceiveStage = "configuration" | "gmail_auth" | "mailbox" | "list" | "save" | "completion";
function receiveError(error: unknown, stage: ReceiveStage): never {
  const phase = caseMailFailurePhase(error);
  const diagnostic = { stage, reason: caseMailFailureReason(error), ...(phase ? { phase } : {}) };
  // UID・メールID・外部例外・スタックを出さず、失敗工程だけを記録する。
  warn("case_mail_receive_failed", diagnostic);
  if (error instanceof HttpsError) throw new HttpsError(error.code, error.message, diagnostic);
  // 外部応答・認証情報・原文をエラー本文やログへ流さない。
  throw new HttpsError("failed-precondition", "案件メールを受信できませんでした。設定を確認して再試行してください。途中まで保存された候補は一覧で確認できます。", diagnostic);
}
/** 管理者の明示受信。宛先・認証・解析結果はクライアント入力に含めない。 */
export const receiveCaseMailMessage = onCall(options, async request => {
  requireAdmin(request);
  const input = requestSchema.safeParse(request.data);
  if (!input.success) throw new HttpsError("invalid-argument", "受信対象のメールIDを確認してください。");
  let stage: ReceiveStage = "configuration";
  try {
    const receiver = await receiverFor(request, input.data);
    stage = "save";
    return { ok: true, ...await receiver.receive({messageId:input.data.messageId}) };
  } catch (error) { return receiveError(error, stage); }
});
/** 一覧の続きは成功時だけ返す。途中失敗時は同じ範囲を冪等に再受信する。 */
export const receiveCaseMailMessages = onCall(options, async request => {
  requireAdmin(request);
  const input = pageSchema.safeParse(request.data);
  if (!input.success) throw new HttpsError("invalid-argument", "受信範囲を確認してください。");
  let stage: ReceiveStage = "configuration";
  try {
    const receiver = await receiverFor(request, input.data);
    stage = "gmail_auth";
    const token = await receiver.dependencies.obtainGmailAccessToken({...receiver.config,scope:"https://www.googleapis.com/auth/gmail.readonly"});
    const { GmailReadClient } = require("../case-mail-runtime/read-mail.cjs");
    const client = new GmailReadClient({obtainAccessToken:async()=>token,...(receiver.dependencies.fetchImpl?{fetchImpl:receiver.dependencies.fetchImpl}:{})});
    stage = "mailbox";
    const profile = await client.get("profile");
    if (typeof profile.emailAddress !== "string" || profile.emailAddress.toLowerCase() !== receiver.config.mailbox) throw Error("受信箱不一致");
    stage = "list";
    const raw = await client.list({startedAt:receiver.config.startedAt,pageToken:input.data.cursor,maxResults:5});
    const page = z.object({messages:z.array(z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)})).max(5),
      nextPageToken:pageSchema.shape.cursor.unwrap().nullable()}).parse(raw);
    if (new Set(page.messages.map(item=>item.id)).size !== page.messages.length) throw Error("受信一覧重複");
    let received = 0, skipped = 0;
    stage = "save";
    for (const item of page.messages) {
      const result = await receiver.receive({messageId:item.id});
      if (result.persisted) received++; else skipped++;
    }
    stage = "completion";
    await assertCaseMailReceiverEnabled(receiver.config);
    return {ok:true,received,skipped,nextCursor:page.nextPageToken};
  } catch (error) { return receiveError(error, stage); }
});
