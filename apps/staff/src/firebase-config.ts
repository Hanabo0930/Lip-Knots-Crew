export const appEnvironment = import.meta.env.VITE_APP_ENVIRONMENT ?? "development";
export const expectedFirebaseProjectId =
  import.meta.env.VITE_EXPECTED_FIREBASE_PROJECT_ID?.trim() ?? "";
export const functionsRegion =
  import.meta.env.VITE_FUNCTIONS_REGION?.trim() || "asia-northeast1";
export const useFirebaseEmulators =
  import.meta.env.VITE_USE_EMULATORS === "true";

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId
);

export function assertFirebaseConfiguration(): void {
  const hasAnyFirebaseValue = Object.values(firebaseConfig).some(Boolean);
  if (hasAnyFirebaseValue && !firebaseConfigured) {
    throw new Error("Firebase設定が一部だけ入力されています。起動を停止しました。");
  }

  if (appEnvironment !== "development" && useFirebaseEmulators) {
    throw new Error(`${appEnvironment}ではFirebase Emulatorを使用できません。`);
  }

  if (appEnvironment !== "development" && !expectedFirebaseProjectId) {
    throw new Error(
      `${appEnvironment}ではVITE_EXPECTED_FIREBASE_PROJECT_IDが必須です。`
    );
  }

  if (
    expectedFirebaseProjectId &&
    firebaseConfig.projectId !== expectedFirebaseProjectId
  ) {
    throw new Error(
      `Firebase Project ID不一致: expected=${expectedFirebaseProjectId}, actual=${firebaseConfig.projectId || "未設定"}`
    );
  }
}
