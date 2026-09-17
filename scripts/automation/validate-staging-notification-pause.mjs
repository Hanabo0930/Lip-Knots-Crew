import fs from 'node:fs';
import path from 'node:path';

export function assertNotificationDeliveryPaused(plan, sourceDirectory) {
  if (!plan.functions.includes('processNotificationQueue')) return;
  if (plan.project !== 'lip-knots-crew-staging' || plan.region !== 'asia-northeast1') throw Error('NOTIFICATION_PAUSE_SCOPE_INVALID');
  const file = path.join(sourceDirectory, 'functions/.env.' + plan.project);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw Error('NOTIFICATION_PAUSE_CONFIG_MISSING'); }
  const required = {APP_ENVIRONMENT: 'staging', EXPECTED_FIREBASE_PROJECT_ID: plan.project, LKC_NOTIFICATION_DELIVERY_MODE: 'paused'};
  for (const [key, expected] of Object.entries(required)) {
    const rows = text.split(/\r?\n/).filter(line => new RegExp('^\\s*(?:export\\s+)?' + key + '\\s*=').test(line));
    if (rows.length !== 1 || rows[0] !== key + '=' + expected) throw Error('NOTIFICATION_PAUSE_CONFIG_INVALID');
  }
}
