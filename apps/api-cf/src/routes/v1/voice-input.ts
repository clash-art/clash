/**
 * Cloudflare adapter of the shared voice-input contract.
 *
 * Readiness and transcription semantics live in
 * `@clash/shared-runtime/cloud-project-host/voice-input`. This module supplies
 * the hosted user model/provider-account settings and model catalog, then runs
 * the Provider call through the hosted text-generation adapter. Local ASR
 * install/models and builtin-rpc stay local-only.
 */
import { Hono, type Context } from "hono";
import {
  listModelCatalogEntries,
  type ModelCatalogEntry,
} from "@clash/shared-types";
import {
  VOICE_INPUT_MAX_AUDIO_BYTES,
  VOICE_INPUT_NOT_CONFIGURED_MESSAGE,
  VoiceInputError,
  isVoiceInputProviderReady,
  resolveVoiceInputReadiness,
  transcribeVoiceInputWithProvider,
  voiceInputUsesProviderRoute,
  type VoiceInputPorts,
  type VoiceInputSelection,
} from "@clash/shared-runtime/cloud-project-host/voice-input";
import type { Env } from "../../config";
import { transcribeWithTextGeneration } from "../../generation/adapters/text-gen";
import { loadHostedModelCards } from "../../generation/model-provider-route";

export interface VoiceInputRouteOptions {
  /** Tests inject ports; production reads the user's hosted model settings. */
  createPorts?: (env: Env, userId: string) => VoiceInputPorts;
}

type VoiceInputContext = Context<{ Bindings: Env }>;

function userIdOf(c: VoiceInputContext): string | null {
  return c.req.header("x-user-id") ?? null;
}

/** Hosted catalog from the shared loader; mock routes only run on the local Host. */
async function hostedCatalog(
  env: Env,
  userId: string,
): Promise<ModelCatalogEntry[]> {
  const { models, configuredProviders } = await loadHostedModelCards(env, userId, {
    excludeProviderIds: ["mock"],
  });
  return listModelCatalogEntries({ models, configuredProviders });
}

function chooseHostedSelection(
  entries: readonly ModelCatalogEntry[],
): VoiceInputSelection {
  const candidates = entries.filter(
    (entry) =>
      voiceInputUsesProviderRoute(entry) &&
      entry.selectedRoute?.apiShape !== "local-asr",
  );
  const chosen = candidates.find(isVoiceInputProviderReady) ?? candidates[0];
  return chosen
    ? { enabled: true, model: chosen.model.id }
    : { enabled: false, model: "" };
}

/** Reuse the user's hosted provider accounts/model cards; no new settings store. */
function createHostedVoiceInputPorts(
  env: Env,
  userId: string,
): VoiceInputPorts {
  let catalogPromise: Promise<ModelCatalogEntry[]> | undefined;
  const catalog = () => (catalogPromise ??= hostedCatalog(env, userId));
  const entryFor = async (modelId: string) =>
    (await catalog()).find((entry) => entry.model.id === modelId) ?? null;

  return {
    async resolveVoiceInputSelection() {
      return chooseHostedSelection(await catalog());
    },
    async resolveModelEntry(_userId, modelId) {
      return entryFor(modelId);
    },
    async transcribeWithModel({ modelId, audio, prompt, language }) {
      const entry = await entryFor(modelId);
      const route = entry?.selectedRoute;
      if (!route) {
        throw new VoiceInputError(VOICE_INPUT_NOT_CONFIGURED_MESSAGE, 409);
      }
      return transcribeWithTextGeneration({
        env,
        userId,
        route,
        audio,
        prompt,
        ...(language ? { language } : {}),
      });
    },
  };
}

function errorResponse(c: VoiceInputContext, error: unknown) {
  if (error instanceof VoiceInputError) {
    return c.json({ error: error.message }, error.status);
  }
  return c.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Voice input transcription failed.",
    },
    502,
  );
}

export function createVoiceInputRoutes(
  options: VoiceInputRouteOptions = {},
): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();
  const createPorts = options.createPorts ?? createHostedVoiceInputPorts;

  routes.get("/audio/voice-input", async (c) => {
    const userId = userIdOf(c);
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    try {
      const ports = createPorts(c.env, userId);
      const selection = await ports.resolveVoiceInputSelection(userId);
      const entry = selection.enabled
        ? await ports.resolveModelEntry(userId, selection.model)
        : null;
      return c.json(resolveVoiceInputReadiness(selection, entry).response);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/audio/transcriptions", async (c) => {
    const userId = userIdOf(c);
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const form = await c.req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return c.json({ error: "Missing file" }, 400);
    }
    if (file.size > VOICE_INPUT_MAX_AUDIO_BYTES) {
      return c.json({ error: "Audio upload exceeds the 20 MB limit." }, 413);
    }
    const language = form.get("language");
    try {
      const ports = createPorts(c.env, userId);
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
