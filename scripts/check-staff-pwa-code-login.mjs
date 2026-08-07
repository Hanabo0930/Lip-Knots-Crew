import { readFile } from "node:fs/promises";

const appSource = await readFile("apps/staff/src/App.tsx", "utf8");
const loginSource = await readFile("functions/src/login-links.ts", "utf8");
const indexSource = await readFile("functions/src/index.ts", "utf8");
const failures = [];

assert(
  /signInWithCustomToken[\s\S]*?requestStaffLoginLink/u.test(appSource),
  "The installed Staff app must exchange the code through the existing allowlisted callable"
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
  /loginVerificationCodes[\s\S]*?active: false,[\s\S]*?usedAt: FieldValue\.serverTimestamp\(\)/u.test(loginSource),
  "A redeemed code must be atomically disabled and marked as used"
);
assert(
  /minuteCount >= 5 \|\| hourCount >= 20/u.test(loginSource),
  "Code guessing must be rate-limited per email"
);
assert(
  /auth\.createCustomToken\(authUser\.uid\)/u.test(loginSource)
    && /signInWithCustomToken\(activeAuth,customToken\)/u.test(appSource),
  "The verified code must become a locally persisted Firebase Auth session"
);
assert(
  /確認コードは15分間・1回限り有効です/u.test(loginSource),
  "Both HTML and text email instructions must explain the short-lived code"
);
assert(
  /expiredLoginCodes/u.test(loginSource)
    && !/exchangeStaffLoginCode/u.test(indexSource + appSource + loginSource),
  "Expired codes must be cleaned up without adding a non-allowlisted Function"
);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Staff PWA confirmation-code login checks passed (10 assertions)");

function assert(condition, message) {
  if (!condition) failures.push(message);
}
