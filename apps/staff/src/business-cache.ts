const BUSINESS_CACHE_VERSION = 1;
const BUSINESS_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const BUSINESS_SCOPE_VERSION = 1;

export type BusinessScope = {
  companyId: string;
  staffId: string;
};

type BusinessSnapshot<Job, Task> = {
  version: number;
  savedAt: number;
  jobs: Job[];
  tasks: Task[];
};

function cacheKey(uid: string, companyId: string, staffId: string): string {
  return `lkcBusinessSnapshot:${uid}:${companyId}:${staffId}`;
}

function scopeKey(uid: string): string {
  return `lkcBusinessScope:${uid}`;
}

function safeScopeValue(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && !/[\r\n\0]/u.test(value);
}

function isRecord(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
function text(value:unknown):value is string{return typeof value==="string"&&value.trim().length>0;}
function optionalFields(value:Record<string,unknown>,fields:string[],type:string):boolean{return fields.every(key=>value[key]==null||typeof value[key]===type);}
function validRows(value:unknown,check:(row:Record<string,unknown>)=>boolean):boolean{
  if(!Array.isArray(value))return false;
  const ids=new Set<string>();
  return value.every(row=>{if(!isRecord(row)||!text(row.id)||ids.has(row.id)||!check(row))return false;ids.add(row.id);return true;});
}
function validCachedJob(job:Record<string,unknown>):boolean{
  if(!text(job.dateKey)||!text(job.status)||typeof job.menuName!=="string"||
     !optionalFields(job,["workDate","clientName","makerName","storeName","workTime","storeAddress","storeNearestStation","materialStatus","companyId","assignedStaffId"],"string")||
     !optionalFields(job,["cancelled"],"boolean"))return false;
  if(job.preContact!=null){
    if(!isRecord(job.preContact)||!optionalFields(job.preContact,["arrivalTime"],"string"))return false;
    const temperature=job.preContact.temperature;
    if(temperature!=null&&typeof temperature!=="number"&&typeof temperature!=="string")return false;
  }
  if(job.netPrint!=null){
    if(!isRecord(job.netPrint))return false;
    if(job.netPrint.items!=null&&!validRows(job.netPrint.items,item=>typeof item.number==="string"&&optionalFields(item,["printed"],"boolean")))return false;
  }
  if(job.submissionStatus!=null){
    if(!isRecord(job.submissionStatus))return false;
    for(const kind of ["report","salesFloor"]){const status=job.submissionStatus[kind];if(status!=null&&(!isRecord(status)||!optionalFields(status,["completed","clientSubmitted","lipKnotsSubmitted"],"boolean")))return false;}
  }
  return true;
}
function validCachedTask(task:Record<string,unknown>):boolean{
  return [task.jobId,task.kind,task.title].every(text)&&typeof task.body==="string"&&
    typeof task.priority==="string"&&["normal","urgent","overdue"].includes(task.priority)&&(task.metadata==null||isRecord(task.metadata));
}

function removeCacheKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Browser storage can be unavailable without affecting network loading.
  }
}

export function loadLastBusinessScope(uid: string): BusinessScope | null {
  if (!uid) return null;
  const key = scopeKey(uid);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const scope = JSON.parse(raw) as Partial<BusinessScope> & { version?: number };
    if (
      scope.version !== BUSINESS_SCOPE_VERSION
      || !safeScopeValue(scope.companyId)
      || !safeScopeValue(scope.staffId)
    ) {
      removeCacheKey(key);
      return null;
    }
    return { companyId: scope.companyId, staffId: scope.staffId };
  } catch {
    removeCacheKey(key);
    return null;
  }
}

function saveLastBusinessScope(uid: string, companyId: string, staffId: string): void {
  if (!uid || !safeScopeValue(companyId) || !safeScopeValue(staffId)) return;
  try {
    localStorage.setItem(scopeKey(uid), JSON.stringify({
      version: BUSINESS_SCOPE_VERSION,
      companyId,
      staffId,
    }));
  } catch {
    // A missing scope hint only makes the next startup use the network-first path.
  }
}

export function loadBusinessSnapshot<Job, Task>(
  uid: string,
  companyId: string,
  staffId: string,
  now = Date.now(),
): BusinessSnapshot<Job, Task> | null {
  const key = cacheKey(uid, companyId, staffId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const snapshot = JSON.parse(raw) as Partial<BusinessSnapshot<Job, Task>>;
    const valid = snapshot.version === BUSINESS_CACHE_VERSION
      && typeof snapshot.savedAt === "number"
      && snapshot.savedAt <= now + 5 * 60 * 1000
      && now - snapshot.savedAt <= BUSINESS_CACHE_MAX_AGE_MS
      && validRows(snapshot.jobs,validCachedJob)
      && validRows(snapshot.tasks,validCachedTask);
    if (!valid) {
      removeCacheKey(key);
      return null;
    }
    return snapshot as BusinessSnapshot<Job, Task>;
  } catch {
    removeCacheKey(key);
    return null;
  }
}

export function saveBusinessSnapshot<Job, Task>(
  uid: string,
  companyId: string,
  staffId: string,
  jobs: Job[],
  tasks: Task[],
): void {
  if (!uid || !companyId || !staffId) return;
  const snapshot: BusinessSnapshot<Job, Task> = {
    version: BUSINESS_CACHE_VERSION,
    savedAt: Date.now(),
    jobs,
    tasks,
  };
  try {
    localStorage.setItem(cacheKey(uid, companyId, staffId), JSON.stringify(snapshot));
    saveLastBusinessScope(uid, companyId, staffId);
  } catch {
    // Storage can be unavailable in private browsing. Fresh network data remains authoritative.
  }
}

export function clearBusinessSnapshot(uid: string, companyId: string, staffId: string): void {
  if (!uid || !companyId || !staffId) return;
  removeCacheKey(cacheKey(uid, companyId, staffId));
  const scope = loadLastBusinessScope(uid);
  if (scope?.companyId === companyId && scope.staffId === staffId) {
    removeCacheKey(scopeKey(uid));
  }
}
