import { useEffect, useRef, useState } from 'react';
import { IconDotsVertical } from '@tabler/icons-react';
import { formatBytes } from '@/lib/format';
import { driveUrlWithAuthuser, findRootRecordingsFolderId } from '@/lib/drive';
import type { Account } from '@/types/account';

const AVATAR_COLORS = ['bg-[#3b82f6]', 'bg-[#ef4444]', 'bg-[#10b981]', 'bg-[#f59e0b]'];

function storageBarColor(usedFraction: number): string {
  if (usedFraction >= 0.9) return 'bg-[#ef4444]';
  if (usedFraction >= 0.5) return 'bg-[#f59e0b]';
  return 'bg-[#10b981]';
}

interface AccountRowProps {
  account: Account;
  colorIndex: number;
  onSetDefault: () => void;
  onDisconnect: () => void;
}

export function AccountRow({ account, colorIndex, onSetDefault, onDisconnect }: AccountRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Wraps the toggle button *and* the dropdown (see the JSX below) — not
  // just the dropdown alone — so a click back on the three-dot button
  // itself, while the menu is open, counts as "inside" and doesn't fight
  // with the button's own onClick toggle (mousedown would otherwise close
  // it a moment before click reopens it, on every single toggle-off click).
  const menuRef = useRef<HTMLDivElement>(null);
  const quota = account.quota;
  const usedFraction = quota?.limitBytes ? quota.usageBytes / quota.limitBytes : 0;

  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  // Resolved on click, not eagerly — this is a live Drive API lookup (see
  // findRootRecordingsFolderId), no need to pay for it for every account row
  // on every Settings render. Falls back to plain my-drive (still with
  // ?authuser so it opens in the right account) if this account has never
  // uploaded a recording yet, or the lookup itself fails for any reason.
  async function handleViewInDrive() {
    setMenuOpen(false);
    let folderId: string | null = null;
    try {
      folderId = await findRootRecordingsFolderId(account.id);
    } catch (err) {
      console.warn('[QuickCast][settings] Failed to look up the recordings folder for "View in Drive"', account.email, err);
    }
    const url = folderId
      ? driveUrlWithAuthuser(`/drive/folders/${folderId}`, account.email)
      : driveUrlWithAuthuser('/drive/my-drive', account.email);
    chrome.tabs.create({ url });
  }

  return (
    <div
      className={`relative flex items-center justify-between rounded-xl border px-4 py-3 ${
        account.isDefault ? 'border-[#3b82f6] bg-[#3b82f6]/5' : 'border-[#e5e5e5]'
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-medium text-white ${AVATAR_COLORS[colorIndex % AVATAR_COLORS.length]}`}
        >
          {account.email.charAt(0).toUpperCase()}
        </span>
        <div>
          <p className="text-sm font-medium text-[#1a1d24]">{account.email}</p>
          <p className="text-xs text-[#666]">
            {quota
              ? `${formatBytes(quota.usageBytes)} used of ${quota.limitBytes ? formatBytes(quota.limitBytes) : 'unlimited'}`
              : 'Storage unknown'}
            {' · '}
            {account.workspaceType === 'workspace' ? 'Workspace' : 'Personal'}
          </p>
          {quota?.limitBytes && (
            <div className="mt-1.5 h-1 w-40 overflow-hidden rounded-full bg-[#e5e5e5]">
              <div
                className={`h-full ${storageBarColor(usedFraction)}`}
                style={{ width: `${Math.min(usedFraction * 100, 100)}%` }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        {account.isDefault && (
          <span className="rounded-full bg-[#3b82f6] px-2.5 py-1 text-xs font-medium text-white">Default</span>
        )}
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className="text-[#999] hover:text-[#666]"
          >
            <IconDotsVertical size={18} stroke={1.75} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 z-10 mt-1 w-44 rounded-lg border border-[#e5e5e5] bg-white py-1 text-sm shadow-lg">
              {!account.isDefault && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onSetDefault();
                  }}
                  className="block w-full px-3 py-2 text-left text-[#1a1d24] hover:bg-[#f5f5f4]"
                >
                  Set as default
                </button>
              )}
              <button
                type="button"
                onClick={handleViewInDrive}
                className="block w-full px-3 py-2 text-left text-[#1a1d24] hover:bg-[#f5f5f4]"
              >
                View in Drive
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDisconnect();
                }}
                className="block w-full px-3 py-2 text-left text-[#ef4444] hover:bg-[#f5f5f4]"
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
