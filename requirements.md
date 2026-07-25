# QuickCast — Requirements

A personal screen recording tool for support engineers. Chrome extension. Records screen + mic + optional webcam, streams the upload to the user's own Google Drive during recording, and returns a shareable Drive link within seconds of stopping.

Built as an alternative to Loom to remove storage limits and manual video cleanup. Each user runs their own independent instance with their own Google account(s).

---

## Users

Support engineers who need to record short walkthroughs (bug repros, configuration guides, how-tos) and send a link to a client. Videos are 5–20 minutes typically. Clients watch the video in a browser and reply asynchronously.

There is no team account and no shared infrastructure. Each user connects their own Google Drive account(s).

---

## Non-goals

To keep scope tight, the tool does **not**:

- Host videos on any server owned by the developer (no S3, no CDN, no backend)
- Use any paid service (no Whisper, no LLM API, no URL shortener, no paid storage)
- Provide team features (shared library, admin, permissions, seat management)
- Provide viewer analytics (who watched, how long, when)
- Provide AI features (transcription, auto-titling, auto-tagging)
- Support browsers other than Chrome/Edge (Chromium-based only)
- Provide video editing beyond trim (no filters, annotations, effects, cuts, merging)
- Auto-generate custom short URLs (Drive URL is shared as-is)

---

## Core features

### 1. Recording

- Screen capture modes: full screen, application window, single browser tab
- Microphone capture with device selection
- Optional webcam bubble overlay (circular, draggable to any corner during recording)
- No hard time limit; must reliably handle 30+ minute recordings
- Local safety copy: recording is always saved locally in IndexedDB during capture, so a network drop never loses the video
- Recording starts immediately on Start — no countdown
- Controls during recording: pause, resume, stop, cancel/delete
- Keyboard shortcut: `Ctrl+Shift+0` (Windows/Linux) / `Cmd+Shift+0` (Mac) opens the QuickCast popup. Chosen to avoid Chrome's reserved shortcuts (e.g., `Ctrl+Shift+R` is hardcoded for hard reload). Users can rebind it anytime via `chrome://extensions/shortcuts`.
- Video format: WebM (VP9 + Opus) via `MediaRecorder`

### 2. Chunked streaming upload to Google Drive

- Recording is chunked in real time (via `MediaRecorder` `timeslice`)
- Chunks upload to Drive continuously **during** recording using Drive's resumable upload API with unknown-size sessions (`Content-Range: bytes N-M/*`)
- By the time the user hits Stop, most of the file is already uploaded
- Post-stop wait is only the final buffered chunk (~2–5 seconds on typical connections)
- On network drop: upload pauses, retries automatically, resumes from last confirmed byte
- If upload cannot complete, user can retry from the share screen using the local copy

### 3. Multi-account Google Drive support

- User can connect multiple Google Drive accounts (Workspace or personal Gmail)
- Each connected account uses the user's own Google Cloud OAuth credentials (Client ID + Secret), pasted once during setup
- Credentials are stored locally only, never transmitted anywhere except Google's OAuth endpoints
- One account is marked as default
- User can pick which account to upload to before each recording, or use the default
- Setting: always use default / ask each time / auto-switch to next account when default is >90% full
- Storage quota is fetched from Drive API and shown per account

### 4. Guided account setup

- First-time users see a setup guide (4 steps) to create their Google Cloud project
- Steps: create project → enable Drive API → configure OAuth consent + add test users → create OAuth Client ID (Chrome Extension type, using QuickCast's extension ID)
- Returning users adding a 2nd/3rd account skip the guide and go straight to pasting credentials
- Setup guide is reachable from Settings anytime

### 5. Post-recording share screen

- Appears immediately when recording stops
- Shows: upload status (usually "Ready in 2s"), video preview thumbnail, editable title, the Drive share link (auto-copied to clipboard on appearance), optional notes field
- Primary actions: Send email (opens default mail client with subject/body pre-filled including the link), Copy for Slack
- Secondary actions: trim, download local copy, delete (deletes both local and Drive copy)
- Notes field content is saved to the Drive file's description so it becomes searchable in Drive later

### 6. Drive file organization

Files are auto-organized in the user's Drive:

```
📁 QuickCast Recordings
  📁 {YYYY-MM}
    📼 {video-title}-{YYYY-MM-DD}.webm
```

Each uploaded file's Drive description is auto-populated with:
- Title (user's title or timestamp fallback)
- Recorded date/time
- Duration
- Source tab URL (if tab capture mode)
- User-entered notes

Sharing permission is set to "anyone with the link can view" via Drive API.

### 7. Recent recordings

- The extension popup shows the last 20 recordings (title, timestamp, which account it's on, copy-link button)
- No search, no filter, no thumbnails — deliberately minimal
- "View all in Drive" link opens the recordings folder in Drive
- Recent list is stored in `chrome.storage.local`

### 8. Settings

- Connected accounts (list, add, remove, set default, view storage per account)
- Storage behavior (default account / ask each time / auto-switch when full)
- Recording defaults (quality: 1080p/720p/480p, frame rate: 24/30/60 fps, webcam corner position)
- Keyboard shortcuts (view only for v1)
- Appearance (light / dark / system)
- Link to setup guide

---

## Constraints

- Zero paid services. Every dependency must have a free-forever tier that covers this use case.
- Zero backend. The extension talks only to Google's APIs and the user's own machine.
- Credentials and tokens stored only in `chrome.storage.local`. Never sent to any third party.
- Extension must remain functional under Chrome's Manifest V3 restrictions (service worker + offscreen document for media recording).
- Long recordings (30+ min) must not crash the extension. Chunks written to IndexedDB, uploaded, then discarded.

---

## Assumptions worth flagging

- Each user has an account on either Google Workspace or personal Gmail with enough Drive storage (or is willing to connect multiple accounts to stack free storage).
- Users are technical enough to complete the one-time Google Cloud OAuth setup with a guided walkthrough (~5 minutes).
- Default Drive API quota (1 billion queries/day per project, effectively unlimited for this use case) is sufficient; no quota increase form needs to be filled.
- Clients viewing shared videos have any modern browser and can access `drive.google.com` (i.e., not on a network that blocks Google Drive).

---

## Success criteria

- Time from clicking Stop to having a shareable link in the clipboard: **under 5 seconds** for a 10-minute recording on typical broadband.
- Storage capacity: limited only by how many Google accounts the user connects.
- Zero recurring cost to the user, forever.
- A user leaving the team can take all their recordings with them (they're in their own Drive already).
