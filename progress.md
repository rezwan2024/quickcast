# QuickCast — Progress

Living document. Update after every meaningful work session — check off completed items, log decisions, note blockers.

Kept intentionally concise: this file holds the **current state** and **confirmed root causes/fixes**, not a diary of every intermediate wrong turn during a debugging session. When a bug takes several rounds to solve, only the final, confirmed explanation and fix belong here — not each disproven theory along the way. If a past investigation's full detail is ever needed, it's in the conversation history that solved it, not here.

---

## Current status

- **Phase:** 6 — in progress. Core functionality (record → upload → share) is complete and confirmed working end-to-end on real BuddyBoss support workflows, across multiple Google accounts, with cross-tab following.
- **Last worked on:** 2026-07-26
- **Known issues, parked (not blocking, not currently being worked):**
  - **Local instant-preview video playback intermittently fails** on the share screen. It falls back gracefully to Drive's own preview iframe automatically — the share link and download both work regardless. Root cause never fully confirmed despite a thorough pipeline audit (see Decisions log) — the one missing piece of evidence is the actual `MediaError.code` from the `<video>` element's `onError` handler (already logged, just never captured live).
  - **support.buddyboss.com-specific: the recording pill can still fail to (re)appear** in some repeat-recording / toggle-state combination on that one site specifically (the only site confirmed to actively mutate the extension's own DOM). One concrete cause was found and fixed (a missing state reset between recordings — see Decisions log), but a further edge case remains. No other site is affected. Parked at the user's explicit request.

---

## Phase checklist

### Phase 0 — Project scaffold
- [x] WXT + React + TS scaffolded, manifest permissions configured, keyboard shortcut registered, Tailwind + Tabler Icons working.

### Phase 1 — Recording (local only)
- [x] Core pipeline confirmed end-to-end: screen capture → MediaRecorder (VP9/Opus) → IndexedDB chunking → download.
- [x] Countdown removed entirely (2026-07-26, explicit user request) — recording now starts immediately on Start.
- [ ] Never explicitly tested: Window/Tab capture modes (only Screen mode used in practice), a full 30-minute recording, mic device-selection UI.

### Phase 2 — Google account connection
- [x] OAuth confirmed working end-to-end. **Working configuration, don't relitigate:** OAuth client must be **Web application** type (not "Chrome Extension"), PKCE authorization-code grant, `client_secret` included in the token exchange, redirect URI registered with a **trailing slash** (`chrome.identity.getRedirectURL()` always returns one — a missing trailing slash is the #1 cause of `redirect_uri_mismatch`), `prompt=select_account consent` to force the account chooser.
- [x] Token refresh on 401 implemented and working.
- Known transient quirk (not a bug): right after a brand-new consent grant, Google's `tokeninfo` endpoint can briefly under-report the granted scope — `fetchGrantedScopes()` already retries 3× before concluding it's genuinely missing.

### Phase 3 — Chunked streaming upload
- [x] Confirmed working end-to-end — live progress, resumable session, correct final-chunk sizing, "anyone with the link" permission set automatically.

### Phase 4 — Share screen + Drive organization
- [x] Confirmed working — share screen opens immediately on Stop, link auto-copied, title/notes sync to Drive, monthly folder auto-created (`QuickCast Recordings/{YYYY-MM}/`).

### Phase 5 — Multi-account & defaults
- [x] Multi-account connect/dedupe/disconnect/default, per-account storage bars, Storage behavior setting, Recording defaults (quality/fps/webcam corner), Recent recordings list — all confirmed working.
- [x] Webcam appears in the recorded video — confirmed, though the underlying architecture changed since (see Decisions log: the on-page bubble is now the sole source, not a separate offscreen composite).

### Phase 6 — Distribution & polish
- [x] Real icons, empty states, error toasts.
- [x] Webcam bubble: content script owns its own camera directly, follows across tabs — confirmed working.
- [x] Cross-tab "follow recording across tabs" (widget + webcam bubble) — confirmed working once the underlying permission is actually granted (see Decisions log for a toggle-display bug fixed 2026-07-26).
- [x] Original-tab widget-visibility bug on support.buddyboss.com — root cause found and fixed 2026-07-26 (see Decisions log). The earlier "Tailwind class conflict" theory was wrong; don't re-open it.
- [x] Duplicate webcam bubble in the recorded output video — fixed 2026-07-25 (see Decisions log).
- [x] Browser slowdown/hang during recording — resolved, confirmed by the user 2026-07-26.
- [ ] Not done yet: README for teammates, `pnpm zip` distribution packaging, Edge cross-check, pre-submission checklist walkthrough (see CLAUDE.md).

---

## Decisions log

Architecture and behavior decisions, and their current, confirmed state — not a session-by-session diary. Superseded reasoning is removed, not preserved.

- **OAuth**: users bring their own Google Cloud OAuth credentials, `drive.file` scope only (non-sensitive, no Google verification required). See Phase 2 above for the exact working client configuration.
- **Recording architecture**: the offscreen document owns `getDisplayMedia()`/`MediaRecorder`/mic. It does **not** own a webcam. The content script owns the on-page timer widget/pill and, if cam is on, its own independent webcam bubble — each tab that ever shows a bubble opens its own camera independently (there is no cross-tab camera/track handoff on the web platform).
- **Webcam architecture — rewritten 2026-07-25 (double-bubble fix):** previously, both the content script (for the live on-screen bubble) *and* the offscreen document (compositing a circle onto the recorded canvas) independently opened the camera. Since the on-page bubble is itself part of whatever the screen/window/tab capture records, this produced **two overlapping camera circles in the recorded output**. Fixed by removing the offscreen document's camera/canvas-compositing entirely (`lib/webcam-compositor.ts` deleted) — the content-script's on-page bubble is now the *only* source of the webcam, both live and in the recording. **Accepted trade-off:** if `mode: 'window'` and the user shares a window other than the browser (or a monitor that doesn't show it), the webcam won't appear in the recording at all — confirmed acceptable by the user. This is also very likely why the long-standing browser slowdown/hang during recording is now resolved — it removed a continuous `setInterval`-driven full-resolution canvas redraw that had been running for the entire duration of every recording.
- **Countdown removed entirely (2026-07-26):** recording now starts immediately when Start is clicked — no 3-2-1 overlay, no `countdownSeconds` anywhere in config, messaging, or preferences. `WidgetEnsureStateMessage.phase` is now just `'recording' | 'paused'`. One correctness fix made during this removal: `prepare()` (offscreen) now returns `uploadDisabledReason` directly in its own response, read and persisted into the session *before* the widget is ever mounted — previously this relied on a separate best-effort broadcast that depended on the widget already being mounted, a dependency the countdown's own delay used to (accidentally) guarantee.
- **Original-tab widget-visibility bug on support.buddyboss.com — actual root cause, confirmed 2026-07-26:** the page's own script actively mutates the extension's shadow-DOM host element's attributes (confirmed via a live console warning). An earlier fix from 2026-07-15 (a Tailwind-conflict-free `RecordingPill` component) had appeared to resolve this at the time but was not actually addressing the real cause — it likely just avoided triggering the mutation during that one test. Fixed properly with a last-resort `<iframe>` fallback (`entrypoints/widget-frame/`) that had already been scaffolded months earlier but was never actually wired up — `lastFrameState` is now kept live, `postStateToIframe()`/`removeIframeFallback()` are now actually called, and a `window.addEventListener('message', ...)` handler was added to receive the iframe's own handshake/button clicks. The fallback now activates immediately on a confirmed shadow-host mutation.
  - **Found and fixed along the way:** the `MutationObserver` callback was firing this logic on *any* DOM mutation anywhere on the whole page (it ignored its own `mutations` argument) — falsely triggering the iframe fallback on ordinary sites with normal dynamic content, not just support.buddyboss.com. Now correctly filters to mutations whose `target` is the shadow host itself.
  - **Found and fixed along the way:** `widgetIframe`/`lastFrameState` were missing from the per-recording state reset (only two older flags were reset there). A stale iframe reference from a first recording made a second recording (same tab, no reload) think the widget was "already healthy" and skip mounting anything — now reset alongside the other flags.
  - **Known remaining gap, parked 2026-07-26:** a further site-specific edge case (pill not reappearing in some toggle/repeat-recording combination) still exists on support.buddyboss.com specifically, nowhere else. Next step if picked back up: the *page* console (not background) from that exact tab, filtered to `QC-DIAG`, from the moment of a live repro — extensive diagnostic logging is already in place (see below) and should pinpoint exactly where it breaks.
- **Cross-tab-follow permission toggle bug — fixed 2026-07-26:** the Settings toggles ("Show recording widget/webcam bubble on any tab") displayed as ON by default even when the real underlying `<all_urls>` Chrome permission had never actually been granted — the *stored preference* defaults to `true` independently of the real grant, which can only ever happen via an explicit click. Fixed: the toggle's displayed state now reflects the real grant (`hasCrossTabPermission()`), not just the stored preference — if they disagree, the stale preference is corrected to `false` so the next click actually fires the real permission request.
- **`[QC-DIAG]`-prefixed console logging:** added throughout `entrypoints/content/index.ts`, `entrypoints/background.ts`, `components/recording-pill.tsx`, `components/recording-widget.tsx` during the 2026-07-26 pill-visibility investigation. Still in place — useful for the remaining support.buddyboss.com edge case above. Safe to remove once that's resolved.
- **Instant local-preview playback (share screen):** plays the recording from a local Blob immediately, before Drive finishes transcoding, falling back to Drive's own `/preview` iframe if local playback fails (which it still sometimes does — see Current status). The full pipeline (IndexedDB chunks → per-chunk ArrayBuffers → background reconstructs one Blob → re-serializes to ArrayBuffer → share screen reconstructs the Blob again) has been verified byte-correct. If picked up again, get the actual `MediaError.code`/`.message` first — not another pipeline-correctness pass.
- **Permissions model:** `activeTab`, `tabs`, `storage`, `offscreen`, `identity`, `notifications`, `scripting`, `webNavigation` (required); `<all_urls>` as `optional_host_permissions` only, requested at runtime via the Settings toggle above. Never add `<all_urls>` (or any broad host permission) to the required set.

---

## Session log (short form — see Decisions log above for detail)

- 2026-07-25 — Fixed duplicate webcam bubble in the recorded output video (removed the offscreen document's canvas compositor entirely).
- 2026-07-26 — Removed the countdown feature entirely; recording now starts immediately on Start.
- 2026-07-26 — Root-caused and fixed the support.buddyboss.com widget-visibility bug: wired up the previously-dead iframe fallback, fixed a MutationObserver false-positive, fixed a missing state reset between recordings.
- 2026-07-26 — Fixed the cross-tab-follow permission toggles showing ON when the real Chrome permission had never been granted.
- 2026-07-26 — Confirmed: the long-standing browser slowdown/hang during recording is resolved.
- 2026-07-26 — Minor UI: `RecordingWidget` height bumped slightly (`RecordingPill`, used on the original tab, left unchanged).
- 2026-07-26 — Parked: a further support.buddyboss.com-specific repeat-recording pill edge case, and the intermittent local-preview video playback failure (see Current status).
