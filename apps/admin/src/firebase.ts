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
import {
  connectStorageEmulator,
  getStorage,
} from "firebase/storage";
import { getMessaging, isSupported, Messaging } from "firebase/messaging";
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
export const storage = app ? getStorage(app) : null;

if (auth) {
  void setPersistence(auth, browserLocalPersistence);
}

if (app && useFirebaseEmulators) {
  connectAuthEmulator(auth!, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db!, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions!, "127.0.0.1", 5001);
  connectStorageEmulator(storage!, "127.0.0.1", 9199);
}

let messagingPromise: Promise<Messaging | null> | null = null;

export function getClientMessaging(): Promise<Messaging | null> {
  if (!app) return Promise.resolve(null);
  if (!messagingPromise) {
    messagingPromise = isSupported().then((supported) =>
      supported ? getMessaging(app) : null
    );
  }
  return messagingPromise;
}
