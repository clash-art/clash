/**
 * One HTTP contract for Provider-route voice input, mounted by every hosted
 * adapter. Identity, catalog/credential/audit ports and `fetch` come from the
 * adapter; multipart parsing, the size limit and response shapes live here.
 */
import { Hono, type Context, type Env } from "hono";
import {
  VOICE_INPUT_DISABLED_MESSAGE,
  VOICE_INPUT_MAX_AUDIO_BYTES,
  VOICE_INPUT_NOT_CONFIGURED_MESSAGE,
  VoiceInputError,
  isVoiceInputProviderReady,
  resolveVoiceInputReadiness,
  transcribeVoiceInputWithProvider,
  type VoiceInputPorts,
} from "./cloud-project-host/voice-input.js";

/** Room for multipart boundaries and the language field around the audio part. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const AUDIO_TOO_LARGE = "Audio upload exceeds the 20 MB limit.";

export interface VoiceInputRouteOptions<E extends Env> {
  /** Build the user-scoped ports for one request. */
  createPorts: (c: Context<E>, userId: string) => VoiceInputPorts;
  /** Defaults to the neutral `x-user-id` header used by the v1 gateway. */
  userId?: (c: Context<E>) => string | null;
}

function errorResponse<E extends Env>(c: Context<E>, error: unknown) {
  if (error instanceof VoiceInputError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  // A Provider/network failure keeps its original message; it is never masked.
  return c.json(
    {
      error:
        error instanceof Error && error.message
          ? error.message
          : "Voice input transcription failed.",
      code: "VOICE_INPUT_PROVIDER_FAILED",
    },
    502,
  );
}

export function createVoiceInputRoutes<E extends Env = Env>(
  options: VoiceInputRouteOptions<E>,
): Hono<E> {
  const routes = new Hono<E>();
  const userIdOf =
    options.userId ?? ((c: Context<E>) => c.req.header("x-user-id") ?? null);

  routes.get("/audio/voice-input", async (c) => {
    const userId = userIdOf(c);
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    try {
      const ports = options.createPorts(c, userId);
      const selection = await ports.resolveVoiceInputSelection(userId);
      const entry = selection.enabled
        ? await ports.resolveModelEntry(userId, selection.model)
        : null;
      return c.json(resolveVoiceInputReadiness(selection, entry).response);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  /**
   * Hosted warmup: a ready Provider route needs no local runtime; an
   * unconfigured one reports the same needs-config state as readiness, plus the
   * coded error the composer shows (a bare 409 left the user with "HTTP 409"). The
   * local Host keeps its builtin-rpc warmup under the same path.
   */
  routes.post("/audio/voice-input/warmup", async (c) => {
    const userId = userIdOf(c);
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    try {
      const ports = options.createPorts(c, userId);
      const selection = await ports.resolveVoiceInputSelection(userId);
      if (!selection.enabled) {
        return c.json(
          {
            status: "disabled",
            runtime: "provider-route",
            error: VOICE_INPUT_DISABLED_MESSAGE,
            code: "VOICE_INPUT_DISABLED",
          },
          409,
        );
      }
      const entry = await ports.resolveModelEntry(userId, selection.model);
      if (isVoiceInputProviderReady(entry)) {
        return c.json({ status: "not-needed", runtime: "provider-route" });
      }
      return c.json(
        {
          status: "needs-config",
          runtime: "provider-route",
          error: VOICE_INPUT_NOT_CONFIGURED_MESSAGE,
          code: "VOICE_INPUT_NOT_CONFIGURED",
        },
        409,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/audio/transcriptions", async (c) => {
    const userId = userIdOf(c);
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    // Reject oversized bodies before buffering the multipart form in memory.
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (
      declaredLength >
      VOICE_INPUT_MAX_AUDIO_BYTES + MULTIPART_OVERHEAD_BYTES
    ) {
      return c.json({ error: AUDIO_TOO_LARGE, code: "VOICE_INPUT_AUDIO_TOO_LARGE" }, 413);
    }
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "Missing file", code: "VOICE_INPUT_MISSING_FILE" }, 400);
    }
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return c.json({ error: "Missing file", code: "VOICE_INPUT_MISSING_FILE" }, 400);
    }
    if (file.size > VOICE_INPUT_MAX_AUDIO_BYTES) {
      return c.json({ error: AUDIO_TOO_LARGE, code: "VOICE_INPUT_AUDIO_TOO_LARGE" }, 413);
    }
    const language = form.get("language");
    try {
      const ports = options.createPorts(c, userId);
      const selection = await ports.resolveVoiceInputSelection(userId);
      const transcript = await transcribeVoiceInputWithProvider({
        userId,
        ports,
        selection,
        audio: {
          bytes: new Uint8Array(await file.arrayBuffer()),
          mediaType: file.type || "application/octet-stream",
        },
        language: typeof language === "string" ? language : null,
      });
      return c.json(transcript);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return routes;
}
