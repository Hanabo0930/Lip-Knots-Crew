export function defaultBackupPolicy(){return{dailyRetentionDays:14,weeklyRetentionWeeks:8,monthlyRetentionMonths:12,includeCollections:["settings","members","staffProfiles","jobs","applications","submissions","auditLogs"],excludeCollections:["temporaryUploads","previewCache"]};}
export function backupObjectName(tenantId:string,iso:string,type:"daily"|"weekly"|"monthly"){
  if(!/^[A-Za-z0-9_-]{2,100}$/.test(tenantId))throw new Error("tenantId invalid");
  const d=new Date(iso);if(Number.isNaN(d.getTime()))throw new Error("date invalid");
  return`backups/${tenantId}/${type}/${d.toISOString().replace(/[:.]/g,"-")}.json.gz`;
}
