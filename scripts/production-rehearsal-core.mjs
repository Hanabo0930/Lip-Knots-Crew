import { createHash } from "node:crypto";

export function buildProductionRehearsalCommands(config) {
  validateProductionRehearsalConfig(config);
  const stamp="YYYYMMDD-HHMMSS";
  const prefix=`${config.backupBucket.replace(/\/$/u,"")}/${config.releaseId}/${stamp}`;
  const steps=[
    {order:1,key:"freeze",label:"変更凍結",command:"管理画面で段階配布・公開状態を固定し、freeze証跡を保存"},
    {order:2,key:"firestore_export",label:"Firestore export",command:`gcloud firestore export ${prefix}/firestore --project ${config.sourceProjectId}`},
    {order:3,key:"storage_manifest",label:"Storage manifest",command:`gcloud storage ls --recursive gs://${config.sourceProjectId}.appspot.com`},
    {order:4,key:"auth_export",label:"Auth export",command:`firebase auth:export auth-users.json --project ${config.sourceProjectId}`},
    {order:5,key:"restore",label:"隔離復元",command:`gcloud firestore import ${prefix}/firestore --project ${config.restoreProjectId}`},
    {order:6,key:"rules_indexes",label:"Rules・Indexes",command:`firebase deploy --only firestore:rules,firestore:indexes --project ${config.restoreProjectId}`},
    {order:7,key:"validate",label:"件数・SHA・権限・smoke検算",command:"管理画面へ元件数・復元件数・snapshot SHA-256・probe結果を記録"},
    {order:8,key:"migration",label:"移行dry-run",command:"production migrationをdry-runし、予定件数・適用件数・差異を記録"},
    {order:9,key:"rollback",label:"切戻し",command:"隔離環境をsnapshotへ切戻し、RTO・RPO・smokeを記録"},
  ];
  const fingerprint=createHash("sha256").update(JSON.stringify({config,steps})).digest("hex");
  return {releaseId:config.releaseId,sourceProjectId:config.sourceProjectId,restoreProjectId:config.restoreProjectId,prefix,maxRtoMinutes:config.maxRtoMinutes,maxRpoMinutes:config.maxRpoMinutes,steps,fingerprint};
}

export function validateProductionRehearsalConfig(config) {
  if(!config||typeof config!=="object")throw new Error("rehearsal config is required");
  for(const key of ["releaseId","sourceEnvironment","sourceProjectId","restoreProjectId","backupBucket"]){if(typeof config[key]!=="string"||!config[key].trim())throw new Error(`${key} is required`);}
  if(config.sourceEnvironment!=="staging")throw new Error("source environment must be staging");
  if(config.sourceProjectId===config.restoreProjectId)throw new Error("restore project must be isolated");
  if(!/(restore|drill|rehearsal)/iu.test(config.restoreProjectId))throw new Error("restore project name must identify drill isolation");
  if(!/^gs:\/\/[a-z0-9][a-z0-9._-]+$/u.test(config.backupBucket))throw new Error("backup bucket is invalid");
  if(!Number.isInteger(config.maxRtoMinutes)||config.maxRtoMinutes<5||config.maxRtoMinutes>240)throw new Error("maxRtoMinutes is invalid");
  if(!Number.isInteger(config.maxRpoMinutes)||config.maxRpoMinutes<0||config.maxRpoMinutes>60)throw new Error("maxRpoMinutes is invalid");
}
