/**
 * Measurement fixture for the preview isolation spike (#435).
 *
 * This page mounts the same preview stack the editor uses: an
 * `@remotion/player` `<Player>` driving `@clash/remotion-components`
 * `VideoComposition` over a Timeline. Nothing here is a product surface; it
 * exists so `apps/web/e2e/preview-iframe-longtask.ts` can compare the same
 * preview hosted on the page's own main thread against the same preview
 * hosted in a cross-site iframe.
 *
 * The probe reports its own long tasks so the harness can show that the work
 * did not disappear - it moved off the editor's thread.
 */
import { StrictMode, useEffect, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Player, type PlayerRef } from "@remotion/player";
import { VideoComposition } from "@clash/remotion-components";
import type { Track } from "@clash/remotion-core";

const FPS = 30;
const DURATION_IN_FRAMES = 600;
const WIDTH = 1920;
const HEIGHT = 1080;
/** Text items rendered per track. The count drives the per-frame render cost. */
const ITEMS_PER_TRACK = 20;
const TRACK_COUNT = 6;

export const PREVIEW_PROBE_SCENARIO = "remotion-timeline-preview-1080p";

function buildTracks(): Track[] {
  return Array.from({ length: TRACK_COUNT }, (_unused, trackIndex) => ({
    id: `probe-track-${trackIndex}`,
    name: `Probe track ${trackIndex}`,
    items: Array.from({ length: ITEMS_PER_TRACK }, (_unused, itemIndex) => ({
      id: `probe-item-${trackIndex}-${itemIndex}`,
      type: "text" as const,
      text: `Preview probe ${trackIndex}.${itemIndex} — 预览探针`,
      color: "#ffffff",
      fontSize: 64 + itemIndex,
      fontFamily: "Inter, sans-serif",
      fontWeight: 700,
      from: 0,
      durationInFrames: DURATION_IN_FRAMES,
      properties: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        opacity: 1,
      },
    })),
  }));
}

const tracks = buildTracks();

declare global {
  interface Window {
    __previewProbe?: {
      scenario: string;
      itemCount: number;
      play(): void;
      pause(): void;
      currentFrame(): number;
      longTasks(): number[];
      resetLongTasks(): void;
    };
  }
}

const longTasks: number[] = [];
if (typeof PerformanceObserver !== "undefined") {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      longTasks.push(entry.duration);
    }
  }).observe({ type: "longtask" });
}

/**
 * When the probe is embedded, it reports its own long tasks to the page that
 * embedded it. The parent origin is the probe document's referrer, so a report
 * never goes to a site that did not embed the probe.
 */
function parentOrigin(): string | null {
  if (!document.referrer) return null;
  try {
    return new URL(document.referrer).origin;
  } catch {
    return null;
  }
}

const origin = parentOrigin();
/**
 * The parent can ask the probe to play before React has mounted the Player.
 * The request is remembered and applied as soon as the probe exists.
 */
let pendingPlay = false;
/** Tells the embedding page that the probe can take commands. */
function announceReady() {
  if (!origin) return;
  window.parent.postMessage(
    { type: "clash.preview-probe.ready" },
    origin,
  );
}
if (origin) {
  window.addEventListener("message", (event) => {
    if (event.origin !== origin) return;
    const type = event.data?.type;
    if (type === "clash.preview-probe.request-report") {
      window.parent.postMessage(
        {
          type: "clash.preview-probe.report",
          scenario: PREVIEW_PROBE_SCENARIO,
          itemCount: TRACK_COUNT * ITEMS_PER_TRACK,
          currentFrame: window.__previewProbe?.currentFrame() ?? 0,
          longTasks: longTasks.slice(),
        },
        origin,
      );
      return;
    }
    if (type === "clash.preview-probe.play") {
      if (window.__previewProbe) {
        window.__previewProbe.play();
      } else {
        pendingPlay = true;
      }
      return;
    }
    if (type === "clash.preview-probe.pause") {
      window.__previewProbe?.pause();
      return;
    }
    if (type === "clash.preview-probe.reset-long-tasks") {
      window.__previewProbe?.resetLongTasks();
    }
  });
}

function Probe() {
  const playerRef = useRef<PlayerRef>(null);
  const inputProps = useMemo(() => ({ tracks }), []);

  useEffect(() => {
    window.__previewProbe = {
      scenario: PREVIEW_PROBE_SCENARIO,
      itemCount: TRACK_COUNT * ITEMS_PER_TRACK,
      play: () => playerRef.current?.play(),
      pause: () => playerRef.current?.pause(),
      currentFrame: () => playerRef.current?.getCurrentFrame() ?? 0,
      longTasks: () => longTasks.slice(),
      resetLongTasks: () => {
        longTasks.length = 0;
      },
    };
    if (pendingPlay) {
      pendingPlay = false;
      playerRef.current?.play();
    }
    announceReady();
    return () => {
      delete window.__previewProbe;
    };
  }, []);

  return (
    <Player
      ref={playerRef}
      component={VideoComposition}
      compositionWidth={WIDTH}
      compositionHeight={HEIGHT}
      durationInFrames={DURATION_IN_FRAMES}
      fps={FPS}
      inputProps={inputProps}
      style={{ width: WIDTH / 2, height: HEIGHT / 2 }}
      controls={false}
      loop={false}
      numberOfSharedAudioTags={0}
    />
  );
}

const container = document.getElementById("preview-probe-root");
if (!container) {
  throw new Error("The preview probe needs a #preview-probe-root element.");
}
createRoot(container).render(
  <StrictMode>
    <Probe />
  </StrictMode>,
);
