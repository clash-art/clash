/**
 * The apps/render-server `/render` protocol, shared by every adapter that
 * renders a Timeline (Cloudflare GenerationWorkflow, Node render worker).
 *
 * The transport is a port: Cloudflare reaches render-server through
 * RENDER_SERVER_URL or its RENDER_CONTAINER binding, Node through an HTTP
 * origin. Request body, error text and `X-Render-*` metadata are one fact.
 */

export interface RenderServerPort {
  /** `path` is a render-server route such as `/render`. */
  fetch(path: string, init: RequestInit): Promise<Response>;
}

export interface RenderTimelineLike {
  compositionWidth?: number;
  compositionHeight?: number;
  fps?: number;
  durationInFrames?: number;
}

export interface RenderedTimelineMetadata {
  width?: number;
  height?: number;
  durationMs?: number;
}

type HeaderReader = Pick<Headers, "get">;

function readPositiveInt(
  headers: HeaderReader,
  name: string,
): number | undefined {
  const raw = headers.get(name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

export function getRenderMetadataFromHeaders(
  headers: HeaderReader,
  timelineDsl?: RenderTimelineLike | null,
): RenderedTimelineMetadata {
  const fps =
    typeof timelineDsl?.fps === "number" && timelineDsl.fps > 0
      ? timelineDsl.fps
      : undefined;
  const durationInFrames =
    typeof timelineDsl?.durationInFrames === "number" &&
    timelineDsl.durationInFrames > 0
      ? timelineDsl.durationInFrames
      : undefined;

  return {
    width:
      readPositiveInt(headers, "X-Render-Width") ??
      (typeof timelineDsl?.compositionWidth === "number" &&
      timelineDsl.compositionWidth > 0
        ? timelineDsl.compositionWidth
        : undefined),
    height:
      readPositiveInt(headers, "X-Render-Height") ??
      (typeof timelineDsl?.compositionHeight === "number" &&
      timelineDsl.compositionHeight > 0
        ? timelineDsl.compositionHeight
        : undefined),
    durationMs:
      readPositiveInt(headers, "X-Render-Duration-Ms") ??
      (fps && durationInFrames
        ? Math.round((durationInFrames * 1000) / fps)
        : undefined),
  };
}

/** One `POST /render`; media in `timelineDsl` must already be fetchable URLs. */
export async function renderTimelineVideo(
  port: RenderServerPort,
  request: {
    timelineDsl: Record<string, unknown> | undefined;
    projectId: string;
    taskId: string;
  },
): Promise<{ bytes: ArrayBuffer; metadata: RenderedTimelineMetadata }> {
  const response = await port.fetch("/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timelineDsl: request.timelineDsl,
      projectId: request.projectId,
      taskId: request.taskId,
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Render server error ${response.status}: ${errText}`);
  }
  const bytes = await response.arrayBuffer();
  return {
    bytes,
    metadata: getRenderMetadataFromHeaders(
      response.headers,
      request.timelineDsl as RenderTimelineLike | undefined,
    ),
  };
}

/** render-server reached over HTTP at `origin` (no path, query or credentials). */
export function createHttpRenderServerPort(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): RenderServerPort {
  const base = origin.replace(/\/+$/, "");
  return { fetch: (path, init) => fetchImpl(`${base}${path}`, init) };
}
