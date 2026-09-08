// SDK初期化より前に検証し、クラウドや別ホストへのフォールバックを拒否する。
export function emulatorSeedEnvironment(env) {
  const project = env.GCLOUD_PROJECT || 'demo-lip-knots-crew';
  if (!/^demo-[a-z0-9-]+$/.test(project)) throw new Error('Seed requires a demo-* project');
  let config;
  try { config = JSON.parse(env.FIREBASE_CONFIG || '{}'); } catch { throw new Error('Seed requires JSON FIREBASE_CONFIG'); }
  for (const value of [env.GCP_PROJECT, env.GOOGLE_CLOUD_PROJECT, env.EXPECTED_FIREBASE_PROJECT_ID, config?.projectId]) {
    if (value && value !== project) throw new Error('Seed project aliases must match');
  }
  function endpoint(value, fallback) {
    const host = value || fallback;
    const match = /^(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$/.exec(host);
    if (!match || Number(match[2]) > 65535) throw new Error('Seed requires a loopback host and valid port');
    return host;
  }
  if (env.APP_ENVIRONMENT && env.APP_ENVIRONMENT !== 'development') throw new Error('Seed requires development environment');
  return {GCLOUD_PROJECT:project,
    FIRESTORE_EMULATOR_HOST:endpoint(env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8080'),
    FIREBASE_AUTH_EMULATOR_HOST:endpoint(env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:9099')};
}
