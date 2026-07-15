import { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IconEye, IconEyeOff, IconX } from '@tabler/icons-react';
import type { WebcamCorner } from '@/lib/preferences';

// A live preview of the content script's *own* camera stream — separate
// from (and unaffected by) the offscreen document's own, independent
// getUserMedia call used to composite the webcam into the actual recorded
// video (see lib/webcam-compositor.ts). A live MediaStreamTrack cannot be
// sent between those two contexts (no such transfer mechanism exists in
// chrome.runtime.sendMessage or any other extension messaging API), so each
// side opens the camera separately: this bubble is purely a same-tab,
// same-permission-grant preview for the user's own on-screen awareness.
const BUBBLE_SIZE = 200;
const HIDDEN_DOT_SIZE = 28;
const MARGIN = 24;

interface WebcamBubbleProps {
  stream: MediaStream;
  corner: WebcamCorner;
  onClose: () => void;
}

function initialCornerStyle(corner: WebcamCorner): React.CSSProperties {
  const vertical = corner.startsWith('top') ? { top: MARGIN } : { bottom: MARGIN };
  const horizontal = corner.endsWith('left') ? { left: MARGIN } : { right: MARGIN };
  return { ...vertical, ...horizontal };
}

export function WebcamBubble({ stream, corner, onClose }: WebcamBubbleProps) {
  const [hidden, setHidden] = useState(false);
  // Drag position is local-only, on purpose — it never affects the
  // composited video's corner, which is fixed at recording start from
  // Settings (see the session brief's explicit requirement).
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragState = useRef<{ dragging: boolean; offsetX: number; offsetY: number }>({ dragging: false, offsetX: 0, offsetY: 0 });

  // Bound once, imperatively — srcObject isn't a React-managed attribute,
  // and the stream reference is stable for the whole life of this bubble
  // (a new stream means a whole new mount, not a prop update).
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Keeps the host page's own global click/pointerdown listeners from
    // ever seeing (and potentially interfering with) interaction with this
    // overlay.
    e.stopPropagation();
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    if (!position && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setPosition({ left: rect.left, top: rect.top });
    }
    dragState.current = { dragging: true, offsetX: e.clientX, offsetY: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (!dragState.current.dragging) return;
    e.preventDefault();
    const dx = e.clientX - dragState.current.offsetX;
    const dy = e.clientY - dragState.current.offsetY;
    dragState.current.offsetX = e.clientX;
    dragState.current.offsetY = e.clientY;
    setPosition((prev) => {
      const base = prev ?? { left: 16, top: 16 };
      return { left: base.left + dx, top: base.top + dy };
    });
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (!dragState.current.dragging) return;
    dragState.current.dragging = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  const size = hidden ? HIDDEN_DOT_SIZE : BUBBLE_SIZE;
  const style: React.CSSProperties = position
    ? { position: 'fixed', left: position.left, top: position.top, zIndex: 2147483647, width: size, height: size, pointerEvents: 'auto' }
    : { position: 'fixed', zIndex: 2147483647, width: size, height: size, pointerEvents: 'auto', ...initialCornerStyle(corner) };

  return (
    <div
      ref={containerRef}
      style={style}
      className="select-none rounded-full font-sans shadow-lg"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Kept mounted (not conditionally rendered) even while hidden=true —
          hiding is purely visual (via the wrapper's own size/overflow
          above), so the underlying <video> element and its srcObject binding
          never get torn down and re-attached, which would otherwise cause a
          visible flash/reload every time the eye button is toggled. */}
      <div className={`h-full w-full overflow-hidden rounded-full border-[3px] border-white bg-[#1a1d24] ${hidden ? 'invisible' : ''}`}>
        <video ref={videoRef} autoPlay muted playsInline className="h-full w-full scale-x-[-1] object-cover" />
      </div>
      {hidden ? (
        <button
          type="button"
          title="Show webcam preview"
          onClick={() => setHidden(false)}
          className="absolute inset-0 flex items-center justify-center rounded-full bg-[#3b82f6]"
        >
          <IconEye size={14} stroke={2} className="text-white" />
        </button>
      ) : (
        <div className="absolute -top-1 -right-1 flex gap-1">
          <button
            type="button"
            title="Hide webcam preview (still recorded)"
            onClick={() => setHidden(true)}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-[#1a1d24] text-white shadow"
          >
            <IconEyeOff size={13} stroke={2} />
          </button>
          <button
            type="button"
            title="Stop webcam"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-[#ef4444] text-white shadow"
          >
            <IconX size={13} stroke={2} />
          </button>
        </div>
      )}
    </div>
  );
}

export function mountWebcamBubble(container: HTMLElement, props: WebcamBubbleProps): Root {
  const root = createRoot(container);
  root.render(<WebcamBubble {...props} />);
  return root;
}
