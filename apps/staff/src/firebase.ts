import { initializeApp, getApps } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  setPersistence,
  browserLocalPersistence,
} from "firebase/auth";
import {
  connectFirestoreEmulator,
  getFirestore,
} from "firebase/firestore";
import {
  connectFunctionsEmulator,
  getFunctions,
} from "firebase/functions";
import type { Messaging } from "firebase/messaging";
import {
  assertFirebaseConfiguration,
  firebaseConfig,
  firebaseConfigured,
  functionsRegion,
  useFirebaseEmulators,
} from "./firebase-config";

export { firebaseConfigured } from "./firebase-config";

assertFirebaseConfiguration();

export const firebaseApp = firebaseConfigured
  ? (getApps()[0] ?? initializeApp(firebaseConfig))
  : null;

const app = firebaseApp;

export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
export const functions = app ? getFunctions(app, functionsRegion) : null;

export const authPersistenceReady = auth
  ? setPersistence(auth, browserLocalPersistence).catch(()=>{throw new Error("ログイン情報の保存準備に失敗しました。サイトデータの保存設定を確認してから、画面を再読み込みしてください。");})
  : Promise.resolve();

// ログイン操作が待ち受ける前の拒否も処理済みにし、await時には失敗を伝える。
void authPersistenceReady.catch(()=>undefined);

if (app && useFirebaseEmulators) {
  connectAuthEmulator(auth!, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db!, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions!, "127.0.0.1", 5001);
}

let messagingPromise: Promise<Messaging | null> | null = null;

export function getClientMessaging(): Promise<Messaging | null> {
  if (!app) return Promise.resolve(null);
  if (!messagingPromise) {
    messagingPromise = import("firebase/messaging")
      .then(async ({isSupported,getMessaging}) =>
        await isSupported() ? getMessaging(app) : null
      )
      .catch((error)=>{
        messagingPromise=null;
        throw error;
      });
  }
  return messagingPromise;
}
