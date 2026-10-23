/**
 * Wire request -> GatewayRequest. The original body is preserved for
 * pass-through: normalization validates and extracts what routing, limits and
 * holds need, and never rewrites what the caller asked the model to do.
 */
import { z } from "zod";
import {
  activeModelParameterIds,
  type ModelUpstreamRoute,
} from "@clash/shared-types/model-routing";

import { GatewayError } from "./errors.js";
import type { GatewayPriceUnit } from "./pricing.js";
import { estimateTokensFromBytes, type GatewayMediaUnit } from "./usage.js";

export type GatewayModelKind = ModelUpstreamRoute["kind"];

export type GatewayProtocol = "openai-chat" | "anthropic-messages" | "media";

export interface GatewayRequest {
  protocol: GatewayProtocol;
  kind: GatewayModelKind;
  /** Model code as the caller sent it; routing normalizes aliases. */
  model: string;
  stream: boolean;
  /** Caller's output ceiling, when the protocol carries one. */
  maxOutputTokens?: number;
  /** Size of the serialized body, the basis of the input estimate. */
  bodyBytes: number;
  /** Conservative prompt estimate used for holds and token limits. */
  estimatedInputTokens: number;
  /** Media/AIGC quantities the caller requested, priced for the hold. */
  requestedUnits: Partial<Record<GatewayMediaUnit, number>>;
  /** Card parameters materially selected, for route parameter support. */
  requestedParameterIds: string[];
  idempotencyKey?: string;
  /** Original JSON body, forwarded as-is except for protocol-owned fields. */
  body: Record<string, unknown>;
}

const positiveInt = z.number().int().positive();

const messageSchema = z.looseObject({
  role: z.string().min(1),
});

const openAIChatSchema = z.looseObject({
  model: z.string().trim().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  max_tokens: positiveInt.nullish(),
  max_completion_tokens: positiveInt.nullish(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullish(),
});

const anthropicMessagesSchema = z.looseObject({
  model: z.string().trim().min(1),
  messages: z.array(messageSchema).min(1),
  max_tokens: positiveInt,
  stream: z.boolean().optional(),
});

const mediaUnitSchema = z.enum([
  "image",
  "video_second",
  "audio_second",
  "character",
  "request",
]);

const mediaSchema = z.object({
  model: z.string().trim().min(1),
  kind: z.string().trim().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  // At least one billable quantity: a media hold of zero would leave the budget unprotected.
  units: z
    .partialRecord(mediaUnitSchema, z.number().int().nonnegative())
    .refine((units) => Object.values(units).some((quantity) => (quantity ?? 0) > 0), {
      message: "State at least one billable unit (image, video_second, audio_second, character or request).",
    }),
});

export interface NormalizeOptions {
  idempotencyKey?: string | null;
  /** Reject bodies above this size with GATEWAY_REQUEST_TOO_LARGE. */
  maxBodyBytes?: number;
}

const encoder = new TextEncoder();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new GatewayError("GATEWAY_INVALID_REQUEST", {
    message: issue
      ? `${issue.path.join(".") || "body"}: ${issue.message}`
      : "The request body is invalid.",
    details: {
      param: issue?.path.join(".") || undefined,
      issues: result.error.issues.map((entry) => ({
        path: entry.path.join("."),
        message: entry.message,
      })),
    },
  });
}

function measure(body: unknown, options: NormalizeOptions): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(body);
  } catch (cause) {
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      message: "The request body is not JSON-serializable.",
      cause,
    });
  }
  const bytes = encoder.encode(serialized ?? "").byteLength;
  if (options.maxBodyBytes !== undefined && bytes > options.maxBodyBytes)
    throw new GatewayError("GATEWAY_REQUEST_TOO_LARGE", {
      details: { bytes, maxBytes: options.maxBodyBytes },
    });
  return bytes;
}

function idempotencyKey(options: NormalizeOptions): string | undefined {
  const key = options.idempotencyKey?.trim();
  return key ? key : undefined;
}

export function normalizeOpenAIChatRequest(
  body: unknown,
  options: NormalizeOptions = {},
): GatewayRequest {
  const bodyBytes = measure(body, options);
  const parsed = parse(openAIChatSchema, body);
  const maxOutputTokens =
    parsed.max_completion_tokens ?? parsed.max_tokens ?? undefined;
  return {
    protocol: "openai-chat",
    kind: "text",
    model: parsed.model,
    stream: parsed.stream === true,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    bodyBytes,
    estimatedInputTokens: estimateTokensFromBytes(bodyBytes),
    requestedUnits: {},
    requestedParameterIds: [],
    ...(idempotencyKey(options) ? { idempotencyKey: idempotencyKey(options) } : {}),
    body: parsed,
  };
}

export function normalizeAnthropicMessagesRequest(
  body: unknown,
  options: NormalizeOptions = {},
): GatewayRequest {
  const bodyBytes = measure(body, options);
  const parsed = parse(anthropicMessagesSchema, body);
  return {
    protocol: "anthropic-messages",
    kind: "text",
    model: parsed.model,
    stream: parsed.stream === true,
    maxOutputTokens: parsed.max_tokens,
    bodyBytes,
    estimatedInputTokens: estimateTokensFromBytes(bodyBytes),
    requestedUnits: {},
    requestedParameterIds: [],
    ...(idempotencyKey(options) ? { idempotencyKey: idempotencyKey(options) } : {}),
    body: parsed,
  };
}

const anthropicCountTokensSchema = z.looseObject({
  model: z.string().trim().min(1),
  messages: z.array(messageSchema).min(1),
});

/** An Anthropic `messages/count_tokens` body: nothing is generated, so nothing is held or metered. */
export interface CountTokensRequest {
  model: string;
  /** Original JSON body, forwarded as-is except for `model`. */
  body: Record<string, unknown>;
}

export function normalizeAnthropicCountTokensRequest(
  body: unknown,
  options: NormalizeOptions = {},
): CountTokensRequest {
  measure(body, options);
  const parsed = parse(anthropicCountTokensSchema, body);
  return { model: parsed.model, body: parsed };
}

/**
 * Media/AIGC generation (image, video, audio, ...). The caller states the
 * billable quantities it is asking for; the hold prices exactly those.
 */
export function normalizeMediaGenerationRequest(
  body: unknown,
  options: NormalizeOptions = {},
): GatewayRequest {
  const bodyBytes = measure(body, options);
  const parsed = parse(mediaSchema, body);
  if (parsed.kind === "text")
    throw new GatewayError("GATEWAY_INVALID_REQUEST", {
      message: "Text models use the chat or messages protocol.",
      details: { param: "kind" },
    });
  const requestedParameterIds = activeModelParameterIds(parsed.params);
  return {
    protocol: "media",
    kind: parsed.kind as GatewayModelKind,
    model: parsed.model,
    stream: false,
    bodyBytes,
    estimatedInputTokens: 0,
    requestedUnits: parsed.units,
    requestedParameterIds,
    ...(idempotencyKey(options) ? { idempotencyKey: idempotencyKey(options) } : {}),
    body: parsed as Record<string, unknown>,
  };
}

/**
 * Upstream body for a selected upstream model. Streaming OpenAI-compatible
 * requests always ask for the final usage chunk; without it most compatible
 * upstreams report no usage and every request would settle on an estimate.
 */
export function prepareUpstreamBody(
  request: GatewayRequest,
  upstreamModel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...request.body };
  if (request.protocol !== "media") body.model = upstreamModel;
  if (request.protocol === "openai-chat" && request.stream) {
    const streamOptions =
      body.stream_options && typeof body.stream_options === "object"
        ? (body.stream_options as Record<string, unknown>)
        : {};
    body.stream_options = { ...streamOptions, include_usage: true };
  }
  return body;
}

/** True when the caller did not ask for the usage chunk the gateway injected. */
export function callerOmittedStreamUsage(request: GatewayRequest): boolean {
  if (request.protocol !== "openai-chat" || !request.stream) return false;
  const options = request.body.stream_options as
    | { include_usage?: unknown }
    | null
    | undefined;
  return options?.include_usage !== true;
}

/** Price units the admission hold for this request depends on. */
export function holdUnits(request: GatewayRequest): GatewayPriceUnit[] {
  if (request.protocol === "media")
    return Object.entries(request.requestedUnits)
      .filter(([, quantity]) => (quantity ?? 0) > 0)
      .map(([unit]) => unit as GatewayPriceUnit);
  return ["input_token", "output_token"];
}
