import { useCallback, useRef, useState } from 'react';
import { IconCircleCheck, IconAlertCircle } from '@tabler/icons-react';

export type ToastVariant = 'error' | 'success';

interface ToastState {
  message: string;
  variant: ToastVariant;
}

const AUTO_DISMISS_MS = 4000;

// Shared across popup/settings/share so error/success feedback looks and
// behaves the same everywhere, rather than each page growing its own
// one-off toast. Timer id is kept in a ref (not state) — showToast can be
// called again before the previous auto-dismiss fires (e.g. two failures
// back to back), and only one timer should ever be pending at a time.
export function useToast(): { toast: ToastState | null; showToast: (message: string, variant?: ToastVariant) => void; dismiss: () => void } {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast(null);
  }, []);

  const showToast = useCallback((message: string, variant: ToastVariant = 'error') => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, variant });
    timerRef.current = setTimeout(() => setToast(null), AUTO_DISMISS_MS);
  }, []);

  return { toast, showToast, dismiss };
}

interface ToastHostProps {
  toast: { message: string; variant: ToastVariant } | null;
  onDismiss: () => void;
}

export function ToastHost({ toast, onDismiss }: ToastHostProps) {
  if (!toast) return null;
  const isError = toast.variant === 'error';
  return (
    <div className="fixed top-4 left-1/2 z-50 -translate-x-1/2 px-4">
      <button
        type="button"
        onClick={onDismiss}
        className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-white shadow-lg ${
          isError ? 'bg-[#ef4444]' : 'bg-[#10b981]'
        }`}
      >
        {isError ? (
          <IconAlertCircle size={16} stroke={1.75} />
        ) : (
          <IconCircleCheck size={16} stroke={1.75} />
        )}
        {toast.message}
      </button>
    </div>
  );
}
