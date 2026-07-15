import { createRoot, type Root } from 'react-dom/client';
import { IconCloud, IconCloudCheck, IconCloudOff, IconLoader2, IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconTrash } from '@tabler/icons-react';
import type { UploadHealth, UploadProgress } from '@/types/recording';
import { formatBytes, formatElapsed, formatEta, formatSpeed } from '@/lib/format';
import { useRecordingPillState, type RecordingPhase } from '@/lib/use-recording-pill-state';
import { useDraggablePosition } from '@/lib/use-draggable-position';

// Reverted back to a content-script shadow-DOM overlay in the recorded tab
// (matching how this worked before an attempt to use chrome.windows.create
// for a persistent-across-tabs widget window) — that approach caused Chrome
// to steal focus and switch away from the recorded tab on macOS, which is
// worse than the original limitation (the widget only being visible on the
// tab being recorded). Switching tabs during a recording now simply means
// the widget isn't visible until switching back — an accepted tradeoff.
//
// State/message-handling lives in lib/use-recording-pill-state.ts, shared
// with RecordingPill (components/recording-pill.tsx) — the two components
// only need to differ in how they render (Tailwind classes here vs.
// RecordingPill's inline styles, for the Tailwind-conflict isolation from
// round 16), not in how they track state.

const POSITION_STORAGE_KEY = 'quickcast:widget-position';

const HEALTH_COLOR: Record<UploadHealth, string> = {
  synced: 'text-[#10b981]',
  green: 'text-[#10b981]',
  amber: 'text-[#f59e0b]',
  red: 'text-[#ef4444]',
  offline: 'text-[#ef4444]',
};

function UploadStatus({ progress, disabledReason }: { progress: UploadProgress | null; disabledReason: string | null }) {
  if (disabledReason) {
    return (
      <>
        <IconCloudOff size={13} stroke={1.75} className="text-[#ef4444]" />
        <span className="text-[11px] text-[#ef4444]">Not uploading — {disabledReason}</span>
      </>
    );
  }
  if (!progress) {
    return <span className="text-[11px] text-white/60">Not uploading</span>;
  }

  const Icon = progress.health === 'offline' ? IconCloudOff : progress.health === 'synced' ? IconCloudCheck : IconCloud;
  const totalBytes = progress.uploadedBytes + progress.bufferedBytes;
  const etaSeconds = progress.speedBytesPerSec > 0 ? progress.bufferedBytes / progress.speedBytesPerSec : 0;

  let label: string;
  if (progress.health === 'offline') {
    label = 'Offline — will resume automatically';
  } else if (progress.bufferedBytes === 0) {
    label = `${formatBytes(progress.uploadedBytes)} uploaded`;
  } else {
    label = `${formatBytes(progress.uploadedBytes)} / ${formatBytes(totalBytes)} · ${formatSpeed(progress.speedBytesPerSec)} · ~${formatEta(etaSeconds)} after stop`;
  }

  return (
    <>
      <Icon size={13} stroke={1.75} className={HEALTH_COLOR[progress.health]} />
      <span className="text-[11px] text-white/60">{label}</span>
    </>
  );
}

interface WidgetProps {
  recordingId: string;
  countdownSeconds: number;
  // Set when mounting into a tab already past the countdown (see
  // widget:ensure-state in entrypoints/content/index.ts) — skips the
  // countdown and starts already reflecting the recording's real state
  // instead of a fresh countdown/zeroed timer/no upload status.
  initialPhase?: RecordingPhase;
  initialStartedAt?: number;
  initialUploadProgress?: UploadProgress | null;
  initialUploadDisabledReason?: string | null;
}

function RecordingWidget({
  recordingId,
  countdownSeconds,
  initialPhase,
  initialStartedAt,
  initialUploadProgress,
  initialUploadDisabledReason,
}: WidgetProps) {
  const { phase, countdown, elapsed, uploadProgress, uploadDisabledReason, stopping, onPauseClick, onResumeClick, onStopClick, onCancelClick } = useRecordingPillState({
    recordingId,
    countdownSeconds,
    initialPhase,
    initialStartedAt,
    initialUploadProgress,
    initialUploadDisabledReason,
    logPrefix: '[QuickCast][widget]',
  });
  const { position, onPointerDown, onPointerMove, onPointerUp } = useDraggablePosition(POSITION_STORAGE_KEY);

  // A large, impossible-to-miss overlay — distinct from the compact pill used
  // once recording actually starts. The previous version showed the countdown
  // as small inline text inside the same small pill, which was easy to miss
  // entirely while Chrome's own native source-picker/share-indicator are also
  // competing for attention at that exact moment.
  if (phase === 'countdown') {
    return (
      <div
        data-quickcast-root="true"
        className="fixed inset-0 flex items-center justify-center bg-black/50 font-sans"
        style={{ zIndex: 2147483647, pointerEvents: 'auto' }}
      >
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-36 w-36 items-center justify-center rounded-full bg-[#1a1d24] shadow-2xl">
            <span key={countdown} className="animate-quickcast-countdown-pop text-7xl font-bold text-white tabular-nums">
              {countdown}
            </span>
          </div>
          <p className="text-lg font-medium text-white">Recording starts in {countdown}…</p>
        </div>
      </div>
    );
  }

  // Default anchors to the viewport's bottom-left using `bottom`, not a
  // `top` computed from window.innerHeight — position: fixed with `bottom`
  // is already viewport-relative and self-correcting on any screen size or
  // page height, unlike a one-time top calculation. Only a position the
  // user has actually dragged to (loaded from chrome.storage.local above)
  // switches this to top/left tracking.
  const style: React.CSSProperties = position
    ? { position: 'fixed', left: position.left, top: position.top, zIndex: 2147483647, width: 'max-content', height: 'max-content', pointerEvents: 'auto' }
    : { position: 'fixed', left: 16, bottom: 16, zIndex: 2147483647, width: 'max-content', height: 'max-content', pointerEvents: 'auto' };

  return (
    <div
      data-quickcast-root="true"
      style={style}
      className="flex select-none items-center gap-2 rounded-full bg-[#1a1d24] px-3 py-2 font-sans text-white shadow-lg"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      // Runs in the bubble phase, after the Pause/Stop/Cancel buttons' own
      // onClick has already fired — this only stops the click from
      // continuing on to the host page, it never blocks our own handlers.
      onClick={(e) => e.stopPropagation()}
    >
      <span className={`h-2 w-2 rounded-full bg-[#ef4444] ${phase === 'recording' ? 'animate-pulse' : ''}`} />
      <span className="font-mono text-xs tabular-nums">{formatElapsed(elapsed)}</span>
      <span className="h-3 w-px bg-white/20" />
      <UploadStatus progress={uploadProgress} disabledReason={uploadDisabledReason} />
      <span className="h-3 w-px bg-white/20" />
      <div className="flex items-center gap-1.5">
        {phase === 'recording' ? (
          <button type="button" title="Pause" disabled={stopping} className="disabled:opacity-40" onClick={onPauseClick}>
            <IconPlayerPause size={14} stroke={1.75} />
          </button>
        ) : (
          <button type="button" title="Resume" disabled={stopping} className="disabled:opacity-40" onClick={onResumeClick}>
            <IconPlayerPlay size={14} stroke={1.75} />
          </button>
        )}
        <button type="button" title={stopping ? 'Stopping…' : 'Stop'} disabled={stopping} className="disabled:opacity-40" onClick={onStopClick}>
          {stopping ? <IconLoader2 size={14} stroke={1.75} className="animate-spin" /> : <IconPlayerStop size={14} stroke={1.75} />}
        </button>
        <button type="button" title="Cancel" disabled={stopping} className="disabled:opacity-40" onClick={onCancelClick}>
          <IconTrash size={14} stroke={1.75} />
        </button>
      </div>
    </div>
  );
}

export function mountRecordingWidget(container: HTMLElement, props: WidgetProps): Root {
  const root = createRoot(container);
  root.render(<RecordingWidget {...props} />);
  return root;
}
