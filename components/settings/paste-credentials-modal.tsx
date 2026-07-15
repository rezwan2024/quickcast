import { useState } from 'react';
import { IconKey, IconCloudCheck, IconInfoCircle } from '@tabler/icons-react';
import { Modal, ModalHeader } from '@/components/modal';
import { Input } from '@/components/input';
import { Button } from '@/components/button';
import { validateCredentials } from '@/lib/oauth';
import type { AccountCredentials } from '@/types/account';

interface PasteCredentialsModalProps {
  onClose: () => void;
  onReopenGuide: () => void;
  onSubmit: (credentials: AccountCredentials) => Promise<void>;
}

export function PasteCredentialsModal({ onClose, onReopenGuide, onSubmit }: PasteCredentialsModalProps) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  async function handleSubmit() {
    const validationError = validateCredentials(clientId);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setConnecting(true);
    try {
      await onSubmit({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
      });
      // On success, the parent closes this modal itself — nothing left to do here.
    } catch (err) {
      console.error('[QuickCast][settings] Connect and authorize failed', err);
      setError(err instanceof Error ? err.message : 'Something went wrong connecting this account.');
      setConnecting(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <ModalHeader icon={<IconKey size={20} stroke={1.75} />} title="Paste your credentials" onClose={onClose} />
      <div className="space-y-4 px-5 py-5">
        <p className="text-sm text-[#666]">
          Paste the Client ID (and Secret, if your OAuth client has one) from Google Cloud. Stored locally, never sent
          anywhere except Google's own OAuth endpoints.
        </p>

        <Input
          label="Client ID"
          monospace
          placeholder="1234567890-abc...apps.googleusercontent.com"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
        <Input
          label="Client Secret · optional"
          monospace
          type="password"
          placeholder="Required for Web application clients. Leave empty for Chrome Extension clients."
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
        />
        {error && <p className="text-xs text-[#ef4444]">{error}</p>}
        {error && error.toLowerCase().includes('drive access') && (
          <div className="flex items-start gap-2 rounded-lg bg-[#f5f5f4] px-3 py-2.5 text-xs text-[#666]">
            <IconInfoCircle size={16} stroke={1.75} className="mt-0.5 shrink-0 text-[#3b82f6]" />
            If this is a personal Gmail account and authorization fails with a scope error, go back to your Google
            Cloud project → Data Access → Add or remove scopes → add drive.file.
          </div>
        )}

        <div className="flex items-start gap-2 rounded-lg bg-[#f5f5f4] px-3 py-2.5 text-xs text-[#666]">
          <IconInfoCircle size={16} stroke={1.75} className="mt-0.5 shrink-0 text-[#3b82f6]" />
          Make sure to select the Google account that owns your Google Cloud project when the sign-in popup appears.
        </div>

        <Button
          icon={<IconCloudCheck size={18} stroke={1.75} />}
          disabled={connecting}
          onClick={handleSubmit}
          className="w-full"
        >
          {connecting ? 'Connecting…' : 'Connect and authorize'}
        </Button>

        <button type="button" onClick={onReopenGuide} className="mx-auto block text-xs text-[#666] underline">
          Need help? Reopen setup guide
        </button>
      </div>
    </Modal>
  );
}
