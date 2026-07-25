import { createRoot, type Root } from 'react-dom/client';
import { IconCloud, IconCloudCheck, IconCloudOff, IconLoader2, IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconTrash } from '@tabler/icons-react';
import type { UploadHealth, UploadProgress } from '@/types/recording';
import { formatBytes, formatElapsed, formatEta, formatSpeed } from '@/lib/format';
import { useRecordingPillState, type RecordingPhase } from '@/lib/use-recording-pill-state';
import { useDraggablePosition } from '@/lib/use-draggable-position';

// Round 16: a plain-inline-styles variant of RecordingWidget, used only on
// the original recording tab. After 15 rounds of CSS/timing fixes to the
// Tailwind-classed RecordingWidget never made it appear on
// support.buddyboss.com — while WebcamBubble, mounted through the exact same
// shadow-DOM/wrapper mechanism on the exact same tab, keeps rendering fine —
// the one thing never directly isolated is whether a global rule on that
// page conflicts with one of RecordingWidget's Tailwind utility classes
// specifically (WebcamBubble still uses a few of its own, so it was never a
// clean control). This component carries zero classNames and mounts with no
// external stylesheet at all (see mountRecordingPill's call site in
// entrypoints/content/index.ts) — every visual property is an explicit
// inline CSSProperties value, so nothing outside this file's own JSX can
// affect its appearance short of a page directly overriding element-level
// inline styles.
//
// State/message-handling lives in lib/use-recording-pill-state.ts, shared
// with RecordingWidget (components/recording-widget.tsx) — the two
// components only need to differ in how they render, not in how they track
// state.

// Own storage key, separate from RecordingWidget's — only one of the two
// components is ever mounted per tab (see isOriginalTab in
// entrypoints/content/index.ts), but keeping them independent avoids one
// dragging the other's pill next time it mounts.
const PILL_POSITION_STORAGE_KEY = 'quickcast:pill-position';

const HEALTH_COLOR: Record<UploadHealth, string> = {
  synced: '#10b981',
  green: '#10b981',
  amber: '#f59e0b',
  red: '#ef4444',
  offline: '#ef4444',
};

function UploadStatus({ progress, disabledReason }: { progress: UploadProgress | null; disabledReason: string | null }) {
  if (disabledReason) {
    return (
      <>
        <IconCloudOff size={13} stroke={1.75} color="#ef4444" />
        <span style={{ fontSize: 11, color: '#ef4444' }}>Not uploading — {disabledReason}</span>
      </>
    );
  }
  if (!progress) {
    return <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>Not uploading</span>;
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
      <Icon size={13} stroke={1.75} color={HEALTH_COLOR[progress.health]} />
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>{label}</span>
    </>
  );
}

export interface RecordingPillProps {
  recordingId: string;
  initialPhase?: RecordingPhase;
  initialStartedAt?: number;
  initialUploadProgress?: UploadProgress | null;
  initialUploadDisabledReason?: string | null;
}

export function RecordingPill({
  recordingId,
  initialPhase,
  initialStartedAt,
  initialUploadProgress,
  initialUploadDisabledReason,
}: RecordingPillProps) {
  const { phase, elapsed, uploadProgress, uploadDisabledReason, stopping, onPauseClick, onResumeClick, onStopClick, onCancelClick } = useRecordingPillState({
    recordingId,
    initialPhase,
    initialStartedAt,
    initialUploadProgress,
    initialUploadDisabledReason,
    logPrefix: '[QuickCast][pill]',
  });
  const { position, onPointerDown, onPointerMove, onPointerUp } = useDraggablePosition(PILL_POSITION_STORAGE_KEY);

  // TEMPORARY — pill-visibility investigation. Remove once resolved. Fires
  // on every render, including the first — distinguishes "React never
  // rendered this" from "rendered but not visible on screen."
  console.log('[QC-DIAG][pill] RecordingPill rendering', { phase, elapsed, position });

  const buttonStyle = (disabled: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    padding: 0,
    margin: 0,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    color: '#ffffff',
  });

  // Anchors to the viewport's bottom-left via `bottom` (self-correcting on
  // any screen size, unlike a one-time top calculation from
  // window.innerHeight) until the user actually drags it — same approach as
  // RecordingWidget's own positioning.
  const rootStyle: React.CSSProperties = {
    position: 'fixed',
    ...(position ? { left: position.left, top: position.top } : { left: 16, bottom: 16 }),
    zIndex: 2147483647,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    borderRadius: 9999,
    backgroundColor: '#1a1d24',
    color: '#ffffff',
    padding: '8px 12px',
    boxShadow: '0 10px 25px rgba(0,0,0,0.35)',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    userSelect: 'none',
    pointerEvents: 'auto',
    width: 'max-content',
    height: 'max-content',
    cursor: 'grab',
  };

  return (
    <div
      data-quickcast-root="true"
      style={rootStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Local, self-contained keyframes for the Stop spinner — the only
          animation this component needs, and inlining it here (rather than
          reaching for Tailwind's animate-spin) keeps this file's "no external
          CSS dependency" guarantee intact. */}
      <style>{'@keyframes quickcastPillSpin { to { transform: rotate(360deg); } }'}</style>
      <span
        style={{
          height: 8,
          width: 8,
          borderRadius: 9999,
          backgroundColor: '#ef4444',
          opacity: phase === 'recording' ? 1 : 0.5,
          flexShrink: 0,
        }}
      />
      <span style={{ fontFamily: 'monospace', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{formatElapsed(elapsed)}</span>
      <span style={{ height: 12, width: 1, backgroundColor: 'rgba(255,255,255,0.2)', flexShrink: 0 }} />
      <UploadStatus progress={uploadProgress} disabledReason={uploadDisabledReason} />
      <span style={{ height: 12, width: 1, backgroundColor: 'rgba(255,255,255,0.2)', flexShrink: 0 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {phase === 'recording' ? (
          <button type="button" title="Pause" disabled={stopping} style={buttonStyle(stopping)} onClick={onPauseClick}>
            <IconPlayerPause size={14} stroke={1.75} />
          </button>
        ) : (
          <button type="button" title="Resume" disabled={stopping} style={buttonStyle(stopping)} onClick={onResumeClick}>
            <IconPlayerPlay size={14} stroke={1.75} />
          </button>
        )}
        <button type="button" title={stopping ? 'Stopping…' : 'Stop'} disabled={stopping} style={buttonStyle(stopping)} onClick={onStopClick}>
          {stopping ? <IconLoader2 size={14} stroke={1.75} style={{ animation: 'quickcastPillSpin 1s linear infinite' }} /> : <IconPlayerStop size={14} stroke={1.75} />}
        </button>
        <button type="button" title="Cancel" disabled={stopping} style={buttonStyle(stopping)} onClick={onCancelClick}>
          <IconTrash size={14} stroke={1.75} />
        </button>
      </div>
    </div>
  );
}

export function mountRecordingPill(container: HTMLElement, props: RecordingPillProps): Root {
  // TEMPORARY — pill-visibility investigation. Remove once resolved.
  console.log('[QC-DIAG][pill] mountRecordingPill() called', {
    recordingId: props.recordingId,
    initialPhase: props.initialPhase,
    containerConnected: container.isConnected,
    containerTagName: container.tagName,
  });
  const root = createRoot(container);
  root.render(<RecordingPill {...props} />);
  console.log('[QC-DIAG][pill] mountRecordingPill() — root.render() called (React commit is async; this does not confirm paint)');
  return root;
}
