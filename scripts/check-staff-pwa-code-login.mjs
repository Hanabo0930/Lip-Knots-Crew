import { readFile } from "node:fs/promises";

const appSource = await readFile("apps/staff/src/App.tsx", "utf8");
const loginSource = await readFile("functions/src/login-links.ts", "utf8");
const indexSource = await readFile("functions/src/index.ts", "utf8");
const failures = [];

assert(
  /emailActionLink[\s\S]*?signInWithEmailLink\(activeAuth,email,emailActionLink\)/u.test(appSource),
  "The installed Staff app must redeem the code and complete the email-link sign-in inside the PWA"
);
assert(
  /inputMode="numeric"[\s\S]*?autoComplete="one-time-code"[\s\S]*?maxLength=\{6\}/u.test(appSource),
  "The Staff login form must provide a six-digit one-time-code input"
);
assert(
  /code: z\.string\(\)\.regex\(\/\^\\d\{6\}\$\/\)\.optional\(\)/u.test(loginSource),
  "The existing request schema must accept only an optional six-digit code"
);
assert(
  /if \(input\.data\.code\)[\s\S]*?return redeemStaffLoginCode\(email, input\.data\.code\)/u.test(loginSource),
  "Code redemption must short-circuit before sending another login email"
);
assert(
  /LOGIN_CODE_TTL_MS = 15 \* 60 \* 1000/u.test(loginSource)
    && /randomInt\(0, 1_000_000\).*padStart\(6, "0"\)/u.test(loginSource),
  "Login codes must be random six-digit values with a 15-minute lifetime"
);
assert(
  /loginCodeActive: false,[\s\S]*?loginCodeUsedAt: FieldValue\.serverTimestamp\(\)[\s\S]*?redemptionSource: "pwa_code"/u.test(loginSource),
  "A redeemed code and its gateway token must be disabled atomically"
);
assert(
  /minuteCount >= 5 \|\| hourCount >= 20/u.test(loginSource),
  "Code guessing must be rate-limited per email"
);
assert(
  /loginCodeGatewayTokenHash: tokenHash/u.test(loginSource)
    && /return \{ emailActionLink \}/u.test(loginSource)
    && !/createCustomToken|signInWithCustomToken/u.test(appSource + loginSource),
  "Code login must reuse the existing one-time Firebase email action link without IAM signing"
);
assert(
  /確認コードは15分間・1回限り有効です/u.test(loginSource),
  "Both HTML and text email instructions must explain the short-lived code"
);
assert(
  /loginCodeGatewayTokenHash: FieldValue\.delete\(\)/u.test(loginSource)
    && !/loginVerificationCodes|loginCodeAttemptRateLimits/u.test(loginSource)
    && !/exchangeStaffLoginCode/u.test(indexSource + appSource + loginSource),
  "Expired codes must be cleaned from the existing rate-limit record without extra collections or Functions"
);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Staff PWA confirmation-code login checks passed (10 assertions)");

function assert(condition, message) {
  if (!condition) failures.push(message);
}
