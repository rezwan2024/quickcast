// Last 20 recordings, shown in the popup's history panel (requirements.md
// §7). Newest first. No search/filter/thumbnails — deliberately minimal.

export interface RecentRecording {
  recordingId: string;
  title: string;
  timestamp: number; // ms epoch — when the recording actually started
  accountId: string;
  accountEmail: string;
  // Both undefined while the Drive upload is still finishing (see
  // entrypoints/background.ts's openPendingShareScreen/handleUploadFinished)
  // — the row still shows up right away, just without a working copy-link
  // button until the upload completes.
  driveFileId?: string;
  shareLink?: string;
}

const STORAGE_KEY = 'quickcast:recent-recordings';
const MAX_ENTRIES = 20;

export async function getRecentRecordings(): Promise<RecentRecording[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as RecentRecording[] | undefined) ?? [];
}

// Called once, right when the share screen opens (see background.ts) — the
// upload may still be pending at that point, so driveFileId/shareLink are
// often unset here and filled in later via updateRecentRecording.
export async function addRecentRecording(entry: RecentRecording): Promise<void> {
  const list = await getRecentRecordings();
  // Replace rather than duplicate if this recordingId is somehow already
  // present (shouldn't normally happen — each recording only opens its share
  // screen once — but guards against a double-call adding two rows).
  const withoutExisting = list.filter((r) => r.recordingId !== entry.recordingId);
  const updated = [entry, ...withoutExisting].slice(0, MAX_ENTRIES);
  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
}

// Patches an already-added entry once the Drive upload finishes (fileId/link
// become known) — no-ops if the entry isn't found (e.g. it aged out of the
// 20-entry cap between being added and the upload finishing).
export async function updateRecentRecording(recordingId: string, patch: Partial<RecentRecording>): Promise<void> {
  const list = await getRecentRecordings();
  const index = list.findIndex((r) => r.recordingId === recordingId);
  if (index === -1) return;
  list[index] = { ...list[index], ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
}
