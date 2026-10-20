export interface Env {
  /** Cloudflare Workers AI binding */
  AI: Ai;
  /** Cloudflare AI Gateway token — used for OpenAI unified billing */
  CF_AIG_TOKEN: string;
  /** AI Gateway base URL for OpenAI, e.g. https://gateway.ai.cloudflare.com/v1/{account}/{gw}/openai */
  CF_AIG_OPENAI_URL: string;
  /** Optional direct Google AI Studio key. AI Gateway BYOK does not require it. */
  GOOGLE_API_KEY?: string;
  /** Provider-native Cloudflare Gateway base ending in /google-ai-studio. */
  GOOGLE_AI_STUDIO_BASE_URL?: string;
  /** Model override, e.g. "claude-sonnet-4-20250514" or "gpt-5" */
  AI_MODEL?: string;
  R2_BUCKET: R2Bucket;
  R2_PUBLIC_URL: string;
  /** Origin that serves both /cdn-cgi/media/* and /assets/*. In prod, the
   *  zone URL (edge handles MT). In dev, the gateway URL (Next.js ffmpeg
   *  handler mimics MT). See services/thumbnail.ts. */
  MEDIA_GATEWAY_URL?: string;
  ENVIRONMENT: string;
  ROOM: DurableObjectNamespace;
  /** Issue #130: stateless upload Worker; when bound, upload paths are forwarded to it. */
  API_UPLOAD?: { fetch(request: Request): Promise<Response> };
  /** Issue #138: lean metadata Worker (optional; routes fall back in-process). */
  API_META?: { fetch(request: Request): Promise<Response> };
  SUPERVISOR: DurableObjectNamespace;
  GENERATION_WORKFLOW: Workflow;
  RENDER_CONTAINER: DurableObjectNamespace<import("./containers/render").RenderContainer>;
  RUNTIME_ROOM: DurableObjectNamespace<import("./agents/runtime-room").RuntimeRoom>;
  /** For local dev: direct URL to render-server (bypasses Container) */
  RENDER_SERVER_URL?: string;
  DB: D1Database;
  // ProjectRoom authentication
  JWT_SECRET?: string;
  BETTER_AUTH_ORIGIN?: string;
  BETTER_AUTH_BASE_PATH?: string;
  WORKER_PUBLIC_URL?: string;
  /** AES-GCM key for encrypting/decrypting user variables (action secrets) */
  ACTION_SECRET_KEY?: string;
  /**
   * Key-encryption key for official model-gateway upstream credentials
   * (`gateway_upstream_account.encrypted_credentials`); deliberately distinct
   * from ACTION_SECRET_KEY. Rows may instead reference a `GATEWAY_UPSTREAM_*`
   * Worker secret by name (`secret_ref`).
   */
  GATEWAY_ENCRYPTION_KEY?: string;
  /**
   * Platform-admin grant for the model gateway control plane (price book,
   * packages, top-up packs, billing periods): comma-separated Better Auth user
   * ids. Unset means nobody is a platform admin. Not a tenant role.
   */
  GATEWAY_ADMIN_USER_IDS?: string;
  /**
   * Optional secret: JSON array of operator-registered OAuth Providers,
   * `[{ id, label?, flow }]` where `flow` is a PluginAuthFlow with tokenUrl and
   * clientId. Parsed on first use (services/provider-oauth-config.ts), never at
   * Worker startup. Hosted builds bundle no Provider declarations.
   */
  PROVIDER_OAUTH_PROVIDERS?: string;
  /** HMAC key for short-lived hosted executable-plugin broker capabilities. */
  // Better Auth — handler runs in this Worker now (apps/api-cf/src/auth.ts).
  KV?: KVNamespace<string>;
  /** Cloudflare Email Service binding — wrangler [[send_email]] name = "EMAIL". */
  EMAIL?: import("./auth").AuthBindings["EMAIL"];
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  AUTH_SECRET?: string;
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
  AUTH_EMAIL_FROM?: string;
}
