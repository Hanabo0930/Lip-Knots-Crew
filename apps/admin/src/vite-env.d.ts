/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_ENVIRONMENT?: "development" | "staging" | "production";
  readonly VITE_EXPECTED_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FUNCTIONS_REGION?: string;
  readonly VITE_FIREBASE_VAPID_KEY: string;
}
