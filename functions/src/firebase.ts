import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { getStorage } from "firebase-admin/storage";

const appEnvironment = process.env.APP_ENVIRONMENT ?? "development";
const expectedProjectId = process.env.EXPECTED_FIREBASE_PROJECT_ID?.trim();
const firebaseConfig = (() => {
  try {
    return JSON.parse(process.env.FIREBASE_CONFIG ?? "{}") as {
      projectId?: string;
    };
  } catch {
    return {};
  }
})();
const actualProjectId =
  process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? firebaseConfig.projectId;

if (appEnvironment !== "development" && !expectedProjectId) {
  throw new Error(
    `${appEnvironment}ではEXPECTED_FIREBASE_PROJECT_IDが必須です。`
  );
}
if (expectedProjectId && actualProjectId && expectedProjectId !== actualProjectId) {
  throw new Error(
    `Firebase Project ID不一致: expected=${expectedProjectId}, actual=${actualProjectId}`
  );
}

initializeApp();

export const auth = getAuth();
export const db = getFirestore();
export const messaging = getMessaging();
export const storage = getStorage();
