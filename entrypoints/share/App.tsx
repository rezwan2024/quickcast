import { useEffect, useMemo, useState } from 'react';
import { IconCircleCheck, IconLoader2, IconAlertTriangle, IconDownload, IconCopy } from '@tabler/icons-react';
import { Input } from '@/components/input';
import { downloadFileMedia, getFileMetadata, getVideoMediaMetadata, renameFile } from '@/lib/drive';
import { getChunks } from '@/lib/idb';
import type { ShareUploadFailedMessage, ShareUploadProgressMessage, ShareUploadReadyMessage } from '@/lib/messaging';
import { getUploadResult } from '@/lib/upload-results';
import { useToast, ToastHost } from '@/components/toast';
import { formatBytes, formatSpeed } from '@/lib/format';
import type { UploadProgress } from '@/types/recording';

const LOG = '[QuickCast][share]';

// "Ready in 644s" is meaningless at a glance — this reads naturally for both
// the common case (a handful of seconds) and the case where a lot was still
// buffered at Stop time (per Phase 3's share-screen-opens-on-upload-finished
// design, that can legitimately take minutes).
function formatReadyIn(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const recordingId = params.get('recordingId') ?? '';
  const accountId = params.get('accountId') ?? '';
  const recordedAtIso = params.get('recordedAt') ?? new Date().toISOString();
  const durationMs = Number(params.get('durationMs') ?? 0);

  // The share screen opens immediately on Stop, before the Drive flush
  // necessarily finishes (see entrypoints/background.ts's
  // openPendingShareScreen) — fileId may not be in the URL yet. If it's
  // missing, `pending` from the URL says whether background is still going
  // to push it here (see the message listener below) or whether there's
  // genuinely nothing to wait for.
  const [fileId, setFileId] = useState(params.get('fileId') ?? '');
  const [pending, setPending] = useState(!params.get('fileId') && params.get('pending') === '1');
  const [uploadFailed, setUploadFailed] = useState(false);

  const [title, setTitle] = useState(params.get('title') ?? '');
  const [link, setLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [readySeconds, setReadySeconds] = useState<number | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  // Bumped by the "Retry preview" button below to force the iframe to
  // remount (React keys off this) — Drive's own /preview player has no way
  // to tell this parent page when it's actually ready, so a manual retry is
  // the only recovery available short of a full page reload.
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const { toast, showToast, dismiss: dismissToast } = useToast();

  // Loom-style instant playback: the locally-recorded blob (handed off to
  // background.ts right after Stop — see OffscreenBlobReadyMessage) plays
  // immediately instead of waiting on Drive's transcode. `driveSynced` flips
  // once polling (below) confirms Drive has finished processing, at which
  // point the preview swaps over to Drive's own player and this blob: URL is
  // released.
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);
  const [driveSynced, setDriveSynced] = useState(false);
  // True from mount until the local-blob request settles (found or not) —
  // assembling a long recording's blob in offscreen.ts can take several
  // seconds, during which the preview box would otherwise just sit black.
  const [localBlobLoading, setLocalBlobLoading] = useState(true);

  // Requests the local blob on mount — not a one-time thing tied to Stop,
  // since this tab can be closed and reopened after the recording ended (see
  // ShareRequestLocalBlobMessage's own comment). URL.createObjectURL() is
  // deliberately called here, in this long-lived tab, rather than in
  // background.ts or the offscreen document — a blob: URL is only valid for
  // as long as the context that created it is alive, and both of those can
  // be torn down (service worker idle timeout; offscreen document closes
  // once upload finishes) well before this tab does.
  useEffect(() => {
    if (!recordingId) {
      setLocalBlobLoading(false);
      return;
    }
    let cancelled = false;
    console.log(LOG, 'Requesting local recording blob for instant playback', recordingId);
    chrome.runtime
      .sendMessage({ type: 'share:request-local-blob', recordingId })
      // A bare Blob doesn't survive chrome.runtime.sendMessage's structured
      // clone between the service worker and this page (confirmed live —
      // it arrived as `undefined`) — background.ts sends an ArrayBuffer +
      // mimeType instead (which does survive), reconstructed into a real
      // Blob here before handing it to URL.createObjectURL().
      .then((response: { arrayBuffer: ArrayBuffer | null; mimeType?: string } | undefined) => {
        console.log(LOG, 'share:request-local-blob response', recordingId, response?.arrayBuffer ? `${response.arrayBuffer.byteLength} bytes` : response?.arrayBuffer);
        if (cancelled) return;
        if (response?.arrayBuffer) {
          const blob = new Blob([response.arrayBuffer], { type: response.mimeType });
          const objectUrl = URL.createObjectURL(blob);
          console.log(LOG, 'Local video blob: URL created, handing to <video>', objectUrl, blob.size, 'bytes', blob.type);
          setLocalVideoUrl(objectUrl);
        }
      })
      .catch((err: unknown) => console.warn(LOG, 'Failed to fetch local recording blob for instant playback', err))
      .finally(() => {
        if (!cancelled) setLocalBlobLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [recordingId]);

  // Polls Drive every 5s once a fileId exists, until videoMediaMetadata shows
  // up (transcode finished) — see lib/drive.ts's getVideoMediaMetadata. Capped
  // at MAX_POLL_ATTEMPTS as a safety net against a runaway timer, not because
  // this wait is ever expected to take that long.
  useEffect(() => {
    if (!fileId || driveSynced) return;
    let cancelled = false;
    let attempts = 0;
    const MAX_POLL_ATTEMPTS = 240; // ~20 minutes at 5s intervals
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      attempts++;
      try {
        const ready = await getVideoMediaMetadata(accountId, fileId);
        if (ready) {
          if (!cancelled) setDriveSynced(true);
          return;
        }
      } catch (err) {
        console.warn(LOG, 'videoMediaMetadata poll failed', err);
      }
      if (!cancelled && attempts < MAX_POLL_ATTEMPTS) {
        timer = setTimeout(poll, 5000);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fileId, driveSynced, accountId]);

  // Once synced, the local blob is no longer needed — release it here (the
  // context that created the URL) and tell background.ts to drop it from its
  // Map. Also runs on unmount so a share tab closed before sync doesn't leak
  // a blob: URL indefinitely.
  useEffect(() => {
    return () => {
      if (localVideoUrl) URL.revokeObjectURL(localVideoUrl);
    };
  }, [localVideoUrl]);

  useEffect(() => {
    if (!driveSynced || !recordingId) return;
    setLocalVideoUrl(null);
    chrome.runtime.sendMessage({ type: 'share:blob-done', recordingId }).catch(() => undefined);
    // Confirmed root cause of "video doesn't play after Drive sync without a
    // manual reload": once driveSynced flips true, the <iframe> JSX below is
    // structurally identical to what it already rendered during the
    // not-yet-synced fallback state (same key, same src) — React reuses that
    // existing iframe element rather than remounting it, so the browser
    // never re-fetches Drive's /preview document and keeps showing whatever
    // it served the first time (Drive's "still processing" content). Bumping
    // previewReloadKey here forces a real remount, the same mechanism the
    // "Retry preview" button already uses.
    setPreviewReloadKey((k) => k + 1);
  }, [driveSynced, recordingId]);

  // Single source of truth for what the preview box shows, in strict
  // priority order — computed once per render (not scattered across nested
  // ternaries) so it can be logged directly and reasoned about in one place.
  const previewMode: 'loading' | 'iframe-synced' | 'local-video' | 'iframe-fallback' | 'none' = localBlobLoading
    ? 'loading'
    : driveSynced && fileId
      ? 'iframe-synced'
      : localVideoUrl
        ? 'local-video'
        : fileId
          ? 'iframe-fallback'
          : 'none';

  useEffect(() => {
    console.log(LOG, 'Preview mode ->', previewMode, { localBlobLoading, driveSynced, fileId, hasLocalVideoUrl: Boolean(localVideoUrl) });
  }, [previewMode]);

  const missingParams = !recordingId || !accountId;

  // Listens for background.ts pushing the real outcome once the Drive flush
  // (kicked off before this tab could possibly have the fileId yet) finishes.
  // This alone isn't enough, though: chrome.tabs.sendMessage only reaches
  // whatever onMessage listener happens to be registered at the moment it's
  // sent — if the user refreshes this tab after that message already went
  // out, a fresh listener here would never receive it and would be stuck on
  // "Finishing upload…" forever. The effect below checks chrome.storage.local
  // (which background.ts persists the same outcome to) on every mount to
  // recover from exactly that case.
  useEffect(() => {
    function onMessage(message: ShareUploadReadyMessage | ShareUploadFailedMessage | ShareUploadProgressMessage | { type: string; recordingId?: string }) {
      if (message.recordingId !== recordingId) return;
      if (message.type === 'share:upload-ready') {
        setPending(false);
        setFileId((message as ShareUploadReadyMessage).fileId);
      } else if (message.type === 'share:upload-failed') {
        setPending(false);
        setUploadFailed(true);
      } else if (message.type === 'share:upload-progress') {
        const msg = message as ShareUploadProgressMessage;
        setUploadProgress({
          uploadedBytes: msg.uploadedBytes,
          bufferedBytes: msg.bufferedBytes,
          speedBytesPerSec: msg.speedBytesPerSec,
          health: msg.health,
        });
      }
    }
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [recordingId]);

  useEffect(() => {
    if (!recordingId || fileId) return;
    getUploadResult(recordingId).then((result) => {
      if (!result) return; // upload (still) hasn't finished — keep waiting for the message
      setPending(false);
      if (result.fileId) {
        setFileId(result.fileId);
      } else {
        setUploadFailed(true);
      }
    });
  }, [recordingId, fileId]);

  useEffect(() => {
    if (missingParams || !fileId) return;
    setLoading(true);
    getFileMetadata(accountId, fileId)
      .then(async (meta) => {
        setLink(meta.webViewLink);
        if (!title.trim()) setTitle(meta.name.replace(/\.webm$/, ''));

        // "Ready in Xs" — how long since the user actually clicked Stop
        // (recordedAt + durationMs) until the link is available here.
        const stoppedAtMs = new Date(recordedAtIso).getTime() + durationMs;
        setReadySeconds(Math.max(0, Math.round((Date.now() - stoppedAtMs) / 1000)));

        await navigator.clipboard.writeText(meta.webViewLink).catch((err) => {
          console.warn(LOG, 'Clipboard write failed (browser permission?)', err);
        });
        showToast('Link copied!', 'success');
      })
      .catch((err) => {
        console.error(LOG, 'Failed to load file metadata', err);
        showToast('Could not load this recording from Drive');
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  async function handleTitleBlur() {
    if (!title.trim() || missingParams || !fileId) return;
    try {
      await renameFile(accountId, fileId, `${title.trim()}.webm`);
    } catch (err) {
      console.error(LOG, 'Failed to rename file', err);
      showToast('Could not rename the file in Drive');
    }
  }

  // Only ever triggered by the user clicking this button — there is no
  // automatic download on Stop (see entrypoints/offscreen/main.ts's
  // stopAndSave). Tries the local IndexedDB copy first (rarely still
  // present by the time this screen loads — see lib/idb.ts's deleteRecording
  // call right after Stop), falling back to fetching from Drive.
  async function handleDownload() {
    try {
      const chunks = await getChunks(recordingId);
      if (chunks.length > 0) {
        triggerDownload(new Blob(chunks, { type: 'video/webm' }), `${title.trim() || 'quickcast-recording'}.webm`);
        return;
      }
    } catch (err) {
      console.warn(LOG, 'Local IndexedDB copy unavailable, falling back to Drive', err);
    }
    if (missingParams || !fileId) return;
    try {
      const blob = await downloadFileMedia(accountId, fileId);
      triggerDownload(blob, `${title.trim() || 'quickcast-recording'}.webm`);
    } catch (err) {
      console.error(LOG, 'Download from Drive failed', err);
      showToast('Download failed');
    }
  }

  // bufferedBytes is genuinely "still left to upload," not "not yet
  // recorded" — recording has already stopped by the time this screen
  // exists, so uploadedBytes only grows and bufferedBytes only shrinks from
  // here, making this a valid, monotonically-increasing percentage.
  const totalUploadBytes = uploadProgress ? uploadProgress.uploadedBytes + uploadProgress.bufferedBytes : 0;
  const uploadPercent = uploadProgress && totalUploadBytes > 0 ? Math.min(100, Math.round((uploadProgress.uploadedBytes / totalUploadBytes) * 100)) : null;

  if (missingParams) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white px-6 text-center">
        <p className="text-sm text-[#666]">This share screen was opened without the information it needs. Close this tab and try again.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-[640px] bg-white px-6 py-8">
      <header className="mb-6 flex items-center gap-2">
        {pending ? (
          <IconLoader2 size={24} stroke={1.75} className="animate-spin text-[#3b82f6]" />
        ) : uploadFailed ? (
          <IconAlertTriangle size={24} stroke={1.75} className="text-[#ef4444]" />
        ) : (
          <IconCircleCheck size={24} stroke={1.75} className="text-[#10b981]" />
        )}
        <div>
          <h1 className="text-lg font-semibold text-[#1a1d24]">
            {pending ? 'Finishing upload…' : uploadFailed ? 'Upload failed' : 'Recording ready'}
          </h1>
          {pending && <p className="text-xs text-[#999]">Your recording is still uploading to Drive — this page will update automatically.</p>}
          {uploadFailed && (
            <p className="text-xs text-[#999]">The recording downloaded locally, but couldn't be uploaded to Drive. Check your connection.</p>
          )}
          {!pending && !uploadFailed && readySeconds !== null && (
            <p className="text-xs text-[#999]">Ready in {formatReadyIn(readySeconds)}</p>
          )}
        </div>
      </header>

      {pending && uploadProgress && (
        <div className="mb-6">
          <div className="mb-1 flex items-center justify-between text-xs text-[#999]">
            <span>
              {formatBytes(uploadProgress.uploadedBytes)}
              {totalUploadBytes > 0 ? ` / ${formatBytes(totalUploadBytes)}` : ''}
            </span>
            <span>{formatSpeed(uploadProgress.speedBytesPerSec)}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#eee]">
            <div
              className={`h-full rounded-full bg-[#3b82f6] ${uploadPercent !== null ? '' : 'animate-pulse'}`}
              style={{ width: uploadPercent !== null ? `${uploadPercent}%` : '100%' }}
            />
          </div>
          {uploadPercent !== null && <p className="mt-1 text-right text-xs font-medium text-[#1a1d24]">{uploadPercent}%</p>}
        </div>
      )}

      {/* Plays the local blob instantly, Loom-style, instead of waiting on
          Drive's transcode. Strict priority order via previewMode (computed
          above, logged on every change): loading spinner first (nothing else
          to show yet), then the synced Drive iframe (once driveSynced, the
          local blob is stale/no longer needed — see the cleanup effect
          above), then the local video, then the Drive iframe as a fallback
          if the local blob request settled with nothing to play (e.g.
          background.ts's in-memory copy didn't survive a service worker
          restart), then a generic loader if nothing is known yet at all. An
          extension page can't play a Drive file directly via <video src> —
          cross-origin embedding of Drive's media bytes is blocked — Drive's
          own /preview endpoint (an iframe, same as Drive uses on its own
          site) is what's used for both iframe cases. */}
      <div className="relative mb-1.5 flex items-center justify-center overflow-hidden rounded-xl bg-[#1a1d24]" style={{ aspectRatio: '16 / 9' }}>
        {previewMode === 'loading' ? (
          <div className="flex flex-col items-center gap-2 text-white/70">
            <IconLoader2 size={28} stroke={1.75} className="animate-spin text-[#3b82f6]" />
            <span className="text-xs">Preparing video…</span>
          </div>
        ) : previewMode === 'iframe-synced' || previewMode === 'iframe-fallback' ? (
          <iframe
            // Keyed on fileId + synced/fallback state (not just
            // previewReloadKey) so the transition from iframe-fallback to
            // iframe-synced always remounts fresh regardless of whether the
            // driveSynced effect's own previewReloadKey bump runs first —
            // previewReloadKey is still folded in so the "Retry preview"
            // button's manual remount keeps working within either state.
            key={`drive-preview-${fileId}-${previewMode}-${previewReloadKey}`}
            src={`https://drive.google.com/file/d/${fileId}/preview`}
            className="h-full w-full"
            style={{ border: 'none' }}
            allow="autoplay; fullscreen"
            allowFullScreen
            title="Recording preview"
          />
        ) : previewMode === 'local-video' ? (
          <video
            src={localVideoUrl ?? undefined}
            controls
            autoPlay
            muted
            className="h-full w-full"
            onLoadedMetadata={(e) => console.log(LOG, 'Local video loadedmetadata, duration', e.currentTarget.duration)}
            onError={(e) => {
              // The reassembled Blob failed to actually play (confirmed live
              // — an immediate 'error' event on a fresh recording) — rather
              // than leave a broken, native-error <video> on screen for
              // however long it takes Drive to finish transcoding, fall back
              // to the same iframe used when no local blob was ever
              // available: clearing localVideoUrl flips previewMode to
              // 'iframe-fallback' (if fileId is known) or 'none' otherwise.
              // (revoking the now-unusable blob: URL is already handled by
              // the cleanup effect above, which fires whenever localVideoUrl
              // changes away from a truthy value)
              // The React SyntheticEvent itself doesn't carry the useful
              // part — the underlying MediaError (e.currentTarget.error)
              // does: its numeric `code` (1 aborted / 2 network / 3 decode /
              // 4 src-not-supported) is what actually distinguishes "this
              // format genuinely isn't playable" from a transient/loading
              // issue, which the bare Event object logged before this
              // couldn't tell apart.
              const mediaError = e.currentTarget.error;
              console.error(LOG, 'Local video playback error — falling back to Drive preview', {
                code: mediaError?.code,
                message: mediaError?.message,
              });
              setLocalVideoUrl(null);
            }}
          />
        ) : (
          <IconLoader2 size={32} stroke={1.75} className="animate-spin text-[#3b82f6]" />
        )}
        {driveSynced && (
          <span className="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-xs font-medium text-white">
            <IconCircleCheck size={14} stroke={2} className="text-[#10b981]" />
            Synced to Drive
          </span>
        )}
      </div>

      {/* Only relevant for the fallback iframe (no local blob, not yet
          synced) — Drive's /preview player can show its own "still being
          processed for playback" message for a freshly uploaded file, and
          this parent page has no way to detect that (the iframe is
          cross-origin, its content isn't readable from here), so rather than
          trying to react to it, this note sets the expectation up front and
          offers a manual retry. */}
      {previewMode === 'iframe-fallback' && (
        <p className="mb-5 text-lg text-gray-600">
          Drive can take a minute to finish processing a fresh upload before its preview plays.{' '}
          <button type="button" onClick={() => setPreviewReloadKey((k) => k + 1)} className="text-[#3b82f6] underline">
            Retry preview
          </button>
          {' · '}
          <span className="font-medium text-[#1a1d24]">Your share link and download both work right away regardless.</span>
        </p>
      )}

      <div className="space-y-4">
        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          placeholder="Untitled recording"
        />

        <div>
          <span className="text-xs font-medium tracking-wide text-[#999] uppercase">Share link</span>
          <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-[#e5e5e5] px-3 py-2.5">
            <span className="flex-1 truncate font-mono text-sm text-[#1a1d24]">
              {pending ? 'Uploading…' : loading ? 'Loading…' : (link ?? 'Unavailable')}
            </span>
            <button
              type="button"
              onClick={() => link && navigator.clipboard.writeText(link).then(() => showToast('Link copied!', 'success'))}
              className="text-[#3b82f6] disabled:opacity-50"
              disabled={!link}
              title="Copy link"
            >
              <IconCopy size={16} stroke={1.75} />
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={handleDownload}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#f5f5f4] px-4 py-2.5 text-sm font-medium text-[#1a1d24]"
        >
          <IconDownload size={18} stroke={1.75} />
          Download
        </button>
      </div>

      <ToastHost toast={toast} onDismiss={dismissToast} />
    </div>
  );
}

export default App;
