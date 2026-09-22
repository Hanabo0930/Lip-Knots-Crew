import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';

// SDK初期化より前に呼ぶ。実プロジェクトや既存の認証情報へ退避しない。
export function localAcceptanceEnvironment(env) {
  if (env.METADATA_SERVER_DETECTION !== 'none') throw new Error('CLOUD_METADATA_DETECTION_MUST_BE_DISABLED');
  const project = env.GCLOUD_PROJECT;
  if (!/^demo-lkc-accept-[a-z0-9]+$/.test(project ?? '')) throw new Error('LOCAL_DEMO_PROJECT_REQUIRED');
  if (env.APP_ENVIRONMENT !== 'development') throw new Error('LOCAL_DEVELOPMENT_REQUIRED');
  for (const key of ['GCP_PROJECT','GOOGLE_CLOUD_PROJECT','EXPECTED_FIREBASE_PROJECT_ID']) {
    if (env[key] !== undefined && env[key] !== project) throw new Error('PROJECT_ALIAS_MISMATCH');
  }
  let config;
  try { config = JSON.parse(env.FIREBASE_CONFIG ?? '{}'); } catch { throw new Error('INVALID_FIREBASE_CONFIG'); }
  if (!config || config.projectId !== project || (config.storageBucket !== undefined && config.storageBucket !== 'synthetic-bucket')) throw new Error('LOCAL_CONFIG_REQUIRED');
  if (env.GOOGLE_APPLICATION_CREDENTIALS || env.FIREBASE_TOKEN || env.GOOGLE_OAUTH_ACCESS_TOKEN) throw new Error('CREDENTIALS_NOT_ALLOWED');
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(env.FIRESTORE_EMULATOR_HOST ?? '');
  if (!match || Number(match[1]) > 65535) throw new Error('LOCAL_FIRESTORE_ENDPOINT_REQUIRED');
  return {project, host:'127.0.0.1', port:Number(match[1])};
}
export function allowedConnection(options, port) {
  return options && !options.path && ['127.0.0.1','localhost'].includes(options.host ?? 'localhost') && Number(options.port) === port;
}
export function blockNonEmulatorConnections(port) {
  const connect = net.Socket.prototype.connect;
  let allowed = 0, blocked = 0;
  net.Socket.prototype.connect = function(...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = first && typeof first === 'object' ? first
      : {port:first, host:typeof args[1] === 'string' ? args[1] : 'localhost'};
    if (!allowedConnection(options, port)) { blocked++; throw new Error('NON_EMULATOR_NETWORK_BLOCKED'); }
    allowed++;
    return connect.apply(this,args);
  };
  syncBuiltinESMExports();
  return {stats:()=>({allowed,blocked}), restore:()=>{net.Socket.prototype.connect=connect;syncBuiltinESMExports();}};
}

