import type { WebcamCorner } from '@/lib/preferences';

export type RecordingMode = 'screen' | 'window' | 'tab';

export interface RecordingConfig {
  recordingId: string;
  title: string;
  mode: RecordingMode;
  mic: boolean;
  cam: boolean;
  // Which connected Drive account to stream the upload to. Undefined means
  // no account is connected yet — recording still proceeds (local IndexedDB
  // safety copy per requirements.md), just without a Drive upload.
  accountId?: string;
  // Resolved by background.ts from Settings' Recording defaults
  // (lib/preferences.ts) before this config is sent to the offscreen
  // document — the popup itself doesn't set these; the offscreen document
  // can't read chrome.storage.local to resolve them itself (same reason
  // driveAuth/folderId are resolved in background.ts and passed through).
  videoBitsPerSecond?: number;
  frameRate?: number;
  // Set only when `cam` is true — which corner the content-script's own
  // on-page webcam bubble anchors to (components/webcam-bubble.tsx). No
  // longer used for recording composition: the offscreen document does not
  // open its own camera or composite a circle onto the recorded video — the
  // on-page bubble (already visible on screen) is the single source of the
  // webcam in both the live view and the recorded pixels, per the
  // double-bubble fix (see lib/webcam-compositor.ts's removal).
  webcamCorner?: WebcamCorner;
}

export type RecordingState = 'idle' | 'recording' | 'paused' | 'stopping';

export type UploadHealth = 'synced' | 'green' | 'amber' | 'red' | 'offline';

export interface UploadProgress {
  uploadedBytes: number;
  bufferedBytes: number;
  speedBytesPerSec: number;
  health: UploadHealth;
}
