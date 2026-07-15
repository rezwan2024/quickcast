import { useEffect, useState } from 'react';
import { IconArrowLeft, IconCheck, IconCopy } from '@tabler/icons-react';
import { getAllAccounts } from '@/lib/accounts-storage';
import { driveUrlWithAuthuser, findRootRecordingsFolderId } from '@/lib/drive';
import { formatRelativeTime } from '@/lib/format';
import { getRecentRecordings, type RecentRecording } from '@/lib/recent-recordings';
import { useToast, ToastHost } from '@/components/toast';

const LOG = '[QuickCast][popup]';

interface HistoryPanelProps {
  onBack: () => void;
}

export function HistoryPanel({ onBack }: HistoryPanelProps) {
  const [recordings, setRecordings] = useState<RecentRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const { toast, showToast, dismiss: dismissToast } = useToast();

  useEffect(() => {
    getRecentRecordings().then((list) => {
      setRecordings(list);
      setLoading(false);
    });
  }, []);

  async function handleCopy(recording: RecentRecording) {
    if (!recording.shareLink) return;
    await navigator.clipboard.writeText(recording.shareLink);
    setCopiedId(recording.recordingId);
    showToast('Link copied!', 'success');
    setTimeout(() => setCopiedId((id) => (id === recording.recordingId ? null : id)), 1500);
  }

  // Opens the recordings folder for the default account — requirements.md
  // §7. Falls back to plain Drive (not an error) if this account has never
  // uploaded a recording yet (no folder exists) or the lookup itself fails.
  // ?authuser={email} (see lib/drive.ts's driveUrlWithAuthuser) makes sure
  // this opens in the *default account's* own Drive, not whichever Google
  // account the browser profile happens to be signed into by default.
  async function handleViewAllInDrive() {
    const accounts = Object.values(await getAllAccounts());
    const defaultAccount = accounts.find((a) => a.isDefault) ?? accounts[0];
    if (!defaultAccount) {
      chrome.tabs.create({ url: 'https://drive.google.com/drive/my-drive' });
      return;
    }
    try {
      const folderId = await findRootRecordingsFolderId(defaultAccount.id);
      chrome.tabs.create({
        url: folderId
          ? driveUrlWithAuthuser(`/drive/folders/${folderId}`, defaultAccount.email)
          : driveUrlWithAuthuser('/drive/my-drive', defaultAccount.email),
      });
    } catch (err) {
      console.error(LOG, 'Failed to look up the recordings folder', err);
      chrome.tabs.create({ url: driveUrlWithAuthuser('/drive/my-drive', defaultAccount.email) });
    }
  }

  return (
    <div className="w-[340px] bg-white">
      <header className="flex items-center gap-3 border-b border-[#e5e5e5] px-4 py-3">
        <button type="button" onClick={onBack} className="text-[#666]">
          <IconArrowLeft size={18} stroke={1.75} />
        </button>
        <span className="text-base font-semibold text-[#1a1d24]">Recent recordings</span>
      </header>

      <div className="max-h-[380px] overflow-y-auto px-4 py-3">
        {loading ? (
          <p className="py-8 text-center text-sm text-[#999]">Loading…</p>
        ) : recordings.length === 0 ? (
          <p className="py-10 text-center text-sm text-[#999]">
            No recordings yet.
            <br />
            Start recording to see your history here.
          </p>
        ) : (
          <div className="space-y-2">
            {recordings.map((recording) => (
              <div
                key={recording.recordingId}
                className="flex items-center justify-between gap-2 rounded-lg border border-[#e5e5e5] px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[#1a1d24]">
                    {recording.title.trim() || new Date(recording.timestamp).toLocaleString()}
                  </p>
                  <p className="truncate text-xs text-[#999]">
                    {formatRelativeTime(recording.timestamp)} · {recording.accountEmail}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy(recording)}
                  disabled={!recording.shareLink}
                  title={recording.shareLink ? 'Copy link' : 'Still uploading…'}
                  className="shrink-0 text-[#3b82f6] disabled:text-[#999] disabled:opacity-50"
                >
                  {copiedId === recording.recordingId ? (
                    <IconCheck size={16} stroke={1.75} className="text-[#10b981]" />
                  ) : (
                    <IconCopy size={16} stroke={1.75} />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-[#e5e5e5] px-4 py-3">
        <button type="button" onClick={handleViewAllInDrive} className="mx-auto block text-sm font-medium text-[#3b82f6] underline">
          View all in Drive →
        </button>
      </div>

      <ToastHost toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
