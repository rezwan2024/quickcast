// postMessage protocol between the content script (parent frame, on
// whatever page is being recorded) and the widget-frame fallback page
// (entrypoints/widget-frame/), embedded as an <iframe> only when the normal
// shadow-DOM widget fails to become visible within its 2-second watch
// window (see entrypoints/content/index.ts's watchWidgetVisibility). Plain
// window.postMessage, not chrome.runtime messaging — the iframe is a real,
// separate browsing context (its own window), and postMessage is the only
// channel that reaches directly into it from the parent frame without
// round-tripping through the background service worker.
//
// A `source` tag on every message (not just relying on event.source
// identity checks, which both sides also do) — postMessage has no built-in
// message-shape guarantee, and both this extension's own other messages
// (chrome.runtime ones) and, in principle, the host page's own unrelated
// postMessage traffic could otherwise be misread as one of these.

export type WidgetFrameUploadHealth = 'synced' | 'green' | 'amber' | 'red' | 'offline';

export interface WidgetFrameStateMessage {
  source: 'quickcast-parent';
  type: 'state';
  recordingId: string;
  phase: 'recording' | 'paused';
  startedAt?: number;
  uploadedBytes?: number;
  bufferedBytes?: number;
  speedBytesPerSec?: number;
  uploadHealth?: WidgetFrameUploadHealth;
  uploadDisabledReason?: string;
}

export type WidgetFrameToParentMessage =
  | { source: 'quickcast-widget-frame'; type: 'ready' }
  | { source: 'quickcast-widget-frame'; type: 'pause-clicked'; recordingId: string }
  | { source: 'quickcast-widget-frame'; type: 'resume-clicked'; recordingId: string }
  | { source: 'quickcast-widget-frame'; type: 'stop-clicked'; recordingId: string }
  | { source: 'quickcast-widget-frame'; type: 'cancel-clicked'; recordingId: string };
