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

type ServiceAccountJson = {
  client_email: string;
  private_key: string;
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

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Gmail送信用サービスアカウント情報が不足しています。");
  }

  const from = mailFrom.value();
  const jwt = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    subject: from,
  });

  const gmail = google.gmail({ version: "v1", auth: jwt });
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
