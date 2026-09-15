import { initializeApp, getApps } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  setPersistence,
  browserLocalPersistence,
} from "firebase/auth";
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
export const functions = app ? getFunctions(app, functionsRegion) : null;

if (auth) {
  void setPersistence(auth, browserLocalPersistence);
}

if (app && useFirebaseEmulators) {
  connectAuthEmulator(auth!, "http://127.0.0.1:9099", { disableWarnings: true });
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
