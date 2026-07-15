import type { ReactNode } from 'react';
import { IconX } from '@tabler/icons-react';

interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  widthClassName?: string;
}

export function Modal({ onClose, children, widthClassName = 'max-w-[420px]' }: ModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      {/* Capped to the viewport height and laid out as a column so a long
          modal (e.g. the setup guide's OAuth-consent step) doesn't grow past
          the screen with no way to reach its own header/footer or the rest
          of its content — overflow-hidden here keeps the rounded corners
          intact; whichever child actually needs to scroll (see e.g.
          setup-guide-modal.tsx's body div) gets its own flex-1 overflow-y-auto. */}
      <div
        className={`flex max-h-[90vh] w-full flex-col overflow-hidden rounded-xl bg-white shadow-xl ${widthClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

interface ModalHeaderProps {
  icon: ReactNode;
  title: string;
  onClose: () => void;
  rightSlot?: ReactNode;
}

export function ModalHeader({ icon, title, onClose, rightSlot }: ModalHeaderProps) {
  return (
    <div className="flex items-center justify-between border-b border-[#e5e5e5] px-5 py-4">
      <div className="flex items-center gap-2 text-[#1a1d24]">
        {icon}
        <span className="text-base font-medium">{title}</span>
      </div>
      <div className="flex items-center gap-3">
        {rightSlot}
        <button type="button" onClick={onClose} className="text-[#999] hover:text-[#666]">
          <IconX size={18} stroke={1.75} />
        </button>
      </div>
    </div>
  );
}
