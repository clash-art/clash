import { hostedGenerationStatus } from "../generation/status";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";

import type { Env } from "../config";
import { log } from "../logger";
import { startGeneration } from "../generation/start";
import { Status } from "../domain/canvas";
import { getAssetByTaskId } from "../services/assets";
import { uploadBase64Image } from "../services/r2";
import type { GenerationParams } from "../agents/generation";
import {
  DEFAULT_IMAGE_MODEL,
  GenerateDescriptionRequestSchema,
  GenerateImageRequestSchema,
  GenerateSemanticIDRequestSchema,
  GenerateVideoRequestSchema,
  TaskSubmitRequestSchema,
} from "../domain/requests";

export const api = new Hono<{ Bindings: Env }>();

api.use("/*", cors());

// Suno requires a public callback URL even when the client polls task state.
// Generation completion remains polling-driven; this endpoint intentionally
// acknowledges callbacks without mutating workflow state.
api.post("/api/v1/provider-callbacks/suno", (c) => c.json({ ok: true }));

api.onError((err, c) => {
  if (err instanceof ZodError) {
    return c.json({ error: "Validation failed", details: err.issues }, 400);
  }
  log.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

// ─── Helpers ───────────────────────────────────────────────

function stripDataUrl(base64Str: string): string {
  const idx = base64Str.indexOf("base64,");
  return idx >= 0 ? base64Str.slice(idx + 7) : base64Str;
}

/** Convert an ArrayBuffer to a base64 string, chunked to avoid stack overflow. */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 8192;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(chunks.join(""));
}

const FETCH_TIMEOUT_MS = 30_000;

async function fetchUrlToBase64(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`Failed to fetch reference image: ${url}`);
    const buf = await resp.arrayBuffer();
    return arrayBufferToBase64(buf);
  } catch (e: any) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`Timed out fetching image: ${url}`);
    throw e;
  }
}

/** Resolve base64/URL image arrays to base64 strings. */
function resolveImagesToBase64(
  base64Images: string[] | undefined,
  referenceUrls: string[] | undefined
): { base64Inputs: string[]; urlPromises: Promise<string[]> } {
  const base64Inputs = (base64Images ?? []).filter(Boolean).map(stripDataUrl);
  const urlPromises = Promise.allSettled(
    (referenceUrls ?? []).filter(Boolean).map(fetchUrlToBase64)
  ).then((results) =>
    results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
      .map((r) => r.value)
  );
  return { base64Inputs, urlPromises };
}

/** Resolve the calling user's id from the request. The /api/v1 middleware
 *  already populated x-user-id from cookie or API token; the legacy
 *  /api/generate/* endpoints don't pass through that gateway but the
 *  edge gateway still stamps the header. Used by Phase 0 attribution to
 *  populate actorUserId on every GenerationParams the route mints.
 *  Returns "" when nothing is available; the route then 401s explicitly. */
function getActorUserId(c: Context<{ Bindings: Env }>): string {
  return c.req.header("x-user-id") ?? "";
}

/** Submit a generation task to the Workflow. Returns error response if create fails. */
async function submitToWorkflow(
  c: Context<{ Bindings: Env }>,
  taskId: string,
  genParams: GenerationParams
): Promise<Response | null> {
  try {
    await startGeneration(c.env, taskId, genParams);
    return null; // success
  } catch (e) {
    // Asset row is created inside the workflow on completion; nothing to mark failed here.
    // The orphan-recovery loop in NodeProcessor catches stuck `pendingTask` via workflow.status().
    log.error("Failed to create workflow instance:", e);
    return c.json({ error: "Failed to start generation task" }, 500);
  }
}

// ─── POST /api/generate/image ──────────────────────────────

api.post("/api/generate/image", async (c) => {
  const body = GenerateImageRequestSchema.parse(await c.req.json());
  const taskId = crypto.randomUUID();

  // Resolve reference images to base64 upfront
  const { base64Inputs, urlPromises } = resolveImagesToBase64(body.base64_images, body.reference_image_urls);
  const urlInputs = await urlPromises;
  const allImages = [...base64Inputs, ...urlInputs];

  // Upload resolved base64 images to R2 to get R2 keys
  const referenceImageR2Keys: string[] = [];
  for (const b64 of allImages) {
    const key = await uploadBase64Image(c.env.R2_BUCKET, b64, body.project_id);
    referenceImageR2Keys.push(key);
  }

  const actorUserId = getActorUserId(c);
  if (!actorUserId) return c.json({ error: "unauthorized" }, 401);

  // Submit to Workflow (D1 asset created inside workflow on completion)
  const genParams: GenerationParams = {
    taskId,
    nodeId: body.asset_id,
    type: "image_gen",
    projectId: body.project_id,
    prompt: body.prompt,
    systemPrompt: body.system_prompt,
    aspectRatio: body.aspect_ratio,
    modelName: body.model_name ?? DEFAULT_IMAGE_MODEL,
    referenceImageR2Keys: referenceImageR2Keys.length ? referenceImageR2Keys : undefined,
    actorType: "user",
    actorUserId,
  };

  const errorResponse = await submitToWorkflow(c, taskId, genParams);
  if (errorResponse) return errorResponse;

  return c.json({
    base64: null,
    model: body.model_name ?? DEFAULT_IMAGE_MODEL,
    task_id: taskId,
  });
});

// ─── POST /api/generate/video ──────────────────────────────

api.post("/api/generate/video", async (c) => {
  const body = GenerateVideoRequestSchema.parse(await c.req.json());
  const taskId = crypto.randomUUID();

  const hasImage =
    body.image_url ||
    (body.base64_images ?? []).some(Boolean) ||
    (body.reference_image_urls ?? []).some(Boolean);
  if (!hasImage) {
    return c.json({ error: "No image provided" }, 400);
  }

  // Resolve primary image to base64
  let primaryBase64: string | undefined;
  if (body.image_url) {
    if (body.image_url.startsWith("http://") || body.image_url.startsWith("https://")) {
      primaryBase64 = await fetchUrlToBase64(body.image_url);
    } else if (body.image_url.includes("base64,")) {
      primaryBase64 = stripDataUrl(body.image_url);
    }
  }

  const { base64Inputs, urlPromises } = resolveImagesToBase64(body.base64_images, body.reference_image_urls);
  const urlInputs = await urlPromises;

  const imageToUse = primaryBase64 ?? base64Inputs[0] ?? urlInputs[0];
  if (!imageToUse) {
    return c.json({ error: "Failed to resolve image to base64" }, 400);
  }

  // Upload base64 image to R2 to get an R2 key. Routed as a flat reference
  // image — provider (e.g. fal-video for Sora 2) maps it to the i2v anchor
  // slot internally based on its model id.
  const imageKey = await uploadBase64Image(c.env.R2_BUCKET, imageToUse, body.project_id);

  const actorUserId = getActorUserId(c);
  if (!actorUserId) return c.json({ error: "unauthorized" }, 401);

  // Submit to Workflow (D1 asset created inside workflow on completion)
  const genParams: GenerationParams = {
    taskId,
    nodeId: body.asset_id,
    type: "video_gen",
    projectId: body.project_id,
    prompt: body.prompt,
    referenceImageR2Keys: [imageKey],
    duration: body.duration,
    cfgScale: body.cfg_scale,
    videoModel: body.model,
    actorType: "user",
    actorUserId,
  };

  const errorResponse = await submitToWorkflow(c, taskId, genParams);
  if (errorResponse) return errorResponse;

  return c.json({
    url: null,
    duration: body.duration,
    model: body.model,
    task_id: taskId,
  });
});

// ─── POST /api/describe ────────────────────────────────────

api.post("/api/describe", (c) => c.json({ error: "Hosted description generation is unavailable. Use the supported visual understanding operation.", code: "HOSTED_DESCRIPTION_UNAVAILABLE" }, 410));

// ─── GET /api/tasks/:taskId ────────────────────────────────

api.get("/api/tasks/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const durable = await hostedGenerationStatus(c.env, taskId);
  if (durable) {
    if (durable.actorUserId !== getActorUserId(c)) return c.json({ error: "Task not found" }, 404);
    return c.json({ task_id: taskId, status: durable.status, ...(durable.assetId ? { asset_id: durable.assetId } : {}), ...(durable.updates ? { result_data: durable.updates } : {}), ...(durable.error ? { error: durable.error } : {}) });
  }
  const asset = await getAssetByTaskId(c.env.DB, taskId);

  if (!asset) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({
    task_id: taskId,
    status: Status.Completed,
    asset_id: asset.id,
    result_url: asset.srcR2Key,
    result_data: {
      cover_url: asset.coverR2Key ?? undefined,
    },
  });
});

// ─── POST /api/tasks/submit ────────────────────────────────

api.post("/api/tasks/submit", async (c) => {
  const body = TaskSubmitRequestSchema.parse(await c.req.json());
  const taskId = crypto.randomUUID();
  const { task_type, project_id, node_id, params } = body;
  const actorUserId = getActorUserId(c);
  if (!actorUserId) return c.json({ error: "unauthorized" }, 401);

  if (task_type === "image_gen") {
    const referenceImages: string[] = params.reference_images ?? [];
    const resolvedR2Keys: string[] = [];
    for (const ref of referenceImages) {
      if (ref.startsWith("http://") || ref.startsWith("https://")) {
        try {
          const b64 = await fetchUrlToBase64(ref);
          const key = await uploadBase64Image(c.env.R2_BUCKET, b64, project_id);
          resolvedR2Keys.push(key);
        } catch (e) {
          log.error(`Failed to fetch reference image: ${ref}`, e);
        }
      } else if (ref.startsWith("projects/")) {
        resolvedR2Keys.push(ref);
      }
    }

    const genParams: GenerationParams = {
      taskId,
      nodeId: node_id,
      type: "image_gen",
      projectId: project_id,
      prompt: params.prompt ?? "",
      aspectRatio: params.aspect_ratio ?? "16:9",
      modelName: params.model,
      referenceImageR2Keys: resolvedR2Keys.length ? resolvedR2Keys : undefined,
      actorType: "user",
      actorUserId,
    };

    const errorResponse = await submitToWorkflow(c, taskId, genParams);
    if (errorResponse) return errorResponse;

    return c.json({ task_id: taskId, status: Status.Pending });
  }

  if (task_type === "video_gen") {
    let imageKey: string | undefined;
    const imageRef = params.image_r2_key ?? params.reference_images?.[0];
    if (imageRef) {
      if (imageRef.startsWith("http://") || imageRef.startsWith("https://")) {
        const b64 = await fetchUrlToBase64(imageRef);
        imageKey = await uploadBase64Image(c.env.R2_BUCKET, b64, project_id);
      } else if (imageRef.startsWith("projects/")) {
        imageKey = imageRef;
      }
    }

    if (!imageKey) {
      return c.json({ error: "No image provided for video generation" }, 400);
    }

    const genParams: GenerationParams = {
      taskId,
      nodeId: node_id,
      type: "video_gen",
      projectId: project_id,
      prompt: params.prompt ?? "",
      referenceImageR2Keys: [imageKey],
      duration: params.duration,
      cfgScale: params.cfg_scale,
      videoModel: params.model,
      actorType: "user",
      actorUserId,
    };

    const errorResponse = await submitToWorkflow(c, taskId, genParams);
    if (errorResponse) return errorResponse;

    return c.json({ task_id: taskId, status: Status.Pending });
  }

  if (task_type === "image_desc" || task_type === "video_desc") {
    const r2Key = params.r2_key as string | undefined;
    if (!r2Key) {
      return c.json({ error: "Missing r2_key for description" }, 400);
    }

    const cleanKey = r2Key.startsWith("http://") || r2Key.startsWith("https://")
      ? new URL(r2Key).pathname.replace(/^\//, "")
      : r2Key;

    const genParams: GenerationParams = {
      taskId,
      nodeId: node_id,
      type: task_type as GenerationParams["type"],
      projectId: project_id,
      r2Key: cleanKey,
      mimeType: params.mime_type as string || "image/png",
      actorType: "user",
      actorUserId,
    };

    const errorResponse = await submitToWorkflow(c, taskId, genParams);
    if (errorResponse) return errorResponse;

    return c.json({ task_id: taskId, status: Status.Pending });
  }

  if (task_type === "video_thumbnail") {
    return c.json({ task_id: null, status: Status.Completed });
  }

  if (task_type === "audio_gen") {
    const genParams: GenerationParams = {
      taskId,
      nodeId: node_id,
      type: "audio_gen",
      projectId: project_id,
      prompt: params.prompt ?? "",
      modelName: params.model as string | undefined,
      modelParams: params.model_params as Record<string, unknown> | undefined,
      actorType: "user",
      actorUserId,
    };

    const errorResponse = await submitToWorkflow(c, taskId, genParams);
    if (errorResponse) return errorResponse;

    return c.json({ task_id: taskId, status: Status.Pending });
  }

  if (task_type === "text_gen") {
    const genParams: GenerationParams = {
      taskId,
      nodeId: node_id,
      type: "text_gen",
      projectId: project_id,
      prompt: params.prompt ?? "",
      modelName: params.model,
      modelParams: params.model_params as Record<string, unknown> | undefined,
      actorType: "user",
      actorUserId,
    };

    const errorResponse = await submitToWorkflow(c, taskId, genParams);
    if (errorResponse) return errorResponse;

    return c.json({ task_id: taskId, status: Status.Pending });
  }

  if (task_type === "video_render") {
    return c.json({ error: "Video rendering is handled client-side via Remotion" }, 501);
  }

  return c.json({ error: `Unknown task_type: ${task_type}` }, 400);
});

// The ProjectRoom ClashAgent upload protocol was replaced by executable
// plugins hosted by local-api. Keep an explicit tombstone so old SDKs fail
// deterministically instead of writing a second Asset model into D1/R2.
api.all("/api/custom-action/upload", (c) =>
  c.json(
    {
      error:
        "Legacy ClashAgent custom-action upload is retired; use a clash.plugin/v1 executable plugin.",
      code: "LEGACY_CUSTOM_ACTION_PROTOCOL_RETIRED",
    },
    410,
  ),
);

// ─── POST /api/generate-ids ───────────────────────────────

api.post("/api/generate-ids", async (c) => {
  const body = GenerateSemanticIDRequestSchema.parse(await c.req.json());

  const ids: string[] = [];
  for (let i = 0; i < body.count; i++) {
    ids.push(crypto.randomUUID().slice(0, 8));
  }

  return c.json({ ids, project_id: body.project_id });
});
