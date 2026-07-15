import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'QuickCast',
    description: 'Screen recorder for support engineers — records to your own Google Drive.',
    version: '0.1.0',
    icons: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    // webNavigation added specifically for chrome.webNavigation.onHistoryStateUpdated
    // — the only reliable signal for a single-page app's own in-app route
    // change (history.pushState/replaceState), which chrome.tabs.onUpdated
    // does not fire for on its own. Needed so the widget/bubble can heal
    // themselves on a real support site that re-renders its own page on
    // navigation without a full reload (see entrypoints/background.ts's
    // ensureWidgetOnActiveTab). Not a host permission — doesn't expand what
    // sites QuickCast can read/modify, only what *navigation events* it's
    // told about for tabs it can already message.
    permissions: ['activeTab', 'tabs', 'storage', 'offscreen', 'identity', 'notifications', 'scripting', 'webNavigation'],
    host_permissions: ['https://*.googleapis.com/*', 'https://accounts.google.com/*'],
    // Not requested by default — chrome.scripting.executeScript otherwise
    // has no way to inject the recording widget into a tab the user merely
    // switches to mid-recording (activeTab only ever covers the one tab the
    // user actually clicked Start/the shortcut on, and that grant doesn't
    // extend to tabs visited afterward). Requested at runtime via
    // chrome.permissions.request(), only when the user turns on Settings'
    // "Follow recording across tabs" toggle — see lib/preferences.ts's
    // getFollowAcrossTabs and entrypoints/settings/App.tsx.
    optional_host_permissions: ['<all_urls>'],
    // Lets an arbitrary host page's own content script embed
    // widget-frame.html in an <iframe> — required for Chrome to allow
    // loading a chrome-extension:// URL inside a foreign page's DOM at all;
    // without this the browser blocks the request outright regardless of
    // any other permission. This does NOT grant the extension any new
    // access to those pages (unlike a host permission) — it only says which
    // pages are allowed to *load this one file*, which is the entrypoints/
    // widget-frame/ CSS-isolation fallback for the widget (see
    // entrypoints/content/index.ts's activateIframeFallback). Kept scoped
    // to <all_urls> only because the widget can legitimately be needed on
    // any tab the user records, same reasoning as optional_host_permissions
    // above, but this specific manifest key carries no such runtime opt-in
    // — it's inert until a script actually tries to embed the resource.
    web_accessible_resources: [
      {
        resources: ['widget-frame.html'],
        matches: ['<all_urls>'],
      },
    ],
    commands: {
      open_popup: {
        suggested_key: {
          default: 'Ctrl+Shift+0',
          mac: 'Command+Shift+0',
        },
        description: 'Open the QuickCast popup',
      },
    },
  },
});
