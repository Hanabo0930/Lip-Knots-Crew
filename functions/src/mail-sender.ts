import { google } from "googleapis";
import { defineSecret, defineString } from "firebase-functions/params";

export const gmailServiceAccountJson = defineSecret(
  "GMAIL_SERVICE_ACCOUNT_JSON"
);
export const mailFrom = defineString("MAIL_FROM", {
  default: "staff@lipknots.com",
});
export const staffAppUrl = defineString("STAFF_APP_URL", {
  default: "https://staff.lipknots.com/",
});
export const publicLoginGatewayUrl = defineString("PUBLIC_LOGIN_GATEWAY_URL", {
  default: "",
});

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

type ServiceAccountJson = {
  client_email: string;
  private_key?: string;
};

export async function sendWorkspaceMail(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ messageId: string }> {
  const rawCredentials = gmailServiceAccountJson.value();
  if (!rawCredentials) {
    throw new Error("GMAIL_SERVICE_ACCOUNT_JSONが設定されていません。");
  }

  let credentials: ServiceAccountJson;
  try {
    credentials = JSON.parse(rawCredentials) as ServiceAccountJson;
  } catch {
    throw new Error("GMAIL_SERVICE_ACCOUNT_JSONのJSON形式が不正です。");
  }

  if (!credentials.client_email) {
    throw new Error("Gmail送信用サービスアカウント情報が不足しています。");
  }

  const from = mailFrom.value();
  const auth = credentials.private_key
    ? new google.auth.JWT({
        email: credentials.client_email,
        key: credentials.private_key.replace(/\\n/g, "\n"),
        scopes: [GMAIL_SEND_SCOPE],
        subject: from,
      })
    : await createKeylessDelegatedAuth({
        serviceAccountEmail: credentials.client_email,
        subject: from,
      });

  const gmail = google.gmail({ version: "v1", auth });
  const raw = buildMimeMessage({
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  return { messageId: response.data.id ?? "" };
}

async function createKeylessDelegatedAuth(input: {
  serviceAccountEmail: string;
  subject: string;
}): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const signerAuth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const iamCredentials = google.iamcredentials({
    version: "v1",
    auth: signerAuth,
  });
  const now = Math.floor(Date.now() / 1000);
  const signed = await iamCredentials.projects.serviceAccounts.signJwt({
    name: `projects/-/serviceAccounts/${input.serviceAccountEmail}`,
    requestBody: {
      payload: JSON.stringify({
        iss: input.serviceAccountEmail,
        sub: input.subject,
        scope: GMAIL_SEND_SCOPE,
        aud: GOOGLE_TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    },
  });
  const assertion = signed.data.signedJwt;
  if (!assertion) {
    throw new Error("Gmail送信用JWTの署名に失敗しました。");
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const token = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!tokenResponse.ok || !token.access_token) {
    throw new Error(
      `Gmail送信用アクセストークンの取得に失敗しました。${
        token.error ? ` (${token.error})` : ""
      }`
    );
  }

  const delegatedAuth = new google.auth.OAuth2();
  delegatedAuth.setCredentials({ access_token: token.access_token });
  return delegatedAuth;
}

function buildMimeMessage(input: {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}): string {
  const boundary = `lkc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const lines = [
    `From: Lip Knots Crew <${input.from}>`,
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(input.text, "utf8").toString("base64")),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(input.html, "utf8").toString("base64")),
    `--${boundary}--`,
    "",
  ];

  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

function encodeHeader(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? value;
}
