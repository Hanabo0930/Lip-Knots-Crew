import { google } from "googleapis";
import { CaseMailAuthFailure } from "./case-mail-diagnostics";
import type { CaseMailGmailDependencies } from "./case-mail-gmail";

const tokenUrl = "https://oauth2.googleapis.com/token";
const extractorOrigin = "https://lkcm-attachment-extractor-740154137290.asia-northeast1.run.app";

/** 既存の実行IDから短期認証だけを取得する。鍵・権限・委任設定は作成しない。 */
export function createCaseMailCloudAuth(serviceAccountEmail: string, extractorSecret: () => string): CaseMailGmailDependencies {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]@lip-knots-crew-staging\.iam\.gserviceaccount\.com$/.test(serviceAccountEmail)) {
    throw new Error("案件受信用のSTAGING認証設定を確認してください。");
  }
  return {
    async obtainGmailAccessToken(context) {
      if (context.mailbox !== "info@lipknots.com" || context.scope !== "https://www.googleapis.com/auth/gmail.readonly") {
        throw new Error("案件受信の読取範囲が一致しません。");
      }
      let phase: "signing" | "exchange" = "signing";
      try {
        const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
        const iam = google.iamcredentials({ version: "v1", auth });
        const now = Math.floor(Date.now() / 1000);
        const signed = await iam.projects.serviceAccounts.signJwt({
          name: `projects/-/serviceAccounts/${serviceAccountEmail}`,
          requestBody: { payload: JSON.stringify({ iss: serviceAccountEmail, sub: context.mailbox,
            scope: context.scope, aud: tokenUrl, iat: now, exp: now + 300 }) },
        }, { timeout: 30000 });
        if (!signed.data.signedJwt) throw Error("署名なし");
        phase = "exchange";
        const response = await fetch(tokenUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signed.data.signedJwt }) });
        if (!response.ok) {
          // error_description等は保持せず、固定のOAuth区分だけを見る。
          const body: unknown = await response.json().catch(() => null);
          const code = body && typeof body === "object" && "error" in body ? body.error : null;
          throw new CaseMailAuthFailure(code === "unauthorized_client" || code === "access_denied"
            ? "gmail_delegation_denied" : "gmail_token_exchange_failed");
        }
        const token = await response.json() as { access_token?: unknown; token_type?: unknown };
        if (typeof token.access_token !== "string" || !token.access_token || /\s/.test(token.access_token) || token.token_type !== "Bearer") throw new CaseMailAuthFailure("gmail_token_invalid");
        return token.access_token;
      } catch (error) {
        if (error instanceof CaseMailAuthFailure) throw error;
        throw new CaseMailAuthFailure(phase === "signing" ? "gmail_signing_failed" : "gmail_token_exchange_failed");
      }
    },
    async obtainExtractorCredentials(context) {
      if (context.mailbox !== "info@lipknots.com" || context.audience !== extractorOrigin) throw Error("添付抽出先が一致しません。");
      try {
        const secret = extractorSecret();
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw Error("認証設定なし");
        const auth = new google.auth.GoogleAuth();
        const client = await auth.getIdTokenClient(extractorOrigin);
        const idToken = await client.idTokenProvider.fetchIdToken(extractorOrigin);
        return { idToken, secret };
      } catch { throw new CaseMailAuthFailure("extractor_auth_failed"); }
    },
  };
}
