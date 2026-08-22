const BUSINESS_CACHE_VERSION = 1;
const BUSINESS_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

type BusinessSnapshot<Job, Task> = {
  version: number;
  savedAt: number;
  jobs: Job[];
  tasks: Task[];
};

function cacheKey(uid: string, companyId: string, staffId: string): string {
  return `lkcBusinessSnapshot:${uid}:${companyId}:${staffId}`;
}

function removeCacheKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Browser storage can be unavailable without affecting network loading.
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
  } catch {
    // Storage can be unavailable in private browsing. Fresh network data remains authoritative.
  }
}

export function clearBusinessSnapshot(uid: string, companyId: string, staffId: string): void {
  if (!uid || !companyId || !staffId) return;
  removeCacheKey(cacheKey(uid, companyId, staffId));
}
