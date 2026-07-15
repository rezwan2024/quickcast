import { useEffect, useState } from 'react';
import type {
  WidgetClosedMessage,
  WidgetCountdownDoneMessage,
  WidgetPausedMessage,
  WidgetRecordingStartedMessage,
  WidgetResumedMessage,
  WidgetUploadDisabledMessage,
  WidgetUploadProgressMessage,
} from '@/lib/messaging';
import type { UploadProgress } from '@/types/recording';

// Shared by RecordingWidget and RecordingPill (round 18) — the two
// components only need to differ in how they render (Tailwind classes vs.
// inline styles, for the Tailwind-conflict isolation from round 16), not in
// how they track state or handle messages. Pulling all of that here means a
// future behavior change (a new upload-health state, a change to how Stop
// works) only needs to be made once, instead of drifting between two
// hand-copied implementations.
export type RecordingPhase = 'countdown' | 'recording' | 'paused';

export interface UseRecordingPillStateProps {
  recordingId: string;
  countdownSeconds: number;
  initialPhase?: RecordingPhase;
  initialStartedAt?: number;
  initialUploadProgress?: UploadProgress | null;
  initialUploadDisabledReason?: string | null;
  // Distinguishes RecordingWidget's console output from RecordingPill's —
  // both mount through the same handleEnsureState call site in
  // entrypoints/content/index.ts, and telling their logs apart has mattered
  // directly in this project's own bug history (see progress.md rounds
  // 9-16).
  logPrefix: '[QuickCast][widget]' | '[QuickCast][pill]';
}

export interface UseRecordingPillStateResult {
  phase: RecordingPhase;
  countdown: number;
  elapsed: number;
  uploadProgress: UploadProgress | null;
  uploadDisabledReason: string | null;
  stopping: boolean;
  onPauseClick: () => void;
  onResumeClick: () => void;
  onStopClick: () => void;
  onCancelClick: () => void;
}

function sendToBackground(logPrefix: string, message: unknown): void {
  console.log(`${logPrefix} Sending message`, message);
  void chrome.runtime.sendMessage(message);
}

export function useRecordingPillState({
  recordingId,
  countdownSeconds,
  initialPhase,
  initialStartedAt,
  initialUploadProgress,
  initialUploadDisabledReason,
  logPrefix,
}: UseRecordingPillStateProps): UseRecordingPillStateResult {
  const [phase, setPhase] = useState<RecordingPhase>(initialPhase ?? 'countdown');
  const [countdown, setCountdown] = useState(countdownSeconds);
  const [startedAt, setStartedAt] = useState<number | null>(initialStartedAt ?? null);
  const [elapsed, setElapsed] = useState(initialStartedAt ? Date.now() - initialStartedAt : 0);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(initialUploadProgress ?? null);
  const [uploadDisabledReason, setUploadDisabledReason] = useState<string | null>(initialUploadDisabledReason ?? null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    console.log(`${logPrefix} Widget mounted for recording`, recordingId);
  }, [recordingId, logPrefix]);

  useEffect(() => {
    // A widget/pill ensured after the recording already started mounts
    // directly in 'recording'/'paused' with countdownSeconds: 0 — it never
    // actually ran a countdown, so it must not send widget:countdown-done
    // (that would tell background to call offscreen:begin a second time).
    if (phase !== 'countdown') return;
    if (countdown <= 0) {
      const done: WidgetCountdownDoneMessage = { type: 'widget:countdown-done', recordingId };
      sendToBackground(logPrefix, done);
      return;
    }
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [phase, countdown, recordingId, logPrefix]);

  useEffect(() => {
    function onMessage(
      message: WidgetRecordingStartedMessage | WidgetPausedMessage | WidgetResumedMessage | WidgetClosedMessage | WidgetUploadProgressMessage | WidgetUploadDisabledMessage | { type: string },
    ) {
      console.log(`${logPrefix} *** onMessage received`, message.type, message);
      if (message.type === 'widget:recording-started') {
        const msg = message as WidgetRecordingStartedMessage;
        setPhase('recording');
        setStartedAt(msg.startedAt);
      } else if (message.type === 'widget:paused') {
        // Broadcast from background whenever Pause is clicked on *any* tab
        // (see handlePauseClicked) — every tab, not just the one that was
        // clicked, needs to reflect the new phase.
        setPhase('paused');
      } else if (message.type === 'widget:resumed') {
        setPhase('recording');
      } else if (message.type === 'widget:close') {
        setPhase('countdown');
      } else if (message.type === 'widget:upload-progress') {
        const msg = message as WidgetUploadProgressMessage;
        setUploadProgress({
          uploadedBytes: msg.uploadedBytes,
          bufferedBytes: msg.bufferedBytes,
          speedBytesPerSec: msg.speedBytesPerSec,
          health: msg.health,
        });
      } else if (message.type === 'widget:upload-disabled') {
        setUploadDisabledReason((message as WidgetUploadDisabledMessage).reason);
      }
    }
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [logPrefix]);

  useEffect(() => {
    if (phase !== 'recording' || startedAt === null) return;
    const interval = setInterval(() => setElapsed(Date.now() - startedAt), 250);
    return () => clearInterval(interval);
  }, [phase, startedAt]);

  return {
    phase,
    countdown,
    elapsed,
    uploadProgress,
    uploadDisabledReason,
    stopping,
    onPauseClick: () => {
      setPhase('paused');
      sendToBackground(logPrefix, { type: 'widget:pause-clicked', recordingId });
    },
    onResumeClick: () => {
      setPhase('recording');
      sendToBackground(logPrefix, { type: 'widget:resume-clicked', recordingId });
    },
    onStopClick: () => {
      console.log(`${logPrefix} *** Stop button onClick fired`, { recordingId, alreadyStopping: stopping });
      setStopping(true);
      sendToBackground(logPrefix, { type: 'widget:stop-clicked', recordingId });
    },
    onCancelClick: () => {
      setStopping(true);
      sendToBackground(logPrefix, { type: 'widget:cancel-clicked', recordingId });
    },
  };
}
