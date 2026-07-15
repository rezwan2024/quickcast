import { addChunk, deleteRecording, getChunks } from '@/lib/idb';
import {
  driveFetchWithAuth,
  initiateResumableUpload,
  queryUploadedOffset,
  setAnyoneWithLinkPermission,
  uploadChunk,
} from '@/lib/drive';
import { startWebcamCompositor, type WebcamCompositor } from '@/lib/webcam-compositor';
import type {
  OffscreenBeginMessage,
  OffscreenBlobReadyMessage,
  OffscreenCancelMessage,
  OffscreenPauseMessage,
  OffscreenPrepareMessage,
  OffscreenResumeMessage,
  OffscreenStopMessage,
  OffscreenUploadDisabledMessage,
  OffscreenUploadFinishedMessage,
  OffscreenUploadProgressMessage,
  OffscreenWebcamStopMessage,
} from '@/lib/messaging';
import type { DriveAuth } from '@/types/account';
import type { RecordingConfig, UploadHealth } from '@/types/recording';

const LOG = '[QuickCast][offscreen]';

// Drive's resumable upload protocol requires every PUT except the final one
// to carry a byte count that's a multiple of 256 KiB.
const CHUNK_ALIGN_BYTES = 256 * 1024;
// Per plan.md's Phase 3 spec: don't PUT the instant 256 KiB is available —
// wait for at least 2 MiB. Uploading in small ~256 KiB pieces (one MediaRecorder
// timeslice's worth at typical bitrates) means one HTTP round-trip roughly
// every second; each PUT's fixed overhead (TLS/HTTP framing, Google's
// server-side processing, this device's own latency to Google) dominates at
// that size, capping throughput well below the connection's real capacity —
// which is exactly why a direct browser-to-Drive upload (using much larger
// chunks) is faster than this extension's uploads were. Batching to 2 MiB
// amortizes that per-request overhead across ~8x more bytes.
const MIN_UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
// 2s, 4s, 8s, 16s, 32s — per plan.md's Phase 3 spec — then fall back to
// waiting for the browser's 'online' event instead of retrying on a timer.
const BACKOFF_DELAYS_MS = [2000, 4000, 8000, 16000, 32000];
const SPEED_WINDOW_MS = 8000;
const PROGRESS_THROTTLE_MS = 400;
// Generous, since stopAndSave() no longer blocks on this finishing (see
// finalizeUploadThenNotify) — its only job now is to stop a genuinely dead
// connection from keeping this document open forever, not to cap a normal
// large remaining buffer (which can legitimately take minutes on a slow
// connection).
const FINAL_FLUSH_TIMEOUT_MS = 5 * 60_000;

interface Session {
  config: RecordingConfig;
  // Every track that owns real hardware/capture and must have .stop() called
  // on cleanup — desktop video, webcam video (if acquired), mic audio. Does
  // NOT include the canvas-composited video track that MediaRecorder
  // actually records from when a webcam is active — that's owned by
  // `compositor` below and stopped via its own stop() (which also halts the
  // draw loop, not just the track).
  tracks: MediaStreamTrack[];
  // Only set when the webcam was requested and getUserMedia succeeded — see
  // lib/webcam-compositor.ts. Its stop() must be called before/alongside
  // stopTracks() so the requestAnimationFrame draw loop doesn't keep running
  // (and referencing torn-down streams) after the recording ends.
  compositor?: WebcamCompositor;
  // The raw webcam video track (also present in `tracks` above, for the
  // full-recording-end cleanup path) — kept separately so the
  // offscreen:webcam-stop handler (user closed the on-screen bubble
  // mid-recording) can stop just this one track and turn off the camera
  // light immediately, without touching the desktop/mic tracks.
  camTrack?: MediaStreamTrack;
  recorder: MediaRecorder;
  chunkIndex: number;
  // Set right before we stop tracks ourselves (normal Stop/Cancel), so the
  // desktop track's 'ended' listener below can tell the difference between
  // "we did this" and "the user clicked Chrome's native Stop sharing button."
  endingByUs: boolean;

  // --- Phase 3: Drive upload state ---
  // Auth material passed in from background.ts (see types/account.ts's
  // DriveAuth) — this document cannot read chrome.storage.local itself, so
  // it never looks an account up on its own. driveFetchWithAuth mutates
  // this object's accessToken in place after a mid-recording 401 refresh.
  driveAuth?: DriveAuth;
  // Resumable upload session URI (Drive's Location header from the initiate
  // POST). Undefined if no account was selected, or initiation failed.
  sessionUri?: string;
  fileId?: string;
  uploadDisabled: boolean;
  // Set alongside uploadDisabled. Not sent to the widget directly from here —
  // prepare() runs before widget:ensure-state is even sent, so the widget
  // (which only mounts and starts listening once that arrives) isn't
  // guaranteed to exist yet to receive it. begin() re-reports this once
  // recording actually starts, a point by which the widget is definitely
  // mounted (it just sent widget:countdown-done itself).
  uploadDisabledReason?: string;
  uploadedBytes: number;
  // Chunks recorded but not yet confirmed uploaded. Kept as an array so a
  // partial (non-256KiB-aligned) remainder can be cheaply prepended to the
  // next MediaRecorder chunk instead of re-slicing a huge Blob each time.
  pendingBlobs: Blob[];
  pendingBytes: number;
  // Every upload attempt (including the final flush) is chained onto this
  // promise so at most one is ever in flight, and a final flush requested
  // mid-recording waits for any already-queued chunk uploads first rather
  // than racing them.
  uploadChain: Promise<void>;
  speedSamples: { t: number; bytes: number }[];
  lastProgressSentAt: number;
}

const sessions = new Map<string, Session>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOnline(): Promise<void> {
  if (navigator.onLine) return Promise.resolve();
  return new Promise((resolve) => {
    window.addEventListener(
      'online',
      () => resolve(),
      { once: true },
    );
  });
}

function fileNameFor(config: RecordingConfig): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const title = config.title.trim() || `Recording ${now.toTimeString().slice(0, 5)}`;
  return `${title}-${dateStr}.webm`;
}

// Requests the screen/window/tab picker and stream directly in this document
// — no chrome.desktopCapture + streamId handoff from the background service
// worker, since chooseDesktopMedia's streamId (when a targetTab is supplied,
// which Chrome now requires from a service worker) can only be redeemed by
// getUserMedia from a frame within that tab, and this offscreen document is a
// chrome-extension:// page, not a frame in any tab. displaySurface is only a
// hint for which tab the native picker defaults to — the user can still pick
// a different source there.
function displaySurfaceFor(mode: RecordingConfig['mode']): 'monitor' | 'window' | 'browser' {
  switch (mode) {
    case 'screen':
      return 'monitor';
    case 'window':
      return 'window';
    case 'tab':
      return 'browser';
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const name = 'name' in err ? String((err as { name?: unknown }).name) : 'Error';
    return `${name}: ${err.message}`;
  }
  return 'unknown error';
}

function recordSpeedSample(session: Session): void {
  const now = performance.now();
  session.speedSamples.push({ t: now, bytes: session.uploadedBytes });
  session.speedSamples = session.speedSamples.filter((s) => now - s.t <= SPEED_WINDOW_MS);
}

function computeSpeedBytesPerSec(session: Session): number {
  if (session.speedSamples.length < 2) return 0;
  const first = session.speedSamples[0];
  const last = session.speedSamples[session.speedSamples.length - 1];
  const dtSeconds = (last.t - first.t) / 1000;
  if (dtSeconds <= 0) return 0;
  return (last.bytes - first.bytes) / dtSeconds;
}

// Thresholds per plan.md's Phase 3 spec: green if the estimated wait after
// Stop is under 5s, amber 5-30s, red over 30s. 'synced' (fully caught up) and
// 'offline' are additional states design.md calls for beyond those three.
function computeHealth(session: Session, speedBytesPerSec: number): UploadHealth {
  if (!navigator.onLine) return 'offline';
  if (session.pendingBytes === 0) return 'synced';
  if (speedBytesPerSec <= 0) return 'red';
  const etaSeconds = session.pendingBytes / speedBytesPerSec;
  if (etaSeconds < 5) return 'green';
  if (etaSeconds <= 30) return 'amber';
  return 'red';
}

// Surfaced directly in the widget (see WidgetUploadDisabledMessage) so the
// reason is visible without opening the offscreen document's own devtools —
// which most users won't know how to find (chrome://extensions → QuickCast →
// Inspect views → offscreen.html). Safe to send from begin() (see below)
// since the content-script widget is already mounted (still in its countdown
// phase, but listening) well before begin() ever runs.
function sendUploadDisabled(recordingId: string, reason: string): void {
  console.error(LOG, '*** Drive upload disabled for this recording:', reason);
  const message: OffscreenUploadDisabledMessage = { type: 'offscreen:upload-disabled', recordingId, reason };
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

function sendProgress(session: Session, opts: { force?: boolean } = {}): void {
  const now = performance.now();
  if (!opts.force && now - session.lastProgressSentAt < PROGRESS_THROTTLE_MS) return;
  session.lastProgressSentAt = now;
  const speedBytesPerSec = computeSpeedBytesPerSec(session);
  const message: OffscreenUploadProgressMessage = {
    type: 'offscreen:upload-progress',
    recordingId: session.config.recordingId,
    uploadedBytes: session.uploadedBytes,
    bufferedBytes: session.pendingBytes,
    speedBytesPerSec,
    health: computeHealth(session, speedBytesPerSec),
  };
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

// Uploads exactly [start, start + blob.size) and does not return until Drive
// has confirmed those bytes — retrying indefinitely through network drops.
// On any failure it first asks Drive how many bytes it actually received
// before assuming none did (a failed PUT doesn't tell us whether the bytes
// landed before the connection dropped), then narrows the retry to only the
// unconfirmed remainder.
async function uploadWithRetry(
  session: Session,
  blob: Blob,
  start: number,
  totalSize: number | null,
): Promise<{ fileId?: string }> {
  let attempt = 0;
  let pendingBlob = blob;
  let pendingStart = start;

  while (true) {
    if (!navigator.onLine) {
      console.warn(LOG, 'Offline — waiting for connectivity before uploading', { pendingStart });
      sendProgress(session, { force: true });
      await waitForOnline();
    }
    try {
      const result = await uploadChunk(session.driveAuth!, session.sessionUri!, pendingBlob, pendingStart, totalSize);
      console.log(LOG, 'Chunk PUT succeeded', { start: pendingStart, bytes: pendingBlob.size, status: result.status, fileId: result.fileId });
      return { fileId: result.fileId };
    } catch (err) {
      console.error(LOG, 'Chunk PUT failed', { start: pendingStart, bytes: pendingBlob.size, attempt }, describeError(err));

      try {
        const confirmed = await queryUploadedOffset(session.driveAuth!, session.sessionUri!, totalSize);
        console.log(LOG, 'Queried confirmed offset after failure', { pendingStart, confirmed });
        if (confirmed > pendingStart) {
          const alreadyReceived = confirmed - pendingStart;
          if (alreadyReceived >= pendingBlob.size) return {};
          pendingBlob = pendingBlob.slice(alreadyReceived);
          pendingStart = confirmed;
        }
      } catch (queryErr) {
        console.error(LOG, 'Failed to query confirmed upload offset', describeError(queryErr));
      }

      if (attempt < BACKOFF_DELAYS_MS.length) {
        console.warn(LOG, `Retrying in ${BACKOFF_DELAYS_MS[attempt]}ms`, { attempt });
        sendProgress(session, { force: true });
        await sleep(BACKOFF_DELAYS_MS[attempt]);
        attempt++;
      } else {
        // Exhausted the timed backoff — stop hammering Drive and wait for the
        // browser to actually report connectivity is back.
        console.warn(LOG, 'Exhausted timed backoff — waiting for the online event before retrying again');
        sendProgress(session, { force: true });
        await waitForOnline();
        attempt = 0;
      }
    }
  }
}

// Drains whatever's in session.pendingBlobs, uploading 256KiB-aligned chunks
// of at least MIN_UPLOAD_CHUNK_BYTES each (or, when opts.final, whatever
// remains regardless of size/alignment — this is the one PUT allowed to
// declare the real total size instead of '*').
async function drainUpload(session: Session, opts: { final: boolean }): Promise<void> {
  if (session.uploadDisabled || !session.sessionUri || !session.driveAuth) return;

  while (true) {
    const availableBytes = session.pendingBytes;
    if (!opts.final && availableBytes < MIN_UPLOAD_CHUNK_BYTES) break;
    const uploadSize = opts.final ? availableBytes : Math.floor(availableBytes / CHUNK_ALIGN_BYTES) * CHUNK_ALIGN_BYTES;
    if (uploadSize === 0 && !opts.final) break;

    // Snapshot exactly which already-buffered chunks this upload covers.
    // recorder.ondataavailable can (and, now that uploads batch to 2MB+
    // instead of firing near-instantly, routinely will) push more chunks
    // onto session.pendingBlobs — the very same array — while the PUT below
    // is in flight (an `await` yields to the event loop, and ondataavailable
    // is a task that can run in that gap). Only ever remove the snapshotted
    // portion afterward; anything pushed during the upload must survive.
    const consumedCount = session.pendingBlobs.length;
    const full = new Blob(session.pendingBlobs.slice(0, consumedCount), { type: 'video/webm' });
    const chunk = full.slice(0, uploadSize);
    const remainder = full.slice(uploadSize);
    const start = session.uploadedBytes;
    const totalSize = opts.final ? session.uploadedBytes + uploadSize : null;

    console.log(LOG, 'Uploading chunk', { start, uploadSize, totalSize: totalSize ?? '*' });
    const result = await uploadWithRetry(session, chunk, start, totalSize);
    session.uploadedBytes += uploadSize;
    session.pendingBytes -= uploadSize;
    // Bug this replaces: `session.pendingBlobs = remainder.size > 0 ? [remainder] : []`
    // discarded any chunk that arrived during the `await` above outright —
    // pendingBytes kept counting them, but pendingBlobs no longer actually
    // held their data, so a later upload's `uploadSize` (computed from
    // pendingBytes) could exceed the real blob's size. slice() silently
    // clamps instead of erroring, so the resulting chunk.size fell short of
    // what session.uploadedBytes was then incremented by — permanently
    // desyncing our tracked offset from what Drive actually received. Once
    // that happened, every subsequent PUT's Content-Range no longer matched
    // Drive's own bookkeeping, so Drive kept rejecting it — an unrecoverable
    // stall that looked like the upload had frozen.
    const arrivedDuringUpload = session.pendingBlobs.slice(consumedCount);
    session.pendingBlobs = remainder.size > 0 ? [remainder, ...arrivedDuringUpload] : arrivedDuringUpload;
    if (result.fileId) session.fileId = result.fileId;
    recordSpeedSample(session);
    sendProgress(session);

    if (opts.final) break;
  }
}

// Chains onto session.uploadChain so uploads for a given session never run
// concurrently — a Stop-triggered final flush enqueued while an in-progress
// chunk upload is still retrying waits for it rather than racing it.
function enqueueUploadDrain(session: Session, opts: { final: boolean }): Promise<void> {
  const next = session.uploadChain.then(() => drainUpload(session, opts)).catch((err) => {
    console.error(LOG, 'Upload drain failed', describeError(err));
  });
  session.uploadChain = next;
  return next;
}

async function finalizeUpload(session: Session): Promise<void> {
  if (session.uploadDisabled || !session.sessionUri) return;

  // Don't let a stuck connection block Stop forever — the offscreen document
  // (and any in-flight fetch in it) is torn down shortly after this resolves
  // anyway, and the local IndexedDB copy is the fallback per requirements.md.
  await Promise.race([
    enqueueUploadDrain(session, { final: true }),
    sleep(FINAL_FLUSH_TIMEOUT_MS).then(() => {
      console.warn(LOG, 'Final upload flush timed out — leaving remaining bytes unsent; local copy is still available');
    }),
  ]);

  if (session.fileId) {
    try {
      await setAnyoneWithLinkPermission(session.driveAuth!, session.fileId);
    } catch (err) {
      console.error(LOG, 'Failed to set "anyone with the link" sharing permission', describeError(err));
    }
  }
  sendProgress(session, { force: true });
}

async function prepare(config: RecordingConfig, driveAuth: DriveAuth | undefined, folderId: string | undefined): Promise<void> {
  console.log(LOG, 'prepare() called', { config, hasDriveAuth: Boolean(driveAuth) });
  console.log(
    LOG,
    driveAuth
      ? `Drive upload target: accountId=${driveAuth.accountId}`
      : 'No driveAuth passed in — recording will be local-only, no Drive upload will be attempted',
  );

  // Defensive: shouldn't happen (recordingIds are fresh UUIDs and the
  // offscreen document is recreated per recording by background.ts), but
  // guard against a leftover session blocking a new one.
  const stale = sessions.get(config.recordingId);
  if (stale) {
    console.warn(LOG, 'Stale session found for recordingId, cleaning up first', config.recordingId);
    stopTracks(stale);
    sessions.delete(config.recordingId);
  }

  console.log(LOG, 'Requesting display media', config.mode, 'frameRate', config.frameRate);
  let desktopStream: MediaStream;
  try {
    desktopStream = await navigator.mediaDevices.getDisplayMedia({
      // ideal (not exact) — a hint the OS/browser tries to honor, not a hard
      // requirement that would fail capture on a display that can't hit it.
      video: { displaySurface: displaySurfaceFor(config.mode), frameRate: config.frameRate ? { ideal: config.frameRate } : undefined },
      audio: false,
    });
  } catch (err) {
    // Tag which capture call actually failed — "Invalid state"-style
    // DOMExceptions are otherwise indistinguishable between this and the
    // mic-audio call from the caller's point of view.
    throw new Error(`getDisplayMedia failed: ${describeError(err)}`);
  }
  console.log(LOG, 'Display media stream acquired', desktopStream.getVideoTracks().length, 'video track(s)');
  const desktopTrack = desktopStream.getVideoTracks()[0];
  // Everything that owns real hardware/capture and needs .stop() on cleanup
  // — starts with the desktop track; webcam (if acquired) and mic tracks are
  // pushed on below. Kept separate from `recorderVideoTrack`/`recorderTracks`
  // (what MediaRecorder actually records), since compositing swaps in a
  // synthetic canvas track as the recorder's video source while the real
  // desktop/webcam tracks still need to be stopped directly (the desktop
  // track in particular is also what the native "Stop sharing" listener
  // below is attached to).
  const tracks = [desktopTrack];

  let micTrack: MediaStreamTrack | undefined;
  if (config.mic) {
    console.log(LOG, 'Requesting mic audio via getUserMedia');
    let micStream: MediaStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      throw new Error(`mic-audio getUserMedia failed: ${describeError(err)}`);
    }
    console.log(LOG, 'Mic stream acquired', micStream.getAudioTracks().length, 'audio track(s)');
    micTrack = micStream.getAudioTracks()[0];
    tracks.push(micTrack);
  }

  // Webcam is best-effort: a permission denial, no camera present, or any
  // other getUserMedia/compositor failure here must never block or fail the
  // recording — screen (+ mic) still records exactly as it would with Cam
  // off. Only a genuine success sets `compositor`, which is what makes
  // MediaRecorder use the composited canvas as its video source instead of
  // the raw desktop track.
  let compositor: WebcamCompositor | undefined;
  let camTrack: MediaStreamTrack | undefined;
  if (config.cam) {
    console.log(LOG, '*** Webcam requested (config.cam=true) — attempting getUserMedia');
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      camTrack = camStream.getVideoTracks()[0];
      tracks.push(camTrack);
      console.log(LOG, '*** Webcam getUserMedia succeeded — starting compositor', { corner: config.webcamCorner });
      compositor = await startWebcamCompositor(
        desktopStream,
        camStream,
        config.webcamCorner ?? 'bottom-right',
        config.frameRate ?? 30,
      );
      console.log(LOG, '*** Webcam compositor started successfully');
    } catch (err) {
      // Logged with name/message explicitly (not just describeError's
      // combined string) so a permission dismissal is unmistakable in the
      // offscreen document's own console (chrome://extensions → QuickCast →
      // Inspect views → offscreen.html) — this is the exact same failure
      // mode Phase 1 hit for the mic (an invisible page can't show a
      // permission prompt, so Chrome silently dismisses it), now fixed the
      // same way: the popup requests camera permission first, in a visible
      // page, before this ever runs.
      console.warn(LOG, '*** Webcam getUserMedia/compositor failed — continuing with screen-only recording', {
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      });
      compositor = undefined;
      camTrack = undefined;
    }
  } else {
    console.log(LOG, 'Webcam not requested (config.cam=false)');
  }

  const recorderVideoTrack = compositor ? compositor.stream.getVideoTracks()[0] : desktopTrack;
  const recorderTracks = [recorderVideoTrack, ...(micTrack ? [micTrack] : [])];

  const combined = new MediaStream(recorderTracks);
  const recorder = new MediaRecorder(combined, {
    mimeType: 'video/webm;codecs=vp9,opus',
    // Resolved by background.ts from Settings' Recording defaults (quality
    // dropdown → bitrate — see lib/preferences.ts's bitrateForQuality) —
    // falls back to the old fixed default only if somehow unset.
    videoBitsPerSecond: config.videoBitsPerSecond ?? 2_500_000,
  });
  console.log(
    LOG,
    'MediaRecorder created',
    recorder.mimeType,
    'videoBitsPerSecond',
    config.videoBitsPerSecond ?? 2_500_000,
    'webcamComposited',
    Boolean(compositor),
  );

  const session: Session = {
    config,
    tracks,
    compositor,
    camTrack,
    recorder,
    chunkIndex: 0,
    endingByUs: false,
    driveAuth,
    uploadDisabled: !driveAuth,
    uploadDisabledReason: driveAuth ? undefined : 'No account connected',
    uploadedBytes: 0,
    pendingBlobs: [],
    pendingBytes: 0,
    uploadChain: Promise.resolve(),
    speedSamples: [],
    lastProgressSentAt: 0,
  };

  if (driveAuth) {
    console.log(LOG, 'Calling initiateResumableUpload()', { accountId: driveAuth.accountId, folderId });
    try {
      // folderId is resolved (and cached per account) by background.ts before
      // this message is sent — this document can't read chrome.storage.local
      // itself to do that caching. Undefined falls back to Drive's root,
      // same as before folder organization existed.
      session.sessionUri = await initiateResumableUpload(driveAuth, fileNameFor(config), folderId ? [folderId] : undefined);
      console.log(LOG, 'Resumable upload session initiated successfully', session.sessionUri);
    } catch (err) {
      // Never block the recording itself on Drive being unavailable — the
      // local IndexedDB copy (written below regardless) is the fallback.
      const reason = describeError(err);
      console.error(LOG, '*** initiateResumableUpload() threw:', err);
      session.uploadDisabled = true;
      session.uploadDisabledReason = `Failed to start Drive upload: ${reason}`;
    }
  }

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      console.log(LOG, 'Chunk received', session.chunkIndex, event.data.size, 'bytes');
      void addChunk(config.recordingId, session.chunkIndex++, event.data);
      if (!session.uploadDisabled) {
        session.pendingBlobs.push(event.data);
        session.pendingBytes += event.data.size;
        // Reported here, not just from inside drainUpload/uploadWithRetry —
        // drainUpload only actually PUTs once pendingBytes crosses
        // MIN_UPLOAD_CHUNK_BYTES (2MB), so a short recording that never
        // reaches that threshold before Stop would otherwise never send a
        // single offscreen:upload-progress message. The widget would then
        // stay on its "Not uploading" (no-data-yet) fallback for the entire
        // recording, indistinguishable from upload actually being disabled.
        sendProgress(session);
        void enqueueUploadDrain(session, { final: false });
      }
    }
  };
  recorder.onerror = (event) => {
    console.error(LOG, 'MediaRecorder error', event);
  };

  // Fires when the user clicks Chrome's native "Stop sharing" bar instead of
  // our own widget's Stop button — without this, that would just silently end
  // the stream with nothing saved. stopTracks() sets endingByUs = true before
  // our own Stop/Cancel flow ends this same track, so this only reacts to a
  // genuinely external end.
  desktopTrack.addEventListener('ended', () => {
    if (session.endingByUs) return;
    console.log(LOG, 'Desktop track ended externally (native Stop sharing likely used)', config.recordingId);
    void (async () => {
      await stopAndSave(config.recordingId);
      chrome.runtime.sendMessage({ type: 'offscreen:ended', recordingId: config.recordingId });
    })();
  });

  sessions.set(config.recordingId, session);
  console.log(LOG, 'Session prepared', config.recordingId);
}

function begin(recordingId: string): number {
  const session = sessions.get(recordingId);
  if (!session) throw new Error('no active session');
  const startedAt = Date.now();
  session.recorder.start(1000);
  console.log(LOG, 'Recorder started', recordingId, 'at', startedAt);
  // Reported here (rather than from prepare(), where the disable decision is
  // actually made) because the widget only mounts and starts listening once
  // widget:ensure-state arrives, moments after prepare() runs — a message
  // sent that early would have no listener yet and be silently dropped. By
  // the time begin() runs the countdown has already finished (the widget
  // itself just sent widget:countdown-done), so it's guaranteed to be alive.
  if (session.uploadDisabledReason) {
    sendUploadDisabled(recordingId, session.uploadDisabledReason);
  }
  return startedAt;
}

function pause(recordingId: string) {
  sessions.get(recordingId)?.recorder.pause();
}

function resume(recordingId: string) {
  sessions.get(recordingId)?.recorder.resume();
}

function stopTracks(session: Session) {
  session.endingByUs = true;
  session.tracks.forEach((track) => track.stop());
  // Stops the requestAnimationFrame draw loop and the composited canvas
  // track — must happen alongside the real tracks above, not left running
  // after the desktop/webcam streams it draws from are already stopped.
  session.compositor?.stop();
}

// User closed the on-screen webcam bubble mid-recording (see
// WidgetWebcamCloseClickedMessage) — stops just the camera (turns off the
// light) and drops it from the composited video for the rest of the
// recording; screen capture and the rest of the session are unaffected.
function stopWebcam(recordingId: string): void {
  const session = sessions.get(recordingId);
  if (!session) return;
  session.compositor?.disableWebcam();
  session.camTrack?.stop();
}

async function waitForStop(recorder: MediaRecorder): Promise<void> {
  if (recorder.state === 'inactive') return;
  await new Promise<void>((resolve) => {
    recorder.addEventListener('stop', () => resolve(), { once: true });
    recorder.stop();
  });
}

// Runs the (potentially long — minutes, if a lot was still buffered)
// post-Stop Drive flush independently of stopAndSave()'s own return, then
// tells background it's safe to close this offscreen document now. This is
// NOT awaited by stopAndSave()/the offscreen:stop message handler: an MV3
// service worker isn't guaranteed to stay alive for as long as a large
// remaining buffer might take to upload, and if background's await chain
// (and the message channel back to the widget) outlives the worker's actual
// lifetime, the whole thing breaks with "message channel closed before a
// response was received" — which is exactly what surfaced the underlying
// problem here. Keeping this work entirely inside the offscreen document
// (an ordinary page, not subject to that lifetime limit) and only notifying
// background once it's truly done sidesteps that entirely.
async function finalizeUploadThenNotify(session: Session): Promise<void> {
  await finalizeUpload(session);
  console.log(LOG, 'Post-stop Drive flush finished (or gave up)', session.config.recordingId, 'fileId:', session.fileId);
  const message: OffscreenUploadFinishedMessage = {
    type: 'offscreen:upload-finished',
    recordingId: session.config.recordingId,
    fileId: session.fileId,
  };
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

// Hands the full local recording off to background.ts (see
// OffscreenBlobReadyMessage) so the share screen can play it back instantly
// while Drive is still transcoding, instead of leaving it stuck on Drive's
// own "still processing" preview state for however long that takes. Must run
// before deleteRecording() below clears the IndexedDB chunks it reads from.
async function sendBlobToBackground(recordingId: string): Promise<void> {
  // Timed end-to-end (not just logged as separate steps) so a slow run shows
  // exactly where the time went — reading a long recording's chunks back out
  // of IndexedDB and assembling them into one Blob is the actual bottleneck
  // for a multi-minute recording, confirmed against BLOB_REQUEST_TIMEOUT_MS
  // (background.ts) being too short for a real ~7 minute recording.
  const startedAt = performance.now();
  try {
    console.log(LOG, 'Reading recorded chunks from IndexedDB for instant local playback', recordingId);
    const chunks = await getChunks(recordingId);
    const readMs = Math.round(performance.now() - startedAt);
    console.log(LOG, 'Read', chunks.length, 'chunk(s) from IndexedDB in', readMs, 'ms', recordingId);
    if (chunks.length === 0) return;
    // MediaRecorder's dataavailable Blobs all share its actual recording
    // mimeType (e.g. 'video/webm;codecs=vp9,opus') — reading it directly off
    // the first chunk rather than hardcoding a plain 'video/webm' (a
    // regression from this function's own earlier refactor, when the
    // intermediate `new Blob(chunks)` this used to come from was removed for
    // speed) means the reconstructed Blob's type actually matches what was
    // recorded, which the codec-agnostic hardcoded string didn't.
    const mimeType = chunks[0].type || 'video/webm';
    console.log(LOG, 'Recorded chunk mimeType', recordingId, mimeType);
    const assembleStartedAt = performance.now();
    // Converts every chunk's own ArrayBuffer concurrently (Promise.all)
    // rather than the slower `new Blob(chunks).arrayBuffer()` two-step,
    // which serializes the whole conversion into one pass over the fully
    // reassembled Blob instead of letting the browser run per-chunk
    // conversions in parallel. Sent to background as an array of per-chunk
    // buffers (not manually concatenated into one here) — background.ts
    // reconstructs via `new Blob(chunkArrayBuffers, { type })`, the same
    // multi-part Blob construction this project's download fallback already
    // relies on, rather than a hand-rolled byte-copy reassembly with no
    // equivalent proven to work elsewhere in this codebase. See
    // OffscreenBlobReadyMessage's own comment for why an ArrayBuffer (not a
    // bare Blob) is what actually crosses this message boundary.
    const chunkArrayBuffers = await Promise.all(chunks.map((chunk) => chunk.arrayBuffer()));
    const totalBytes = chunkArrayBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
    const assembleMs = Math.round(performance.now() - assembleStartedAt);
    console.log(LOG, 'Converted', chunkArrayBuffers.length, 'chunk(s) to ArrayBuffer, totaling', totalBytes, 'bytes, in', assembleMs, 'ms — sending to background');
    const sendStartedAt = performance.now();
    const message: OffscreenBlobReadyMessage = { type: 'offscreen:blob-ready', recordingId, chunkArrayBuffers, mimeType };
    const response = await chrome.runtime.sendMessage(message);
    const sendMs = Math.round(performance.now() - sendStartedAt);
    const totalMs = Math.round(performance.now() - startedAt);
    console.log(LOG, 'offscreen:blob-ready acked by background', recordingId, response, `(send took ${sendMs}ms, total ${totalMs}ms)`);
  } catch (err) {
    // Instant local playback is a nice-to-have on top of the existing
    // Drive-preview flow, not something the rest of Stop should ever block or
    // fail on.
    console.warn(LOG, 'Failed to hand off local recording blob for instant playback', describeError(err));
  }
}

async function stopAndSave(recordingId: string): Promise<void> {
  const session = sessions.get(recordingId);
  if (!session) return;

  await waitForStop(session.recorder);
  stopTracks(session);

  // Deliberately not awaited — see finalizeUploadThenNotify's comment.
  void finalizeUploadThenNotify(session);

  await sendBlobToBackground(recordingId);

  // No automatic local download here — the user downloads on demand from the
  // share screen's Download button instead (which falls back to fetching
  // from Drive via alt=media once this IndexedDB copy is gone, per
  // lib/idb.ts's deleteRecording call right below).
  await deleteRecording(recordingId);
  sessions.delete(recordingId);
}

async function cancel(recordingId: string): Promise<void> {
  const session = sessions.get(recordingId);
  if (!session) return;

  await waitForStop(session.recorder);
  stopTracks(session);

  // Best-effort: tell Drive to abandon the incomplete resumable session so it
  // doesn't linger. Not required for correctness (an unfinished resumable
  // session expires on its own), so a failure here is not worth surfacing.
  if (session.sessionUri && session.driveAuth) {
    driveFetchWithAuth(session.driveAuth, session.sessionUri, { method: 'DELETE' }).catch(() => undefined);
  }

  await deleteRecording(recordingId);
  sessions.delete(recordingId);
}

type IncomingMessage =
  | OffscreenPrepareMessage
  | OffscreenBeginMessage
  | OffscreenPauseMessage
  | OffscreenResumeMessage
  | OffscreenStopMessage
  | OffscreenCancelMessage
  | OffscreenWebcamStopMessage;

chrome.runtime.onMessage.addListener((message: IncomingMessage, _sender, sendResponse) => {
  console.log(LOG, 'Received message', message.type);
  (async () => {
    switch (message.type) {
      case 'offscreen:prepare':
        try {
          await prepare(message.config, message.driveAuth, message.folderId);
          sendResponse({ success: true });
        } catch (err) {
          console.error(LOG, 'prepare() failed', err);
          sendResponse({ success: false, message: describeError(err) });
        }
        break;
      case 'offscreen:begin':
        try {
          const startedAt = begin(message.recordingId);
          sendResponse({ success: true, startedAt });
        } catch (err) {
          console.error(LOG, 'begin() failed', err);
          sendResponse({ success: false, message: describeError(err) });
        }
        break;
      case 'offscreen:pause':
        pause(message.recordingId);
        sendResponse({ success: true });
        break;
      case 'offscreen:resume':
        resume(message.recordingId);
        sendResponse({ success: true });
        break;
      case 'offscreen:stop':
        await stopAndSave(message.recordingId);
        sendResponse({ success: true });
        break;
      case 'offscreen:cancel':
        await cancel(message.recordingId);
        sendResponse({ success: true });
        break;
      case 'offscreen:webcam-stop':
        stopWebcam(message.recordingId);
        sendResponse({ success: true });
        break;
    }
  })();
  return true;
});

// Broadcast an immediate health update the moment connectivity changes,
// rather than waiting for the next upload attempt to notice — the retry loop
// itself (see uploadWithRetry) still handles actually resuming the upload.
window.addEventListener('offline', () => {
  for (const session of sessions.values()) sendProgress(session, { force: true });
});
window.addEventListener('online', () => {
  for (const session of sessions.values()) sendProgress(session, { force: true });
});
