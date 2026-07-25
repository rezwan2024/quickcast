import type { RecordingConfig, UploadProgress } from '@/types/recording';

export interface RecordingSession {
  recordingId: string;
  tabId: number;
  config: RecordingConfig;
  // Set once offscreen:begin resolves — needed later to compute the
  // recording's duration for the share screen (Phase 4).
  startedAt?: number;
  // Set the moment Stop is processed (before the — possibly long — Drive
  // flush and offscreen-document teardown) so duration reflects when the
  // user actually stopped, not whenever the upload happened to finish.
  stoppedAt?: number;
  // Captured at Start time for 'tab' mode recordings — becomes the "Source
  // URL" line in the Drive file's description (Phase 4).
  sourceTabUrl?: string;
  // Set right after Stop opens the share screen (in a pending "Uploading…"
  // state, before the fileId is known) — background pushes the real fileId
  // to this specific tab once the upload finishes, rather than opening a
  // second tab.
  shareTabId?: number;
  // Every tab the widget is currently mounted in — starts as just [tabId],
  // grows as the user switches to other tabs mid-recording (see
  // chrome.tabs.onActivated in background.ts). Stop/progress/disabled
  // messages go to all of these, not just the original tab.
  widgetTabIds: number[];
  // Tracked so a tab visited mid-recording can mount the widget already
  // showing the right phase (recording vs. paused).
  phase?: 'recording' | 'paused';
  lastUploadProgress?: UploadProgress;
  lastUploadDisabledReason?: string;
  // Set once the user explicitly closes the webcam bubble (X button, any
  // tab) — ensureWidgetOnActiveTab checks this so it never (re)starts a
  // bubble on any tab for the rest of the recording once the user has
  // deliberately turned the webcam off. Each tab that shows a bubble opens
  // its own independent camera stream; there's no single "current" tab to
  // track for it, unlike the widget.
  webcamClosed?: boolean;
}

const STORAGE_KEY = 'quickcast:active-recording';

let cached: RecordingSession | undefined;

export async function setActiveSession(session: RecordingSession): Promise<void> {
  cached = session;
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
}

export async function getActiveSession(): Promise<RecordingSession | undefined> {
  if (cached) return cached;
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  cached = stored[STORAGE_KEY] as RecordingSession | undefined;
  return cached;
}

// Patches fields onto the currently active session (e.g. startedAt once
// recording actually begins) without clobbering the rest of it.
export async function updateActiveSession(patch: Partial<RecordingSession>): Promise<RecordingSession | undefined> {
  const current = await getActiveSession();
  if (!current) return undefined;
  const updated = { ...current, ...patch };
  cached = updated;
  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
  return updated;
}

export async function clearActiveSession(): Promise<void> {
  cached = undefined;
  await chrome.storage.local.remove(STORAGE_KEY);
}
