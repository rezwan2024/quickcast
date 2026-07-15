import type { DriveAuth } from '@/types/account';
import type { WebcamCorner } from '@/lib/preferences';
import type { RecordingConfig, UploadProgress } from '@/types/recording';

// popup -> background
// tabId is resolved in the popup itself, not re-queried later in background —
// chrome.tabs.query({currentWindow: true}) reliably means "the browser window
// this popup is attached to" only from the popup's own context. From the
// service worker there's no such concept, and querying there (even with
// lastFocusedWindow) proved unreliable — it could resolve to a different tab
// than the one the user actually meant to record, which activeTab was never
// granted for anyway.
export interface StartRecordingMessage {
  type: 'popup:start-recording';
  tabId: number;
  config: RecordingConfig;
}

// background -> offscreen
// No streamId here: the offscreen document calls navigator.mediaDevices
// .getDisplayMedia() directly (see entrypoints/offscreen/main.ts) — the
// picker and the stream are acquired in the same context that records it, so
// there's no cross-context streamId handoff. An earlier version routed this
// through chrome.desktopCapture.chooseDesktopMedia(sources, targetTab, cb) in
// the background service worker, but that API scopes its resulting streamId
// to frames within targetTab — which the offscreen document (a
// chrome-extension:// page) is not, so it could never redeem it.
export interface OffscreenPrepareMessage {
  type: 'offscreen:prepare';
  config: RecordingConfig;
  // Resolved by background.ts (which can read chrome.storage.local) and
  // handed to the offscreen document, which cannot — see
  // lib/drive.ts's driveFetchWithAuth. Undefined if no account was selected.
  driveAuth?: DriveAuth;
  // The "QuickCast Recordings/{YYYY-MM}" folder id to upload into, resolved
  // (and cached per account, see lib/folder-cache.ts) by background.ts before
  // sending this message — the offscreen document no longer calls
  // ensureMonthlyFolder itself, since that requires chrome.storage.local
  // access to cache against, which it doesn't have. Undefined if driveAuth is
  // undefined, or if folder resolution failed (upload then falls back to
  // Drive's root instead of blocking the recording).
  folderId?: string;
}
export interface OffscreenBeginMessage {
  type: 'offscreen:begin';
  recordingId: string;
}
export interface OffscreenPauseMessage {
  type: 'offscreen:pause';
  recordingId: string;
}
export interface OffscreenResumeMessage {
  type: 'offscreen:resume';
  recordingId: string;
}
export interface OffscreenStopMessage {
  type: 'offscreen:stop';
  recordingId: string;
}
export interface OffscreenCancelMessage {
  type: 'offscreen:cancel';
  recordingId: string;
}
// Sent by background.ts when the user clicks the on-screen webcam bubble's
// close button (see WidgetWebcamCloseClickedMessage below) — tells the
// offscreen document to stop the webcam track and remove it from the
// composited video for the rest of the recording. Screen capture is
// unaffected.
export interface OffscreenWebcamStopMessage {
  type: 'offscreen:webcam-stop';
  recordingId: string;
}

// offscreen -> background
// Sent right after Stop, with the full locally-recorded video (assembled from
// the IndexedDB chunks — see entrypoints/offscreen/main.ts's stopAndSave) —
// before those chunks are deleted. background.ts reconstructs a Blob from
// this and holds it in a recordingId-keyed Map (see localRecordingBlobs) so
// the share screen can play it back instantly instead of waiting on Drive's
// transcode, Loom-style.
//
// Carries an ArrayBuffer + mimeType rather than a Blob directly — confirmed
// live that a bare Blob does not survive chrome.runtime.sendMessage's
// structured clone across the offscreen-document-to-service-worker boundary
// (it arrived as undefined, the same failure this project's own
// background-to-share leg hit first — see ShareRequestLocalBlobMessage's own
// comment). ArrayBuffer does survive it.
//
// Separately: no blob: URL is ever created here or in background.ts — a URL
// created in either context is scoped to whichever one created it and goes
// stale the moment that context is torn down (this offscreen document closes
// once upload finishes; the service worker can idle-terminate any time),
// while the share tab that actually plays it back can stay open far longer
// than either. Only the share screen (a normal, long-lived tab) ever calls
// URL.createObjectURL(), once it has reconstructed its own Blob from the
// ArrayBuffer background.ts hands it (see ShareRequestLocalBlobMessage).
//
// Carries one ArrayBuffer per recorded chunk, not one pre-concatenated
// buffer — background.ts reconstructs via `new Blob(chunkArrayBuffers, {
// type })`, the same battle-tested multi-part Blob construction this
// project's own download fallback already relies on (see
// entrypoints/share/App.tsx's handleDownload, `new Blob(chunks, { type:
// 'video/webm' })`), rather than this file manually concatenating every
// chunk's bytes into one Uint8Array by hand — a hand-rolled reassembly step
// with no equivalent already proven to work elsewhere in this codebase.
export interface OffscreenBlobReadyMessage {
  type: 'offscreen:blob-ready';
  recordingId: string;
  chunkArrayBuffers: ArrayBuffer[];
  mimeType: string;
}

// share -> background
// Requests the locally-recorded Blob stashed by OffscreenBlobReadyMessage —
// sent on share screen mount (not just once, live) since the share tab can
// be closed and reopened after the recording itself has already ended.
// background responds with { blob: Blob | null } (null once already served
// via ShareBlobDoneMessage cleanup, or if it was never received).
export interface ShareRequestLocalBlobMessage {
  type: 'share:request-local-blob';
  recordingId: string;
}
// Sent once the share screen has swapped over to the synced Drive preview
// (or is unmounting) and no longer needs the local blob — background deletes
// its Map entry. Revoking the blob: URL created from it is the share
// screen's own job, since it's the one that created it.
export interface ShareBlobDoneMessage {
  type: 'share:blob-done';
  recordingId: string;
}

// Sent when the desktop video track ends on its own — i.e. the user clicked
// Chrome's native "Stop sharing" bar instead of our own widget's Stop button.
// The offscreen document has already saved/downloaded the recording itself by
// the time this is sent (see the track 'ended' listener in
// entrypoints/offscreen/main.ts); this just tells background to do the same
// widget/session cleanup as a normal stop.
export interface OffscreenEndedMessage {
  type: 'offscreen:ended';
  recordingId: string;
}
export interface OffscreenReadyMessage {
  type: 'offscreen:ready';
  recordingId: string;
}
export interface OffscreenErrorMessage {
  type: 'offscreen:error';
  recordingId: string;
  message: string;
}
export interface OffscreenStoppedMessage {
  type: 'offscreen:stopped';
  recordingId: string;
}
export interface OffscreenCancelledMessage {
  type: 'offscreen:cancelled';
  recordingId: string;
}
// Sent whenever uploaded/buffered byte counts change (throttled — see
// entrypoints/offscreen/main.ts), so background can relay it to the widget.
export interface OffscreenUploadProgressMessage extends UploadProgress {
  type: 'offscreen:upload-progress';
  recordingId: string;
}
// Sent once, right when the offscreen document decides Drive upload won't
// happen for this recording at all (no account selected, or the resumable
// session failed to initiate) — surfaced in the widget itself so the reason
// is visible without opening the offscreen document's devtools console. Safe
// to send directly from begin() (see entrypoints/offscreen/main.ts) since the
// content-script widget is already mounted (in its countdown phase, still
// listening) by the time begin() runs.
export interface OffscreenUploadDisabledMessage {
  type: 'offscreen:upload-disabled';
  recordingId: string;
  reason: string;
}
// Sent once the offscreen document's post-Stop Drive flush has actually
// finished (or given up) — see entrypoints/offscreen/main.ts's
// finalizeUploadThenNotify(). background.ts only closes the offscreen
// document once this arrives, not right after offscreen:stop responds —
// stopAndSave() no longer awaits the full flush before responding (it can
// take much longer than a single message round-trip should reasonably keep a
// service worker alive for), so closing the document any earlier would abort
// an in-progress upload.
export interface OffscreenUploadFinishedMessage {
  type: 'offscreen:upload-finished';
  recordingId: string;
  // Undefined if the upload was disabled or never completed — background
  // only opens the share screen when this is present.
  fileId?: string;
}
// background -> content (widget)
// The single, unified message that makes sure a tab's widget (and, if cam is
// on, its own independent webcam bubble) exist and reflect the current
// recording state — sent from entrypoints/background.ts's
// ensureWidgetOnActiveTab(), itself called from every event that could mean
// "the active tab may not have these yet, or may have lost them": recording
// start, chrome.tabs.onActivated (tab switch), chrome.tabs.onUpdated (page
// load/reload), and chrome.webNavigation.onHistoryStateUpdated (a
// single-page app's own in-app route change, which onUpdated alone doesn't
// catch — confirmed necessary on a real support site that re-renders its
// own <body> on navigation without an actual page reload).
//
// The content script's own handler is idempotent by construction: if the
// widget is already mounted, this is a no-op (ongoing updates — pause,
// upload progress — are already pushed separately once a tab is mounted);
// if not, it mounts fresh from this snapshot. cam here is background's
// already-resolved "should this tab currently try to show a bubble" answer
// (config.cam && the user hasn't closed the webcam via its X button for the
// rest of this recording) — the content script doesn't need to know about
// webcamClosed separately.
//
// Each tab that ends up showing a bubble opens its *own* camera
// independently — there is no cross-tab track handoff (not possible on the
// web platform) and, per this design, no single "current" tab to relocate
// away from either; every tab that has ever needed a bubble just keeps its
// own stream running for the rest of the recording.
export interface WidgetEnsureStateMessage {
  type: 'widget:ensure-state';
  recordingId: string;
  phase: 'countdown' | 'recording' | 'paused';
  // Only meaningful while phase is 'countdown' — how many seconds this tab's
  // own local 3-2-1 should start from. 0 once the recording has actually
  // started (phase is 'recording'/'paused'), regardless of how much of the
  // *original* tab's countdown is or isn't left — a tab that's only just
  // being ensured has never run any part of a countdown itself.
  countdownSeconds: number;
  // Only set once offscreen:begin has actually resolved (phase is no longer
  // 'countdown') — needed for a freshly-ensured tab to compute elapsed time
  // immediately instead of starting from 00:00.
  startedAt?: number;
  // Whether the timer widget pill itself should be shown on this specific
  // tab — false when this tab isn't the original recording tab and the
  // user's "Show recording widget on any tab" setting is off. Independent
  // of `cam`, since the widget and webcam bubble each have their own
  // follow-across-tabs preference (see lib/preferences.ts).
  showWidget: boolean;
  // Round 16: lets the content script pick RecordingPill (plain inline
  // styles, no Tailwind, no external stylesheet) over RecordingWidget for
  // the one tab where the Tailwind-styled pill has never once become
  // visible across 15 rounds of CSS/timing fixes — see recording-pill.tsx's
  // own header comment for why. Every other tab keeps using RecordingWidget
  // unchanged.
  isOriginalTab: boolean;
  cam: boolean;
  webcamCorner?: WebcamCorner;
  uploadProgress?: UploadProgress;
  uploadDisabledReason?: string;
}
export interface WidgetRecordingStartedMessage {
  type: 'widget:recording-started';
  recordingId: string;
  startedAt: number;
}
// Broadcast to every tab in widgetTabIds when Pause/Resume is clicked from
// *any one* of them — mirrors widget:recording-started's own broadcast
// (background.ts's handleCountdownDone). Without this, only the clicking
// tab's own optimistic setPhase() call ever reflected the new phase, and
// every other tab kept showing the old one until it was torn down and
// re-mounted (e.g. a manual reload, which re-fetches session.phase fresh via
// widget:ensure-state).
export interface WidgetPausedMessage {
  type: 'widget:paused';
  recordingId: string;
}
export interface WidgetResumedMessage {
  type: 'widget:resumed';
  recordingId: string;
}
export interface WidgetClosedMessage {
  type: 'widget:close';
  recordingId: string;
}
export interface WidgetErrorMessage {
  type: 'widget:error';
  recordingId: string;
  message: string;
}
export interface WidgetUploadProgressMessage extends UploadProgress {
  type: 'widget:upload-progress';
  recordingId: string;
}
export interface WidgetUploadDisabledMessage {
  type: 'widget:upload-disabled';
  recordingId: string;
  reason: string;
}
// Broadcast to every tab in widgetTabIds when the user clicks the webcam
// bubble's own X button in *any one* of them (see
// WidgetWebcamCloseClickedMessage below) — since every tab with a bubble now
// holds its own independent camera, "closing the webcam" for the rest of the
// recording means stopping it everywhere, not just the one tab it was
// clicked in.
export interface WidgetWebcamStopAllMessage {
  type: 'widget:webcam-stop-all';
  recordingId: string;
}

// background -> content (share screen)
// The share screen opens immediately on Stop (see entrypoints/background.ts's
// endRecording), before the Drive flush has necessarily finished — these push
// the actual outcome to that same already-open tab once it's known, rather
// than opening a second tab.
export interface ShareUploadReadyMessage {
  type: 'share:upload-ready';
  recordingId: string;
  fileId: string;
}
export interface ShareUploadFailedMessage {
  type: 'share:upload-failed';
  recordingId: string;
}
// Same underlying data as WidgetUploadProgressMessage (background.ts's
// handleUploadProgress caches one UploadProgress per session and forwards it
// to both widgetTabIds and shareTabId) — kept as its own message type rather
// than reusing 'widget:upload-progress' so the share screen's listener can't
// accidentally react to a progress update meant for a different tab's
// widget.
export interface ShareUploadProgressMessage extends UploadProgress {
  type: 'share:upload-progress';
  recordingId: string;
}

// content (widget) -> background
export interface WidgetCountdownDoneMessage {
  type: 'widget:countdown-done';
  recordingId: string;
}
export interface WidgetPauseClickedMessage {
  type: 'widget:pause-clicked';
  recordingId: string;
}
export interface WidgetResumeClickedMessage {
  type: 'widget:resume-clicked';
  recordingId: string;
}
export interface WidgetStopClickedMessage {
  type: 'widget:stop-clicked';
  recordingId: string;
}
export interface WidgetCancelClickedMessage {
  type: 'widget:cancel-clicked';
  recordingId: string;
}
// Sent when the user clicks the on-screen webcam bubble's close (X) button
// — the content script has already stopped its own local camera stream and
// removed the bubble by the time this arrives; background just relays it to
// the offscreen document (OffscreenWebcamStopMessage) to stop that
// document's own, entirely separate camera track and drop the circle from
// the composited video for the rest of the recording.
export interface WidgetWebcamCloseClickedMessage {
  type: 'widget:webcam-close-clicked';
  recordingId: string;
}

export type QuickCastMessage =
  | StartRecordingMessage
  | OffscreenPrepareMessage
  | OffscreenBeginMessage
  | OffscreenPauseMessage
  | OffscreenResumeMessage
  | OffscreenStopMessage
  | OffscreenCancelMessage
  | OffscreenWebcamStopMessage
  | OffscreenEndedMessage
  | OffscreenReadyMessage
  | OffscreenErrorMessage
  | OffscreenStoppedMessage
  | OffscreenCancelledMessage
  | OffscreenUploadProgressMessage
  | OffscreenUploadDisabledMessage
  | OffscreenUploadFinishedMessage
  | OffscreenBlobReadyMessage
  | ShareRequestLocalBlobMessage
  | ShareBlobDoneMessage
  | WidgetEnsureStateMessage
  | WidgetRecordingStartedMessage
  | WidgetPausedMessage
  | WidgetResumedMessage
  | WidgetClosedMessage
  | WidgetErrorMessage
  | WidgetUploadProgressMessage
  | WidgetUploadDisabledMessage
  | WidgetWebcamStopAllMessage
  | ShareUploadReadyMessage
  | ShareUploadFailedMessage
  | ShareUploadProgressMessage
  | WidgetCountdownDoneMessage
  | WidgetPauseClickedMessage
  | WidgetResumeClickedMessage
  | WidgetStopClickedMessage
  | WidgetCancelClickedMessage
  | WidgetWebcamCloseClickedMessage;
