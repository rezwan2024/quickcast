import type { Root } from 'react-dom/client';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { mountRecordingWidget } from '@/components/recording-widget';
import { mountRecordingPill } from '@/components/recording-pill';
import { mountWebcamBubble } from '@/components/webcam-bubble';
import type { WidgetEnsureStateMessage, WidgetWebcamCloseClickedMessage } from '@/lib/messaging';
import type { WebcamCorner } from '@/lib/preferences';
import type { WidgetFrameStateMessage, WidgetFrameToParentMessage } from '@/lib/widget-frame-messaging';
// Imported as a raw string (not cssInjectionMode: 'ui') and passed directly
// via createShadowRootUi's `css` option below. cssInjectionMode: 'ui' instead
// fetch()es the CSS at runtime from a chrome-extension:// URL, which some
// sites' Content-Security-Policy blocks (connect-src) — the failure is
// swallowed silently, leaving the shadow root with no styles at all. Inlining
// the CSS at build time has no runtime network request to block.
import widgetCss from '@/assets/tailwind.css?inline';

// wxt's own overlay positioning (see applyPosition in its shared.mjs) makes
// the shadow host `position: relative; width: 0; height: 0`, then positions
// the isolated <html> *inside* the shadow root with `position: absolute`
// relative to that 0×0 box — which itself sits wherever the host ends up in
// the page's normal layout flow. Our own components additionally use
// `position: fixed` for the actual visible content, which is normally
// viewport-relative regardless of ancestors — *unless* some ancestor
// between <body> and the shadow host establishes its own containing block
// for fixed-position descendants (a `transform`, `filter`, `perspective`,
// `will-change: transform`, or `contain: paint/layout/strict/content` on
// any element between them) — a real, if exotic, host-page CSS quirk that
// would make our "fixed" content invisible (positioned relative to that
// ancestor's box instead of the real viewport) despite mounting completely
// successfully otherwise. Forcing the shadow host itself to be
// `position: fixed; inset: 0` sidesteps this entirely: it becomes its own
// guaranteed-viewport-sized containing block, so our nested fixed content
// resolves against *that* (which exactly matches the real viewport, since
// inset:0 on a fixed element spans it edge to edge) regardless of anything
// on the host page. pointer-events: none on the host (with our own content
// left at its default 'auto') means the empty parts of this now-full-page
// overlay don't block clicks to the page underneath — only our own visible
// pill/bubble, which sit inside it, remain clickable.
// `!important` (via setProperty's third argument, not a plain assignment)
// specifically because the shadow HOST element itself lives in the host
// page's own light DOM — unlike everything inside the shadow root (isolated
// from the page's stylesheets by wxt's `all: initial` reset), the host is a
// perfectly ordinary appended element, so a page with an aggressive global
// rule (e.g. a CSS reset or a "hide any element we didn't put here"
// selector, plausible on a heavily customized product UI) could still apply
// `display: none !important` or similar directly to it. An inline
// `!important` style beats any stylesheet rule, `!important` or not, so this
// is the strongest defense available short of confirming (which nobody has
// been able to, so far, for lack of DevTools access to the live page) that
// this is actually what's happening.
function forceViewportAnchoring(shadowHost: HTMLElement): void {
  const set = (prop: string, value: string) => shadowHost.style.setProperty(prop, value, 'important');
  set('position', 'fixed');
  set('inset', '0');
  set('width', 'auto');
  set('height', 'auto');
  // Left at 'none' deliberately, not forced to 'auto' — the host is sized to
  // the full viewport (inset: 0), so making it click-through-able everywhere
  // is what lets the page underneath stay interactive; only the actual
  // pill/bubble content inside the shadow root (which resets pointer-events
  // back to 'auto' via wxt's own `all: initial`, confirmed in
  // node_modules/wxt's shadow-root.d.mts) needs to receive clicks, not this
  // full-page host.
  set('pointer-events', 'none');
  set('visibility', 'visible');
  set('opacity', '1');
  set('display', 'block');

  // CONFIRMED root cause (via a live Elements-panel inspection on
  // support.buddyboss.com, not a hypothesis): wxt's `mount()`/`applyPosition`
  // (see node_modules/wxt's shared.mjs) wraps `shadowHost` itself in an
  // *outer* wrapper div, styled `position: fixed; top: 0; left: 0; width: 0;
  // height: 0; overflow: visible; pointer-events: none`, that we never had a
  // reference to and never touched — everything above this comment forces
  // shadowHost's OWN styles, which turned out to be the wrong element on this
  // one page. `shadowHost.style.setProperty('position','fixed', ...)` etc.
  // makes shadowHost itself correctly viewport-sized, but that wrapper's own
  // 0×0 box is what was actually clipping/hiding it on support.buddyboss.com
  // specifically (evidently a page where the 0×0 ancestor's dimensions still
  // affect a `position: fixed` descendant, despite that not being how the
  // CSS spec says a plain `position: fixed` ancestor — with no transform/
  // filter/contain of its own — should behave for a fixed-positioned child;
  // apparently true here regardless). Forcing the wrapper to the full
  // viewport size directly fixes that, independently of shadowHost's own
  // (already-correct) styles.
  // Never touch `<body>`/`<html>` themselves, even if shadowHost's parent
  // happens to resolve to one of them on some page — round 12 forced this
  // wrapper's size unconditionally, and round 14's page-scroll regression
  // (see forceViewportAnchoring's own call sites and the pointer-events fix
  // below) is consistent with that having actually been `<body>` on at
  // least one affected page: forcing a real page's own `<body>` to exactly
  // `height: 100vh !important` can freeze its scrollable height at one
  // viewport regardless of the page's actual (taller) content, breaking
  // page scroll for as long as the widget is mounted. Whatever
  // wxt-generated wrapper this fix originally targeted is never `<body>` or
  // `<html>` — those belong to the page, not to us.
  const wrapper = shadowHost.parentElement;
  if (wrapper && wrapper !== document.body && wrapper !== document.documentElement) {
    const setWrapper = (prop: string, value: string) => wrapper.style.setProperty(prop, value, 'important');
    setWrapper('width', '100vw');
    setWrapper('height', '100vh');
    setWrapper('pointer-events', 'none');
  }
}

// FOUND (round 14, from the user's own report of page scroll breaking
// whenever the widget/bubble were mounted): this used to force `uiContainer`
// itself — the element inside the shadow root that wxt positions via
// `applyPosition` and that our React tree mounts into — to
// `pointer-events: auto !important`. `uiContainer` is sized to whatever wxt's
// own absolute-positioning logic computes for it, which is not guaranteed to
// be shrink-wrapped tightly around just the visible pill/bubble on every
// page; forcing the *whole* container (rather than just the actual visible
// content inside it) to capture pointer events risked exactly the "transparent
// areas block scroll/clicks" symptom reported. `uiContainer`'s own
// pointer-events now stays at `none` — the actual pill (`recording-widget.tsx`)
// and bubble (`webcam-bubble.tsx`) root elements set their own
// `pointer-events: auto` directly instead, so only their own small, correctly
// bounded boxes are ever click/scroll targets, never whatever larger box
// `uiContainer` happens to occupy around them.
function forceUiContainerVisibility(uiContainer: HTMLElement): void {
  uiContainer.style.setProperty('pointer-events', 'none', 'important');
  uiContainer.style.setProperty('visibility', 'visible', 'important');
  uiContainer.style.setProperty('opacity', '1', 'important');
  uiContainer.style.setProperty('display', 'block', 'important');
}

export default defineContentScript({
  // No static matches — QuickCast only uses activeTab, so this script is
  // injected on demand via chrome.scripting.executeScript when recording starts.
  matches: [],
  registration: 'runtime',
  async main(ctx) {
    // ensureWidgetOnTab (background.ts) always tries a plain sendMessage
    // before ever re-injecting this script — so a redundant executeScript
    // call reaching here at all should mean this tab's JS context is
    // genuinely fresh (a hard reload, where `window` itself is new and this
    // flag is naturally unset) rather than a single-page app's in-app
    // navigation (where `window` persists, this flag is still true, and the
    // *existing* listener/state below is what should keep handling
    // messages — re-running this and registering a second, independent
    // listener would duplicate the widget instead of healing it, since the
    // old listener never actually died). Re-checking DOM connectedness
    // inside handleEnsureState, not this flag, is what makes the SPA-wipe
    // case actually self-heal.
    const win = window as unknown as { __quickcastWidgetInjected?: boolean };
    if (win.__quickcastWidgetInjected) {
      console.log('[QuickCast][content] Content script already active in this tab, skipping re-init');
      return;
    }
    win.__quickcastWidgetInjected = true;

    console.log('[QuickCast][content] Content script loaded on', location.href);
    let ui: Awaited<ReturnType<typeof createShadowRootUi<Root>>> | null = null;
    let webcamUi: Awaited<ReturnType<typeof createShadowRootUi<Root>>> | null = null;
    // The bubble's own real camera stream — opened directly in this content
    // script (a visible page, unlike the offscreen document, which is why
    // this exists at all: see the note in lib/messaging.ts's
    // WidgetEnsureStateMessage). Entirely separate from whatever the
    // offscreen document's own getUserMedia call opens for the actual
    // composited/recorded video — no live track can cross between the two,
    // so each side owns and stops its own. Survives a single-page app
    // wiping its own DOM (it's just a JS object in this closure), which is
    // exactly why mountBubbleUi below is split out from acquiring it.
    let webcamStream: MediaStream | null = null;
    // Needed by the bubble's own close (X) button, which fires later and
    // independently of whichever message last carried a recordingId.
    let currentRecordingId: string | null = null;
    // Set the instant the user clicks the bubble's own X button (locally,
    // synchronously — not waiting on the round trip to background) or this
    // tab receives widget:webcam-stop-all (the same decision made from
    // another tab). Checked before ever re-acquiring the camera, closing a
    // real race: an in-flight widget:ensure-state (built from
    // background.ts's session state a moment *before* webcamClosed had
    // actually been persisted there) could otherwise arrive and immediately
    // undo the close by treating it as "cam is still on, nothing mounted,
    // start fresh" — which looked exactly like "clicking X does nothing."
    let webcamManuallyClosed = false;
    // Set the instant widget:close arrives — refuses any further
    // widget:ensure-state for the rest of this tab's life (until a real
    // reload resets the whole module). Without this, a tab-activity event
    // arriving in the window between Stop being clicked and the session
    // actually clearing (a real Stop waits on the Drive flush) could
    // resurrect the widget/bubble right after Stop had just removed them.
    let recordingEnded = false;
    // Once this tab has seen an ensure-state message (or widget:recording-
    // started) reporting anything other than 'countdown', remembered here so
    // a later, stale-but-late ensure-state message reporting 'countdown'
    // again (see handleEnsureState's own comment on this) can be recognized
    // and ignored instead of demoting an already-recording widget back into
    // showing a countdown it already finished.
    let lastKnownNonCountdownPhase: 'recording' | 'paused' | null = null;
    let lastKnownStartedAt: number | undefined;
    // Serializes handleEnsureState calls — on a genuinely busy single-page
    // app (confirmed via console logs: chrome.webNavigation.onHistoryStateUpdated
    // and chrome.tabs.onUpdated both firing repeatedly, in rapid succession,
    // for the exact same tab), multiple widget:ensure-state messages can
    // arrive close enough together that two invocations of the async
    // handleEnsureState genuinely overlap — e.g. one call's
    // `removeWidgetUi(); ui = await createShadowRootUi(...)` is still
    // mid-flight (ui briefly null) when a second call's own "is it healthy"
    // check reads that same transient null and starts *its own* competing
    // remount. Whichever createShadowRootUi call resolves last silently
    // wins, and the other can leave an orphaned, never-referenced shadow
    // host behind — on a page busy enough to keep re-triggering this, the
    // widget can end up perpetually mid-remount and never actually settle
    // long enough to render. Chaining every call through this one promise
    // forces them to run strictly one at a time, so a later call's checks
    // only ever see a fully-resolved prior state, never a half-finished one.
    let ensureStateQueue: Promise<void> = Promise.resolve();
    // Round 15: separate from ensureStateQueue on purpose. ensureWebcamBubble
    // calls getUserMedia, which can take well over sendMessageWithAck's 500ms
    // timeout (background.ts) — a 400ms NotReadableError retry, real camera
    // hardware init, or contention with the offscreen document's own
    // simultaneous getUserMedia for the composited video. When cam mounting
    // was awaited inside handleEnsureState (and thus inside ensureStateQueue,
    // which also gates sendResponse), a slow getUserMedia delayed sendResponse
    // past background's timeout, causing it to retry/re-inject and queue
    // duplicate widget:ensure-state calls behind the still-running one — and
    // pushed the bubble's actual DOM insertion (which can trigger a busy SPA's
    // own re-render/wipe of unrecognized DOM, see watchWidgetVisibility's own
    // comment) past the widget's 2-second self-heal window, which starts
    // counting from widget mount, not from whenever cam happens to finish.
    // Queuing webcam work separately lets handleEnsureState (and thus
    // sendResponse) return as soon as the widget itself is mounted, and lets
    // the bubble's insertion happen while the widget's watchdog is still
    // actually watching. Still its own serialized queue, not fire-and-forget,
    // so overlapping ensure-state calls' webcam work can't race on the shared
    // webcamStream/webcamUi refs the way handleEnsureState calls used to race
    // on `ui` before round 6's ensureStateQueue existed.
    let webcamQueue: Promise<void> = Promise.resolve();

    function stopWebcamStream(): void {
      webcamStream?.getTracks().forEach((track) => track.stop());
      webcamStream = null;
    }

    function removeWebcamBubbleUi(): void {
      webcamUi?.mounted?.unmount();
      webcamUi?.remove();
      webcamUi = null;
    }

    // Set whenever the widget is mounted, disconnected whenever it's
    // removed (see removeWidgetUi) or the 2-second watch window (see
    // watchWidgetVisibility's own comment) elapses on its own.
    let widgetVisibilityObserver: MutationObserver | null = null;

    function removeWidgetUi(): void {
      widgetVisibilityObserver?.disconnect();
      widgetVisibilityObserver = null;
      ui?.mounted?.unmount();
      ui?.remove();
      ui = null;
    }

    // Last-resort fallback for a page whose CSS/DOM environment defeats the
    // shadow-DOM widget outright (support.buddyboss.com, confirmed across 13
    // rounds of increasingly targeted CSS fixes that never resolved it) —
    // renders the timer pill inside a genuine <iframe>, a completely
    // separate browsing context with its own document, immune to whatever
    // about the host page's own CSS/DOM is interfering with content
    // injected directly into it. Only activated if the shadow-DOM widget is
    // still not actually visible 2 seconds after mounting (see
    // watchWidgetVisibility's own setTimeout) — every other tab, where the
    // shadow-DOM widget works fine, never touches this path at all.
    let widgetIframe: HTMLIFrameElement | null = null;
    // Kept so a late `ready` handshake from the iframe (see its own
    // main.tsx/App.tsx) always has the current state to reply with, even if
    // it arrives after the most recent ensure-state message was processed.
    let lastFrameState: WidgetFrameStateMessage | null = null;

    function postStateToIframe(): void {
      if (!widgetIframe?.contentWindow || !lastFrameState) return;
      widgetIframe.contentWindow.postMessage(lastFrameState, '*');
    }

    function removeIframeFallback(): void {
      widgetIframe?.remove();
      widgetIframe = null;
    }

    function activateIframeFallback(): void {
      if (widgetIframe || !lastFrameState) return;
      console.warn('[QuickCast][content] *** activateIframeFallback: shadow-DOM widget never became visible — falling back to an <iframe>-based widget', lastFrameState);
      // The shadow-DOM widget clearly isn't working on this page — remove
      // it outright rather than leaving an invisible, still-ticking React
      // tree mounted alongside the iframe.
      removeWidgetUi();
      const iframe = document.createElement('iframe');
      iframe.src = chrome.runtime.getURL('widget-frame.html');
      iframe.style.setProperty('position', 'fixed', 'important');
      iframe.style.setProperty('left', '16px', 'important');
      iframe.style.setProperty('bottom', '16px', 'important');
      iframe.style.setProperty('width', '340px', 'important');
      iframe.style.setProperty('height', '64px', 'important');
      iframe.style.setProperty('border', '0', 'important');
      iframe.style.setProperty('background', 'transparent', 'important');
      iframe.style.setProperty('z-index', '2147483647', 'important');
      iframe.style.setProperty('pointer-events', 'auto', 'important');
      iframe.setAttribute('allowtransparency', 'true');
      document.body.appendChild(iframe);
      widgetIframe = iframe;
    }

    // Every previous fix for the original-tab visibility bug (CSS
    // containing-block anchoring, then `!important`-priority forced styles)
    // assumed the shadow host stays in the DOM and only its *styling* is
    // the problem — but round 10's console evidence showed React rendering
    // correctly and repeatedly, with no indication anything is wrong on
    // *our* side, which leaves an option none of those fixes could ever
    // have addressed: the host page's own script actively removing or
    // hiding the shadow host as a side effect of its own DOM management
    // (support.buddyboss.com is a busy single-page app already confirmed,
    // elsewhere in this project's history, to wipe/re-render its own
    // top-level DOM). A MutationObserver watching this exact element is the
    // only way to directly confirm or rule that out, instead of guessing at
    // another CSS mechanism. Scoped to 2 seconds after mount (matching how
    // long a page's own initial-load DOM churn would plausibly still be
    // settling) rather than running for the widget's entire lifetime, to
    // avoid an indefinitely-running observer on a page this active.
    function watchWidgetVisibility(shadowHost: HTMLElement): void {
      widgetVisibilityObserver?.disconnect();
      const parent = shadowHost.parentNode;
      const observer = new MutationObserver(() => {
        if (!shadowHost.isConnected) {
          console.warn('[QuickCast][content] *** watchWidgetVisibility: shadow host was REMOVED from the DOM by something other than QuickCast itself — re-appending', {
            hadParent: parent !== null,
          });
          (parent ?? document.body).appendChild(shadowHost);
          forceViewportAnchoring(shadowHost);
          if (ui) forceUiContainerVisibility(ui.uiContainer);
          return;
        }
        const inlineStyle = shadowHost.getAttribute('style');
        console.warn('[QuickCast][content] *** watchWidgetVisibility: shadow host attributes were mutated by something other than QuickCast itself — re-applying forced styles', {
          styleAttribute: inlineStyle,
        });
        forceViewportAnchoring(shadowHost);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      observer.observe(shadowHost, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
      widgetVisibilityObserver = observer;
      setTimeout(() => {
        if (widgetVisibilityObserver === observer) {
          observer.disconnect();
          widgetVisibilityObserver = null;
        }
        // The observer above only ever fires on a *mutation* — it has
        // nothing to say about a widget that was never removed or
        // restyled, yet still never became visible for some other reason
        // (round 13's finding: on support.buddyboss.com, the shadow-DOM
        // widget renders correctly and stays correctly styled the entire
        // time, and is still just never visible on screen — no mutation
        // ever happens for the observer above to catch). This is the actual
        // visibility check: is the pill's own root element (marked
        // `data-quickcast-root`, see components/recording-widget.tsx)
        // actually present with a non-zero rendered box.
        if (recordingEnded || widgetIframe) return;
        const root = ui?.shadow.querySelector<HTMLElement>('[data-quickcast-root]');
        const rect = root?.getBoundingClientRect();
        const isVisible = root !== null && root !== undefined && rect !== undefined && rect.width > 0 && rect.height > 0;
        if (!isVisible) {
          console.warn('[QuickCast][content] *** watchWidgetVisibility: no mutation occurred, but the widget still has no visible box 2s after mounting', {
            rootFound: root != null,
            rect,
          });
          activateIframeFallback();
        }
      }, 2000);
    }

    // Mounts the bubble UI from whatever webcamStream already holds — does
    // NOT acquire the camera itself, so it's safe (and cheap) to call
    // whenever the UI needs to (re)appear but the stream is already live
    // (e.g. healing after a single-page app wiped the DOM without actually
    // reloading the page).
    async function mountBubbleUi(corner: WebcamCorner | undefined): Promise<void> {
      removeWebcamBubbleUi();
      webcamUi = await createShadowRootUi(ctx, {
        name: 'quickcast-webcam-bubble',
        position: 'overlay',
        alignment: 'bottom-right',
        zIndex: 2147483647,
        css: widgetCss,
        onMount: (container) =>
          mountWebcamBubble(container, {
            stream: webcamStream!,
            corner: corner ?? 'bottom-right',
            onClose: () => {
              // Set synchronously, before anything async — see this flag's
              // own declaration comment for the exact race it closes.
              webcamManuallyClosed = true;
              // Stopped and removed locally, immediately — no need to wait
              // on a round trip to background just to turn this tab's own
              // camera light off. Background is still told separately, so
              // it can relay offscreen:webcam-stop (drops the circle from
              // the *composited* video — an entirely independent camera
              // from this one) and broadcast widget:webcam-stop-all so
              // every other tab with a bubble of its own stops too.
              stopWebcamStream();
              removeWebcamBubbleUi();
              if (currentRecordingId) {
                const closeMessage: WidgetWebcamCloseClickedMessage = {
                  type: 'widget:webcam-close-clicked',
                  recordingId: currentRecordingId,
                };
                void chrome.runtime.sendMessage(closeMessage);
              }
            },
          }),
      });
      webcamUi.mount();
      forceViewportAnchoring(webcamUi.shadowHost);
      console.log('[QuickCast][content] Webcam bubble mounted', {
        shadowHostConnected: webcamUi.shadowHost.isConnected,
        shadowHostRect: webcamUi.shadowHost.getBoundingClientRect(),
      });
    }

    // Best-effort, exactly like the popup's own mic/cam permission priming —
    // a denied/missing camera must never block the recording or show an
    // error, it just means no bubble (and, independently, no composite —
    // that's the offscreen document's own separate, unrelated attempt).
    async function ensureWebcamBubble(corner: WebcamCorner | undefined): Promise<void> {
      if (webcamStream && (!webcamUi || !webcamUi.shadowHost.isConnected)) {
        console.log('[QuickCast][content] *** ensureWebcamBubble: stream still alive, (re)mounting UI only');
        await mountBubbleUi(corner);
        return;
      }
      if (webcamStream && webcamUi?.shadowHost.isConnected) {
        return; // already healthy, nothing to do
      }
      console.log('[QuickCast][content] *** Requesting camera for on-screen bubble');
      try {
        webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (err) {
        // NotReadableError right after another tab just opened/closed its
        // own independent stream on this same physical camera can mean the
        // driver hasn't fully settled yet — one short retry covers that,
        // rather than permanently giving up on a device that's about to be
        // free. Each tab owns its own stream now — there's no "the other
        // tab is still using it" case to wait out beyond this brief window.
        if (err instanceof Error && err.name === 'NotReadableError') {
          console.warn('[QuickCast][content] *** Camera busy — retrying once in 400ms');
          await new Promise((resolve) => setTimeout(resolve, 400));
          try {
            webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          } catch (retryErr) {
            console.warn('[QuickCast][content] *** Camera retry also failed — no on-screen bubble for this recording', retryErr);
            webcamStream = null;
            return;
          }
        } else {
          console.warn(
            '[QuickCast][content] *** Camera getUserMedia failed — no on-screen bubble for this recording',
            err instanceof Error ? err.name : err,
            err,
          );
          webcamStream = null;
          return;
        }
      }
      console.log('[QuickCast][content] *** Camera acquired, mounting webcam bubble');
      await mountBubbleUi(corner);
    }

    // The single handler responsible for making sure this tab has both the
    // widget and (if cam is on) its own webcam bubble, reflecting current
    // state — replaces separate start-countdown/sync-state/webcam-start-here
    // handlers. Checks real DOM connectedness (isConnected), not just
    // "is the reference set", so it correctly detects and heals from a
    // single-page app wiping its own <body> without needing a distinct
    // signal for that case versus a normal, already-healthy re-check.
    async function handleEnsureState(message: WidgetEnsureStateMessage): Promise<void> {
      // Logged unconditionally, before anything else, so the exact state
      // this tab was told to render is always visible — specifically
      // whether phase/startedAt/countdownSeconds are what's expected for
      // this tab (the original tab is the only one that ever receives this
      // while phase is still 'countdown', since every other tab is only
      // ever ensured after the recording has already started).
      console.log('[QuickCast][content] *** handleEnsureState received', message);

      // FOUND: `recordingEnded` (and the other per-recording flags below)
      // were being set once, at Stop/Cancel, and then never reset for the
      // rest of this content script's lifetime — but the content script
      // itself stays alive across recordings on any tab whose listener
      // ensureWidgetOnTab could still reach (it only re-injects when a
      // plain sendMessage fails). A tab that had the widget during a first
      // recording, closed normally, then received a second recording's
      // ensure-state without ever navigating/reloading in between would
      // hit this flag still `true` from the *first* recording and silently
      // ignore the second one forever — exactly the "second recording
      // shows nothing anywhere until I manually reload" bug. A genuinely
      // new recordingId means this is unambiguously a new session, so
      // every per-recording flag gets reset *before* the recordingEnded
      // check below, not after.
      if (currentRecordingId !== null && currentRecordingId !== message.recordingId) {
        console.log('[QuickCast][content] *** handleEnsureState: new recordingId — resetting stale per-recording state left over from the previous session', {
          previousRecordingId: currentRecordingId,
          newRecordingId: message.recordingId,
        });
        recordingEnded = false;
        webcamManuallyClosed = false;
        lastKnownNonCountdownPhase = null;
        lastKnownStartedAt = undefined;
      }
      currentRecordingId = message.recordingId;

      // Refuses to do anything once this tab has actually seen *this*
      // recording end, or the user close the webcam here — both are local,
      // synchronous, zero-latency flags specifically to beat any
      // ensure-state message that was already in flight (built from
      // background.ts's session state a moment *before* either of those
      // decisions had actually been persisted there).
      if (recordingEnded) {
        console.log('[QuickCast][content] handleEnsureState: recording already ended in this tab, ignoring');
        return;
      }

      // Once this tab has seen the recording genuinely start, never let a
      // later ensure-state message demote it back to 'countdown' — with
      // several independent Chrome events (onActivated/onUpdated/
      // onHistoryStateUpdated) each able to trigger their own
      // ensureWidgetOnTab call on the background side, and no cross-call
      // lock there (only this tab's own ensureStateQueue serializes calls
      // that arrive here, not the order background dispatched them), a
      // message built from session state *before* offscreen:begin resolved
      // can physically arrive here after a later message built *after* it
      // resolved — stale-but-late, not just stale. If that stale message
      // then happens to trigger a remount (this tab's widget briefly
      // unhealthy for any reason), it would otherwise reset a
      // known-recording tab back into showing a countdown it already
      // finished.
      const effectivePhase = message.phase === 'countdown' && lastKnownNonCountdownPhase !== null ? lastKnownNonCountdownPhase : message.phase;
      const effectiveStartedAt = message.phase === 'countdown' && lastKnownNonCountdownPhase !== null ? lastKnownStartedAt : message.startedAt;
      if (effectivePhase !== message.phase) {
        console.log('[QuickCast][content] *** handleEnsureState: ignoring a stale countdown demotion, using last-known phase instead', {
          messagePhase: message.phase,
          effectivePhase,
          effectiveStartedAt,
        });
      }
      if (effectivePhase !== 'countdown') {
        lastKnownNonCountdownPhase = effectivePhase;
        lastKnownStartedAt = effectiveStartedAt;
      }

      if (message.showWidget) {
        const widgetHealthy = ui !== null && ui.shadowHost.isConnected;
        if (!widgetHealthy) {
          removeWidgetUi();
          // Round 16: the original tab gets RecordingPill (plain inline
          // styles, no Tailwind classNames, no external stylesheet — see its
          // own header comment) instead of the Tailwind-classed
          // RecordingWidget every other tab still uses. RecordingWidget has
          // never once become visible on this specific tab across 15 rounds
          // of CSS/timing fixes; this isolates whether a Tailwind-class
          // conflict with the host page was the one thing never directly
          // ruled out. `css` is intentionally omitted for the pill — no
          // external stylesheet at all for this mount.
          ui = await createShadowRootUi(ctx, {
            name: 'quickcast-widget',
            position: 'overlay',
            alignment: 'bottom-left',
            zIndex: 2147483647,
            css: message.isOriginalTab ? undefined : widgetCss,
            onMount: (container) =>
              message.isOriginalTab
                ? mountRecordingPill(container, {
                    recordingId: message.recordingId,
                    countdownSeconds: message.countdownSeconds,
                    initialPhase: effectivePhase,
                    initialStartedAt: effectiveStartedAt,
                    initialUploadProgress: message.uploadProgress ?? null,
                    initialUploadDisabledReason: message.uploadDisabledReason ?? null,
                  })
                : mountRecordingWidget(container, {
                    recordingId: message.recordingId,
                    countdownSeconds: message.countdownSeconds,
                    initialPhase: effectivePhase,
                    initialStartedAt: effectiveStartedAt,
                    initialUploadProgress: message.uploadProgress ?? null,
                    initialUploadDisabledReason: message.uploadDisabledReason ?? null,
                  }),
          });
          ui.mount();
          forceViewportAnchoring(ui.shadowHost);
          forceUiContainerVisibility(ui.uiContainer);
          watchWidgetVisibility(ui.shadowHost);
          console.log('[QuickCast][content] Widget (re)mounted', {
            phase: effectivePhase,
            countdownSeconds: message.countdownSeconds,
            startedAt: effectiveStartedAt,
            recordingId: message.recordingId,
            shadowHostConnected: ui.shadowHost.isConnected,
            shadowHostRect: ui.shadowHost.getBoundingClientRect(),
          });
        } else {
          console.log('[QuickCast][content] *** handleEnsureState: widget already healthy, mountRecordingWidget NOT called — new phase/startedAt/countdownSeconds from this message are NOT passed to the existing component', {
            phase: message.phase,
            countdownSeconds: message.countdownSeconds,
            startedAt: message.startedAt,
          });
        }
      } else if (ui) {
        // Not the original tab, and "Show recording widget on any tab" is
        // off — remove it if a previous ensure-state already mounted it
        // (e.g. the setting was flipped mid-recording).
        removeWidgetUi();
      }

      // Not awaited here — queued on webcamQueue instead (see its own
      // declaration comment) so a slow getUserMedia can never delay this
      // function's return, and thus never delay sendResponse past
      // background's sendMessageWithAck timeout.
      const corner = message.webcamCorner;
      const shouldShowCam = message.cam && !webcamManuallyClosed;
      webcamQueue = webcamQueue
        .then(() => {
          if (shouldShowCam) {
            return ensureWebcamBubble(corner);
          }
          if (webcamStream || webcamUi) {
            // cam was turned off (webcamClosed) since this tab last checked
            // in, or this tab itself already closed it locally.
            stopWebcamStream();
            removeWebcamBubbleUi();
          }
          return undefined;
        })
        .catch((err) => {
          console.error('[QuickCast][content] webcamQueue task failed', err);
        });
    }

    chrome.runtime.onMessage.addListener((message: { type: string }, _sender, sendResponse) => {
      console.log('[QuickCast][content] Received message', message.type);

      if (message.type === 'widget:ensure-state') {
        // Queued through ensureStateQueue (see its declaration) rather than
        // called directly — on a busy single-page app, ensure-state
        // messages can arrive close enough together that calling
        // handleEnsureState directly would let two invocations race on the
        // shared `ui` reference. Still awaited before responding (not
        // fire-and-forget) — background's own ack+retry logic
        // (sendMessageWithAck) depends on this response meaning "actually
        // mounted," not just "message received."
        const ensureMessage = message as WidgetEnsureStateMessage;
        const run = ensureStateQueue.then(() => handleEnsureState(ensureMessage));
        ensureStateQueue = run.catch((err) => {
          console.error('[QuickCast][content] handleEnsureState failed', err);
        });
        run.then(
          () => sendResponse({ success: true }),
          (err) => sendResponse({ success: false, message: err instanceof Error ? err.message : String(err) }),
        );
        return true;
      }

      // Broadcast when the user closes the webcam bubble's own X button in
      // *any* tab — every tab with a bubble stops its own independent
      // camera together, since "closing the webcam" is a whole-recording
      // decision, not a per-tab one.
      if (message.type === 'widget:webcam-stop-all') {
        webcamManuallyClosed = true;
        stopWebcamStream();
        removeWebcamBubbleUi();
        console.log('[QuickCast][content] Webcam bubble stopped (closed from another tab)');
        sendResponse({ success: true });
        return;
      }

      if (message.type === 'widget:close') {
        // Set before anything else — see this flag's own declaration
        // comment for why: it's what stops a tab-activity event that
        // arrives in the window right after Stop (before the session is
        // actually cleared) from resurrecting the widget/bubble here.
        recordingEnded = true;
        removeWidgetUi();
        stopWebcamStream();
        removeWebcamBubbleUi();
        console.log('[QuickCast][content] Widget removed');
        sendResponse({ success: true });
      }
    });
  },
});
