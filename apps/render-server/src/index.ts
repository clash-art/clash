import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { renderTimeline } from "./render.js";
import { extractFrame } from "./thumbnail.js";
import { probeAudio } from "./audioProbe.js";
import { shutdownNodeTelemetry } from "@clash/shared-telemetry/node";
import { measured, publicErrorMessage, renderLog, sourceTag } from "./observability.js";

const log = renderLog.child("http");

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

/**
 * POST /thumbnail — extract a single frame from a video.
 *
 * Body: { sourceUrl: string, timeSec?: number, format?: "jpg"|"png"|"webp", width?: number }
 * Response: image bytes with appropriate Content-Type.
 *
 * `sourceUrl` is typically a short-lived signed `/assets/<key>` URL issued by
 * api-cf; ffmpeg fetches it over HTTP. In prod the zone handles this at the
 * edge via Cloudflare Media Transformations instead — this endpoint is the
 * dev / Container path. See apps/api-cf/src/services/thumbnail.ts.
 */
app.post("/thumbnail", async (c) => {
  let body: {
    sourceUrl?: string;
    timeSec?: number;
    format?: "jpg" | "png" | "webp";
    width?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.sourceUrl || typeof body.sourceUrl !== "string") {
    return c.json({ error: "Missing sourceUrl" }, 400);
  }

  const tag = { source: sourceTag(body.sourceUrl), time_sec: body.timeSec ?? 1 };
  log.info("thumbnail.requested", tag);

  try {
    const sourceUrl = body.sourceUrl;
    const { bytes, contentType, sourceWidth, sourceHeight, durationMs } = await measured(
      "thumbnail",
      () =>
        extractFrame({
          sourceUrl,
          timeSec: body.timeSec,
          format: body.format,
          width: body.width,
        }),
    );
    log.info("thumbnail.completed", {
      bytes: bytes.byteLength,
      source_width: sourceWidth,
      source_height: sourceHeight,
      duration_ms: durationMs,
    });
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=60",
      // CORS passthrough so callers can read the metadata headers (api-cf does).
      "Access-Control-Expose-Headers":
        "X-Source-Width, X-Source-Height, X-Duration-Ms",
    };
    if (sourceWidth) headers["X-Source-Width"] = String(sourceWidth);
    if (sourceHeight) headers["X-Source-Height"] = String(sourceHeight);
    if (durationMs) headers["X-Duration-Ms"] = String(durationMs);
    return new Response(bytes.buffer as ArrayBuffer, { headers });
  } catch (e) {
    log.error("thumbnail.failed", { ...tag, error: e });
    return c.json({ error: publicErrorMessage(e) }, 500);
  }
});

/**
 * POST /probe-audio — extract duration + 128-peak waveform from an audio file.
 *
 * Body: { sourceUrl: string }
 * Response: { durationMs: number, waveform: number[] }
 *
 * No edge counterpart — Cloudflare Media Transformations doesn't handle audio,
 * so api-cf's services/audio-metadata.ts always dispatches here.
 */
app.post("/probe-audio", async (c) => {
  let body: { sourceUrl?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.sourceUrl || typeof body.sourceUrl !== "string") {
    return c.json({ error: "Missing sourceUrl" }, 400);
  }

  const tag = { source: sourceTag(body.sourceUrl) };
  log.info("probe_audio.requested", tag);

  try {
    const sourceUrl = body.sourceUrl;
    const { durationMs, waveform } = await measured("probe_audio", () =>
      probeAudio({ sourceUrl }),
    );
    log.info("probe_audio.completed", {
      duration_ms: durationMs,
      peaks: waveform.length,
    });
    return c.json({ durationMs, waveform });
  } catch (e) {
    log.error("probe_audio.failed", { ...tag, error: e });
    return c.json({ error: publicErrorMessage(e) }, 500);
  }
});

app.post("/render", async (c) => {
  const { timelineDsl, projectId, taskId } = await c.req.json<{
    timelineDsl: Record<string, any>;
    projectId: string;
    taskId: string;
  }>();

  if (!timelineDsl?.tracks) {
    return c.json({ error: "Missing timelineDsl.tracks" }, 400);
  }

  log.info("render.started", {
    task_id: taskId,
    project_id: projectId,
    tracks: timelineDsl.tracks.length,
  });

  try {
    const compositionWidth =
      typeof timelineDsl?.compositionWidth === "number" && timelineDsl.compositionWidth > 0
        ? timelineDsl.compositionWidth
        : 1920;
    const compositionHeight =
      typeof timelineDsl?.compositionHeight === "number" && timelineDsl.compositionHeight > 0
        ? timelineDsl.compositionHeight
        : 1080;
    const fps =
      typeof timelineDsl?.fps === "number" && timelineDsl.fps > 0
        ? timelineDsl.fps
        : 30;
    const durationInFrames =
      typeof timelineDsl?.durationInFrames === "number" && timelineDsl.durationInFrames > 0
        ? timelineDsl.durationInFrames
        : 300;
    const durationMs = Math.round((durationInFrames * 1000) / fps);

    const buffer = await measured("render", () => renderTimeline(timelineDsl, taskId));
    log.info("render.completed", { task_id: taskId, bytes: buffer.byteLength });

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": buffer.byteLength.toString(),
        "X-Render-Width": String(compositionWidth),
        "X-Render-Height": String(compositionHeight),
        "X-Render-Duration-Ms": String(durationMs),
      },
    });
  } catch (e) {
    log.error("render.failed", { task_id: taskId, error: e });
    return c.json({ error: publicErrorMessage(e) }, 500);
  }
});

const port = parseInt(process.env.PORT || "8080", 10);
log.info("server.listening", { port });
const server = serve({ fetch: app.fetch, port });

// Container stop sends SIGTERM: stop accepting requests, then flush the last
// spans and metric interval before exiting (bounded so a stuck export or
// long render cannot hold the container past its grace period).
// `on`, not `once`: under tsx (dev) a hidden signal handler exits as soon as
// no app listener remains. A repeated signal only re-arms the same exit.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log.info("server.stopping", { signal });
    server.close();
    const deadline = setTimeout(() => process.exit(0), 10_000);
    deadline.unref();
    void shutdownNodeTelemetry()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
