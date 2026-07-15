# QuickCast — Implementation Plan

Phased build plan for Claude Code. Each phase is a shippable milestone — the extension should work end-to-end at the end of every phase, just with fewer features.

**Stack:** WXT + React + TypeScript. Chromium (Manifest V3) only. Tabler Icons.

**Dev commands** (after `pnpm install`):
- `pnpm dev` — dev mode with HMR, auto-loads unpacked in Chrome
- `pnpm build` — production build to `.output/chrome-mv3/`
- `pnpm zip` — package for distribution

**Testing approach:** manual end-to-end per phase, in a real Chrome profile. No unit tests for v1 — this is a personal tool, over-testing slows delivery.

---

## Phase 0 — Project scaffold

Get a minimal WXT + React project running with the right manifest and folder layout.

**Do:**
- `pnpm create wxt@latest quickcast --template react-ts`
- Set the extension name, description, icons in `wxt.config.ts`
- Configure manifest permissions: `activeTab`, `tabs`, `desktopCapture`, `storage`, `offscreen`, `identity`, `notifications`, and host permissions for `https://*.googleapis.com/*`
- Register the keyboard command `open_popup` bound to `Ctrl+Shift+0` / `Command+Shift+0`
- Set up folder structure:
  ```
  entrypoints/
    popup/          → main popup
    settings/       → settings page (new tab)
    share/          → share screen (new tab)
    background.ts   → service worker
    offscreen/      → offscreen document for MediaRecorder
    content/        → floating widget content script
  components/       → shared React components (Button, Modal, Input, etc.)
  lib/              → non-UI logic (drive.ts, oauth.ts, recorder.ts, storage.ts)
  types/            → shared TS types
  ```
- Install `@tabler/icons-react`, set up Tailwind or CSS Modules (pick Tailwind for speed)

**Done when:** `pnpm dev` launches Chrome with a placeholder popup that says "QuickCast" and the keyboard shortcut opens it.

---

## Phase 1 — Recording (local only, no upload)

Prove the recording pipeline works. Save the resulting WebM locally at the end — no Drive yet.

**Do:**
- Build the main popup UI per screenshot `01-popup.png`: title input, mode picker (Screen / Window / Tab), mic + cam toggles, disabled account picker, start button
- On Start: call `chrome.desktopCapture.chooseDesktopMedia` (or `getDisplayMedia` in offscreen doc) for the chosen source
- Get mic stream via `getUserMedia({ audio: true })`
- Combine tracks into one stream, feed to `MediaRecorder` with `mimeType: 'video/webm;codecs=vp9,opus'` and `timeslice: 1000` (1 sec chunks)
- Show 3-second countdown overlay before recording starts
- Chunks go into IndexedDB (using `idb` package) keyed by recording ID
- Build the floating recording widget per `02-recording-widget.png` — inject as content script, draggable, always on top. For now: timer, pause/resume, stop, cancel. Upload indicators can be static placeholders.
- On Stop: assemble chunks from IndexedDB into a Blob, trigger browser download of the `.webm` file
- On Cancel: purge IndexedDB entries, close widget

**Done when:** user can record a 5-min screen+mic video and download it as a playable WebM. Long recordings (30 min) don't crash the browser (verify chunks stream to IDB instead of living in memory).

---

## Phase 2 — Google account connection

Enable users to connect their first Drive account. No recording integration yet — this is pure OAuth + settings.

**Do:**
- Build the Settings page per `04-settings.png` — opens in a new tab from popup's gear icon
- Empty state: no accounts connected → prominent "Connect a Google Drive account" button
- Build the Connect modal per `05-connect-modal.png` — asks "have credentials?" with two paths
- Build the Setup guide modal per `06-setup-guide.png` — 4-step wizard with Back/Next, progress dots. Content per `design.md`.
- Build the Paste credentials modal per `07-paste-credentials.png` — Client ID + Secret inputs
- On "Connect and authorize" click:
  - Validate the format of Client ID / Secret (regex, non-empty)
  - Store in `chrome.storage.local` under `accounts[uuid].credentials`
  - Launch OAuth via `chrome.identity.launchWebAuthFlow` with scopes: `https://www.googleapis.com/auth/drive.file` (least-privilege — only files created by the app)
  - Store the returned access + refresh tokens under `accounts[uuid].tokens`
  - Fetch user profile (email, avatar) via `https://www.googleapis.com/oauth2/v2/userinfo`
  - Fetch storage quota via Drive API `about.get?fields=storageQuota,user`
  - Show the new account in the Settings list
- Implement token refresh flow — if a Drive API call returns 401, use refresh token to get a new access token, retry
- First account added becomes default automatically

**Done when:** user can walk through setup guide, paste credentials, complete OAuth, and see their account (with correct email, avatar, storage usage) listed in Settings.

---

## Phase 3 — Chunked streaming upload

Wire recording to Drive with true streaming upload during capture.

**Do:**
- Add the account picker to the main popup (screenshot `01-popup.png`) — pulls from stored accounts
- On Start recording:
  - Initiate a Drive resumable upload session (`POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`) with metadata: name, parents (target folder — see Phase 4), mimeType `video/webm`
  - Store the session URI
- As `MediaRecorder` produces chunks (via `ondataavailable` at 1-sec `timeslice`):
  - Append to a local buffer in IndexedDB
  - When buffer ≥ 2 MB (a multiple of 256 KB — Drive requirement), upload via `PUT` to the session URI with header `Content-Range: bytes {start}-{end}/*` (asterisk = size unknown yet)
  - On success, mark bytes as uploaded, drop them from the local buffer, keep going
- Update the floating widget in real time: "MB uploaded / total buffered", "MB/s", "~Xs after stop" (calculated from bytes remaining ÷ recent speed)
- Cloud icon color state: green if remaining upload time < 5s, amber if 5–30s, red if >30s
- On network error: exponential backoff retry (2s, 4s, 8s, 16s, 32s, then give up until reconnection detected via `navigator.onLine`)
- On network return: resume by querying Drive for received bytes (`PUT` with empty body and `Content-Range: bytes */*`), continue from confirmed offset
- On Stop: flush remaining buffer as final chunk with `Content-Range: bytes {start}-{end}/{TOTAL}` (real size, not asterisk), Drive returns the file ID
- Set the file's sharing permission to "anyone with the link can view" via `POST /files/{id}/permissions`

**Done when:** a 10-min recording is fully uploaded to Drive by the time user hits Stop, plus a maximum of 5 seconds. Kill the wifi mid-recording → recording keeps going, upload catches up when wifi returns.

---

## Phase 4 — Share screen + Drive organization

Deliver the payoff moment and organize files properly in Drive.

**Do:**
- On recording stop: open the share screen in a new tab (`entrypoints/share/`) with the file ID as a URL param
- Build the share screen per `03-share.png`: green check + upload time, video preview (use `<video>` with Drive's `webContentLink`), editable title, share link row with copy button, notes textarea, action buttons
- On page load: fetch file metadata from Drive, copy the shareable link to clipboard automatically, show a toast "Link copied"
- On title edit: `PATCH /files/{id}` to rename in Drive; also rename local record
- On notes save: `PATCH /files/{id}` to update `description` — build a structured description:
  ```
  Title: {user title or fallback}
  Recorded: {ISO datetime}
  Duration: {mm:ss}
  Source URL: {tab URL if tab capture, else "screen"}
  Notes:
  {user notes}
  ```
- Auto-folder creation: on first upload each month, ensure `QuickCast Recordings/{YYYY-MM}/` exists. Query with `q=name='...' and mimeType='application/vnd.google-apps.folder'`; create if missing.
- Set the file's `parents` to the correct monthly folder when initiating the upload (Phase 3 metadata step)
- Send email action: opens `mailto:?subject=...&body=...` with a template ("Hi, here's a walkthrough: {link}")
- Copy for Slack action: copies the plain link (Slack unfurls Drive links natively)
- Trim: v1 stub — for now, open the file directly in Drive; wire real trimming to Phase 6 or defer
- Download: fetch the local IDB copy (if still present) or `alt=media` from Drive
- Delete: `DELETE /files/{id}` + clear IDB + close tab

**Done when:** stopping a recording opens the share screen within 2 seconds, the link is in the clipboard, editing the title updates Drive, and the file lives in the correct monthly folder.

---

## Phase 5 — Multi-account, defaults, and polish

Now that the core flow is bulletproof, add the flexibility features.

**Do:**
- Multi-account UI: account switcher in popup, add-account flow from Settings (reuse Phase 2 modals)
- Per-account storage bar with color coding (green/amber/red thresholds)
- Storage behavior setting: use default / ask each time / auto-switch when default is ≥90% full
  - "Ask each time": pre-recording popup shows a step to pick account
  - "Auto-switch": before starting, check default quota via Drive `about.get`; if ≥90%, silently switch to next connected account with room
- Recording defaults: quality (1080p/720p/480p → maps to MediaRecorder `videoBitsPerSecond`: 3 Mbps / 1.5 Mbps / 800 Kbps), frame rate, countdown (0–5 sec), webcam corner
- Webcam bubble: second `getUserMedia({ video: true })` for camera, render to a `<canvas>` composite in the offscreen doc — screen fullsize + webcam as circle in chosen corner, then pipe canvas.captureStream() to MediaRecorder. Draggable in the widget UI. Toggle to hide during recording.
- Recent 20 recordings list: stored in `chrome.storage.local`. Popup's history icon opens a small list panel with title, timestamp, account, and copy-link button per row. "View all in Drive" link at the bottom opens the recordings root folder.

**Done when:** users can connect multiple accounts, switch between them per recording, configure quality/countdown/webcam, and see their recent recordings in the popup.

---

## Phase 6 — Distribution & final polish

Prepare for real-world use by BuddyBoss teammates.

**Do:**
- Real icon set (128, 48, 16 px) — record button motif with QuickCast wordmark for the 128
- Empty states for every screen (no accounts, no recordings, connection failed, offline, quota exhausted)
- Error toasts + retry UX (upload failed, OAuth failed, permission denied)
- Loading skeletons where relevant (settings account list, share screen preview)
- Onboarding: first-time popup opens Settings automatically if no account is connected
- Cross-check on Edge (Chromium, should Just Work but verify OAuth)
- README.md for teammates:
  - What QuickCast is
  - Install steps (Load unpacked or download signed .zip)
  - Google Cloud setup summary (with link to in-app guide)
  - Troubleshooting: OAuth errors, quota, network issues
- `pnpm zip` produces a distributable `.zip`. Optionally publish as unlisted Chrome Web Store listing ($5 one-time dev fee) so teammates can install with one click.

**Done when:** a teammate on a fresh Chrome profile can install the extension, follow the guide, record a video, and share the link — all without asking for help.

---

## Deferred (post-v1)

- Real trimming UI (currently redirects to Drive)
- Dark mode
- Firefox / Safari support
- Team library / shared folders
- Custom short URLs
- Voice transcription / AI titling (explicitly out of scope — see requirements.md non-goals)

---

## Working with Claude Code

- Tackle one phase at a time. Don't jump ahead.
- Each phase produces a working extension — always be able to `pnpm dev`, load it, and use what you built so far.
- After each phase, do a quick manual test using the "Done when" criteria before moving on.
- Reference `design.md` screenshots when building UI. Reference `requirements.md` when scope is unclear.
- If a decision isn't covered in these docs, prefer the simpler implementation and note the tradeoff in a code comment.
