/**
 * HTML MG PreviewFrameProducer (`kind: "html-scene"`) for #447.
 *
 * Paints one or more sandboxed HTML documents into a host element and owns a
 * local frame clock on play(). Uses clash.preview-host.v1 facts via the
 * optional reporter; never invents an audio-master-clock. Remotion items keep
 * the Remotion Player as time authority elsewhere.
 */
import type { PreviewCompositionDescriptor } from "./protocol";
import type {
  PreviewFrameProducer,
  PreviewProducerReporter,
} from "./producer";
import {
  HTML_SCENE_DOCUMENT_PROTOCOL,
  HTML_SCENE_SANDBOX,
  createHtmlSceneBlobUrl,
  validateHtmlDocumentCapacity,
  wrapHtmlDocumentForPreview,
  type HtmlSceneBlobHandle,
} from "@clash/remotion-components/html-scene";

export type HtmlSceneDescriptor = {
  id: string;
  source: string;
  from: number;
  durationInFrames: number;
  sourceNodeId?: string;
};

export type CreateHtmlSceneProducerOptions = {
  /** Element that receives absolutely-positioned sandboxed iframes. */
  mountElement: HTMLElement;
  reporter?: PreviewProducerReporter;
  /**
   * Optional override: when set, used instead of extracting from composition
   * tracks + allNodes.
   */
  resolveScenes?: (
    composition: PreviewCompositionDescriptor,
  ) => HtmlSceneDescriptor[];
};

type MountedScene = HtmlSceneDescriptor & {
  iframe: HTMLIFrameElement;
  blob: HtmlSceneBlobHandle;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nodeContent(node: unknown): string | null {
  if (!isRecord(node)) return null;
  const type = typeof node.type === "string" ? node.type : undefined;
  // Canvas RF nodes carry type + data; accept html-motion or bare data bags.
  if (type && type !== "html-motion") return null;
  const data = isRecord(node.data) ? node.data : node;
  const content = data.content;
  return typeof content === "string" && content.trim() ? content : null;
}

function nodesMap(
  allNodes: unknown,
): Map<string, unknown> {
  if (!allNodes) return new Map();
  if (allNodes instanceof Map) return allNodes as Map<string, unknown>;
  if (isRecord(allNodes)) return new Map(Object.entries(allNodes));
  return new Map();
}

/**
 * Extract live HTML MG scenes from Timeline tracks + Canvas allNodes.
 * Timeline stores no HTML snapshot — only sourceNodeId + runtime: html.
 */
export function extractHtmlScenesFromComposition(
  composition: PreviewCompositionDescriptor,
): HtmlSceneDescriptor[] {
  const tracks = Array.isArray(composition.tracks) ? composition.tracks : [];
  const nodes = nodesMap(composition.allNodes);
  const scenes: HtmlSceneDescriptor[] = [];

  for (const track of tracks) {
    if (!isRecord(track) || !Array.isArray(track.items)) continue;
    for (const item of track.items) {
      if (!isRecord(item)) continue;
      if (item.type !== "composition" || item.runtime !== "html") continue;
      const id = typeof item.id === "string" ? item.id : null;
      if (!id) continue;
      const sourceNodeId =
        typeof item.sourceNodeId === "string" ? item.sourceNodeId : undefined;
      let source: string | null = null;
      if (sourceNodeId && nodes.has(sourceNodeId)) {
        source = nodeContent(nodes.get(sourceNodeId));
      }
      if (!source && typeof item.htmlSource === "string") {
        source = item.htmlSource;
      }
      if (!source) continue;
      const from =
        typeof item.from === "number" && Number.isFinite(item.from)
          ? Math.max(0, Math.round(item.from))
          : 0;
      const durationInFrames =
        typeof item.durationInFrames === "number" &&
        Number.isFinite(item.durationInFrames)
          ? Math.max(1, Math.round(item.durationInFrames))
          : composition.durationInFrames;
      scenes.push({ id, source, from, durationInFrames, sourceNodeId });
    }
  }
  return scenes;
}

export function compositionHasHtmlScenes(
  composition: PreviewCompositionDescriptor,
): boolean {
  return extractHtmlScenesFromComposition(composition).length > 0;
}

export function compositionIsHtmlOnly(
  composition: PreviewCompositionDescriptor,
): boolean {
  const tracks = Array.isArray(composition.tracks) ? composition.tracks : [];
  let sawItem = false;
  for (const track of tracks) {
    if (!isRecord(track) || !Array.isArray(track.items)) continue;
    for (const item of track.items) {
      if (!isRecord(item)) continue;
      sawItem = true;
      if (item.type === "composition" && item.runtime === "html") continue;
      // Any non-html composition / media / solid / text means not html-only.
      return false;
    }
  }
  return sawItem && compositionHasHtmlScenes(composition);
}

export function createHtmlSceneProducer(
  options: CreateHtmlSceneProducerOptions,
): PreviewFrameProducer {
  const frameListeners = new Set<(frame: number) => void>();
  let composition: PreviewCompositionDescriptor | null = null;
  let mounted: MountedScene[] = [];
  let currentFrame = 0;
  let playing = false;
  let rafId: number | null = null;
  let playStartedAtMs = 0;
  let playStartedAtFrame = 0;

  const emitFrame = (frame: number) => {
    currentFrame = frame;
    options.reporter?.reportFrame(frame);
    for (const listener of frameListeners) listener(frame);
  };

  const postSeek = (scene: MountedScene, frame: number, fps: number) => {
    const local = Math.max(0, frame - scene.from);
    const win = scene.iframe.contentWindow;
    if (!win) return;
    try {
      win.postMessage(
        {
          protocol: HTML_SCENE_DOCUMENT_PROTOCOL,
          type: "seek",
          frame: local,
          fps,
          durationInFrames: scene.durationInFrames,
        },
        "*",
      );
    } catch {
      // Opaque-origin / unloaded frame — ignore.
    }
  };

  const clearMount = () => {
    for (const scene of mounted) {
      scene.blob.revoke();
      scene.iframe.remove();
    }
    mounted = [];
    options.mountElement.replaceChildren();
  };

  const stopClock = () => {
    playing = false;
    if (rafId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(rafId);
    }
    rafId = null;
  };

  const tick = () => {
    if (!playing || !composition) return;
    const fps = composition.fps || 30;
    const elapsedMs =
      typeof performance !== "undefined"
        ? performance.now() - playStartedAtMs
        : Date.now() - playStartedAtMs;
    const next = Math.min(
      composition.durationInFrames - 1,
      playStartedAtFrame + Math.floor((elapsedMs / 1000) * fps),
    );
    if (next !== currentFrame) {
      for (const scene of mounted) postSeek(scene, next, fps);
      emitFrame(next);
    }
    if (next >= composition.durationInFrames - 1) {
      stopClock();
      options.reporter?.reportTransport({ type: "ended" });
      return;
    }
    rafId = requestAnimationFrame(tick);
  };

  return {
    kind: "html-scene",
    prepare(next: PreviewCompositionDescriptor) {
      stopClock();
      clearMount();
      composition = next;
      const scenes = (
        options.resolveScenes ?? extractHtmlScenesFromComposition
      )(next);

      for (const scene of scenes) {
        const capacity = validateHtmlDocumentCapacity(scene.source);
        if (!capacity.ok) {
          options.reporter?.reportError(capacity.reason);
          continue;
        }
        const wrapped = wrapHtmlDocumentForPreview(scene.source);
        const blob = createHtmlSceneBlobUrl(wrapped);
        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", HTML_SCENE_SANDBOX);
        iframe.setAttribute("title", `HTML MG ${scene.id}`);
        iframe.dataset.htmlSceneId = scene.id;
        if (scene.sourceNodeId) {
          iframe.dataset.htmlSceneSourceNodeId = scene.sourceNodeId;
        }
        iframe.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;pointer-events:none;";
        iframe.src = blob.url;
        options.mountElement.appendChild(iframe);
        mounted.push({ ...scene, iframe, blob });
      }
      currentFrame = 0;
    },
    seek(frame: number) {
      if (!composition) return;
      const fps = composition.fps || 30;
      const clamped = Math.max(
        0,
        Math.min(composition.durationInFrames - 1, Math.round(frame)),
      );
      for (const scene of mounted) postSeek(scene, clamped, fps);
      emitFrame(clamped);
    },
    play() {
      if (!composition || playing) return;
      playing = true;
      playStartedAtFrame = currentFrame;
      playStartedAtMs =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      options.reporter?.reportTransport({ type: "play" });
      rafId = requestAnimationFrame(tick);
    },
    pause() {
      if (!playing) return;
      stopClock();
      options.reporter?.reportTransport({ type: "pause" });
    },
    dispose() {
      stopClock();
      clearMount();
      composition = null;
      frameListeners.clear();
    },
    onFrame(listener: (frame: number) => void) {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
  };
}
