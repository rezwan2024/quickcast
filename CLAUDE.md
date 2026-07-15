# CLAUDE.md — Rules for working on QuickCast

Read this file first before doing any work on this project. It tells you how to work, what to check, and what will cause a Chrome Web Store rejection.

---

## Project docs (read in this order)

1. **`requirements.md`** — what and why. Feature scope. Non-goals. Constraints.
2. **`design.md`** — how it looks. Screens, flows, visual language. See `screenshots/` for UI reference.
3. **`plan.md`** — build order. 7 phases, each with acceptance criteria.
4. **`progress.md`** — living tracker. Read at start of every session, update at end.

When something isn't documented, ask before assuming. Do not invent scope.

---

## Working rules

- **One phase at a time.** Don't jump ahead. Each phase in `plan.md` must produce a working extension before moving to the next.
- **Verify "Done when" before checking things off.** Manually test in a real Chrome profile. Don't mark work complete because the code compiles.
- **Update `progress.md` after every session.** Check off items, log decisions, note blockers. This is the memory between sessions.
- **Simpler is better.** If a decision isn't in the docs, pick the simpler option and add a code comment explaining the tradeoff.
- **No new dependencies without a reason.** Every dependency ships to users' browsers. Justify additions in the decisions log.

---

## Coding standards

- **Language:** TypeScript strict mode. No `any` — use `unknown` and narrow.
- **Framework:** React function components + hooks. No class components.
- **Style:** Tailwind CSS utility classes. Avoid custom CSS files unless necessary.
- **Icons:** `@tabler/icons-react` only. Consistent visual language.
- **State:** local component state for UI; `chrome.storage.local` for persistence; a small Zustand store if cross-component state grows past 2–3 shared hooks.
- **File naming:** kebab-case for files (`recording-widget.tsx`), PascalCase for React components, camelCase for functions, SCREAMING_SNAKE for constants.
- **Formatting:** Prettier defaults, no bikeshedding. Run before every commit.
- **Errors:** never swallow. Log with context, surface to user via toast or share screen retry.
- **No comments explaining what code does.** Only comment *why*, when the reason isn't obvious.
- **Async:** `async/await`, not `.then()` chains.
- **Imports:** absolute paths from `@/` root, not relative `../../..` chains.

---

## Chrome Web Store approval rules

These are the rules Google's review team applies. Breaking any of them causes rejection.

### Manifest V3 requirements

- `"manifest_version": 3` — MV2 is not accepted.
- Background script must be a **service worker**, not a persistent page. Handle idle termination — always reconstruct state from `chrome.storage` on wakeup, never rely on in-memory state persisting.
- No `eval()`, no `new Function()`, no `unsafe-eval` in CSP. Only `wasm-unsafe-eval` is allowed if actually needed.
- **All code must be bundled locally in the extension package.** No `<script src="https://...">` tags. No fetching JavaScript from a remote server and executing it. This is the #2 reason for rejection.
- Data can be fetched from external sources (Drive API is fine), but only *data* — never *logic* / executable code.
- Modifying network requests: use `declarativeNetRequest` if ever needed. Not applicable to QuickCast.

### Permissions

- **Request only the minimum permissions needed.** This is the #1 reason for rejection.
- For QuickCast, the exact minimum set is:
  - `activeTab` — to know the current tab for capture context
  - `tabs` — to open the share screen in a new tab and read tab titles/URLs for capture metadata
  - `desktopCapture` — for screen/window capture
  - `storage` — for `chrome.storage.local`
  - `offscreen` — to run `MediaRecorder` outside the service worker (which can't handle media)
  - `identity` — for OAuth
  - `notifications` — for upload complete/failure notifications
- Host permissions:
  - `https://*.googleapis.com/*` — for Drive API calls
  - `https://accounts.google.com/*` — for OAuth
- **Do NOT request `<all_urls>` or broad host permissions.** Instant rejection.
- Every permission must be justified in the Web Store listing when submitting.

### Privacy policy (required)

- **Must exist and be hosted at a public URL** (not behind login).
- Must be linked from the OAuth consent screen and the Web Store listing.
- Must clearly state:
  - What data is collected (for QuickCast: none — everything is local or in user's own Drive)
  - How data is stored (locally in `chrome.storage.local` and IndexedDB only)
  - That no data is sent to any third-party server owned by the developer
  - That OAuth credentials are stored locally and never transmitted except to Google's OAuth endpoints
  - How users delete their data (uninstall the extension + optionally delete Google Cloud project)
- Include a **"Limited Use" statement** because we access user Drive data:
  > "QuickCast's use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. QuickCast only accesses files it created (`drive.file` scope) and never transmits Drive data to any third party."

### OAuth scope selection

- Use **`https://www.googleapis.com/auth/drive.file`** — NOT `drive` or `drive.readonly`.
  - `drive.file`: per-file access, only files the app creates. **Non-sensitive scope, no verification required.**
  - `drive` or `drive.readonly`: full Drive access. **Sensitive/Restricted scope, requires Google's verification (weeks-long review, video demo, security assessment for restricted scopes).**
- QuickCast only ever writes files it created, never reads other files → `drive.file` is exactly right.
- **QuickCast's architecture means users bring their own OAuth credentials.** Each user's Google Cloud project stays in "testing" mode with themselves as a test user (up to 100). Verification is NOT needed by the QuickCast developer — this is a huge simplification.
- If a user wants to publish their own OAuth credentials as production, that's on them. Not QuickCast's responsibility.

### Store listing requirements

Prepare all of these before submission:

- **Name:** ≤ 45 characters (`QuickCast — Screen Recorder for Support` fits)
- **Summary:** ≤ 132 characters (the search snippet)
- **Description:** ≤ 16,000 characters; first 2–3 sentences must sell it since they show in preview
- **Icons:** 128×128 PNG (main), plus 48×48 and 16×16 (Chrome auto-derives from 128 if quality holds)
- **Screenshots:** 1–5 at 1280×800 or 640×400 PNG. Must show real UI, not marketing mockups.
- **Category:** Productivity
- **Privacy practices form:** filled out honestly — no data collection, no personal info, no health data, no auth info transmitted, etc.
- **Privacy policy URL:** publicly accessible, hosted on a domain you own
- **Permission justifications:** one sentence per permission explaining why it's necessary
- **Distribution:** Public (or Unlisted if we want teammate-only access via link)

### Code quality signals reviewers look for

- Manifest is clean, minimal, permissions justified
- No unused permissions declared
- No console.error spam in production
- No obvious debug/dev-mode leftovers (`console.log("test")`, hardcoded credentials, TODO comments about security)
- All external API calls go to declared hosts
- No calls to unexpected domains

### Common rejection reasons (avoid all of these)

1. **Broad permissions** — using `<all_urls>` when a specific host suffices
2. **Remote code** — loading JS from a CDN and executing it
3. **Missing privacy policy** or one that doesn't actually cover what the extension does
4. **Vague description** — "Makes browsing better" tells the reviewer nothing
5. **Fake screenshots** — mockups instead of real UI, or screenshots showing features not in the extension
6. **Duplicate/spam behavior** — pretending to be another product
7. **Data collection not disclosed** — even local storage of user data must be disclosed
8. **Non-functional after install** — reviewer installs it, nothing happens, or it errors

### Review timeline

- First-time submission from a new account: **7–14 business days**
- Established account: **2–5 business days**
- Updates to existing extensions: **24–48 hours** in most cases
- Plan a **2-week buffer** from "final build" to "live on store."

### Update policy

- **Never add new permissions in an update.** Chrome will disable the extension for existing users until they re-consent, and reviewers scrutinize permission expansions.
- If a feature genuinely needs a new permission, use **optional permissions** requested at runtime with `chrome.permissions.request()`.
- Bump the version number in `wxt.config.ts` on every submission — Chrome requires monotonically increasing versions.

---

## Security must-nots

- **Never** log OAuth credentials (Client ID, Client Secret, access tokens, refresh tokens) to `console`.
- **Never** transmit OAuth credentials or tokens to any server other than Google's OAuth endpoints.
- **Never** store credentials in `chrome.storage.sync` — sync is not designed for secrets. Use `chrome.storage.local` only.
- **Never** hardcode any OAuth client ID or secret in the extension code. Users bring their own.
- **Never** expand OAuth scope beyond `drive.file` without explicit discussion — it triggers Google verification.
- **Never** capture data from tabs the user didn't explicitly select as the recording source.
- **Do** clear all tokens and credentials when the user disconnects an account.
- **Do** validate every input from the user (Client ID format, Client Secret non-empty) before storing.

---

## Chrome extension architecture notes

- **Service worker** (`entrypoints/background.ts`) handles: OAuth token refresh, upload retry when network returns, notifications. Cannot use `MediaRecorder` or DOM APIs — those live in the offscreen document.
- **Offscreen document** (`entrypoints/offscreen/`) hosts `MediaRecorder` since MV3 service workers can't access media APIs. Communicate with the service worker via `chrome.runtime.sendMessage`.
  - **`getUserMedia` permission prompts cannot be shown from the offscreen document** — it's invisible, so Chrome silently dismisses any prompt it would need to show there (`NotAllowedError: Permission dismissed`), rather than erroring loudly. **Confirmed fix, in production use:** request the permission first from a *visible* page — the popup, in `handleStart()` — then immediately stop the tracks; once granted, the offscreen document's own later `getUserMedia` call for the *same* permission type succeeds without re-prompting, since Chrome scopes media permissions per-origin and popup/offscreen/settings/share all share the extension's origin. Confirmed working for **microphone** (Phase 1) and requested the same way for **camera** (Phase 5's webcam bubble).
  - **Open, unconfirmed issue (Phase 5 → carried into Phase 6):** even after adding the popup-side camera permission request (mirroring the confirmed-working mic pattern above, and confirmed via the user granting a real prompt), the webcam's on-screen preview bubble still doesn't appear during recording — though the webcam *is* still composited into the recorded video correctly. The root cause was never actually confirmed — the one piece of evidence that would show it (the offscreen document's own console, via `chrome://extensions` → this extension → "Inspect views: offscreen.html") was requested but never obtained. **Do not assume the mic-pattern fix is insufficient for camera** without that evidence — treat as unexplained, not as a proven camera-specific limitation, until someone actually reads that console output.
- **Content script** (`entrypoints/content/`) injects the floating recording widget into the active tab. Must be resilient to CSS conflicts on host pages (use Shadow DOM or aggressive namespacing).
- **Popup** (`entrypoints/popup/`) is short-lived — closes when it loses focus. Persist any state to `chrome.storage.local` immediately, don't rely on component memory.
- **Settings and Share pages** (`entrypoints/settings/` and `entrypoints/share/`) are full HTML pages opened as new tabs. Long-lived, can hold state normally.

Communication between contexts: `chrome.runtime.sendMessage` for one-shot, `chrome.runtime.connect` for streaming (e.g., upload progress updates from offscreen to widget).

---

## Pre-submission checklist

Copy this into `progress.md` when Phase 6 starts:

```
[ ] manifest_version: 3
[ ] All code bundled locally, no remote scripts
[ ] No eval() or unsafe-eval in CSP
[ ] Service worker handles idle termination correctly
[ ] Permissions audited — minimum necessary set only
[ ] All permissions justified in the listing
[ ] OAuth uses drive.file scope only (non-sensitive)
[ ] Privacy policy hosted at public URL
[ ] Privacy policy includes Limited Use statement
[ ] Icons: 128×128, 48×48, 16×16 PNG
[ ] Screenshots: 1–5 at 1280×800, showing real UI
[ ] Name ≤ 45 chars, Summary ≤ 132 chars
[ ] Description first 3 sentences sell the value
[ ] Privacy practices form filled honestly
[ ] Version number set in wxt.config.ts
[ ] Tested on Chrome + Edge (Chromium)
[ ] Tested with fresh Chrome profile (empty state works)
[ ] No console.log leftovers, no hardcoded secrets
[ ] .zip built via `pnpm zip`
[ ] Uploaded to Chrome Web Store Developer Dashboard
[ ] Distribution set: Public (or Unlisted for teammate-only)
```

---

## When in doubt

- Prefer the simpler implementation.
- Prefer fewer permissions.
- Prefer local processing over any network call.
- Ask before adding a dependency.
- Ask before expanding scope beyond what's in `requirements.md`.
- If something in the docs contradicts something you're doing, **stop and ask** — don't quietly deviate.
