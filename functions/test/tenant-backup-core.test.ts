import {defaultBackupPolicy,backupObjectName} from "../src/tenant-backup-core";
function eq(a:unknown,b:unknown,m:string){if(a!==b)throw new Error(m);}
eq(defaultBackupPolicy().dailyRetentionDays,14,"policy");
eq(backupObjectName("acme","2026-07-13T00:00:00Z","daily").startsWith("backups/acme/daily/"),true,"name");
console.log("tenant backup core tests passed");
