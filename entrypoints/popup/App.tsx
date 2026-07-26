import { useEffect, useState } from 'react';
import {
  IconAppWindow,
  IconBrowser,
  IconCamera,
  IconChevronDown,
  IconCloudPlus,
  IconDeviceDesktop,
  IconHistory,
  IconMicrophone,
  IconSettings,
} from '@tabler/icons-react';
import { Toggle } from '@/components/toggle';
import { HistoryPanel } from '@/components/history-panel';
import type { RecordingMode } from '@/types/recording';
import type { StartRecordingMessage } from '@/lib/messaging';
import { getAllAccounts } from '@/lib/accounts-storage';
import {
  clearSelectedAccountId,
  getCamEnabled,
  getMicEnabled,
  getSelectedAccountId,
  setCamEnabled,
  setMicEnabled,
  setSelectedAccountId,
} from '@/lib/preferences';
import { formatBytes } from '@/lib/format';
import type { Account } from '@/types/account';

const MODES: { value: RecordingMode; label: string; icon: typeof IconDeviceDesktop }[] = [
  { value: 'screen', label: 'Screen', icon: IconDeviceDesktop },
  { value: 'window', label: 'Window', icon: IconAppWindow },
  { value: 'tab', label: 'Tab', icon: IconBrowser },
];

// getUserMedia throws the same generic-looking rejection for very different
// underlying problems — a real permission denial (NotAllowedError), no mic
// hardware detected at all (NotFoundError), or a mic that's present but the
// OS/driver can't actually read from it, e.g. faulty hardware (NotReadableError).
// Distinguishing these is the difference between "click Allow" and "this is a
// hardware problem, not a permission problem."
function describeMicError(err: unknown): string {
  const name = err instanceof Error ? err.name : undefined;
  switch (name) {
    case 'NotAllowedError':
      return 'Microphone access was denied or blocked. Allow it in Chrome, or turn off Mic and try again.';
    case 'NotFoundError':
      return "No microphone was detected by this Mac. Check System Settings → Sound → Input, or turn off Mic and try again.";
    case 'NotReadableError':
      return "A microphone was found, but the system couldn't read from it — this usually means a hardware or driver problem, not a permission issue. Try another app that uses the mic to confirm, or turn off Mic and try again.";
    default:
      return `Microphone request failed (${name ?? 'unknown error'}). Turn off Mic and try again, or check the popup console for details.`;
  }
}

// Only NotAllowedError has a concrete, walkable fix — NotFoundError/
// NotReadableError are hardware issues with nothing to click through, so
// this stays specific to that one case. Points at Settings' own "Grant
// access" button (components/settings/mic-camera-permission-section.tsx)
// rather than the address-bar site-permission icon: confirmed via a live
// repro that the popup can silently refuse getUserMedia with no prompt at
// all even when Chrome's site permission and the OS's own privacy setting
// are both already clean — a real limitation of requesting media from a
// transient browser-action popup rather than a normal page. Settings is a
// real, persistent tab (opened per CLAUDE.md's architecture notes) that
// shares this popup's chrome-extension:// origin, so a grant made there
// covers every later call from the popup too.
const IS_MAC = navigator.platform.toLowerCase().includes('mac');
const MIC_BLOCKED_FIX_STEPS = [
  'Click "Open QuickCast Settings" below (opens in a new tab).',
  'Scroll to "Microphone & camera access" and click "Grant access" next to Microphone.',
  'A real permission popup should appear there (this extension\'s own popup sometimes can\'t show one) — click Allow.',
  IS_MAC
    ? 'If it still fails, also check System Settings → Privacy & Security → Microphone → make sure Google Chrome is enabled.'
    : 'If it still fails, also check your OS privacy settings → Microphone → make sure Chrome is allowed.',
  'Come back here and click Start recording again.',
];

function App() {
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<RecordingMode>('screen');
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [micBlocked, setMicBlocked] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  // getAllAccounts() is async — without this, clicking Start before it
  // resolves would silently send config.accountId: undefined, disabling the
  // Drive upload with no visible error (the widget would just show "Not
  // uploading" for the whole recording). Gating Start on this instead of
  // trusting accountId to "probably" be populated by click time closes that
  // race outright.
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  // History panel replaces the main popup content in place (not a separate
  // page) per requirements.md §7 — toggled by the header's history icon.
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    (async () => {
      const [micEnabled, camEnabled] = await Promise.all([getMicEnabled(), getCamEnabled()]);
      setMic(micEnabled);
      setCam(camEnabled);

      const accountsById = await getAllAccounts();
      const list = Object.values(accountsById);
      setAccounts(list);

      const defaultAccountId = list.find((a) => a.isDefault)?.id ?? list[0]?.id;
      // A previous recording's one-off pick (see handleAccountChange) — if it
      // still points at a connected account, pre-select it; otherwise (the
      // account was disconnected since, or this is stale from some other
      // reason) fall back to the default and clear the stale key so it
      // doesn't keep getting checked on every future popup open.
      const selected = await getSelectedAccountId();
      if (selected && list.some((a) => a.id === selected)) {
        setAccountId(selected);
      } else {
        if (selected) await clearSelectedAccountId();
        setAccountId(defaultAccountId);
      }
      setAccountsLoaded(true);
    })();
  }, []);

  function handleAccountChange(id: string) {
    setAccountId(id);
    // Persisted immediately, not just kept in component state — the popup
    // can close on blur (clicking away, etc.) at any point before Start is
    // clicked, which would otherwise silently lose the user's pick.
    void setSelectedAccountId(id);
  }

  // Same reasoning as handleAccountChange — persisted immediately so the
  // choice survives the popup closing (it previously reset to on/on every
  // time the popup reopened, even right after explicitly toggling one off).
  function handleMicToggle(next: boolean) {
    setMic(next);
    void setMicEnabled(next);
  }

  function handleCamToggle(next: boolean) {
    setCam(next);
    void setCamEnabled(next);
  }

  async function handleStart() {
    console.log('[QuickCast][popup] Start recording clicked', { mode, mic, cam, title, accountId });

    // Must be the very first thing this function does — no state updates
    // (and their re-renders), no chrome.tabs.query, nothing async ahead of
    // it. Chrome only shows the mic/cam permission prompt while the click's
    // transient user-activation is still fresh; any await before this one
    // can let that window lapse, which makes Chrome silently refuse the
    // request (immediate NotAllowedError, no dialog ever shown) instead of
    // erroring loudly. Confirmed via a live repro where Chrome's own site
    // permission (chrome://settings/content/microphone) and Windows'
    // microphone privacy panel were both already clean, yet no prompt ever
    // appeared — this reordering (query used to run first) is the fix.
    // Offscreen documents are invisible, so Chrome can't surface a mic
    // permission prompt from inside one — it silently dismisses it instead.
    // Requesting (and immediately releasing) the mic here, in a visible
    // page, forces that one-time OS/Chrome prompt where the user can
    // actually see and answer it, fully awaited before this function does
    // anything else. Once granted, the grant applies to the extension's
    // origin, so the offscreen document's own getUserMedia({audio:true})
    // call later succeeds without prompting again.
    if (mic) {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStream.getTracks().forEach((track) => track.stop());
        console.log('[QuickCast][popup] Mic permission granted');
      } catch (err) {
        console.error('[QuickCast][popup] Mic permission request failed', err instanceof Error ? err.name : err, err);
        setError(describeMicError(err));
        setMicBlocked(err instanceof Error && err.name === 'NotAllowedError');
        return;
      }
    }

    // Same reasoning as mic above. Two separate places make their own
    // getUserMedia({video:true}) call later — the offscreen document (for
    // the actual composited/recorded video) and the content script (for the
    // on-screen bubble preview) — since a live camera track can't be handed
    // between those two contexts. Priming the grant here, in a visible page,
    // means both later calls succeed without a prompt regardless of which
    // context would otherwise have had to show it (the offscreen document
    // can't show one at all; the content script technically could, but
    // priming here avoids an extra prompt appearing on the recorded page
    // itself). Unlike mic, this is best-effort per requirements.md — a
    // denied/missing camera must never block Start or show the user an
    // error, so failures here are only logged, not surfaced.
    if (cam) {
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        camStream.getTracks().forEach((track) => track.stop());
        console.log('[QuickCast][popup] Camera permission granted');
      } catch (err) {
        console.warn(
          '[QuickCast][popup] Camera permission request failed — continuing without webcam',
          err instanceof Error ? err.name : err,
          err,
        );
      }
    }

    setMicBlocked(false);

    // Resolve the target tab here, in the popup, after the mic/cam priming
    // above (deliberately moved below it — see that block's comment).
    // currentWindow reliably means "the browser window this popup is
    // attached to" only from the popup's own context — querying it later
    // from the background service worker (which has no window of its own)
    // proved unreliable and could resolve to the wrong tab entirely, one
    // activeTab was never granted for.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id || !/^https?:\/\//.test(activeTab.url ?? '')) {
      setError('Open a regular webpage tab first, then try recording again.');
      return;
    }
    const tabId = activeTab.id;

    setError(null);
    setStarting(true);

    const message: StartRecordingMessage = {
      type: 'popup:start-recording',
      tabId,
      config: {
        recordingId: crypto.randomUUID(),
        title: title.trim(),
        mode,
        mic,
        cam,
        accountId,
      },
    };

    // Fire-and-forget from here: background's own setup (offscreen doc,
    // getDisplayMedia) can take a few seconds, and design.md's flow wants
    // the popup to close right away rather than sit open through all of
    // that.
    console.log('[QuickCast][popup] Sending popup:start-recording', message);
    chrome.runtime.sendMessage(message);
    window.close();
  }

  if (showHistory) {
    return <HistoryPanel onBack={() => setShowHistory(false)} />;
  }

  // No accounts connected yet — nothing to upload to, so showing the
  // recording controls (mode, mic/cam, Start) would just let the user start
  // a recording that can never be saved anywhere. Replace them entirely with
  // a single, unambiguous next step instead of a disabled-looking form.
  if (accountsLoaded && accounts.length === 0) {
    return (
      <div className="w-[340px] bg-white">
        <header className="flex items-center justify-between border-b border-[#e5e5e5] px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#ef4444]">
              <span className="h-2.5 w-2.5 rounded-full bg-white" />
            </span>
            <span className="text-base font-semibold text-[#1a1d24]">QuickCast</span>
          </div>
        </header>
        <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
          <IconCloudPlus size={32} stroke={1.5} className="text-[#999]" />
          <p className="text-sm text-[#666]">Connect a Google Drive account to start recording.</p>
          <button
            type="button"
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') })}
            className="flex items-center justify-center gap-2 rounded-lg bg-[#ef4444] px-4 py-2.5 text-sm font-medium text-white"
          >
            <IconCloudPlus size={18} stroke={1.75} />
            Connect account
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-[340px] bg-white">
      <header className="flex items-center justify-between border-b border-[#e5e5e5] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#ef4444]">
            <span className="h-2.5 w-2.5 rounded-full bg-white" />
          </span>
          <span className="text-base font-semibold text-[#1a1d24]">QuickCast</span>
        </div>
        <div className="flex items-center gap-3 text-[#666]">
          <button type="button" onClick={() => setShowHistory(true)} title="Recent recordings">
            <IconHistory size={18} stroke={1.75} />
          </button>
          <button type="button" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') })}>
            <IconSettings size={18} stroke={1.75} />
          </button>
        </div>
      </header>

      <div className="space-y-5 px-4 py-4">
        <div>
          <label className="text-xs font-medium tracking-wide text-[#999] uppercase">
            Video title <span className="normal-case text-[#999]">· optional</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Frank login redirect fix"
            className="mt-1.5 w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm text-[#1a1d24] placeholder:text-[#999] focus:border-[#3b82f6] focus:outline-none"
          />
        </div>

        <div>
          <span className="text-xs font-medium tracking-wide text-[#999] uppercase">Recording mode</span>
          <div className="mt-1.5 grid grid-cols-3 gap-2">
            {MODES.map(({ value, label, icon: Icon }) => {
              const selected = mode === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-sm ${
                    selected
                      ? 'border-[#3b82f6] bg-[#3b82f6]/10 text-[#3b82f6]'
                      : 'border-[#e5e5e5] text-[#1a1d24]'
                  }`}
                >
                  <Icon size={22} stroke={1.5} />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex gap-2">
          <div className="flex flex-1 items-center justify-between rounded-lg border border-[#e5e5e5] px-3 py-2.5">
            <span className="flex items-center gap-2 text-sm text-[#1a1d24]">
              <IconMicrophone size={18} stroke={1.75} className="text-[#10b981]" />
              Mic
            </span>
            <Toggle checked={mic} onChange={handleMicToggle} />
          </div>
          <div className="flex flex-1 items-center justify-between rounded-lg border border-[#e5e5e5] px-3 py-2.5">
            <span className="flex items-center gap-2 text-sm text-[#1a1d24]">
              <IconCamera size={18} stroke={1.75} className="text-[#10b981]" />
              Cam
            </span>
            <Toggle checked={cam} onChange={handleCamToggle} />
          </div>
        </div>
      </div>

      <div className="border-t border-[#e5e5e5] px-4 py-4">
        <span className="text-xs font-medium tracking-wide text-[#999] uppercase">Upload to</span>
        <div className="relative mt-1.5">
          <select
            value={accountId}
            onChange={(e) => handleAccountChange(e.target.value)}
            disabled={accounts.length === 1}
            className="w-full appearance-none rounded-lg border border-[#e5e5e5] px-3 py-2.5 text-sm text-[#1a1d24] disabled:text-[#666]"
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.email}
                {account.quota?.limitBytes
                  ? ` · ${formatBytes(account.quota.limitBytes - account.quota.usageBytes)} free`
                  : ''}
              </option>
            ))}
          </select>
          <IconChevronDown size={16} stroke={1.75} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#999]" />
        </div>

        <button
          type="button"
          onClick={handleStart}
          disabled={starting || !accountsLoaded}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-[#ef4444] py-3 text-sm font-medium text-white disabled:opacity-60"
        >
          <span className="h-2 w-2 rounded-full bg-white" />
          {starting ? 'Starting…' : !accountsLoaded ? 'Loading…' : 'Start recording'}
        </button>
        {error && <p className="mt-2 text-center text-xs text-[#ef4444]">{error}</p>}
        {micBlocked && (
          <div className="mt-2 rounded-lg border border-[#fecaca] bg-[#fef2f2] p-3 text-xs text-[#7f1d1d]">
            <ol className="list-decimal space-y-1 pl-4">
              {MIC_BLOCKED_FIX_STEPS.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            <button
              type="button"
              onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') })}
              className="mt-2 w-full rounded-md bg-[#7f1d1d] py-1.5 text-center font-medium text-white"
            >
              Open QuickCast Settings
            </button>
          </div>
        )}
        <p className="mt-3 text-center text-xs text-[#999]">Ctrl+Shift+0 to open</p>
      </div>
    </div>
  );
}

export default App;
