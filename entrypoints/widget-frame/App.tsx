import { useEffect, useRef, useState } from 'react';
import { IconPlayerPause, IconPlayerPlay, IconPlayerStop } from '@tabler/icons-react';
import type { WidgetFrameStateMessage, WidgetFrameToParentMessage } from '@/lib/widget-frame-messaging';

// Last-resort fallback for a page whose own CSS/DOM environment defeats the
// normal shadow-DOM widget (see entrypoints/content/index.ts's
// watchWidgetVisibility and activateIframeFallback) — this page runs as a
// genuinely separate browsing context (an <iframe>, its own window/document),
// so nothing about the host page's CSS can reach in and hide it the way it
// apparently can for content injected directly into the host page's own DOM.
// Deliberately minimal compared to components/recording-widget.tsx: no
// drag-to-reposition, no upload-progress detail. Just enough to show the
// recording is happening and let the user Pause/Resume/Stop it.
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function postToParent(message: WidgetFrameToParentMessage): void {
  window.parent.postMessage(message, '*');
}

export default function App() {
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [phase, setPhase] = useState<'recording' | 'paused'>('recording');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const recordingIdRef = useRef<string | null>(null);
  recordingIdRef.current = recordingId;

  // Tells the parent frame this page is ready to receive state — sent
  // repeatedly for the first few seconds rather than once, in case the
  // parent's own listener attaches a moment after this iframe's `load`
  // event already fired (the two frames' script execution isn't
  // synchronized any more tightly than that).
  useEffect(() => {
    const ready: WidgetFrameToParentMessage = { source: 'quickcast-widget-frame', type: 'ready' };
    postToParent(ready);
    const interval = setInterval(() => postToParent(ready), 300);
    const timeout = setTimeout(() => clearInterval(interval), 3000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const message = event.data as WidgetFrameStateMessage | { source?: string };
      if (!message || message.source !== 'quickcast-parent') return;
      const state = message as WidgetFrameStateMessage;
      if (state.type !== 'state') return;
      setRecordingId(state.recordingId);
      setPhase(state.phase);
      setStartedAt(state.startedAt ?? null);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (phase !== 'recording' || startedAt === null) return;
    setElapsed(Date.now() - startedAt);
    const interval = setInterval(() => setElapsed(Date.now() - startedAt), 250);
    return () => clearInterval(interval);
  }, [phase, startedAt]);

  if (recordingId === null) return null;

  return (
    <div
      className="flex select-none items-center gap-3 rounded-full bg-[#1a1d24] px-5 py-3.5 font-sans text-white shadow-lg"
      style={{ position: 'fixed', left: 16, bottom: 16, width: 'max-content', height: 'max-content' }}
    >
      <span className={`h-2.5 w-2.5 rounded-full bg-[#ef4444] ${phase === 'recording' ? 'animate-pulse' : ''}`} />
      <span className="font-mono text-sm tabular-nums">{formatElapsed(elapsed)}</span>
      <span className="h-4 w-px bg-white/20" />
      <div className="flex items-center gap-2">
        {phase === 'recording' ? (
          <button
            type="button"
            title="Pause"
            disabled={stopping}
            className="disabled:opacity-40"
            onClick={() => {
              setPhase('paused');
              if (recordingIdRef.current) postToParent({ source: 'quickcast-widget-frame', type: 'pause-clicked', recordingId: recordingIdRef.current });
            }}
          >
            <IconPlayerPause size={17} stroke={1.75} />
          </button>
        ) : (
          <button
            type="button"
            title="Resume"
            disabled={stopping}
            className="disabled:opacity-40"
            onClick={() => {
              setPhase('recording');
              if (recordingIdRef.current) postToParent({ source: 'quickcast-widget-frame', type: 'resume-clicked', recordingId: recordingIdRef.current });
            }}
          >
            <IconPlayerPlay size={17} stroke={1.75} />
          </button>
        )}
        <button
          type="button"
          title="Stop"
          disabled={stopping}
          className="disabled:opacity-40"
          onClick={() => {
            setStopping(true);
            if (recordingIdRef.current) postToParent({ source: 'quickcast-widget-frame', type: 'stop-clicked', recordingId: recordingIdRef.current });
          }}
        >
          <IconPlayerStop size={17} stroke={1.75} />
        </button>
      </div>
    </div>
  );
}
