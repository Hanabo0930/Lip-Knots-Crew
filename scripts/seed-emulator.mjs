import crypto from "node:crypto";
import { emulatorSeedEnvironment } from "./emulator-seed-safety.mjs";

Object.assign(process.env, emulatorSeedEnvironment(process.env));
const { default: admin } = await import("firebase-admin");

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const auth = admin.auth();

const companyId = "lipknots";
const staffId = "staff_demo_001";
const email = "staff-demo@lipknots.com";
const hash = crypto.createHash("sha256").update(email).digest("hex");

await db.collection("emailIndex").doc(hash).set({
  companyId,
  staffId,
  email,
  active: true,
});

await db.collection("staffProfiles").doc(staffId).set({
  companyId,
  displayName: "A",
  emailAddresses: [email],
  phone: "090-0000-0000",
  prefecture: "千葉県",
  nearestStation: "津田沼駅",
  active: true,
  rank: "A",
});

await db.collection("jobs").doc("demo_job_1").set({
  companyId,
  caseId: "LKC-DEMO-0001",
  workDate: admin.firestore.Timestamp.fromDate(new Date("2026-07-20T00:00:00+09:00")),
  dateKey: "2026-07-20",
  monthKey: "2026.7",
  clientName: "〇〇デモ",
  makerName: "〇〇乳業",
  menuName: "ヨーグルト試食（50代まで歓迎）",
  storeName: "イオン船橋店",
  workTime: "10:00〜18:00",
  basePay: 10000,
  allowances: [{ label: "遠方手当", amount: 1000 }],
  status: "open",
  recruitmentStopped: false,
  cancelled: false,
  sheetRef: { sheetName: "2026.7", currentRow: 10 },
});

try {
  await auth.createUser({ email, emailVerified: true, displayName: "A" });
} catch (error) {
  if (error?.code !== "auth/email-already-exists") throw error;
}

console.log("Emulator seed completed.");
console.log("Staff email:", email);
