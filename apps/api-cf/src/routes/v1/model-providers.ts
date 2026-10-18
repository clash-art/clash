import {
  buildEffectiveModelCards,
  invalidProviderModelFilters,
  listModelCatalogEntries,
  listDeclaredModelUpstreamRoutes,
  listProviderModelSupport,
  missingModelRouteCredentials,
  MODEL_CARDS,
  normalizeModelId,
  UserModelCardConfigSchema,
  PROVIDER_OAUTH_ERROR_MESSAGES,
  PROVIDER_OAUTH_RETURN_PARAMS,
  ProviderOAuthIdSchema,
  type ProviderOAuthErrorCode,
  type ProviderOAuthId,
  type ProviderAccountAvailability,
  type ModelCard,
  type ModelUpstreamRoute,
  type UserModelCardConfig,
} from "@clash/shared-types";
import { Hono } from "hono";
import type { Env } from "../../config";
import {
  deleteModelCardConfig,
  listModelCardConfigs,
  upsertModelCardConfig,
} from "../../services/model-card-configs";
import {
  listProviderAccounts,
  normalizeProviderAccountInput,
  deleteProviderAccount,
  upsertProviderAccounts,
  type PublicProviderAccount,
  type ProviderAccountInput,
} from "../../services/provider-accounts";
import {
  applyProviderOAuth,
  completeWebProviderOAuthCallback,
  deleteProviderOAuthRecord,
  deleteProviderOAuthRecordsForAccount,
  findProviderOAuthRecord,
  listProviderOAuthRecords,
  publicProviderOAuth,
  startWebProviderOAuth,
  type WebProviderOAuthCallbackResult,
} from "../../services/provider-oauth";
import {
  hostedOAuthProvider,
  ProviderOAuthConfigError,
} from "../../services/provider-oauth-config";
import { publicOrigin } from "../../services/public-origin";
import { hostedBaseModelCards } from "../../generation/hosted-model-cards";

export const modelProviderRoutes = new Hono<{ Bindings: Env }>();

function sameProviderAccount(
  a: Pick<ProviderAccountInput, "id" | "providerId" | "upstreamId" | "region">,
  b: Pick<ProviderAccountInput, "id" | "providerId" | "upstreamId" | "region">,
): boolean {
  if (a.id && b.id) return a.id === b.id;
  return a.providerId === b.providerId &&
    (a.upstreamId ?? "") === (b.upstreamId ?? "") &&
    (a.region ?? "") === (b.region ?? "");
}

function displayModelName(modelId: string): string {
  return MODEL_CARDS.find((model) => model.id === modelId)?.name ?? modelId;
}

function displayProviderName(provider: Pick<ProviderAccountInput, "providerId" | "upstreamId" | "region">): string {
  if (provider.providerId === "mock") return "Mock provider";
  if (provider.providerId === "official" && provider.upstreamId) {
    if (provider.upstreamId === "openai") return "OpenAI";
    if (provider.upstreamId === "anthropic") return "Anthropic";
    if (provider.upstreamId === "bfl") return "Black Forest Labs";
    if (provider.upstreamId === "google-ai-studio") return "Google AI Studio";
    if (provider.upstreamId === "google-agent-platform") return "Google Cloud Agent Platform";
    return provider.upstreamId;
  }
  const names: Record<string, string> = {
    fal: "fal.ai",
    replicate: "Replicate",
    kling: "Kling",
    minimax: "MiniMax",
    volcengine: "Volcengine",
    elevenlabs: "ElevenLabs",
    suno: "Suno API",
  };
  if (names[provider.providerId]) return names[provider.providerId];
  return provider.upstreamId && provider.upstreamId !== provider.providerId
    ? `${provider.providerId}/${provider.upstreamId}`
    : provider.providerId;
}

function parseProviderOAuthId(value: unknown): ProviderOAuthId | null {
  const parsed = ProviderOAuthIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function routeProviderId(route: ModelUpstreamRoute): string {
  if (route.providerId) return route.providerId;
  if (route.upstreamId === "local") return "local";
  if (
    route.upstreamId === "openai" ||
    route.upstreamId === "google-ai-studio" ||
    route.upstreamId === "google-agent-platform" ||
    route.upstreamId === "anthropic"
    || route.upstreamId === "bfl"
  ) {
    return "official";
  }
  if (route.upstreamId === "fal" || route.upstreamId === "pika" || route.upstreamId === "replicate" || route.upstreamId === "mock") {
    return route.upstreamId;
  }
  return "custom";
}

function modelRoutesForProviderAccount(
  account: Pick<ProviderAccountInput, "id" | "providerId" | "upstreamId" | "region">,
  modelId: string,
  models: readonly ModelCard[] = MODEL_CARDS,
): ModelUpstreamRoute[] {
  const routes = listDeclaredModelUpstreamRoutes(models);
  return routes.filter((route) =>
    route.modelCode === modelId &&
    (!route.accountId || route.accountId === account.id) &&
    routeProviderId(route) === account.providerId &&
    (!account.upstreamId || route.upstreamId === account.upstreamId) &&
    (route.region ?? "") === (account.region ?? "")
  );
}

async function listProviderAccountsWithOAuth(env: Env, userId: string) {
  const [accounts, oauthRecords] = await Promise.all([
    listProviderAccounts(env.DB, userId),
    listProviderOAuthRecords(env.DB, userId),
  ]);
  return applyProviderOAuth(accounts, oauthRecords);
}

function providerAccountAvailability(account: PublicProviderAccount): ProviderAccountAvailability {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...availability } = account;
  return availability;
}

function normalizeModelCardConfigInput(
  modelId: string,
  value: unknown,
  accounts: PublicProviderAccount[],
): UserModelCardConfig | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const builtIn = MODEL_CARDS.some((model) => model.id === modelId);
  const parsed = UserModelCardConfigSchema.safeParse({
    ...raw,
    modelId,
    custom: raw.custom ?? !builtIn,
  });
  if (!parsed.success) return null;
  const config = parsed.data;
  if (builtIn) {
    return !config.custom && config.providerBindings.length === 0 ? config : null;
  }
  if (!config.custom || !config.name || config.providerBindings.length === 0) return null;
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const validBindings = config.providerBindings.every((binding) => {
    const account = accountsById.get(binding.providerAccountId);
    if (!account) return false;
    if (account.apiShape === "openai-compatible" || account.apiShape === "anthropic-compatible") return true;
    return account.providerId === "official" &&
      (account.upstreamId === "openai" || account.upstreamId === "anthropic");
  });
  return validBindings ? config : null;
}

modelProviderRoutes.get("/model-providers", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ providers: await listProviderAccountsWithOAuth(c.env, userId) });
});

modelProviderRoutes.patch("/model-providers", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { providers?: unknown };
  const providers = Array.isArray(body.providers)
    ? body.providers.map(normalizeProviderAccountInput)
    : [];
  if (providers.length === 0 || providers.some((provider) => !provider)) {
    return c.json({ error: "Invalid providers" }, 400);
  }
  const normalizedProviders = providers.filter((provider) => !!provider);
  const invalidProviders = invalidProviderModelFilters(normalizedProviders);
  if (invalidProviders.length > 0) {
    return c.json({ error: "Invalid provider model filters", invalidProviders }, 400);
  }
  const saved = await upsertProviderAccounts(c.env, userId, normalizedProviders);
  const oauthRecords = await listProviderOAuthRecords(c.env.DB, userId);
  return c.json({ providers: applyProviderOAuth(saved, oauthRecords) });
});

modelProviderRoutes.delete("/model-providers/:accountId", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const accountId = stringField(c.req.param("accountId"));
  if (!accountId) return c.json({ error: "Provider account not found" }, 404);
  const deletedAccount = await deleteProviderAccount(c.env.DB, userId, accountId);
  const deletedOAuth = await deleteProviderOAuthRecordsForAccount(c.env.DB, userId, accountId);
  if (!deletedAccount && !deletedOAuth) return c.json({ error: "Provider account not found" }, 404);
  return new Response(null, { status: 204 });
});

modelProviderRoutes.put("/model-cards/:modelId", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const modelId = stringField(c.req.param("modelId"));
  if (!modelId) return c.json({ error: "Invalid model card config" }, 400);
  const [body, accounts] = await Promise.all([
    c.req.json().catch(() => null),
    listProviderAccountsWithOAuth(c.env, userId),
  ]);
  const config = normalizeModelCardConfigInput(modelId, body, accounts);
  if (!config) return c.json({ error: "Invalid model card config" }, 400);
  return c.json({ config: await upsertModelCardConfig(c.env.DB, userId, config) });
});

modelProviderRoutes.delete("/model-cards/:modelId", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const modelId = stringField(c.req.param("modelId"));
  if (!modelId) return c.json({ error: "Model card config not found" }, 404);
  const deleted = await deleteModelCardConfig(c.env.DB, userId, modelId);
  if (!deleted) return c.json({ error: "Model card config not found" }, 404);
  return new Response(null, { status: 204 });
});

modelProviderRoutes.post("/model-providers/test", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { provider?: unknown; modelId?: unknown };
  const provider = normalizeProviderAccountInput(body.provider);
  const rawProvider = body.provider && typeof body.provider === "object"
    ? body.provider as Record<string, unknown>
    : {};
  const rawModelId = typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : "";
  const modelId = normalizeModelId(rawModelId) ?? rawModelId;
  if (!provider || !modelId) return c.json({ error: "provider and modelId are required" }, 400);

  const [accounts, configs] = await Promise.all([
    listProviderAccountsWithOAuth(c.env, userId),
    listModelCardConfigs(c.env.DB, userId),
  ]);
  const effectiveModels = buildEffectiveModelCards({
    configs,
    providers: accounts.map(providerAccountAvailability),
    baseModels: await hostedBaseModelCards(),
  });
  const stored = accounts.find((account) => sameProviderAccount(provider, account));
  const enabled = rawProvider.enabled === false ? false : stored?.enabled ?? provider.enabled;
  const configuredCredentials = new Set([
    ...(stored?.configuredCredentials ?? []),
    ...Object.keys(provider.credentials ?? {}).filter((key) => provider.credentials?.[key]?.trim()),
  ]);
  const support = listProviderModelSupport({
    models: effectiveModels,
    includeMock: provider.providerId === "mock",
  }).find((row) =>
    row.providerId === provider.providerId &&
    (!provider.upstreamId || row.upstreamId === provider.upstreamId) &&
    (row.region ?? "") === (provider.region ?? "")
  );
  const modelName = effectiveModels.find((model) => model.id === modelId)?.name ?? displayModelName(modelId);
  const baseResult = {
    providerId: provider.providerId,
    ...(provider.upstreamId ? { upstreamId: provider.upstreamId } : {}),
    ...(provider.region ? { region: provider.region } : {}),
    modelId,
  };
  if (enabled === false) {
    return c.json({
      ok: false,
      ...baseResult,
      disabled: true,
      message: `${displayProviderName(provider)} is disabled for ${modelName}.`,
    });
  }
  const supportedModelEntries = support?.models.filter((model) => model.id === modelId) ?? [];
  if (!support || supportedModelEntries.length === 0) {
    return c.json({
      ok: false,
      ...baseResult,
      unsupported: true,
      message: `${displayProviderName(provider)} does not support ${modelName}.`,
    });
  }
  const supportedModelIds = provider.supportedModelIds ?? stored?.supportedModelIds;
  if (
    supportedModelIds?.length &&
    !supportedModelIds.map((id) => normalizeModelId(id) ?? id.trim()).includes(modelId)
  ) {
    return c.json({
      ok: false,
      ...baseResult,
      unsupported: true,
      message: `${displayProviderName(provider)} is not enabled for ${modelName}.`,
    });
  }
  const routeRequirements = modelRoutesForProviderAccount(provider, modelId, effectiveModels);
  const requirementCandidates = routeRequirements.length > 0
    ? routeRequirements.map((route) => ({
      requiredCredentials: route.requiredCredentials ?? [],
      credentialRequirements: route.credentialRequirements,
      requiredOAuth: route.requiredOAuth ?? [],
    }))
    : supportedModelEntries.map((model) => ({
      requiredCredentials: "requiredCredentials" in model ? model.requiredCredentials : support.requiredCredentials,
      credentialRequirements: undefined,
      requiredOAuth: "requiredOAuth" in model ? model.requiredOAuth : support.requiredOAuth,
    }));
  const credentialChecks = requirementCandidates.map((candidate) => ({
    candidate,
    missingCredentials: missingModelRouteCredentials(candidate, {
      providerId: provider.providerId,
      configuredCredentials: [...configuredCredentials],
    }),
  }));
  const credentialReadyChecks = credentialChecks.filter((check) => check.missingCredentials.length === 0);
  if (credentialReadyChecks.length === 0) {
    const bestCredentialCheck = [...credentialChecks].sort((a, b) =>
      a.missingCredentials.length - b.missingCredentials.length
    )[0];
    return c.json({
      ok: false,
      ...baseResult,
      missingCredentials: bestCredentialCheck?.missingCredentials ?? [],
      message: `${displayProviderName(provider)} is missing required credentials for ${modelName}.`,
    });
  }
  const availableOAuth = new Set(stored?.availableOAuth ?? []);
  const oauthChecks = credentialReadyChecks.map((check) => ({
    ...check,
    missingOAuth: check.candidate.requiredOAuth.filter((providerId) => !availableOAuth.has(providerId)),
  }));
  const oauthReadyCheck = oauthChecks.find((check) => check.missingOAuth.length === 0);
  if (!oauthReadyCheck) {
    const bestOAuthCheck = [...oauthChecks].sort((a, b) => a.missingOAuth.length - b.missingOAuth.length)[0];
    return c.json({
      ok: false,
      ...baseResult,
      missingOAuth: bestOAuthCheck?.missingOAuth ?? [],
      message: `${displayProviderName(provider)} needs authorization before testing ${modelName}.`,
    });
  }
  if (provider.providerId === "mock") {
    return c.json({
      ok: false,
      ...baseResult,
      skipped: true,
      message: `Mock provider tests run through the local desktop runtime for ${modelName}.`,
    });
  }
  const providerName = displayProviderName(provider);
  return c.json({
    ok: true,
    ...baseResult,
    message: `${providerName} configuration is ready for ${modelName}.`,
  });
});

modelProviderRoutes.get("/models/catalog", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const [providers, configs] = await Promise.all([
    listProviderAccountsWithOAuth(c.env, userId),
    listModelCardConfigs(c.env.DB, userId),
  ]);
  const configuredProviders = providers
    .filter((provider) => provider.providerId !== "mock")
    .map(providerAccountAvailability);
  return c.json({
    models: listModelCatalogEntries({
      models: buildEffectiveModelCards({
        configs,
        providers: configuredProviders,
        baseModels: await hostedBaseModelCards(),
      }),
      configuredProviders,
    }),
  });
});

modelProviderRoutes.get("/provider-oauth", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const providers = await listProviderOAuthRecords(c.env.DB, userId);
  return c.json({ providers: providers.map(publicProviderOAuth) });
});

function oauthError(code: ProviderOAuthErrorCode, error: string = PROVIDER_OAUTH_ERROR_MESSAGES[code]) {
  return { error, code };
}

/** The settings page a finished web flow returns to. Carries outcome and code, never a token. */
function providerOAuthReturnUrl(
  origin: string,
  result: WebProviderOAuthCallbackResult,
): string {
  const url = new URL("/settings", origin);
  url.searchParams.set("section", "providers");
  if (result.providerId) url.searchParams.set(PROVIDER_OAUTH_RETURN_PARAMS.provider, result.providerId);
  url.searchParams.set(PROVIDER_OAUTH_RETURN_PARAMS.status, result.status);
  if (result.status === "error") url.searchParams.set(PROVIDER_OAUTH_RETURN_PARAMS.code, result.code);
  return url.toString();
}

/**
 * Where the vendor sends the browser back, and where the settings page sends it.
 *
 * Reached by top-level navigation from the vendor, so it answers with a redirect in every case,
 * including a missing session: a JSON 401 would strand the user on a raw error page. The web
 * gateway forwards this path without the fail-closed identity header for exactly that reason; the
 * session cookie is still validated by the `/api/*` middleware and nothing is exchanged without it.
 */
modelProviderRoutes.get("/provider-oauth/callback", async (c) => {
  const origin = publicOrigin(c.req.raw, c.env);
  const redirect = (result: WebProviderOAuthCallbackResult) =>
    c.redirect(providerOAuthReturnUrl(origin, result), 302);
  const userId = c.req.header("x-user-id");
  if (!userId) return redirect({ status: "error", code: "PROVIDER_OAUTH_UNAUTHENTICATED" });
  const result = await completeWebProviderOAuthCallback(c.env, {
    userId,
    state: stringField(c.req.query("state")),
    code: stringField(c.req.query("code")),
    vendorError: c.req.query("error"),
    resolveProvider: (providerId) => hostedOAuthProvider(c.env.PROVIDER_OAUTH_PROVIDERS, providerId),
  });
  return redirect(result);
});

modelProviderRoutes.post("/provider-oauth/:providerId/start", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const providerId = parseProviderOAuthId(c.req.param("providerId"));
  if (!providerId) return c.json(oauthError("PROVIDER_OAUTH_UNSUPPORTED", "Unsupported OAuth provider"), 404);
  let provider;
  try {
    provider = hostedOAuthProvider(c.env.PROVIDER_OAUTH_PROVIDERS, providerId);
  } catch (error) {
    if (error instanceof ProviderOAuthConfigError) {
      return c.json(oauthError(error.code, error.message), 503);
    }
    throw error;
  }
  if (!provider) return c.json(oauthError("PROVIDER_OAUTH_UNSUPPORTED", "Unsupported OAuth provider"), 404);
  if (!c.env.ACTION_SECRET_KEY) {
    return c.json(oauthError(
      "PROVIDER_OAUTH_NOT_CONFIGURED",
      "ACTION_SECRET_KEY is not configured, so a pending authorization cannot be sealed.",
    ), 503);
  }
  const body = (await c.req.json().catch(() => ({}))) as { accountId?: unknown; accountLabel?: unknown };
  const record = await startWebProviderOAuth(c.env, {
    userId,
    provider,
    ...(stringField(body.accountId) ? { accountId: stringField(body.accountId) } : {}),
    ...(stringField(body.accountLabel) ? { accountLabel: stringField(body.accountLabel) } : {}),
    redirectUri: `${publicOrigin(c.req.raw, c.env)}/api/v1/provider-oauth/callback`,
  });
  return c.json(publicProviderOAuth(record));
});

modelProviderRoutes.post("/provider-oauth/:providerId/complete", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const providerId = parseProviderOAuthId(c.req.param("providerId"));
  if (!providerId) return c.json(oauthError("PROVIDER_OAUTH_UNSUPPORTED", "Unsupported OAuth provider"), 404);
  const body = (await c.req.json().catch(() => ({}))) as { accountId?: unknown };
  const record = await findProviderOAuthRecord(c.env.DB, userId, providerId, stringField(body.accountId));
  if (record?.callbackType === "web") {
    return c.json(oauthError(
      "PROVIDER_OAUTH_WEB_CALLBACK",
      `${providerId} authorization is completed by the redirect callback.`,
    ), 409);
  }
  // Device-code and custom-scheme flows finish on the user's machine.
  return c.json(oauthError(
    "PROVIDER_OAUTH_REQUIRES_DESKTOP",
    `${providerId} OAuth completion is available through the local desktop runtime.`,
  ), 501);
});

/** Reading another installed app's credential store needs the user's machine. */
modelProviderRoutes.post("/provider-oauth/:providerId/import-local", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const providerId = parseProviderOAuthId(c.req.param("providerId"));
  if (!providerId) return c.json(oauthError("PROVIDER_OAUTH_UNSUPPORTED", "Unsupported OAuth provider"), 404);
  return c.json(oauthError(
    "PROVIDER_OAUTH_REQUIRES_DESKTOP",
    `Reusing a local ${providerId} login is available through the local desktop runtime.`,
  ), 501);
});

modelProviderRoutes.delete("/provider-oauth/:providerId", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const providerId = parseProviderOAuthId(c.req.param("providerId"));
  if (!providerId) return c.json({ error: "Unsupported OAuth provider" }, 404);
  await deleteProviderOAuthRecord(c.env.DB, userId, providerId, stringField(c.req.query("accountId")));
  return new Response(null, { status: 204 });
});
