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
  // Set only when `cam` is true — where to composite the webcam circle if
  // getUserMedia for the camera actually succeeds (see
  // entrypoints/offscreen/main.ts's prepare()).
  webcamCorner?: WebcamCorner;
}

export type RecordingState = 'idle' | 'countdown' | 'recording' | 'paused' | 'stopping';

export type UploadHealth = 'synced' | 'green' | 'amber' | 'red' | 'offline';

export interface UploadProgress {
  uploadedBytes: number;
  bufferedBytes: number;
  speedBytesPerSec: number;
  health: UploadHealth;
}
