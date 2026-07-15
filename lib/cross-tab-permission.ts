// The widget can only ever be injected into a tab Chrome has actually
// granted access to. `activeTab` (the extension's default, minimal
// permission) only ever covers the one tab the user directly interacted
// with — clicking the popup, or the keyboard shortcut — and that grant does
// NOT extend to tabs the user switches to afterward. There is no narrower,
// per-origin permission that covers "whatever tab becomes active next,
// whichever site that happens to be" — the only real option is the broad
// `<all_urls>` host permission, declared as `optional_host_permissions` in
// wxt.config.ts so it's never active by default and only ever requested
// here, at runtime, when the user explicitly opts in via Settings' "Follow
// recording across tabs" toggle. Chrome persists the grant itself, so
// there's no separate chrome.storage.local flag to keep in sync — `contains`
// is always the live, authoritative answer.
const ALL_URLS = { origins: ['<all_urls>'] };

export async function hasCrossTabPermission(): Promise<boolean> {
  return chrome.permissions.contains(ALL_URLS);
}

// Must be called synchronously from a user gesture (Chrome requirement for
// chrome.permissions.request) — i.e. directly inside a click handler, not
// after an intervening await.
export async function requestCrossTabPermission(): Promise<boolean> {
  return chrome.permissions.request(ALL_URLS);
}

export async function removeCrossTabPermission(): Promise<void> {
  await chrome.permissions.remove(ALL_URLS);
}
