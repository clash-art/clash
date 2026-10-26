/**
 * Plugin surface for api-cf.
 *
 * Default OSS deployments register no plugins → all hooks are no-op,
 * behavior is identical to "no plugin system at all".
 *
 * Hosted (or any downstream) deployments register plugins (e.g. the
 * billing plugin in packages/billing) to inject pre/post-generation
 * checks, route extensions, key resolution, quota enforcement, etc.
 *
 * Hooks are resolved lazily via getPlugins() at call sites — see
 * registry.ts for the lookup mechanism. This keeps the plugin
 * indirection out of OSS hot paths when no plugins are registered.
 */
import type { Hono } from "hono";
import type { Env } from "../config";
import type { GenerationParams } from "../generation/params";

/** Identity + arbitrary plugin-attached metadata (plan, quota, etc.). */
export interface UserContext {
  userId: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
}

/** Result of resolving an API key for a provider call. */
export interface ResolvedKey {
  /** "byok" = user-supplied key (no managed billing).
   *  "env"  = system key (managed billing applies). */
  source: "byok" | "env";
  apiKey: string;
}

/** Shared shape passed to generation lifecycle hooks. */
export interface GenerationHookCtx {
  user?: UserContext;
  params: GenerationParams;
  env: Env;
}

/** Loose result shape — providers emit a superset; plugins read what they need. */
export type GenerationResult = Record<string, unknown>;

/**
 * How tenants obtain credits (#419). Absent (self-host): the core purchase
 * routes grant credits directly, for free. "provider": a payments plugin sells
 * them through its own checkout and records them from verified provider
 * webhooks via the server-only billing API (`@clash/api-cf/billing`); the core
 * purchase routes then refuse with GATEWAY_PAYMENT_REQUIRED_VIA_PROVIDER.
 */
export type BillingPurchaseMode = "provider";

export interface BillingPluginConfig {
  purchaseMode: BillingPurchaseMode;
  /** Where the client starts a purchase (e.g. "/api/v1/billing/checkout"); returned in the 409 details. */
  checkoutPath?: string;
}

export interface Plugin {
  /** Stable identifier — appears in logs / errors. */
  name: string;

  auth?: {
    /** Enrich (or wholly resolve) a user identity from a request. Default: existing JWT/BetterAuth chain in loro/auth.ts. */
    resolveUser?: (req: Request, env: Env) => Promise<UserContext | null>;
  };

  generation?: {
    /** Pick which API key to use for `provider` (e.g. "fal", "google", "kling"). Returning null falls back to env vars. */
    resolveKey?: (provider: string, ctx: GenerationHookCtx) => Promise<ResolvedKey | null>;

    /**
     * Called synchronously before GENERATION_WORKFLOW.create — runs in the
     * caller's request/DO context (HTTP handler, NodeProcessor, agent tool).
     * Throw to refuse the task: the error surfaces immediately to the caller
     * (HTTP 4xx, node `error` field, agent tool result), without spending
     * the workflow scheduling latency budget.
     *
     * Use for fast-fail checks like budget/quota/rate-limit. The per-step
     * `beforeGenerate` hook still runs inside the workflow body and remains
     * the source of truth for credit holds (this hook is read-only).
     */
    beforeGenerationStart?: (ctx: GenerationHookCtx) => Promise<void>;

    /** Called before provider.execute. Throw to reject the workflow. */
    beforeGenerate?: (ctx: GenerationHookCtx) => Promise<void>;

    /** Called after provider.execute succeeds. */
    afterGenerate?: (ctx: GenerationHookCtx, result: GenerationResult) => Promise<void>;

    /** Called when provider.execute throws. */
    onFailure?: (ctx: GenerationHookCtx, err: unknown) => Promise<void>;
  };

  assets?: {
    /** Called before bytes hit R2. Throw to reject (e.g. quota exceeded). */
    beforeUpload?: (input: {
      env: Env;
      projectId: string;
      sizeBytes: number;
      user?: UserContext;
    }) => Promise<void>;
  };

  /** Purchase mode seam (#419). Any plugin declaring "provider" closes the free purchase path. */
  billing?: BillingPluginConfig;

  routes?: {
    /** Mount additional routes on the Hono app at startup. */
    register?: (app: Hono<{ Bindings: Env }>) => void;
  };
}
