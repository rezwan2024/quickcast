import { IconCloudPlus, IconInfoCircle, IconArrowRight, IconCheck, IconBook2 } from '@tabler/icons-react';
import { Modal, ModalHeader } from '@/components/modal';

interface ConnectModalProps {
  onClose: () => void;
  onHaveCredentials: () => void;
  onNeedGuide: () => void;
}

export function ConnectModal({ onClose, onHaveCredentials, onNeedGuide }: ConnectModalProps) {
  return (
    <Modal onClose={onClose}>
      <ModalHeader
        icon={<IconCloudPlus size={20} stroke={1.75} />}
        title="Connect a Google Drive account"
        onClose={onClose}
      />
      <div className="space-y-3 px-5 py-5">
        <p className="text-sm text-[#666]">Do you already have Google Cloud OAuth credentials for this account?</p>

        <button
          type="button"
          onClick={onHaveCredentials}
          className="flex w-full items-center justify-between gap-3 rounded-xl border border-[#e5e5e5] px-4 py-3 text-left"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#10b981]/15 text-[#10b981]">
              <IconCheck size={16} stroke={2} />
            </span>
            <div>
              <p className="text-sm font-medium text-[#1a1d24]">Yes, I have credentials</p>
              <p className="text-xs text-[#666]">I've already set up a Google Cloud project. Take me to paste the Client ID and Secret.</p>
            </div>
          </div>
          <IconArrowRight size={18} stroke={1.75} className="shrink-0 text-[#999]" />
        </button>

        <button
          type="button"
          onClick={onNeedGuide}
          className="flex w-full items-center justify-between gap-3 rounded-xl border border-[#3b82f6] bg-[#3b82f6]/10 px-4 py-3 text-left"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-[#3b82f6]">
              <IconBook2 size={16} stroke={1.75} />
            </span>
            <div>
              <p className="text-sm font-medium text-[#3b82f6]">No, show me how to get them</p>
              <p className="text-xs text-[#3b82f6]">Walk me through creating a Google Cloud project. Takes about 5 minutes, one-time setup.</p>
            </div>
          </div>
          <IconArrowRight size={18} stroke={1.75} className="shrink-0 text-[#3b82f6]" />
        </button>

        <div className="flex items-start gap-2 rounded-lg bg-[#f5f5f4] px-3 py-2.5 text-xs text-[#666]">
          <IconInfoCircle size={16} stroke={1.75} className="mt-0.5 shrink-0 text-[#3b82f6]" />
          Credentials are stored locally on your device and never sent anywhere else.
        </div>
      </div>
    </Modal>
  );
}
