// Composites the webcam as a circle over the screen capture, entirely inside
// the offscreen document (the only place both streams and a canvas exist
// together). Isolated in its own module, separate from the recording
// lifecycle in entrypoints/offscreen/main.ts, so the drawing logic can be
// reasoned about (and, if something's ever wrong with it, debugged) on its
// own — the riskiest new piece this session, since a bug here silently
// corrupts every future recording's video track, not just fails loudly.
import type { WebcamCorner } from '@/lib/preferences';

const CIRCLE_DIAMETER = 200;
const CIRCLE_MARGIN = 24;
const RING_WIDTH = 3;
const FALLBACK_WIDTH = 1920;
const FALLBACK_HEIGHT = 1080;

export interface WebcamCompositor {
  stream: MediaStream;
  stop: () => void;
  // Stops drawing the webcam circle into the composited video for the
  // remainder of the recording (screen capture keeps going) — does not stop
  // the underlying camStream tracks itself; entrypoints/offscreen/main.ts
  // owns that, since it's the one holding the actual camStream reference.
  disableWebcam: () => void;
}

// Crops `video`'s current frame to a centered square (its shorter dimension)
// and draws it into `size`×`size` at (destX, destY) — used by the composited
// circle (drawFrame) below.
function drawCoverSquare(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, destX: number, destY: number, size: number): void {
  const videoWidth = video.videoWidth || 1;
  const videoHeight = video.videoHeight || 1;
  const side = Math.min(videoWidth, videoHeight);
  const sourceX = (videoWidth - side) / 2;
  const sourceY = (videoHeight - side) / 2;
  ctx.drawImage(video, sourceX, sourceY, side, side, destX, destY, size, size);
}

function circleCenter(corner: WebcamCorner, canvasWidth: number, canvasHeight: number): { x: number; y: number } {
  const radius = CIRCLE_DIAMETER / 2;
  const left = CIRCLE_MARGIN + radius;
  const right = canvasWidth - CIRCLE_MARGIN - radius;
  const top = CIRCLE_MARGIN + radius;
  const bottom = canvasHeight - CIRCLE_MARGIN - radius;
  switch (corner) {
    case 'top-left':
      return { x: left, y: top };
    case 'top-right':
      return { x: right, y: top };
    case 'bottom-left':
      return { x: left, y: bottom };
    case 'bottom-right':
      return { x: right, y: bottom };
  }
}

// Plays a MediaStream in a video element that's never attached to the DOM —
// this is allowed (no user-gesture/autoplay restriction applies: both source
// streams here are always video-only, muted, and offscreen documents aren't
// subject to a visible tab's autoplay policy the way a regular page is), and
// is the only way to get decoded frames out of a MediaStreamTrack for
// drawImage() — canvas can't draw a MediaStreamTrack directly.
async function playHiddenVideo(stream: MediaStream): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise<void>((resolve) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    });
  }
  return video;
}

// Starts drawing desktopStream (fullsize) + camStream (a circle in the
// configured corner, with a white ring border) onto a canvas, and returns a
// MediaStream captured from that canvas to use as MediaRecorder's video
// source instead of the raw desktop stream. Caller is responsible for
// calling stop() when the recording ends — this does not stop the
// underlying desktopStream/camStream tracks itself (entrypoints/offscreen/
// main.ts's stopTracks() already owns stopping those, since the desktop
// track in particular is also used for native "Stop sharing" detection).
export async function startWebcamCompositor(
  desktopStream: MediaStream,
  camStream: MediaStream,
  webcamCorner: WebcamCorner,
  frameRate: number,
): Promise<WebcamCompositor> {
  const desktopVideo = await playHiddenVideo(desktopStream);
  const camVideo = await playHiddenVideo(camStream);

  const canvas = document.createElement('canvas');
  canvas.width = desktopVideo.videoWidth || FALLBACK_WIDTH;
  canvas.height = desktopVideo.videoHeight || FALLBACK_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get a 2D canvas context for webcam compositing');

  const { x, y } = circleCenter(webcamCorner, canvas.width, canvas.height);
  const radius = CIRCLE_DIAMETER / 2;

  let rafId = 0;
  let stopped = false;
  // Set by disableWebcam() (the on-screen bubble's "close" button) — the
  // draw loop keeps running (screen capture must continue), it just stops
  // drawing the circle/ring for every subsequent frame.
  let webcamEnabled = true;

  function drawFrame() {
    if (stopped) return;
    ctx!.drawImage(desktopVideo, 0, 0, canvas.width, canvas.height);

    if (webcamEnabled) {
      ctx!.save();
      ctx!.beginPath();
      ctx!.arc(x, y, radius, 0, Math.PI * 2);
      ctx!.clip();
      drawCoverSquare(ctx!, camVideo, x - radius, y - radius, CIRCLE_DIAMETER);
      ctx!.restore();

      ctx!.beginPath();
      ctx!.arc(x, y, radius - RING_WIDTH / 2, 0, Math.PI * 2);
      ctx!.lineWidth = RING_WIDTH;
      ctx!.strokeStyle = '#ffffff';
      ctx!.stroke();
    }

    rafId = requestAnimationFrame(drawFrame);
  }
  rafId = requestAnimationFrame(drawFrame);

  // A fixed capture rate here (not left to fire on every canvas repaint) is
  // what actually makes recordingDefaults.frameRate apply to the composited
  // output — the draw loop above just keeps the canvas current at whatever
  // rate rAF fires; captureStream(frameRate) is what samples it down (or up)
  // to the configured rate for MediaRecorder.
  const stream = canvas.captureStream(frameRate);

  return {
    stream,
    disableWebcam: () => {
      webcamEnabled = false;
    },
    stop: () => {
      stopped = true;
      cancelAnimationFrame(rafId);
      desktopVideo.pause();
      desktopVideo.srcObject = null;
      camVideo.pause();
      camVideo.srcObject = null;
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
