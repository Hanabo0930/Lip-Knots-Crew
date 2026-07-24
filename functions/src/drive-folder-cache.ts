const FOLDER_CACHE_MAX = 200;
const FOLDER_CACHE_TTL_MS = 15 * 60 * 1000;

type FolderCacheEntry = { id: string; expiresAt: number };

const folderCache = new Map<string, FolderCacheEntry>();

export function folderCacheKey(parentId: string, name: string): string {
  return `${parentId}\0${name}`;
}

export function readCachedFolderId(parentId: string, name: string): string | null {
  const key = folderCacheKey(parentId, name);
  const cached = folderCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    if (cached) folderCache.delete(key);
    return null;
  }
  return cached.id;
}

export function writeCachedFolderId(parentId: string, name: string, id: string): void {
  const key = folderCacheKey(parentId, name);
  folderCache.set(key, { id, expiresAt: Date.now() + FOLDER_CACHE_TTL_MS });
  if (folderCache.size <= FOLDER_CACHE_MAX) return;
  const oldestKey = folderCache.keys().next().value;
  if (oldestKey) folderCache.delete(oldestKey);
}
