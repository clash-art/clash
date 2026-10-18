/**
 * Browser Timeline render adapter (apps/web composition root only).
 *
 * The renderer itself runs in a cross-origin iframe: `renderMediaOnWeb`
 * appends a React root to `document.body` and walks the DOM
 * (node_modules/@remotion/web-renderer/dist/esm/index.mjs:1518 creates the
 * root, :4781 creates a TreeWalker), so a Worker cannot host it. A
 * cross-site iframe is an out-of-process iframe with its own main thread, so
 * the editor stays responsive.
 *
 * Upper layers only see the Timeline render port: progress and cancellation
 * travel through it, and a browser render that cannot run or throws falls
 * back to `submit()` — the same Host request the Cloudflare adapter turns
 * into a RENDER_CONTAINER run. A user cancel never falls back.
 */
import { createProjectAssetHttpClient } from "@clash/asset-sdk";
import type {
  TimelineRenderExecutor,
  TimelineRenderReceipt,
} from "@clash/shared-runtime";
import type { ResolvedAsset } from "@clash/shared-types";
import { projectAssetPlaybackUrl } from "@clash/web-ui/lib/assets";
import { runtimeApiUrl } from "@clash/web-ui/lib/runtimeConfig";
import { importProjectAssetFile } from "@clash/web-ui/lib/hooks/useAsset";
import { preflightBrowserTimelineRender } from "./preflight";
import {
  TIMELINE_RENDER_PROTOCOL,
  isTimelineRenderFrameMessage,
  isTrustedFrameMessage,
  type TimelineRenderFrameCommand,
  type TimelineRenderFrameRequest,
} from "./protocol";

/** The frame said it cannot render this Timeline; fall back to the Host. */
export class TimelineRenderFrameUnsupported extends Error {
  constructor(
    readonly reason: string,
    message = reason,
  ) {
    super(message);
    this.name = "TimelineRenderFrameUnsupported";
  }
}

export interface TimelineFrameRenderInput extends TimelineRenderFrameRequest {
  frameUrl: string;
  signal: AbortSignal;
  onProgress(progress: number): void;
  document?: Document;
}

/** Injectable for tests; the production implementation owns the iframe. */
export type TimelineFrameRenderer = (
  input: TimelineFrameRenderInput,
) => Promise<Blob>;

function abortError(): DOMException {
  return new DOMException("The render was cancelled", "AbortError");
}

/**
 * Runs one render inside a hidden cross-origin iframe and enforces the
 * protocol's exact-origin/source checks. The iframe is removed on every exit
 * path so a cancelled render cannot keep painting.
 */
export function renderTimelineInIframe(
  input: TimelineFrameRenderInput,
): Promise<Blob> {
  const ownerDocument = input.document ?? document;
  const frameOrigin = new URL(input.frameUrl).origin;
  return new Promise<Blob>((resolve, reject) => {
    const iframe = ownerDocument.createElement("iframe");
    iframe.title = "Timeline render frame";
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.style.cssText = [
      "position:fixed",
      "left:-10000px",
      "top:0",
      "border:0",
      "opacity:0",
      "pointer-events:none",
      `width:${input.width}px`,
      `height:${input.height}px`,
    ].join(";");

    let settled = false;
    const cleanup = () => {
      ownerDocument.defaultView?.removeEventListener("message", onMessage);
      input.signal.removeEventListener("abort", onAbort);
      iframe.remove();
    };
    const finish = (error: unknown, file?: Blob) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(file!);
    };
    const send = (command: TimelineRenderFrameCommand) => {
      iframe.contentWindow?.postMessage(command, frameOrigin);
    };
    const onAbort = () => {
      send({
        protocol: TIMELINE_RENDER_PROTOCOL,
        type: "cancel",
        parentOrigin: ownerDocument.location.origin,
      });
      finish(abortError());
    };
    const onMessage = (event: MessageEvent) => {
      if (
        !isTrustedFrameMessage(
          event,
          frameOrigin,
          iframe.contentWindow,
        )
      )
        return;
      const message = event.data;
      if (!isTimelineRenderFrameMessage(message)) return;
      switch (message.type) {
        case "ready":
          send({
            protocol: TIMELINE_RENDER_PROTOCOL,
            type: "render",
            parentOrigin: ownerDocument.location.origin,
            request: {
              tracks: input.tracks,
              width: input.width,
              height: input.height,
              fps: input.fps,
              durationInFrames: input.durationInFrames,
              licenseKey: input.licenseKey,
              allowHtmlInCanvas: input.allowHtmlInCanvas,
            },
          });
          return;
        case "progress":
          input.onProgress(message.progress);
          return;
        case "done":
          finish(null, message.file);
          return;
        case "unsupported":
          finish(new TimelineRenderFrameUnsupported(message.reason));
          return;
        case "cancelled":
          finish(abortError());
          return;
        case "error":
          finish(new Error(message.error));
          return;
      }
    };

    input.signal.addEventListener("abort", onAbort, { once: true });
    ownerDocument.defaultView?.addEventListener("message", onMessage);
    iframe.src = input.frameUrl;
    ownerDocument.body.appendChild(iframe);
    if (input.signal.aborted) onAbort();
  });
}

export interface BrowserTimelineRenderExecutorOptions {
  /** Origin of the separate render-frame site (or a full frame URL). */
  frameOrigin: string;
  /** Read from config at the composition root; empty today. */
  licenseKey: string | null;
  /** Config flag, default false. Only honoured when the frame supports it. */
  allowHtmlInCanvas?: boolean;
  /** Config cap in seconds, default ten minutes. */
  maxDurationSeconds?: number;
  /** Injectable seams for unit tests; production uses the values below. */
  renderFrame?: TimelineFrameRenderer;
  uploadAsset?: (input: {
    projectId: string;
    file: File;
  }) => Promise<ResolvedAsset>;
  publishRender?: (input: {
    projectId: string;
    timelineId: string;
    assetId: string;
  }) => Promise<TimelineRenderReceipt>;
  /** Best-effort cleanup when the publication endpoint keeps failing. */
  discardAsset?: (input: {
    projectId: string;
    assetId: string;
  }) => Promise<void>;
  /** Surfaces cleanup failures that would otherwise be lost with an abort. */
  onNotice?: (message: string) => void;
  browser?: { isWebKit: boolean; hasWebCodecs: boolean };
}

function frameUrlFrom(origin: string): string {
  const trimmed = origin.trim().replace(/\/+$/, "");
  return /render-frame\.html$/.test(trimmed)
    ? trimmed
    : `${trimmed}/render-frame.html`;
}

function browserSupport(): { isWebKit: boolean; hasWebCodecs: boolean } {
  const userAgent =
    typeof navigator === "undefined" ? "" : navigator.userAgent;
  return {
    isWebKit: /AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Edg|OPR/.test(
      userAgent,
    ),
    hasWebCodecs: typeof VideoEncoder !== "undefined",
  };
}

/** Absolute URL for the frame origin; relative Host projections use the page. */
function absoluteMediaUrl(value: string): string {
  if (/^(?:https?:|blob:|data:)/i.test(value)) return value;
  return new URL(value, window.location.origin).toString();
}

async function signedTrackSources(
  projectId: string,
  tracks: unknown[],
): Promise<unknown[]> {
  const assetIds = new Set<string>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.assetId === "string" &&
      record.assetId &&
      typeof record.src !== "string"
    )
      assetIds.add(record.assetId);
    for (const key of ["items", "tracks"]) collect(record[key]);
  };
  collect(tracks);
  if (assetIds.size === 0) return tracks;
  const client = createProjectAssetHttpClient({ credentials: "include" });
  const assets = await client.batch({
    projectId,
    assetIds: [...assetIds],
  });
  const urlByAssetId = new Map<string, string>();
  for (const asset of assets) {
    const url = projectAssetPlaybackUrl(asset);
    if (url) urlByAssetId.set(asset.id, absoluteMediaUrl(url));
  }
  const bind = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(bind);
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = { ...record };
    if (typeof record.assetId === "string" && typeof record.src !== "string") {
      const url = urlByAssetId.get(record.assetId);
      if (url) next.src = url;
    }
    if (Array.isArray(record.items)) next.items = record.items.map(bind);
    if (Array.isArray(record.tracks)) next.tracks = record.tracks.map(bind);
    return next;
  };
  return bind(tracks) as unknown[];
}

/**
 * The server answered and refused the publication (4xx), so no Canvas node
 * references the uploaded Asset. Anything else (network loss, 5xx) is
 * ambiguous: the idempotent completion may already have published it.
 */
export class TimelineRenderPublicationRejected extends Error {
  override name = "TimelineRenderPublicationRejected";
}

async function publishTimelineRender(input: {
  projectId: string;
  timelineId: string;
  assetId: string;
}): Promise<TimelineRenderReceipt> {
  const response = await fetch(
    runtimeApiUrl(
      `/api/v1/projects/${encodeURIComponent(input.projectId)}/timeline-renders`,
    ),
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        timelineId: input.timelineId,
        assetId: input.assetId,
      }),
    },
  );
  let body:
    | { renderNodeId?: unknown; actionRunId?: unknown; error?: unknown }
    | undefined;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // A non-JSON refusal still carries its HTTP status to the caller.
    body = undefined;
  }
  if (
    !response.ok ||
    typeof body?.renderNodeId !== "string" ||
    typeof body.actionRunId !== "string"
  )
    throw new (
      response.status >= 400 && response.status < 500
        ? TimelineRenderPublicationRejected
        : Error
    )(
      typeof body?.error === "string"
        ? body.error
        : `Timeline render publication failed with HTTP ${response.status}`,
    );
  return { renderNodeId: body.renderNodeId, actionRunId: body.actionRunId };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBrowserTimelineRenderExecutor(
  options: BrowserTimelineRenderExecutorOptions,
): TimelineRenderExecutor {
  const renderFrame = options.renderFrame ?? renderTimelineInIframe;
  const uploadAsset =
    options.uploadAsset ??
    (async (input) =>
      importProjectAssetFile(input.projectId, input.file, {
        kind: "video",
        // Always use the import-session transport; never a second upload path.
        chunked: true,
      }));
  const publishRender = options.publishRender ?? publishTimelineRender;
  const discardAsset =
    options.discardAsset ??
    (async (input) => {
      await createProjectAssetHttpClient({ credentials: "include" }).trash({
        projectId: input.projectId,
        assetId: input.assetId,
      });
    });
  const reportNotice = (message: string) => options.onNotice?.(message);
  const maxDurationSeconds = options.maxDurationSeconds ?? 600;
  const browser = options.browser ?? browserSupport();
  return async ({
    projectId,
    observed,
    signal,
    onProgress,
    submit,
  }): Promise<TimelineRenderReceipt> => {
    let reachedPublication = false;
    // The Host submission runs at most once per export. A failed (possibly
    // ambiguous) container submission is never retried here: a second one
    // could queue a second render node.
    let submitted = false;
    const submitOnce = () => {
      submitted = true;
      return submit();
    };
    try {
      const preflight = preflightBrowserTimelineRender({
        state: observed.timeline.state,
        maxDurationSeconds,
        browser,
      });
      if (!preflight.ok) {
        const receipt = await submitOnce();
        return {
          ...receipt,
          renderPath: "host",
          fallback: {
            reason: preflight.reason,
            message: preflight.message,
          },
        };
      }
      const tracks = await signedTrackSources(projectId, preflight.tracks);
      const file = await renderFrame({
        frameUrl: frameUrlFrom(options.frameOrigin),
        tracks,
        width: preflight.width,
        height: preflight.height,
        fps: preflight.fps,
        durationInFrames: preflight.durationInFrames,
        licenseKey: options.licenseKey,
        allowHtmlInCanvas: options.allowHtmlInCanvas ?? false,
        signal,
        onProgress,
      });
      const upload = await uploadAsset({
        projectId,
        file: new File([file], `${observed.timeline.id}.mp4`, {
          type: file.type || "video/mp4",
        }),
      });
      if (signal.aborted) {
        try {
          await discardAsset({ projectId, assetId: upload.id });
        } catch (discardError) {
          reportNotice(
            `Export cancelled, but the uploaded file ${upload.id} could not be removed: ${errorMessage(discardError)}`,
          );
        }
        throw abortError();
      }
      reachedPublication = true;
      try {
        const receipt = await publishRender({
          projectId,
          timelineId: observed.timeline.id,
          assetId: upload.id,
        });
        return { ...receipt, renderPath: "browser" };
      } catch (firstError) {
        // The bytes are already public. Retry the node projection once rather
        // than starting a second render that would race this Asset.
        try {
          const receipt = await publishRender({
            projectId,
            timelineId: observed.timeline.id,
            assetId: upload.id,
          });
          return {
            ...receipt,
            renderPath: "browser",
            publicationRetried: { firstError: errorMessage(firstError) },
          };
        } catch (retryError) {
          // Discard only when the server definitively refused. After an
          // ambiguous failure the node may exist and reference this Asset;
          // trashing it would break a published render. An unreferenced
          // Asset stays in the library and a retry republishes idempotently.
          let message = `first: ${errorMessage(firstError)}; retry: ${errorMessage(retryError)}`;
          if (retryError instanceof TimelineRenderPublicationRejected) {
            try {
              await discardAsset({
                projectId,
                assetId: upload.id,
              });
            } catch (discardError) {
              message += `; discard: could not remove uploaded file ${upload.id}: ${errorMessage(discardError)}`;
            }
          }
          // Keep the retry's class: TimelineRenderPublicationRejected is what
          // tells callers the failure is definitive rather than ambiguous.
          if (retryError instanceof Error) {
            retryError.message = message;
            throw retryError;
          }
          throw new Error(message);
        }
      }
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw abortError();
      // A finished upload with a failed publication is not a render failure:
      // falling back would publish a second output for one user action.
      if (reachedPublication || submitted) throw error;
      const receipt = await submitOnce();
      return {
        ...receipt,
        renderPath: "host",
        fallback: {
          reason: "browser-render-failed",
          message: errorMessage(error),
        },
      };
    }
  };
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** Fallback reasons are exported for diagnostics and tests. */
export type { BrowserRenderFallbackReason } from "./preflight";
