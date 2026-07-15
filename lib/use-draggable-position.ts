import { useEffect, useRef, useState } from 'react';

// Shared by RecordingWidget and RecordingPill (round 18) — identical
// pointer-drag mechanics, parameterized only by the chrome.storage.local key
// each uses to persist its own position (the two components never mount on
// the same tab at once, but keeping their saved positions independent avoids
// one dragging the other's pill next time it mounts).
export interface DraggablePosition {
  left: number;
  top: number;
}

export interface UseDraggablePositionResult {
  position: DraggablePosition | null;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export function useDraggablePosition(storageKey: string): UseDraggablePositionResult {
  const [position, setPosition] = useState<DraggablePosition | null>(null);
  const dragState = useRef<{ dragging: boolean; offsetX: number; offsetY: number }>({
    dragging: false,
    offsetX: 0,
    offsetY: 0,
  });

  useEffect(() => {
    chrome.storage.local.get(storageKey).then((stored) => {
      const saved = stored[storageKey] as DraggablePosition | undefined;
      // Guards against an older stored shape ({x, y}) — a stale value like
      // that would otherwise render at left/top undefined instead of
      // falling back to the default position.
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        setPosition(saved);
      }
    });
  }, [storageKey]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Stops the click/drag from bubbling out into the host page's own
    // document/window listeners — a busy page's own global click-away or
    // focus-management listener can otherwise swallow the very first
    // interaction with our overlay.
    e.stopPropagation();
    // Don't start a drag when the press originates on a button — otherwise
    // every click also nudges the pill by a pixel or two from the
    // inevitable tiny mouse movement during a click.
    if ((e.target as HTMLElement).closest('button')) return;
    // Prevents the browser's own native text-selection/drag gesture from
    // starting alongside our pointer-based reposition below.
    e.preventDefault();
    // Before the first-ever drag, the pill is positioned by its default
    // CSS (bottom/left), not by `position` state — measuring its actual
    // rendered box here means the switch to top/left-tracked dragging never
    // causes a jump.
    if (!position) {
      const rect = e.currentTarget.getBoundingClientRect();
      setPosition({ left: rect.left, top: rect.top });
    }
    dragState.current = { dragging: true, offsetX: e.clientX, offsetY: e.clientY };
    // Pointer capture keeps delivering move/up events to this element even
    // when the cursor moves faster than the pill can track.
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (!dragState.current.dragging) return;
    e.preventDefault();
    const dx = e.clientX - dragState.current.offsetX;
    const dy = e.clientY - dragState.current.offsetY;
    dragState.current.offsetX = e.clientX;
    dragState.current.offsetY = e.clientY;
    setPosition((prev) => {
      const base = prev ?? { left: 16, top: window.innerHeight - 16 };
      return { left: base.left + dx, top: base.top + dy };
    });
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (!dragState.current.dragging) return;
    dragState.current.dragging = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setPosition((current) => {
      if (current) void chrome.storage.local.set({ [storageKey]: current });
      return current;
    });
  }

  return { position, onPointerDown, onPointerMove, onPointerUp };
}
