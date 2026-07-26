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
    // Pins the extension's ID to a fixed value, regardless of which machine
    // or folder path it's loaded (unpacked) from. Without this, Chrome
    // derives an unpacked extension's ID from the absolute path of the
    // folder it was loaded from — so the exact same files, loaded on two
    // different machines (or even the same machine at a different path),
    // get two different IDs. That breaks OAuth specifically:
    // chrome.identity.getRedirectURL() embeds the extension ID
    // (https://<id>.chromiumapp.org/), so a redirect URI registered in
    // Google Cloud Console for one machine's ID produces
    // Error 400: redirect_uri_mismatch on any other machine — confirmed
    // live (worked on the original dev machine, failed identically on a
    // second machine loading the same downloaded folder). This key is the
    // base64 DER-encoded public half of a keypair generated solely to pin
    // this ID — it is not a secret and carries no OAuth credentials of its
    // own; the private key never leaves the machine that generated it and
    // isn't needed again unless this key ever needs to be regenerated.
    // Resulting fixed extension ID: kgbpncnkocggadpklblgfpibcooeoalg
    // Resulting fixed OAuth redirect URI:
    //   https://kgbpncnkocggadpklblgfpibcooeoalg.chromiumapp.org/
    // Anyone setting up their own Google Cloud OAuth client for QuickCast
    // must register exactly that redirect URI — see the in-app setup guide.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiBp0Xc1cgiZaleRsxkwafCvOfX4pwJ//AZcwUIqTcyll0OqtcoBNhiogHCUAavhPGz2k5d94AGkBnlWoDiouwrKGo8Aw101QXxYXI+EbwMOwpUnWxC2hlt77uEmE/0QuDqFynqXkwt6yDK8ocpO7EOFY5odJ9h6Hg5wsswKv1pYa9H9zgZABGFNoQGErasTrY2/cw0hj+FvNoaWTOEbAW6dMUgfL29VJnjKKRYhXgIBUTnp4tTeTlndGk4RxSgmnTfGMfy/qBCr6V/sIfnc9rfjIrHalypsW+ZpVLhgjwZNqvDKZqZYzU2fA0n4+saUcwbHxIFoQR2qeGvwrb0LhOwIDAQAB',
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
