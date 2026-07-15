// Caches each account's resolved "QuickCast Recordings/{YYYY-MM}" folder id so
// startRecording() doesn't re-run two Drive list queries (root folder, then
// month folder) on every single recording — only once per account per month.
// Keyed by accountId since two different Drive accounts obviously have two
// different folders, even for the same month string. Lives in
// chrome.storage.local (not the offscreen document, which can't read it —
// see lib/drive.ts's driveFetchWithAuth) and is populated by background.ts.
const STORAGE_KEY = 'quickcast:folder-cache';

type FolderCache = Record<string, Record<string, string>>; // accountId -> yearMonth -> folderId

async function readCache(): Promise<FolderCache> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as FolderCache | undefined) ?? {};
}

export async function getCachedFolderId(accountId: string, yearMonth: string): Promise<string | undefined> {
  const cache = await readCache();
  return cache[accountId]?.[yearMonth];
}

export async function setCachedFolderId(accountId: string, yearMonth: string, folderId: string): Promise<void> {
  const cache = await readCache();
  cache[accountId] = { ...cache[accountId], [yearMonth]: folderId };
  await chrome.storage.local.set({ [STORAGE_KEY]: cache });
}
