import { readFile } from "node:fs/promises";

const firebaseSource = await readFile("apps/staff/src/firebase.ts", "utf8");
const appSource = await readFile("apps/staff/src/App.tsx", "utf8");
const failures = [];

assert(
  /export const authPersistenceReady = auth[\s\S]*?setPersistence\(auth, browserLocalPersistence\)/u.test(firebaseSource),
  "Staff must expose the Firebase Auth persistence setup promise"
);
assert(
  !/void setPersistence\(auth, browserLocalPersistence\)/u.test(firebaseSource),
  "Staff must not discard the Firebase Auth persistence setup promise"
);
assert(
  /authPersistenceReady\.then\(\(\)=>signInWithEmailLink\(activeAuth,email,url\)\)/u.test(appSource),
  "Email-link sign-in must wait for local persistence"
);
assert(
  /emailLinkSignInAttempt\?\.url===url/u.test(appSource),
  "The same email link must be completed only once"
);
assert(
  /emailLinkPending[\s\S]*?ログインを確認しています/u.test(appSource),
  "The login form must be hidden while an email link is being completed"
);
assert(
  /!authResolved\|\|emailLinkPending/u.test(appSource),
  "Staff must wait for the initial Firebase Auth state before showing the login form"
);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Staff email-link single-pass checks passed (6 assertions)");

function assert(condition, message) {
  if (!condition) failures.push(message);
}
