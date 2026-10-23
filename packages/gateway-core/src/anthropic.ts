/**
 * Anthropic Messages protocol (#349): what the data plane needs to serve
 * `POST {base}/anthropic/v1/messages` and `…/messages/count_tokens` to
 * Anthropic clients such as Claude Code (claude-agent-acp's gateway auth sets
 * `ANTHROPIC_BASE_URL` and sends the token as `Authorization: Bearer`).
 *
 * - Credential: the same sk_gw_ token as the OpenAI path, as `Authorization:
 *   Bearer` or, the Anthropic SDK's default, `x-api-key`.
 * - Routes: only `anthropic-compatible` text routes without an executor
 *   plugin, and never a DeepSeek one.
 * - Upstream headers: the gateway's own `x-api-key`, plus the caller's
 *   `anthropic-version` and `anthropic-beta`. Body fields (`cache_control`,
 *   `tools`, `tool_use`/`tool_result` blocks, `thinking`) pass through as sent.
 * - Model ids: agents send Anthropic model ids, so an id that is not a catalog
 *   public code is mapped onto one (resolveAnthropicModelCode).
 */
import type { ModelUpstreamRoute } from "@clash/shared-types/model-routing";

import { namesDeepSeek } from "./catalog-policy.js";
import { GatewayError } from "./errors.js";
import type { GatewayCatalog } from "./routing.js";

/** Sent upstream when the caller names no `anthropic-version`. */
export const ANTHROPIC_DEFAULT_VERSION = "2023-06-01";

/** Routes the Messages protocol can execute without translation. */
export function isAnthropicMessagesRoute(route: ModelUpstreamRoute): boolean {
  return (
    route.kind === "text" &&
    route.apiShape === "anthropic-compatible" &&
    !route.executorPluginId &&
    !namesDeepSeek(route.modelCode, route.upstreamId, route.upstreamModel)
  );
}

/**
 * The caller's credential as a Bearer-only request for the identity port: the
 * `Authorization: Bearer` token when there is one, otherwise `x-api-key`.
 * Nothing else of the caller's request is passed on.
 */
export function anthropicCredentialRequest(request: Request): Request {
  const bearer = /^Bearer[\t ]+(\S+)$/i.exec((request.headers.get("authorization") ?? "").trim())?.[1];
  const token = bearer ?? request.headers.get("x-api-key")?.trim();
  return new Request(request.url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

/** Upstream headers: the gateway's key, and only the protocol headers of the caller's request. */
export function anthropicUpstreamHeaders(apiKey: string, caller: Headers, stream: boolean): Record<string, string> {
  const beta = caller.get("anthropic-beta")?.trim();
  return {
    "x-api-key": apiKey,
    "anthropic-version": caller.get("anthropic-version")?.trim() || ANTHROPIC_DEFAULT_VERSION,
    ...(beta ? { "anthropic-beta": beta } : {}),
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
  };
}

/** The content of a 2xx Messages answer, or undefined when the body is not a message. */
export function anthropicMessageContent(body: Record<string, unknown>): unknown[] | undefined {
  return body.type === "message" && Array.isArray(body.content) ? body.content : undefined;
}

/** The count of a 2xx count_tokens answer, or undefined when the body is not one. */
export function anthropicTokenCount(body: Record<string, unknown>): number | undefined {
  const count = body.input_tokens;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

const DATE_SUFFIX = /-\d{8}$/;
const undated = (id: string) => id.replace(DATE_SUFFIX, "");

/**
 * The catalog public code for a model id an agent sent. In order, for the id
 * and then, when it carries a `-YYYYMMDD` snapshot suffix, its undated form:
 * a text card with that id; a text card listing it among its aliases; a text
 * card with an anthropic-compatible implementation whose upstream model is
 * that id (dated or not). Several cards matching one rule is a coded 404, so
 * a request is never billed to a model the caller did not pick; no match
 * returns the id unchanged and planning answers GATEWAY_MODEL_NOT_FOUND.
 */
export function resolveAnthropicModelCode(requested: string, catalog: GatewayCatalog): string {
  const model = requested.trim();
  const text = catalog.models.filter((card) => card.kind === "text");
  const rules: Array<(candidate: string) => string[]> = [
    (candidate) => text.filter((card) => card.id === candidate).map((card) => card.id),
    (candidate) => text.filter((card) => (card.aliases ?? []).includes(candidate)).map((card) => card.id),
    (candidate) =>
      text
        .filter((card) =>
          (card.providerImplementations ?? []).some(
            (implementation) =>
              implementation.apiShape === "anthropic-compatible" &&
              (implementation.upstreamModel === candidate || undated(implementation.upstreamModel) === candidate),
          ),
        )
        .map((card) => card.id),
  ];
  for (const candidate of new Set([model, undated(model)]))
    for (const rule of rules) {
      const codes = [...new Set(rule(candidate))];
      if (codes.length === 1) return codes[0]!;
      if (codes.length > 1)
        throw new GatewayError("GATEWAY_MODEL_NOT_FOUND", {
          message: "The model id matches several catalog models; use a public model code.",
          details: { model, candidates: codes, catalogVersion: catalog.version },
        });
    }
  return model;
}
