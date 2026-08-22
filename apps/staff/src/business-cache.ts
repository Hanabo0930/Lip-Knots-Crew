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
      && Array.isArray(snapshot.jobs)
      && Array.isArray(snapshot.tasks);
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
