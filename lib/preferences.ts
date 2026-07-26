// One-off/small settings that don't belong on the Account type itself —
// which account the user picked for *this specific* recording, and how
// account selection should behave generally. Both live in chrome.storage.local
// like everything else (no chrome.storage.sync — see CLAUDE.md).

export type StorageBehavior = 'default' | 'ask' | 'auto';

const SELECTED_ACCOUNT_KEY = 'quickcast:selected-account-id';
const STORAGE_BEHAVIOR_KEY = 'quickcast:storage-behavior';

// Set the moment the user picks a different account in the popup's dropdown
// (not just component state — the popup can close on blur at any time, e.g.
// clicking away, so anything not persisted immediately would be lost before
// Start is ever clicked). Cleared once a recording actually starts (see
// clearSelectedAccountId) — this is a one-time override for the next
// recording, not a sticky replacement for the default account.
export async function getSelectedAccountId(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(SELECTED_ACCOUNT_KEY);
  return stored[SELECTED_ACCOUNT_KEY] as string | undefined;
}

export async function setSelectedAccountId(id: string): Promise<void> {
  await chrome.storage.local.set({ [SELECTED_ACCOUNT_KEY]: id });
}

export async function clearSelectedAccountId(): Promise<void> {
  await chrome.storage.local.remove(SELECTED_ACCOUNT_KEY);
}

export async function getStorageBehavior(): Promise<StorageBehavior> {
  const stored = await chrome.storage.local.get(STORAGE_BEHAVIOR_KEY);
  return (stored[STORAGE_BEHAVIOR_KEY] as StorageBehavior | undefined) ?? 'default';
}

export async function setStorageBehavior(behavior: StorageBehavior): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_BEHAVIOR_KEY]: behavior });
}

// --- Mic/Cam toggle memory -----------------------------------------------
// The popup is short-lived (closes on blur, per CLAUDE.md's own architecture
// notes) and previously kept Mic/Cam as component state initialized to
// `true` on every mount — meaning the popup forgot the user's last choice
// the instant it closed, silently reverting to both-on for the next
// recording even right after explicitly toggling one off. Persisted here,
// the same "write immediately on change" pattern already used for
// setSelectedAccountId above, so the choice survives the popup closing.

const MIC_ENABLED_KEY = 'quickcast:mic-enabled';
const CAM_ENABLED_KEY = 'quickcast:cam-enabled';

export async function getMicEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(MIC_ENABLED_KEY);
  return (stored[MIC_ENABLED_KEY] as boolean | undefined) ?? true;
}

export async function setMicEnabled(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [MIC_ENABLED_KEY]: value });
}

export async function getCamEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(CAM_ENABLED_KEY);
  return (stored[CAM_ENABLED_KEY] as boolean | undefined) ?? true;
}

export async function setCamEnabled(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [CAM_ENABLED_KEY]: value });
}

// --- Recording defaults (Phase 5) ---------------------------------------
// Settings' "Recording defaults" grid (design.md's 04-settings.png). Read by
// background.ts at recording start (it's the one context with both
// chrome.storage.local access and the ability to resolve everything before
// handing a plain, already-resolved config to the offscreen document, which
// can't read storage itself — same pattern as driveAuth/folderId).

export type Quality = '1080p' | '720p' | '480p';
export type FrameRate = 24 | 30 | 60;
export type WebcamCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface RecordingDefaults {
  quality: Quality;
  frameRate: FrameRate;
  webcamCorner: WebcamCorner;
}

export const DEFAULT_RECORDING_DEFAULTS: RecordingDefaults = {
  quality: '720p',
  frameRate: 30,
  webcamCorner: 'bottom-right',
};

const RECORDING_DEFAULTS_KEY = 'quickcast:recording-defaults';

export async function getRecordingDefaults(): Promise<RecordingDefaults> {
  const stored = await chrome.storage.local.get(RECORDING_DEFAULTS_KEY);
  return { ...DEFAULT_RECORDING_DEFAULTS, ...(stored[RECORDING_DEFAULTS_KEY] as Partial<RecordingDefaults> | undefined) };
}

export async function setRecordingDefaults(defaults: RecordingDefaults): Promise<void> {
  await chrome.storage.local.set({ [RECORDING_DEFAULTS_KEY]: defaults });
}

// --- Cross-tab follow preferences (Phase 6) ------------------------------
// Whether the widget/webcam bubble should follow the user to tabs other than
// the one recording started on. Independent of lib/cross-tab-permission.ts's
// <all_urls> grant — that's *whether Chrome allows* reaching another tab at
// all; these are *whether the user wants* the widget and/or the webcam
// bubble specifically to do so once that access exists. Two separate keys so
// a user can, say, keep the timer following them everywhere while confining
// the webcam bubble to the original tab.

const FOLLOW_WIDGET_KEY = 'followWidgetAcrossTabs';
const FOLLOW_WEBCAM_KEY = 'followWebcamAcrossTabs';

export async function getFollowWidgetAcrossTabs(): Promise<boolean> {
  const stored = await chrome.storage.local.get(FOLLOW_WIDGET_KEY);
  return (stored[FOLLOW_WIDGET_KEY] as boolean | undefined) ?? true;
}

export async function setFollowWidgetAcrossTabs(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [FOLLOW_WIDGET_KEY]: value });
}

export async function getFollowWebcamAcrossTabs(): Promise<boolean> {
  const stored = await chrome.storage.local.get(FOLLOW_WEBCAM_KEY);
  return (stored[FOLLOW_WEBCAM_KEY] as boolean | undefined) ?? true;
}

export async function setFollowWebcamAcrossTabs(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [FOLLOW_WEBCAM_KEY]: value });
}

// videoBitsPerSecond per plan.md's Phase 5 spec: 1080p → 3 Mbps, 720p → 1.5
// Mbps, 480p → 800 Kbps.
export function bitrateForQuality(quality: Quality): number {
  switch (quality) {
    case '1080p':
      return 3_000_000;
    case '720p':
      return 1_500_000;
    case '480p':
      return 800_000;
  }
}
