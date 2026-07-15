import { closeOffscreenDocument, ensureOffscreenDocument } from '@/lib/offscreen';
import { hasCrossTabPermission } from '@/lib/cross-tab-permission';
import { getAccount, getAllAccounts, updateAccount } from '@/lib/accounts-storage';
import { refreshAccessToken } from '@/lib/oauth';
import { ensureMonthlyFolder } from '@/lib/drive';
import { getCachedFolderId, setCachedFolderId } from '@/lib/folder-cache';
import {
  clearSelectedAccountId,
  getFollowWebcamAcrossTabs,
  getFollowWidgetAcrossTabs,
  getRecordingDefaults,
  getStorageBehavior,
  bitrateForQuality,
} from '@/lib/preferences';
import { clearActiveSession, getActiveSession, setActiveSession, updateActiveSession, type RecordingSession } from '@/lib/recording-session';
import { setUploadResult } from '@/lib/upload-results';
import { addRecentRecording, updateRecentRecording } from '@/lib/recent-recordings';
import type { Account, DriveAuth } from '@/types/account';
import type {
  OffscreenBlobReadyMessage,
  OffscreenEndedMessage,
  OffscreenPrepareMessage,
  OffscreenUploadDisabledMessage,
  OffscreenUploadFinishedMessage,
  OffscreenUploadProgressMessage,
  OffscreenWebcamStopMessage,
  ShareBlobDoneMessage,
  ShareRequestLocalBlobMessage,
  ShareUploadFailedMessage,
  ShareUploadProgressMessage,
  ShareUploadReadyMessage,
  StartRecordingMessage,
  WidgetCancelClickedMessage,
  WidgetCountdownDoneMessage,
  WidgetEnsureStateMessage,
  WidgetPauseClickedMessage,
  WidgetRecordingStartedMessage,
  WidgetResumeClickedMessage,
  WidgetStopClickedMessage,
  WidgetUploadDisabledMessage,
  WidgetUploadProgressMessage,
  WidgetWebcamCloseClickedMessage,
  WidgetWebcamStopAllMessage,
} from '@/lib/messaging';

const LOG = '[QuickCast][background]';
const CONTENT_SCRIPT_PATH = 'content-scripts/content.js';

// Holds each recording's full local Blob (see OffscreenBlobReadyMessage) from
// the moment Stop finishes until the share screen tells us it's done with it
// (ShareBlobDoneMessage) — keyed by recordingId so a share tab that gets
// closed and reopened can still re-request it. Lives only in memory: if the
// service worker itself gets torn down, this (like the rest of its in-memory
// state) is gone, and the share screen just falls back to the existing
// Drive-preview-only behavior.
const localRecordingBlobs = new Map<string, Blob>();

// The share screen opens (and its blob-request effect fires) immediately on
// Stop — see openPendingShareScreen — which is routinely BEFORE offscreen.ts
// has finished reading the recording back out of IndexedDB and sent it here
// (offscreen:blob-ready): confirmed the actual cause of local playback never
// appearing (it fell straight through to the "no blob" iframe fallback,
// every time, not just occasionally) rather than a structured-clone/transfer
// problem. Queues any request that arrives before its blob does, per
// recordingId, and resolves it the moment offscreen:blob-ready lands instead
// of making the share screen poll/retry on a timer. Capped by
// BLOB_REQUEST_TIMEOUT_MS so a request for a recording whose blob genuinely
// never arrives (offscreen hand-off failed) doesn't hang the share screen's
// message channel forever — it just resolves null, same as today's fallback.
const pendingBlobRequests = new Map<string, Array<(blob: Blob | null) => void>>();
// Reading a long recording's chunks back out of IndexedDB and assembling them
// into one Blob (see entrypoints/offscreen/main.ts's sendBlobToBackground)
// isn't instant — confirmed too slow for the original 10s timeout on a real
// ~7 minute recording, which fell back to the Drive-only preview every time
// even though the blob eventually did arrive. 60s comfortably covers that
// without leaving a genuinely failed hand-off waiting too long.
const BLOB_REQUEST_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded retry for chrome.tabs.sendMessage — used for one-time,
// consequential messages (e.g. closeWidget's widget:close) where a
// transient delivery failure would otherwise leave the widget stuck on
// screen indefinitely rather than just missing one of many repeated updates.
async function sendTabMessageWithRetry(tabId: number, message: unknown, attempts = 3, delayMs = 250): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      await sleep(delayMs);
    }
  }
}

// Like sendTabMessageWithRetry, but additionally treats "no response within
// timeoutMs" as a failure worth retrying, not just an outright rejection —
// used specifically for widget:ensure-state, where the content script's own
// handler is async (mount the widget, maybe acquire a camera) and content/
// index.ts is written to only call sendResponse once that fully resolves
// (see its onMessage listener). A plain sendMessage awaiting only "was this
// delivered" isn't a strong enough signal that the tab actually ended up
// with a visible widget — this is. Generous defaults (500ms × 3, 300ms
// gaps) specifically to cover the original recording tab, where this fires
// the moment its content script was *just* injected and may still be in the
// middle of its own async setup.
async function sendMessageWithAck(
  tabId: number,
  message: unknown,
  { attempts = 3, timeoutMs = 500, gapMs = 300 } = {},
): Promise<unknown> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, message),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`no ack within ${timeoutMs}ms`)), timeoutMs)),
      ]);
      console.log(LOG, `*** sendMessageWithAck: tab ${tabId} acked on attempt ${attempt}/${attempts}`, response);
      return response;
    } catch (err) {
      console.warn(LOG, `*** sendMessageWithAck: tab ${tabId} attempt ${attempt}/${attempts} failed`, err instanceof Error ? err.message : err);
      if (attempt === attempts) throw err;
      await sleep(gapMs);
    }
  }
}

// Reverted back to injecting the widget as a content script into the
// recorded tab (rather than a separate chrome.windows.create window) — the
// window approach caused Chrome to steal focus and switch tabs on macOS,
// which is worse than this approach's tradeoff (the widget only being
// visible on the tab actually being recorded, disappearing if the user
// switches away and reappearing when they switch back).
// Called once per recording, but recording twice on the same tab without a
// reload means executeScript runs again on a page that already has a live
// widget instance in it. We don't track "already injected" tab ids here —
// that cache would go stale the moment the tab navigates (the content
// script's context, and thus any widget in it, is gone, but this tab id
// would still look "already injected" and skip the real injection). The
// content script itself guards against the double-injection case instead
// (see entrypoints/content/index.ts's window.__quickcastWidgetInjected
// check), since only it can tell whether its own page context is fresh.
async function injectWidget(tabId: number): Promise<void> {
  console.log(LOG, 'Injecting widget content script into tab', tabId);
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_PATH] });
  console.log(LOG, 'Widget content script injected');
}

async function isInjectableTab(tabId: number): Promise<{ ok: boolean; url?: string }> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { ok: /^https?:\/\//.test(tab.url ?? ''), url: tab.url };
  } catch (err) {
    console.warn(LOG, 'isInjectableTab: chrome.tabs.get failed', tabId, err);
    return { ok: false };
  }
}

// Builds the single snapshot sent to any tab that needs to have (or
// re-confirm) both the widget and, if applicable, its own webcam bubble.
// phase/countdownSeconds branch on whether offscreen:begin has actually
// resolved yet — before that, every tab that gets ensured runs its own
// local 3-2-1 from the same countdownSeconds (see handleCountdownDone's own
// idempotency for why more than one tab safely doing this is fine). `cam`
// folds in webcamClosed so the content script only needs one boolean, not
// two separate flags to reconcile.
function buildEnsureStateMessage(
  session: RecordingSession,
  { showWidget, showWebcam, isOriginalTab }: { showWidget: boolean; showWebcam: boolean; isOriginalTab: boolean },
): WidgetEnsureStateMessage {
  const started = session.startedAt !== undefined;
  return {
    type: 'widget:ensure-state',
    recordingId: session.recordingId,
    phase: started ? session.phase ?? 'recording' : 'countdown',
    countdownSeconds: started ? 0 : session.countdownSeconds,
    startedAt: session.startedAt,
    showWidget,
    isOriginalTab,
    cam: showWebcam && Boolean(session.config.cam) && !session.webcamClosed,
    webcamCorner: session.config.webcamCorner,
    uploadProgress: session.lastUploadProgress,
    uploadDisabledReason: session.lastUploadDisabledReason,
  };
}

// The one mechanism responsible for making sure a given tab has both the
// widget and (if applicable) its own webcam bubble, reflecting current
// state — replaces what used to be three separate, narrower paths
// (inject-on-first-visit, sync-state-on-revisit, relocate-the-one-bubble).
// Cheapest case first: if a content-script listener is already alive in
// this tab (whether it's the original recording tab or one visited
// earlier), a plain sendMessage reaches it — no permission needed for that
// at all, regardless of which tab it is, since nothing is being injected.
// Only falls through to (re-)injecting the script if that fails, which
// happens for a genuinely new tab, or one whose JS context was actually
// destroyed (a hard reload) — not for a single-page app that merely
// re-rendered its own DOM, where the listener (and this tab's camera
// stream, if it had one) are still alive and well.
async function ensureWidgetOnTab(tabId: number, session: RecordingSession): Promise<void> {
  console.log(LOG, '*** ensureWidgetOnTab called', { tabId, isOriginalTab: tabId === session.tabId, recordingId: session.recordingId });

  // Once Stop/Cancel has actually been processed, nothing should ever
  // re-ensure the widget/bubble again for this session, on any tab —
  // without this, a tab-activity event (a tab switch, an onUpdated firing
  // for unrelated page activity) arriving during the window between Stop
  // and the session actually being cleared (which, for a real Stop, waits
  // on the Drive flush — see endRecording's own comment) would resurrect
  // both on whichever tab is active, undoing Stop's own cleanup.
  if (session.stoppedAt !== undefined) {
    console.log(LOG, '*** ensureWidgetOnTab: session already stopped — refusing to (re)ensure', tabId);
    return;
  }

  const { ok: injectable } = await isInjectableTab(tabId);
  if (!injectable) {
    console.log(LOG, '*** ensureWidgetOnTab: tab not injectable, skipping', tabId);
    return;
  }

  // The original tab always gets both, regardless of these preferences —
  // they only govern whether the widget/webcam bubble *follow* the user to
  // OTHER tabs, per the user's "Show recording widget on any tab" / "Show
  // webcam bubble on any tab" Settings toggles (lib/preferences.ts). If
  // neither is wanted on this tab there's nothing to inject or send at all.
  const isOriginalTab = tabId === session.tabId;
  let showWidget = true;
  let showWebcam = true;
  if (!isOriginalTab) {
    [showWidget, showWebcam] = await Promise.all([getFollowWidgetAcrossTabs(), getFollowWebcamAcrossTabs()]);
    if (!showWidget && !showWebcam) {
      console.log(LOG, '*** ensureWidgetOnTab: both follow-across-tabs preferences are off, nothing to show here', tabId);
      return;
    }
  }

  const message = buildEnsureStateMessage(session, { showWidget, showWebcam, isOriginalTab });

  async function markTabTracked(): Promise<void> {
    if (!session.widgetTabIds.includes(tabId)) {
      await updateActiveSession({ widgetTabIds: [...session.widgetTabIds, tabId] });
    }
  }

  try {
    const response = await sendMessageWithAck(tabId, message);
    console.log(LOG, '*** ensureWidgetOnTab: existing listener acked', tabId, response);
    await markTabTracked();
    return;
  } catch (err) {
    console.log(LOG, '*** ensureWidgetOnTab: no live listener after retries, will (re-)inject', tabId, err instanceof Error ? err.message : err);
  }

  // Re-injecting needs either activeTab (only ever valid for the exact tab
  // the user invoked Start/the shortcut on, and only until it navigates) or
  // the optional cross-tab permission (Settings' "Follow recording across
  // tabs" toggles). The original tab gets one unconditional attempt below
  // regardless — if its activeTab grant is still valid this just works; if
  // it's been revoked (e.g. a hard navigation), the attempt harmlessly fails
  // and is caught, same as it would for any other ungranted tab.
  if (!isOriginalTab && !(await hasCrossTabPermission())) {
    console.log(LOG, '*** ensureWidgetOnTab: no listener and no cross-tab permission — skipping', tabId);
    return;
  }

  try {
    console.log(LOG, '*** ensureWidgetOnTab: (re-)injecting into', tabId);
    await injectWidget(tabId);
    console.log(LOG, '*** ensureWidgetOnTab: injection done, sending ensure-state with ack+retry', tabId);
    const response = await sendMessageWithAck(tabId, message);
    console.log(LOG, '*** ensureWidgetOnTab: injected tab acked', tabId, response);
    await markTabTracked();
  } catch (err) {
    console.warn(LOG, '*** ensureWidgetOnTab: failed to inject/send after retries', tabId, {
      name: err instanceof Error ? err.name : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// Called from every event that could mean "the currently active tab may not
// have the widget/bubble, or may have lost them": a tab switch, a page
// load/reload, and a single-page app's own in-app route change — see the
// three listeners in defineBackground() below, plus the direct call from
// startRecording() for the very first tab.
// A busy single-page app (confirmed on a real support site: chrome.tabs.
// onUpdated and chrome.webNavigation.onHistoryStateUpdated both firing
// repeatedly, in rapid succession, for the same tab) can trigger this many
// times a second. The content script's own ensureStateQueue is what
// actually guarantees correctness under that load, but there's no reason to
// keep re-sending (and re-logging) an ensure-state message to the same tab
// every single time when nothing about the recording itself has changed in
// the meantime — a short per-tab debounce cuts the redundant traffic at the
// source instead of only absorbing it downstream.
const lastEnsuredAt = new Map<number, number>();
const ENSURE_DEBOUNCE_MS = 400;

// Takes the tabId directly from whichever Chrome event fired (onActivated's
// own activeInfo.tabId, or onUpdated/onHistoryStateUpdated's own tabId
// argument) instead of re-resolving "the active tab" via chrome.tabs.query —
// this used to query with `{ active: true, currentWindow: true }` from here,
// but `currentWindow` has no reliable meaning from a service worker, which
// has no window of its own to anchor to (the exact same class of bug Phase 1
// hit and fixed once already, for a different function — see progress.md's
// decisions log, 2026-07-12). With multiple browser windows open, that could
// silently resolve to the active tab of the WRONG window, sending
// ensure-state to a tab that only coincidentally matched, while the tab the
// event actually fired for — potentially the original recording tab — never
// got ensured at all. `chrome.tabs.get(tabId).active` below confirms the
// event's own tab really is the front-most one in its window before doing
// anything, without ever having to guess which window is "current."
async function ensureWidgetOnTabIfActive(tabId: number): Promise<void> {
  const session = await getActiveSession();
  if (!session) return;

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (err) {
    console.log(LOG, '*** ensureWidgetOnTabIfActive: tab no longer exists', tabId, err instanceof Error ? err.message : err);
    return;
  }
  if (!tab.active) {
    console.log(LOG, '*** ensureWidgetOnTabIfActive: tab is not the active tab in its window, skipping', tabId);
    return;
  }

  const now = Date.now();
  const last = lastEnsuredAt.get(tabId);
  if (last !== undefined && now - last < ENSURE_DEBOUNCE_MS) {
    return;
  }
  lastEnsuredAt.set(tabId, now);

  await ensureWidgetOnTab(tabId, session);
}

// Resolves the auth material the offscreen document needs to call the Drive
// API itself — it can't read chrome.storage.local (confirmed empirically:
// reading it there threw "Cannot read properties of undefined (reading
// 'local')"), so background.ts (which can) reads the account here and hands
// over exactly what's needed, refreshing the token first if it's already
// expired or close to it.
async function resolveDriveAuth(accountId: string | undefined): Promise<DriveAuth | undefined> {
  if (!accountId) return undefined;
  const account = await getAccount(accountId);
  if (!account) {
    console.warn(LOG, 'resolveDriveAuth: no stored account with id', accountId);
    return undefined;
  }

  let tokens = account.tokens;
  if (tokens.expiresAt <= Date.now() + 60_000) {
    console.log(LOG, 'Access token expired or expiring soon — refreshing before recording starts');
    const refreshed = await refreshAccessToken(account.credentials, tokens.refreshToken);
    tokens = { ...tokens, ...refreshed };
    await updateAccount(accountId, { tokens });
  }

  return {
    accountId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    clientId: account.credentials.clientId,
    clientSecret: account.credentials.clientSecret,
  };
}

function usedFraction(account: Account): number {
  return account.quota?.limitBytes ? account.quota.usageBytes / account.quota.limitBytes : 0;
}

// Decides which account a recording actually uploads to, per the Settings
// "Storage behavior" setting (lib/preferences.ts). `popupAccountId` is
// whatever the popup's account switcher had selected when Start was clicked
// (see entrypoints/popup/App.tsx) — already defaulted to the default account
// there if the user never touched the dropdown.
async function resolveAccountId(popupAccountId: string | undefined): Promise<string | undefined> {
  const accounts = Object.values(await getAllAccounts());
  if (accounts.length === 0) return undefined;
  const defaultAccount = accounts.find((a) => a.isDefault) ?? accounts[0];
  const behavior = await getStorageBehavior();

  if (behavior === 'auto') {
    // Quota-based auto-switching is relative to the default account
    // specifically, regardless of whatever the popup's switcher shows — a
    // one-off manual pick from the switcher wouldn't make sense to silently
    // override here, but "auto" mode's whole point is not needing that pick
    // in the first place.
    if (usedFraction(defaultAccount) < 0.9) return defaultAccount.id;
    const alternative = accounts.find((a) => a.id !== defaultAccount.id && usedFraction(a) < 0.9);
    if (alternative) {
      console.log(LOG, 'Default account is ≥90% full — auto-switching', { from: defaultAccount.id, to: alternative.id });
      return alternative.id;
    }
    console.warn(LOG, 'Default account is ≥90% full and no alternative has room — proceeding with default anyway');
    return defaultAccount.id;
  }

  // 'ask' and 'default' both defer to the popup's switcher: 'ask' mode's
  // "asking" *is* the popup's existing account dropdown (always shown when
  // 2+ accounts are connected — see entrypoints/popup/App.tsx), and 'default'
  // mode simply falls back to the default account when the user didn't
  // override it there.
  if (popupAccountId && accounts.some((a) => a.id === popupAccountId)) return popupAccountId;
  return defaultAccount.id;
}

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7); // "2026-07"
}

// Resolves the "QuickCast Recordings/{YYYY-MM}" folder id for this account,
// via a per-account cache (lib/folder-cache.ts) so a recording doesn't re-run
// two Drive list queries every single time — only once per account per month.
// Runs here (not in the offscreen document, which can't read
// chrome.storage.local) so the cache can actually be read/written.
async function resolveMonthlyFolderId(driveAuth: DriveAuth): Promise<string | undefined> {
  const yearMonth = currentYearMonth();
  const cached = await getCachedFolderId(driveAuth.accountId, yearMonth);
  if (cached) {
    console.log(LOG, 'Using cached monthly folder id', { accountId: driveAuth.accountId, yearMonth, folderId: cached });
    return cached;
  }
  try {
    const folderId = await ensureMonthlyFolder(driveAuth, yearMonth);
    await setCachedFolderId(driveAuth.accountId, yearMonth, folderId);
    return folderId;
  } catch (err) {
    // Don't block the recording on this — initiateResumableUpload (in the
    // offscreen document) will just fall back to Drive's root if no folder id
    // is passed, same as before folder organization existed.
    console.error(LOG, 'Failed to resolve monthly folder id — recording will upload to Drive root', err);
    return undefined;
  }
}

async function startRecording(message: StartRecordingMessage): Promise<void> {
  const { config: popupConfig, tabId } = message;
  console.log(LOG, 'Received popup:start-recording', popupConfig, 'tabId', tabId);
  console.log(LOG, 'Recording started, originalTabId:', tabId);

  // The account actually used can differ from what the popup sent — the
  // Storage behavior setting can auto-switch away from it (see
  // resolveAccountId) — so this, not popupConfig, is the config threaded
  // through the rest of the session (share screen, upload, everything).
  // Cleared unconditionally once resolved: it's a one-time override for this
  // one recording, not a sticky replacement for the default account (see
  // lib/preferences.ts).
  const resolvedAccountId = await resolveAccountId(popupConfig.accountId);
  await clearSelectedAccountId();

  // Quality/frame rate come from Settings' Recording defaults — resolved
  // here (not in the offscreen document, which can't read
  // chrome.storage.local) and threaded through the config, same pattern as
  // accountId/driveAuth/folderId above.
  const recordingDefaults = await getRecordingDefaults();
  const config = {
    ...popupConfig,
    accountId: resolvedAccountId,
    videoBitsPerSecond: bitrateForQuality(recordingDefaults.quality),
    frameRate: recordingDefaults.frameRate,
    webcamCorner: recordingDefaults.webcamCorner,
  };
  console.log(LOG, 'Resolved account for this recording', { popupPicked: popupConfig.accountId, resolved: resolvedAccountId });
  console.log(LOG, 'Applying recording defaults', recordingDefaults);

  // Persisted the moment `config` itself is ready — tabId here is exactly
  // the same value logged as "originalTabId" above and is never
  // recalculated or overwritten anywhere else in this file; every
  // isOriginalTab check for the rest of this recording (ensureWidgetOnTab)
  // compares directly against this stored session.tabId. sourceTabUrl (an
  // extra chrome.tabs.get lookup, only for 'tab'-mode recordings) is filled
  // in just after instead of gating this write on it, so the tabId that
  // matters for widget/bubble presence lands in storage with the fewest
  // possible awaits ahead of it.
  await setActiveSession({
    recordingId: config.recordingId,
    tabId,
    config,
    widgetTabIds: [tabId],
    countdownSeconds: recordingDefaults.countdown,
  });

  // Inject the widget content script right away, while activeTab's temporary
  // grant (from the user's click in the popup moments ago) is still fresh.
  // The script itself stays dormant — it only renders once it receives
  // widget:ensure-state below — so injecting early doesn't show anything
  // yet. Doing this *after* the offscreen/getDisplayMedia steps (as before)
  // left a multi-second gap, including the getDisplayMedia native picker's
  // own extended user interaction, which was long enough for Chrome to expire
  // activeTab's grant before the injection ever ran — "Cannot access
  // contents of url ... Extension manifest must request permission."
  await injectWidget(tabId);

  // Captured now (not looked up later) since the tab could navigate away or
  // close during the recording — this becomes the "Source URL" line in the
  // Drive file's description for tab-mode recordings (Phase 4). Not needed
  // for widget/bubble presence, so it's fetched after the session (and its
  // tabId) is already persisted, not before.
  if (config.mode === 'tab') {
    try {
      const sourceTabUrl = (await chrome.tabs.get(tabId)).url;
      await updateActiveSession({ sourceTabUrl });
    } catch (err) {
      console.warn(LOG, 'Failed to read source tab URL for tab-mode recording', err);
    }
  }

  // Always start from a fresh offscreen document — rules out a stale one left
  // over from an earlier failed/aborted attempt.
  console.log(LOG, 'Resetting offscreen document');
  await closeOffscreenDocument();
  await ensureOffscreenDocument();
  console.log(LOG, 'Offscreen document ready');

  const driveAuth = await resolveDriveAuth(config.accountId);
  console.log(LOG, driveAuth ? 'Resolved Drive auth for accountId ' + driveAuth.accountId : 'No Drive auth — local-only recording');

  const folderId = driveAuth ? await resolveMonthlyFolderId(driveAuth) : undefined;

  // The offscreen document calls navigator.mediaDevices.getDisplayMedia()
  // itself (see entrypoints/offscreen/main.ts) — the native picker and the
  // resulting stream are acquired in the same context that records it, so
  // there's no streamId to obtain here.
  const prepareMessage: OffscreenPrepareMessage = { type: 'offscreen:prepare', config, driveAuth, folderId };
  console.log(LOG, 'Sending offscreen:prepare', { ...prepareMessage, driveAuth: driveAuth ? '(redacted)' : undefined });
  const prepareResult = await chrome.runtime.sendMessage(prepareMessage);
  console.log(LOG, 'offscreen:prepare result', prepareResult);
  if (!prepareResult?.success) {
    throw new Error(prepareResult?.message ?? 'failed to prepare recording');
  }

  // The content script was already injected above (before the slow
  // offscreen/getDisplayMedia setup, for the activeTab-timing reason
  // explained there) — this reaches it via the cheap sendMessage path in
  // ensureWidgetOnTab, no re-injection needed.
  const freshSession = await getActiveSession();
  if (freshSession) await ensureWidgetOnTab(tabId, freshSession);
  console.log(LOG, 'Ensure-state message delivered to the original tab', tabId);
}

async function handleCountdownDone(message: WidgetCountdownDoneMessage): Promise<void> {
  console.log(LOG, 'Received widget:countdown-done', message);
  const session = await getActiveSession();
  if (!session || session.recordingId !== message.recordingId) {
    console.warn(LOG, 'No matching active session for countdown-done', message.recordingId);
    return;
  }
  // More than one tab can now legitimately run its own local countdown
  // simultaneously (any tab ensured while phase is still 'countdown' — see
  // buildEnsureStateMessage) — only the first one to actually finish should
  // call offscreen:begin; later ones are a no-op, not a second recording
  // start.
  if (session.startedAt !== undefined) {
    console.log(LOG, 'widget:countdown-done arrived after the recording already started — ignoring (a second tab finished its own local countdown)', message.recordingId);
    return;
  }

  console.log(LOG, 'Sending offscreen:begin');
  const beginResult = await chrome.runtime.sendMessage({ type: 'offscreen:begin', recordingId: message.recordingId });
  console.log(LOG, 'offscreen:begin result', beginResult);
  if (!beginResult?.success) return;

  await updateActiveSession({ startedAt: beginResult.startedAt, phase: 'recording' });

  // Broadcast to every tab that currently has the widget, not just the
  // original — any of them could have been showing their own local
  // countdown (see the note above) and needs telling it's over.
  const startedMessage: WidgetRecordingStartedMessage = {
    type: 'widget:recording-started',
    recordingId: message.recordingId,
    startedAt: beginResult.startedAt,
  };
  await Promise.all(
    session.widgetTabIds.map((tabId) => chrome.tabs.sendMessage(tabId, startedMessage).catch(() => undefined)),
  );
  console.log(LOG, 'Recording started', startedMessage);
}

async function handlePauseClicked(message: WidgetPauseClickedMessage): Promise<void> {
  console.log(LOG, 'widget:pause-clicked', message.recordingId);
  // Tracked so a tab ensured after this point mounts already paused (see
  // ensureWidgetOnTab) rather than showing a running timer.
  const session = await updateActiveSession({ phase: 'paused' });
  await chrome.runtime.sendMessage({ type: 'offscreen:pause', recordingId: message.recordingId });
  // Every tab's own RecordingWidget/RecordingPill only ever set phase
  // locally when *this* tab's own Pause button was clicked (see
  // useRecordingPillState's onPauseClick) — without broadcasting here, every
  // other tab in widgetTabIds kept showing a running timer until it was
  // torn down and re-mounted (e.g. a manual reload), which was the actual
  // bug: Stop/Cancel already broadcast widget:close the same way (see
  // closeWidget), Pause/Resume never did.
  if (session) {
    await Promise.all(
      session.widgetTabIds.map((tabId) =>
        chrome.tabs.sendMessage(tabId, { type: 'widget:paused', recordingId: message.recordingId }).catch(() => undefined),
      ),
    );
  }
}

async function handleResumeClicked(message: WidgetResumeClickedMessage): Promise<void> {
  console.log(LOG, 'widget:resume-clicked', message.recordingId);
  const session = await updateActiveSession({ phase: 'recording' });
  await chrome.runtime.sendMessage({ type: 'offscreen:resume', recordingId: message.recordingId });
  if (session) {
    await Promise.all(
      session.widgetTabIds.map((tabId) =>
        chrome.tabs.sendMessage(tabId, { type: 'widget:resumed', recordingId: message.recordingId }).catch(() => undefined),
      ),
    );
  }
}

// Just makes the widget disappear — does not clear the active-session record
// or close the offscreen document. For a real Stop, both of those have to
// wait: the session record still holds config/startedAt/sourceTabUrl needed
// to open the share screen once the upload actually finishes (see
// handleUploadFinished), and the offscreen document has to stay alive for
// that same flush to complete.
async function closeWidget(session: RecordingSession): Promise<void> {
  // Retried (not a bare fire-and-forget .catch(() => undefined)) — a
  // transient delivery failure here used to mean the widget silently never
  // got the message and stayed on screen indefinitely, showing the
  // recording as still running even after Stop/Cancel had already fully
  // processed on the background/offscreen side (tracks stopped, share
  // screen opened) — from the user's point of view indistinguishable from
  // "my click did nothing," even though it hadn't.
  await Promise.all(
    session.widgetTabIds.map((tabId) =>
      sendTabMessageWithRetry(tabId, { type: 'widget:close', recordingId: session.recordingId }).catch((err) =>
        console.warn(LOG, 'widget:close failed to deliver to tab after retries', tabId, err),
      ),
    ),
  );
  console.log(LOG, 'Widget closed', session.recordingId);
}

// Builds the share screen's URL (entrypoints/share/) — everything it needs
// is passed via query params rather than looked up again there, since the
// active-session record is about to be cleared and the share screen has no
// other way to know the recording's title/duration/source. `fileId` is
// omitted while the Drive flush is still in progress — `pending` tells the
// share screen to show a "finishing upload" state until it's told otherwise
// (see ShareUploadReadyMessage/ShareUploadFailedMessage).
function shareScreenUrl(params: {
  fileId?: string;
  recordingId: string;
  accountId: string;
  title: string;
  recordedAtIso: string;
  durationMs: number;
  sourceUrl?: string;
  pending?: boolean;
}): string {
  const search = new URLSearchParams({
    recordingId: params.recordingId,
    accountId: params.accountId,
    title: params.title,
    recordedAt: params.recordedAtIso,
    durationMs: String(params.durationMs),
  });
  if (params.fileId) search.set('fileId', params.fileId);
  if (params.sourceUrl) search.set('sourceUrl', params.sourceUrl);
  if (params.pending) search.set('pending', '1');
  return `${chrome.runtime.getURL('share.html')}?${search.toString()}`;
}

// Opens the share screen right away on Stop, in a pending "finishing
// upload" state — per requirements.md's <5s "link in clipboard" goal, the
// user shouldn't have to wait for the Drive flush (which, per Phase 3's
// design, can legitimately take a while if a lot was still buffered) just
// to see the share screen appear at all. handleUploadFinished pushes the
// real fileId (or a failure) to this same tab once it's known.
async function openPendingShareScreen(session: RecordingSession, stoppedAt: number): Promise<void> {
  if (!session.config.accountId) return; // nothing to share for a local-only recording
  const startedAt = session.startedAt ?? stoppedAt;
  const url = shareScreenUrl({
    recordingId: session.recordingId,
    accountId: session.config.accountId,
    title: session.config.title,
    recordedAtIso: new Date(startedAt).toISOString(),
    durationMs: Math.max(0, stoppedAt - startedAt),
    sourceUrl: session.sourceTabUrl,
    pending: true,
  });
  console.log(LOG, 'Opening share screen immediately (pending upload)', url);
  const tab = await chrome.tabs.create({ url });
  if (tab.id !== undefined) {
    await updateActiveSession({ shareTabId: tab.id });
  }

  // Added right here (not once the upload finishes) per requirements.md §7 —
  // the row should show up immediately, same as the share screen itself;
  // driveFileId/shareLink are filled in later by handleUploadFinished once
  // actually known.
  const account = await getAccount(session.config.accountId);
  await addRecentRecording({
    recordingId: session.recordingId,
    title: session.config.title,
    timestamp: startedAt,
    accountId: session.config.accountId,
    accountEmail: account?.email ?? 'Unknown account',
  });
}

async function endRecording(recordingId: string, kind: 'offscreen:stop' | 'offscreen:cancel'): Promise<void> {
  console.log(LOG, 'Ending recording', recordingId, kind);
  const session = await getActiveSession();
  if (!session || session.recordingId !== recordingId) {
    console.warn(LOG, 'No matching active session to end', recordingId);
    return;
  }

  // A Stop click that already ran once for this session (the active session
  // record isn't cleared until handleUploadFinished, well after this
  // returns — see the comment below) — most likely a second Stop click sent
  // because the widget appeared not to respond to the first one. Re-running
  // everything below would open a *second* share screen tab and add a
  // duplicate recent-recordings entry for the exact same recording. The one
  // thing actually worth retrying is closeWidget() — if the widget is still
  // showing, that's the real symptom to fix, and it's genuinely idempotent.
  if (kind === 'offscreen:stop' && session.stoppedAt !== undefined) {
    console.log(LOG, 'Stop already processed for this session — re-closing widget only, not repeating the rest', recordingId);
    await closeWidget(session);
    return;
  }

  // Captured now, before the (possibly long) Drive flush and offscreen
  // teardown — duration should reflect when the user actually stopped.
  if (kind === 'offscreen:stop') {
    const stoppedAt = Date.now();
    await updateActiveSession({ stoppedAt });
    await openPendingShareScreen(session, stoppedAt);
  }

  // Not allowed to silently swallow this one: if the offscreen document
  // never actually receives offscreen:stop/offscreen:cancel, the real
  // MediaRecorder/tracks never stop even though the rest of this function
  // (closeWidget, session cleanup) would otherwise carry on as if they had.
  try {
    await chrome.runtime.sendMessage({ type: kind, recordingId });
  } catch (err) {
    console.error(LOG, `Failed to deliver ${kind} to the offscreen document`, err);
  }
  await closeWidget(session);

  // Cancel has no pending Drive upload to protect and no share screen to
  // open later — safe to clear the session and close the offscreen document
  // right away. A real Stop's session/document close down via
  // handleUploadFinished once entrypoints/offscreen/main.ts's
  // finalizeUploadThenNotify() actually completes (see its comment for why
  // stopAndSave() no longer waits for that here first).
  if (kind === 'offscreen:cancel') {
    await clearActiveSession();
    await closeOffscreenDocument();
  }
}

async function handleStopClicked(message: WidgetStopClickedMessage): Promise<void> {
  await endRecording(message.recordingId, 'offscreen:stop');
}

async function handleCancelClicked(message: WidgetCancelClickedMessage): Promise<void> {
  await endRecording(message.recordingId, 'offscreen:cancel');
}

async function handleUploadProgress(message: OffscreenUploadProgressMessage): Promise<void> {
  const session = await getActiveSession();
  if (!session || session.recordingId !== message.recordingId) return;
  // Cached so a tab ensured later (see ensureWidgetOnTab) can show
  // real progress immediately instead of a blank/ambiguous state.
  await updateActiveSession({ lastUploadProgress: message });
  const widgetMessage: WidgetUploadProgressMessage = { ...message, type: 'widget:upload-progress' };
  await Promise.all(
    session.widgetTabIds.map((tabId) => chrome.tabs.sendMessage(tabId, widgetMessage).catch(() => undefined)),
  );
  if (session.shareTabId !== undefined) {
    const shareMessage: ShareUploadProgressMessage = { ...message, type: 'share:upload-progress' };
    await chrome.tabs.sendMessage(session.shareTabId, shareMessage).catch(() => undefined);
  }
}

async function handleUploadDisabled(message: OffscreenUploadDisabledMessage): Promise<void> {
  console.warn(LOG, 'Drive upload disabled for this recording:', message.reason);
  const session = await getActiveSession();
  if (!session || session.recordingId !== message.recordingId) return;
  await updateActiveSession({ lastUploadDisabledReason: message.reason });
  const widgetMessage: WidgetUploadDisabledMessage = { ...message, type: 'widget:upload-disabled' };
  await Promise.all(
    session.widgetTabIds.map((tabId) => chrome.tabs.sendMessage(tabId, widgetMessage).catch(() => undefined)),
  );
}

// User clicked the on-screen bubble's close (X) button in one tab — since
// every tab that has a bubble now holds its own independent camera (see
// lib/messaging.ts's WidgetEnsureStateMessage), "closing the webcam" for the
// rest of the recording means stopping it *everywhere*, not just the tab it
// was clicked in. Also tells the offscreen document to stop its own,
// entirely separate camera track and drop the circle from the composited
// video, and records webcamClosed so ensureWidgetOnTabIfActive/ensureWidgetOnTab
// never (re)starts a bubble on any tab for the rest of this recording.
async function handleWebcamCloseClicked(message: WidgetWebcamCloseClickedMessage): Promise<void> {
  console.log(LOG, 'widget:webcam-close-clicked', message.recordingId);
  const session = await updateActiveSession({ webcamClosed: true });
  const stopOffscreenMessage: OffscreenWebcamStopMessage = { type: 'offscreen:webcam-stop', recordingId: message.recordingId };
  await chrome.runtime.sendMessage(stopOffscreenMessage).catch((err) =>
    console.warn(LOG, 'Failed to relay offscreen:webcam-stop', err),
  );
  if (session) {
    const stopAllMessage: WidgetWebcamStopAllMessage = { type: 'widget:webcam-stop-all', recordingId: message.recordingId };
    await Promise.all(
      session.widgetTabIds.map((tabId) => chrome.tabs.sendMessage(tabId, stopAllMessage).catch(() => undefined)),
    );
  }
}

async function handleOffscreenEnded(message: OffscreenEndedMessage): Promise<void> {
  console.log(LOG, 'Offscreen reported recording ended externally', message.recordingId);
  const session = await getActiveSession();
  if (!session || session.recordingId !== message.recordingId) {
    console.warn(LOG, 'No matching active session for offscreen:ended', message.recordingId);
    return;
  }
  const stoppedAt = Date.now();
  await updateActiveSession({ stoppedAt });
  await openPendingShareScreen(session, stoppedAt);
  // Same reasoning as a normal Stop: stopAndSave() (already run by the time
  // this arrives) kicked off the Drive flush without awaiting it, so the
  // session/offscreen document stay around until offscreen:upload-finished
  // arrives — don't clear/close them here.
  await closeWidget(session);
}

async function handleUploadFinished(message: OffscreenUploadFinishedMessage): Promise<void> {
  console.log(LOG, 'Offscreen reported its post-stop upload flush is finished', message.recordingId, 'fileId:', message.fileId);

  // Persisted (not just messaged to the tab) so the share screen can recover
  // the outcome after a page refresh — chrome.tabs.sendMessage only reaches
  // whatever onMessage listener happens to be registered at this exact
  // moment; a refreshed tab's fresh listener would otherwise never receive
  // this and would be stuck on "Finishing upload…" forever.
  await setUploadResult(message.recordingId, { fileId: message.fileId });

  // The recent-recordings row was already added (with no link yet) when the
  // share screen opened — fill in the real Drive file id/link now that the
  // upload has actually finished. A bare .../view URL is a valid, working
  // Drive share link without needing an extra API call to fetch the file's
  // real webViewLink (the share screen already does that separately for its
  // own copy-link button).
  if (message.fileId) {
    await updateRecentRecording(message.recordingId, {
      driveFileId: message.fileId,
      shareLink: `https://drive.google.com/file/d/${message.fileId}/view`,
    });
  }

  const session = await getActiveSession();
  if (session && session.recordingId === message.recordingId) {
    if (session.shareTabId !== undefined) {
      const readyMessage: ShareUploadReadyMessage | ShareUploadFailedMessage = message.fileId
        ? { type: 'share:upload-ready', recordingId: message.recordingId, fileId: message.fileId }
        : { type: 'share:upload-failed', recordingId: message.recordingId };
      console.log(LOG, 'Notifying share screen tab', session.shareTabId, readyMessage.type);
      await chrome.tabs.sendMessage(session.shareTabId, readyMessage).catch((err) => {
        console.warn(LOG, 'Failed to notify the share screen tab (it may have been closed)', err);
      });
    } else if (message.fileId && session.config.accountId) {
      // No share tab was tracked for this recording (shouldn't normally
      // happen if an account was connected) — open one now rather than
      // silently losing the link.
      console.warn(LOG, 'No share tab was tracked for this recording — opening one now as a fallback', message.recordingId);
      const startedAt = session.startedAt ?? Date.now();
      const stoppedAt = session.stoppedAt ?? Date.now();
      await chrome.tabs.create({
        url: shareScreenUrl({
          fileId: message.fileId,
          recordingId: session.recordingId,
          accountId: session.config.accountId,
          title: session.config.title,
          recordedAtIso: new Date(startedAt).toISOString(),
          durationMs: Math.max(0, stoppedAt - startedAt),
          sourceUrl: session.sourceTabUrl,
        }),
      });
    }
    await clearActiveSession();
  } else {
    console.warn(LOG, 'No matching active session when upload finished', message.recordingId);
  }
  await closeOffscreenDocument();
}

function handleBlobReady(message: OffscreenBlobReadyMessage): void {
  // Reconstructed here, right on receipt — offscreen.ts sends an array of
  // per-chunk ArrayBuffers + mimeType, not a Blob (a bare Blob doesn't
  // survive the structured clone from that context — see
  // OffscreenBlobReadyMessage's own comment). `new Blob(buffers, { type })`
  // handles the multi-part reassembly itself, rather than this project doing
  // it by hand — the same construction entrypoints/share/App.tsx's own
  // handleDownload already relies on for its IndexedDB-chunks fallback.
  // localRecordingBlobs itself still stores a real Blob, same as before.
  const expectedBytes = message.chunkArrayBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const blob = new Blob(message.chunkArrayBuffers, { type: message.mimeType });
  console.log(LOG, 'Reconstructed local recording blob from', message.chunkArrayBuffers.length, 'chunk(s)', message.recordingId, {
    expectedBytes,
    blobSize: blob.size,
    bytesMatch: blob.size === expectedBytes,
  });
  localRecordingBlobs.set(message.recordingId, blob);
  console.log(LOG, 'Stored local recording blob for instant playback', message.recordingId, blob.size, 'bytes');

  const waiters = pendingBlobRequests.get(message.recordingId);
  if (waiters) {
    pendingBlobRequests.delete(message.recordingId);
    console.log(LOG, `Resolving ${waiters.length} share-screen request(s) that arrived before this blob did`, message.recordingId);
    waiters.forEach((resolve) => resolve(blob));
  }
}

// A bare Blob does not actually survive chrome.runtime.sendMessage's
// structured clone between the service worker and an ordinary extension page
// (confirmed live: the share screen received `undefined` where the Blob
// should have been) — unlike ArrayBuffer, which does. Converting here, right
// at the point of response, means localRecordingBlobs itself keeps storing
// real Blobs (no change to handleBlobReady or the Map).
async function blobToTransferable(blob: Blob): Promise<{ arrayBuffer: ArrayBuffer; mimeType: string }> {
  return { arrayBuffer: await blob.arrayBuffer(), mimeType: blob.type };
}

type LocalBlobResponse = { arrayBuffer: ArrayBuffer; mimeType: string } | { arrayBuffer: null };

// Responds immediately if the blob is already here; otherwise queues this
// request (see pendingBlobRequests above) and responds once offscreen:blob-
// ready arrives, or after BLOB_REQUEST_TIMEOUT_MS if it never does.
function handleRequestLocalBlob(message: ShareRequestLocalBlobMessage, sendResponse: (response: LocalBlobResponse) => void): void {
  const existing = localRecordingBlobs.get(message.recordingId);
  if (existing) {
    console.log(LOG, 'Local recording blob already present — responding immediately', message.recordingId, existing.size, 'bytes');
    blobToTransferable(existing).then(sendResponse);
    return;
  }

  console.log(LOG, 'Local recording blob not here yet — queuing this request', message.recordingId);
  let resolved = false;
  const resolve = (blob: Blob | null) => {
    if (resolved) return;
    resolved = true;
    if (blob) {
      blobToTransferable(blob).then(sendResponse);
    } else {
      sendResponse({ arrayBuffer: null });
    }
  };
  const waiters = pendingBlobRequests.get(message.recordingId) ?? [];
  waiters.push(resolve);
  pendingBlobRequests.set(message.recordingId, waiters);
  setTimeout(() => {
    if (!resolved) console.warn(LOG, 'Local recording blob never arrived within timeout — falling back to Drive-only preview', message.recordingId);
    resolve(null);
  }, BLOB_REQUEST_TIMEOUT_MS);
}

function handleBlobDone(message: ShareBlobDoneMessage): void {
  localRecordingBlobs.delete(message.recordingId);
  console.log(LOG, 'Share screen released local recording blob', message.recordingId);
}

export default defineBackground(() => {
  browser.commands.onCommand.addListener((command) => {
    if (command === 'open_popup') {
      browser.action.openPopup();
    }
  });

  // The widget/bubble must always be on whatever tab is currently active,
  // regardless of *how* it became active — a plain tab switch, a page
  // load/reload, a single-page app's own in-app route change, or a brand
  // new tab. Rather than reacting differently to each of those, all three
  // events below call ensureWidgetOnTabIfActive() with the tabId the event
  // itself provides — NOT a fresh chrome.tabs.query({currentWindow: true})
  // re-derivation, which is unreliable from a service worker (see that
  // function's own comment) — each one confirms its own tab really is the
  // active one before doing anything, self-healing regardless of why the
  // widget/bubble might be missing there.
  chrome.tabs.onActivated.addListener((activeInfo: chrome.tabs.OnActivatedInfo) => {
    console.log(LOG, '*** chrome.tabs.onActivated fired', activeInfo);
    void ensureWidgetOnTabIfActive(activeInfo.tabId);
  });

  // Fires on page load/reload/URL change — the only signal (short of the
  // webNavigation listener below, for in-app route changes) that a tab's
  // own page just changed under us and may have lost what we injected.
  chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
    if (changeInfo.status !== 'complete' && !changeInfo.url) return;
    console.log(LOG, '*** chrome.tabs.onUpdated fired', tabId, changeInfo);
    void ensureWidgetOnTabIfActive(tabId);
  });

  // chrome.tabs.onUpdated alone does not reliably fire for a single-page
  // app's own history.pushState/replaceState navigation (confirmed missing
  // on a real support-ticket site that re-renders its own <body> on route
  // change without a real page load) — onHistoryStateUpdated is the
  // dedicated signal for exactly that.
  chrome.webNavigation.onHistoryStateUpdated.addListener((details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
    console.log(LOG, '*** chrome.webNavigation.onHistoryStateUpdated fired', details.tabId, details.url);
    void ensureWidgetOnTabIfActive(details.tabId);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Logged unconditionally, before the switch, so a click that never
    // shows up here at all (vs. one that shows up but fails inside its own
    // handler) are distinguishable from the service worker's own console —
    // deliberately added while chasing the "Stop needs two clicks" report,
    // since two rounds of fixes based on reading the code alone didn't
    // resolve it and the next step needs the actual console output.
    console.log(LOG, '*** onMessage received', message?.type, 'from', _sender?.tab?.id ?? '(no tab / offscreen or popup)');
    switch (message?.type) {
      case 'popup:start-recording':
        startRecording(message).then(
          () => sendResponse({ success: true }),
          (err) => {
            console.error(LOG, 'startRecording failed', err);
            sendResponse({ success: false, message: err instanceof Error ? err.message : 'unknown error' });
          },
        );
        return true;
      case 'widget:countdown-done':
        handleCountdownDone(message).then(() => sendResponse({ success: true }));
        return true;
      case 'widget:pause-clicked':
        handlePauseClicked(message).then(() => sendResponse({ success: true }));
        return true;
      case 'widget:resume-clicked':
        handleResumeClicked(message).then(() => sendResponse({ success: true }));
        return true;
      case 'widget:stop-clicked':
        handleStopClicked(message).then(() => sendResponse({ success: true }));
        return true;
      case 'widget:cancel-clicked':
        handleCancelClicked(message).then(() => sendResponse({ success: true }));
        return true;
      case 'widget:webcam-close-clicked':
        handleWebcamCloseClicked(message).then(() => sendResponse({ success: true }));
        return true;
      case 'offscreen:ended':
        handleOffscreenEnded(message).then(() => sendResponse({ success: true }));
        return true;
      case 'offscreen:upload-progress':
        handleUploadProgress(message).then(() => sendResponse({ success: true }));
        return true;
      case 'offscreen:upload-disabled':
        handleUploadDisabled(message).then(() => sendResponse({ success: true }));
        return true;
      case 'offscreen:upload-finished':
        handleUploadFinished(message).then(() => sendResponse({ success: true }));
        return true;
      case 'offscreen:blob-ready':
        handleBlobReady(message);
        sendResponse({ success: true });
        return true;
      case 'share:request-local-blob':
        handleRequestLocalBlob(message, sendResponse);
        return true;
      case 'share:blob-done':
        handleBlobDone(message);
        sendResponse({ success: true });
        return true;
      default:
        return false;
    }
  });
});
