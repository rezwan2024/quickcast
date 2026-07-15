// Persists the outcome of a recording's post-Stop Drive upload, keyed by
// recordingId, so the share screen (entrypoints/share/) can recover it after
// a page refresh — the share:upload-ready/share:upload-failed messages
// background.ts sends are one-shot and only reach a listener that's already
// registered at the moment they're sent; a refreshed tab misses them
// entirely and would otherwise be stuck showing "Finishing upload…" forever.
export interface UploadResult {
  // Undefined means the upload failed or was disabled for this recording.
  fileId?: string;
}

const STORAGE_KEY = 'quickcast:upload-results';

async function getAllUploadResults(): Promise<Record<string, UploadResult>> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as Record<string, UploadResult> | undefined) ?? {};
}

export async function setUploadResult(recordingId: string, result: UploadResult): Promise<void> {
  const all = await getAllUploadResults();
  all[recordingId] = result;
  await chrome.storage.local.set({ [STORAGE_KEY]: all });
}

export async function getUploadResult(recordingId: string): Promise<UploadResult | undefined> {
  const all = await getAllUploadResults();
  return all[recordingId];
}
