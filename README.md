# QuickCast — Developer Branch

Full source code for QuickCast, a Chrome extension built with WXT + React + TypeScript + Tailwind CSS v4.

## Tech Stack

- WXT
- React
- TypeScript
- Tailwind CSS v4
- Manifest V3
- Google Drive Resumable Upload API
- Google OAuth 2.0

## Project Structure

- `entrypoints/` — extension entrypoints (background service worker, offscreen document, popup, settings, share, and widget-frame pages)
- `components/` — shared React UI components
- `lib/` — core logic (OAuth, Drive upload, storage, messaging, recording session)
- `types/` — shared TypeScript types
- `public/` — static assets copied as-is into the build
- `assets/` — assets processed by the build (icons, Tailwind CSS entry)
- `*.md` — project docs (see Documentation below)
- `wxt.config.ts` — WXT/extension configuration (manifest, permissions, etc.)

## Getting Started

1. Clone the repo
2. Switch to the `dev` branch
3. Run `npm install`
4. Run `npm run dev`
5. Load the extension from `.output/chrome-mv3-dev` in Chrome

## Documentation

Full requirements, design decisions, implementation plan, and progress are documented in the `.md` files in the project root: `CLAUDE.md`, `requirements.md`, `design.md`, `plan.md`, `progress.md`.

## OAuth Setup

Each user needs their own Google Cloud OAuth credentials. Refer to the setup guide in the docs for step-by-step instructions.

## Building for Production

1. Run `npm run build`
2. Zip the contents of `.output/chrome-mv3/` for Chrome Web Store submission

---

Built with ❤️ by rezwan2024
