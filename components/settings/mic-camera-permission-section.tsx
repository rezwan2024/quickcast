import { useState } from 'react';
import { IconCheck, IconMicrophone, IconCamera } from '@tabler/icons-react';

interface MicCameraPermissionSectionProps {
  onError: (message: string) => void;
}

type GrantState = 'idle' | 'granted' | 'denied';

// Requesting getUserMedia from the popup can silently fail with
// NotAllowedError and no prompt at all, even when Chrome's own site
// permission and the OS's microphone privacy setting are both already
// clean — a real, observed Chrome limitation with browser-action popups
// (a small, transient surface) rather than a QuickCast bug. This page is a
// normal, persistent tab, which reliably shows Chrome's native permission
// prompt. The grant is per-origin, not per-page, so granting it here makes
// every later getUserMedia call from the popup, the offscreen document, and
// the content script succeed silently — this only ever needs to run once.
async function requestAndRelease(constraints: MediaStreamConstraints): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  stream.getTracks().forEach((track) => track.stop());
}

export function MicCameraPermissionSection({ onError }: MicCameraPermissionSectionProps) {
  const [micState, setMicState] = useState<GrantState>('idle');
  const [camState, setCamState] = useState<GrantState>('idle');

  async function handleGrantMic() {
    try {
      await requestAndRelease({ audio: true });
      setMicState('granted');
    } catch (err) {
      setMicState('denied');
      onError(err instanceof Error ? `Microphone: ${err.message || err.name}` : 'Microphone access failed.');
    }
  }

  async function handleGrantCam() {
    try {
      await requestAndRelease({ video: true, audio: false });
      setCamState('granted');
    } catch (err) {
      setCamState('denied');
      onError(err instanceof Error ? `Camera: ${err.message || err.name}` : 'Camera access failed.');
    }
  }

  return (
    <section className="mt-8">
      <span className="text-xs font-medium tracking-wide text-[#999] uppercase">Microphone & camera access</span>
      <p className="mt-1 text-xs text-[#666]">
        If Start recording shows a mic/camera error with no permission popup ever appearing, grant access here
        instead — this page can show Chrome's prompt reliably, unlike the small popup. A one-time grant here covers
        every recording after.
      </p>
      <div className="mt-2 space-y-2">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[#e5e5e5] px-4 py-3">
          <div className="flex items-center gap-2">
            <IconMicrophone size={18} stroke={1.75} className="text-[#666]" />
            <span className="text-sm font-medium text-[#1a1d24]">Microphone</span>
          </div>
          {micState === 'granted' ? (
            <span className="flex items-center gap-1 text-xs font-medium text-[#16a34a]">
              <IconCheck size={16} stroke={2} /> Granted
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void handleGrantMic()}
              className="rounded-md bg-[#1a1d24] px-3 py-1.5 text-xs font-medium text-white"
            >
              Grant access
            </button>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[#e5e5e5] px-4 py-3">
          <div className="flex items-center gap-2">
            <IconCamera size={18} stroke={1.75} className="text-[#666]" />
            <span className="text-sm font-medium text-[#1a1d24]">Camera</span>
          </div>
          {camState === 'granted' ? (
            <span className="flex items-center gap-1 text-xs font-medium text-[#16a34a]">
              <IconCheck size={16} stroke={2} /> Granted
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void handleGrantCam()}
              className="rounded-md bg-[#1a1d24] px-3 py-1.5 text-xs font-medium text-white"
            >
              Grant access
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
