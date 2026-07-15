const OFFSCREEN_URL = 'offscreen.html';

export async function ensureOffscreenDocument(): Promise<void> {
  const hasDocument = await chrome.offscreen.hasDocument();
  if (hasDocument) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // USER_MEDIA covers the mic getUserMedia() call; DISPLAY_MEDIA covers the
    // screen/window/tab capture via getDisplayMedia().
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.DISPLAY_MEDIA],
    justification: 'Records the screen/mic via MediaRecorder, which service workers cannot access directly.',
  });
}

export async function closeOffscreenDocument(): Promise<void> {
  const hasDocument = await chrome.offscreen.hasDocument();
  if (hasDocument) await chrome.offscreen.closeDocument();
}
