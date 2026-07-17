import { useEffect, useState } from 'react';
import { IconSettings, IconCloudPlus, IconInfoCircle } from '@tabler/icons-react';
import { AccountRow } from '@/components/settings/account-row';
import { ConnectModal } from '@/components/settings/connect-modal';
import { SetupGuideModal } from '@/components/settings/setup-guide-modal';
import { PasteCredentialsModal } from '@/components/settings/paste-credentials-modal';
import { StorageBehaviorSection } from '@/components/settings/storage-behavior-section';
import { RecordingDefaultsSection } from '@/components/settings/recording-defaults-section';
import { CrossTabPermissionSection } from '@/components/settings/cross-tab-permission-section';
import { MicCameraPermissionSection } from '@/components/settings/mic-camera-permission-section';
import { useToast, ToastHost } from '@/components/toast';
import { getAllAccounts, saveAccount, setDefaultAccount, removeAccount, updateAccount } from '@/lib/accounts-storage';
import { authorizeAccount } from '@/lib/oauth';
import { fetchUserInfo, fetchStorageQuota, fetchStorageQuotaForAccount } from '@/lib/drive';
import {
  getStorageBehavior,
  setStorageBehavior,
  getRecordingDefaults,
  setRecordingDefaults,
  DEFAULT_RECORDING_DEFAULTS,
  type StorageBehavior,
  type RecordingDefaults,
} from '@/lib/preferences';
import type { Account, AccountCredentials } from '@/types/account';

type ModalState = 'none' | 'connect' | 'setup-guide' | 'paste-credentials';

const LOG = '[QuickCast][settings]';

function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>('none');
  const [storageBehavior, setStorageBehaviorState] = useState<StorageBehavior>('default');
  const [recordingDefaults, setRecordingDefaultsState] = useState<RecordingDefaults>(DEFAULT_RECORDING_DEFAULTS);
  const { toast, showToast, dismiss: dismissToast } = useToast();

  async function refreshAccounts(): Promise<Account[]> {
    const stored = await getAllAccounts();
    const list = Object.values(stored).sort((a, b) => a.connectedAt - b.connectedAt);
    setAccounts(list);
    return list;
  }

  // Retries the quota fetch for any account that doesn't have one yet — e.g.
  // if the connect-time fetch in handleAuthorize failed (a token that's
  // momentarily unready right after OAuth, a transient network blip, or a
  // 401 that needed a refresh driveFetch can do but the raw-token
  // fetchStorageQuota used at connect time can't). Runs every time Settings
  // opens, not just once, so a persistently-null quota keeps getting another
  // chance rather than being stuck "Storage unknown" forever.
  async function refetchMissingQuotas(list: Account[]): Promise<void> {
    for (const account of list.filter((a) => a.quota == null)) {
      // Logged before the call, not just on failure — accountId and email
      // together make it unambiguous which stored account's token
      // driveFetch (inside fetchStorageQuotaForAccount) is about to look up
      // and use, so a wrong-account bug (if there ever were one) would show
      // up directly instead of needing to be inferred from a generic error.
      console.log(LOG, `Retrying quota fetch — accountId=${account.id} email=${account.email}`);
      try {
        const quota = await fetchStorageQuotaForAccount(account.id);
        await updateAccount(account.id, { quota });
        console.log(LOG, `Fetched quota for ${account.email} (accountId=${account.id}): ${quota.usageBytes} used of ${quota.limitBytes ?? 'unlimited'} total`);
        setAccounts((prev) => prev.map((a) => (a.id === account.id ? { ...a, quota } : a)));
      } catch (err) {
        // describeDriveError (lib/drive.ts) already folds Google's real
        // status/reason/message into err.message — logging the message
        // explicitly (not just the raw Error object) keeps that visible
        // without needing to expand the console entry.
        console.error(
          LOG,
          `Quota fetch failed — accountId=${account.id} email=${account.email}:`,
          err instanceof Error ? err.message : err,
        );
        showToast(`Couldn't refresh ${account.email}'s Drive access — try disconnecting and reconnecting the account.`);
      }
    }
  }

  useEffect(() => {
    Promise.all([
      refreshAccounts(),
      getStorageBehavior().then(setStorageBehaviorState),
      getRecordingDefaults().then(setRecordingDefaultsState),
    ])
      .then(([list]) => {
        // Not awaited — the account rows already render (with "Storage
        // unknown" for whichever ones are missing a quota) without waiting on
        // this; rows update in place as each fetch resolves.
        void refetchMissingQuotas(list);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleStorageBehaviorChange(behavior: StorageBehavior) {
    setStorageBehaviorState(behavior);
    await setStorageBehavior(behavior);
  }

  async function handleRecordingDefaultsChange(next: RecordingDefaults) {
    setRecordingDefaultsState(next);
    await setRecordingDefaults(next);
  }

  async function handleAuthorize(credentials: AccountCredentials) {
    console.log(LOG, 'Starting authorization flow');
    let tokens, userInfo;
    try {
      tokens = await authorizeAccount(credentials);
      userInfo = await fetchUserInfo(tokens.accessToken);
    } catch (err) {
      // PasteCredentialsModal's own catch shows the detailed inline error
      // (with the scope-fix hint) right next to the form — this toast is
      // just a lighter-weight, page-level echo of the same failure.
      showToast("Couldn't connect that account — check the error below and try again.");
      throw err;
    }
    // Storage quota is a nice-to-have for the account row — don't let a quota
    // fetch failure block the account from being connected. A failure here
    // isn't permanent: refetchMissingQuotas (below) retries it every time
    // Settings opens for as long as the saved account's quota stays null.
    const quota = await fetchStorageQuota(tokens.accessToken)
      .then((q) => {
        console.log(LOG, `Fetched quota for ${userInfo.email}: ${q.usageBytes} used of ${q.limitBytes ?? 'unlimited'} total`);
        return q;
      })
      .catch((err) => {
        console.warn(LOG, `Failed to fetch storage quota for ${userInfo.email} at connect time, continuing without it`, err);
        return null;
      });

    // Dedupe by email (a Google account's email is stable and unique) rather
    // than always minting a new row — re-authorizing the same Google account
    // (e.g. after revoking access, or just re-pasting the same credentials)
    // should refresh that account's tokens/credentials in place, not create a
    // second, confusing duplicate entry for the same inbox.
    const existing = accounts.find((a) => a.email.toLowerCase() === userInfo.email.toLowerCase());
    if (existing) {
      await updateAccount(existing.id, { avatarUrl: userInfo.avatarUrl, workspaceType: userInfo.workspaceType, credentials, tokens, quota });
      console.log(LOG, 'Account already connected — updated tokens/credentials in place', userInfo.email);
    } else {
      const account: Account = {
        id: crypto.randomUUID(),
        email: userInfo.email,
        avatarUrl: userInfo.avatarUrl,
        workspaceType: userInfo.workspaceType,
        isDefault: accounts.length === 0,
        credentials,
        tokens,
        quota,
        connectedAt: Date.now(),
      };
      await saveAccount(account);
      console.log(LOG, 'Account connected', account.email);
    }
    await refreshAccounts();
    setModal('none');
  }

  async function handleSetDefault(id: string) {
    await setDefaultAccount(id);
    await refreshAccounts();
  }

  async function handleDisconnect(account: Account) {
    if (!confirm(`Disconnect ${account.email}? QuickCast will no longer be able to upload to this account.`)) {
      return;
    }
    // Revoke the token with Google too, so the grant doesn't linger in the
    // user's Google Account permissions after disconnecting here. Awaited
    // (but never blocks on failure — local credentials/tokens are cleared
    // either way, see CLAUDE.md: always clear tokens on disconnect) because
    // an immediate reconnect of this same account otherwise races Google's
    // own revoke-propagation against the fresh consent grant: the new
    // token's scopes can read back incomplete via tokeninfo (same class of
    // lag as the first-connect retry below) until the old grant has
    // actually finished being revoked server-side.
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(account.tokens.refreshToken)}`, {
        method: 'POST',
      });
    } catch (err) {
      console.warn(LOG, 'Token revoke request failed (continuing anyway)', err);
    }

    await removeAccount(account.id);
    await refreshAccounts();
  }

  return (
    <div className="mx-auto min-h-screen max-w-[640px] bg-white px-6 py-8">
      <header className="mb-6 flex items-center gap-2 text-[#1a1d24]">
        <IconSettings size={22} stroke={1.75} />
        <h1 className="text-lg font-semibold">Settings · Connected accounts</h1>
      </header>

      <section>
        <span className="text-xs font-medium tracking-wide text-[#999] uppercase">Connected Google Drive accounts</span>

        <div className="mt-2 space-y-3">
          {loading ? (
            <p className="py-6 text-center text-sm text-[#999]">Loading…</p>
          ) : accounts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#e5e5e5] px-4 py-8 text-center">
              <p className="text-sm text-[#666]">Connect a Google Drive account to start recording.</p>
              <button
                type="button"
                onClick={() => setModal('connect')}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#ef4444] px-4 py-2.5 text-sm font-medium text-white"
              >
                <IconCloudPlus size={18} stroke={1.75} />
                Connect a Google Drive account
              </button>
            </div>
          ) : (
            accounts.map((account, i) => (
              <AccountRow
                key={account.id}
                account={account}
                colorIndex={i}
                onSetDefault={() => handleSetDefault(account.id)}
                onDisconnect={() => handleDisconnect(account)}
              />
            ))
          )}
        </div>

        {!loading && accounts.length > 0 && (
          <button
            type="button"
            onClick={() => setModal('connect')}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[#e5e5e5] py-3 text-sm text-[#666]"
          >
            <IconCloudPlus size={16} stroke={1.75} />
            Connect another Google Drive account
          </button>
        )}

        <div className="mt-3 flex items-start gap-2 rounded-lg bg-[#f5f5f4] px-3 py-2.5 text-xs text-[#666]">
          <IconInfoCircle size={16} stroke={1.75} className="mt-0.5 shrink-0 text-[#3b82f6]" />
          Each account needs your own Google Cloud OAuth credentials.{' '}
          <button type="button" onClick={() => setModal('setup-guide')} className="font-medium text-[#3b82f6] underline">
            View setup guide →
          </button>
        </div>
      </section>

      {!loading && <StorageBehaviorSection value={storageBehavior} onChange={handleStorageBehaviorChange} />}
      {!loading && <RecordingDefaultsSection value={recordingDefaults} onChange={handleRecordingDefaultsChange} />}
      {!loading && <CrossTabPermissionSection onError={showToast} />}
      {!loading && <MicCameraPermissionSection onError={showToast} />}

      {modal === 'connect' && (
        <ConnectModal
          onClose={() => setModal('none')}
          onHaveCredentials={() => setModal('paste-credentials')}
          onNeedGuide={() => setModal('setup-guide')}
        />
      )}
      {modal === 'setup-guide' && (
        <SetupGuideModal onClose={() => setModal('none')} onDone={() => setModal('paste-credentials')} />
      )}
      {modal === 'paste-credentials' && (
        <PasteCredentialsModal
          onClose={() => setModal('none')}
          onReopenGuide={() => setModal('setup-guide')}
          onSubmit={handleAuthorize}
        />
      )}

      <ToastHost toast={toast} onDismiss={dismissToast} />
    </div>
  );
}

export default App;
