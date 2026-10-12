import {
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  type Attributes,
  type AttributeValue,
  type HrTime,
  type Link,
  type SpanContext,
} from "@opentelemetry/api";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace-node";

/**
 * Decoder for OTLP/HTTP JSON trace requests (ExportTraceServiceRequest).
 *
 * Local clients (the GUI renderer) export with the official
 * `@opentelemetry/exporter-trace-otlp-http` to the Host. The Host turns each
 * span back into the SDK's `ReadableSpan` and hands it to its own span
 * processors, so client spans get the same local `span.end` summary and the
 * same configured OTLP exporter (protocol, headers, batching, retry) as Host
 * spans. Credentials never reach the client.
 *
 * Wire format per the OTLP specification (docs/specification.md, "JSON
 * Protobuf Encoding"): trace and span ids are hex strings, 64-bit integers
 * and timestamps may be strings or numbers, enum fields are integers, and
 * span `kind` is the proto enum (API SpanKind + 1).
 *
 * Input is untrusted: malformed spans are rejected individually and counted
 * in the OTLP partial-success response.
 */

export interface OtlpIngestLimits {
  maxSpans: number;
  maxAttributes: number;
  maxEvents: number;
  maxLinks: number;
}

// OpenTelemetry SDK environment defaults (specification/configuration/
// sdk-environment-variables.md): OTEL_BSP_MAX_EXPORT_BATCH_SIZE=512,
// OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT=128, OTEL_SPAN_EVENT_COUNT_LIMIT=128,
// OTEL_SPAN_LINK_COUNT_LIMIT=128.
export const DEFAULT_OTLP_INGEST_LIMITS: OtlpIngestLimits = {
  maxSpans: 512,
  maxAttributes: 128,
  maxEvents: 128,
  maxLinks: 128,
};

export type OtlpDecodeResult =
  | { ok: true; spans: ReadableSpan[]; rejected: number }
  | { ok: false; error: string };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const TRACE_ID = /^[0-9a-f]{32}$/i;
const SPAN_ID = /^[0-9a-f]{16}$/i;
const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

function traceId(value: unknown): string | undefined {
  return typeof value === "string" &&
    TRACE_ID.test(value) &&
    value !== INVALID_TRACE_ID
    ? value.toLowerCase()
    : undefined;
}

function spanId(value: unknown): string | undefined {
  return typeof value === "string" &&
    SPAN_ID.test(value) &&
    value !== INVALID_SPAN_ID
    ? value.toLowerCase()
    : undefined;
}

const NANOS_PER_SECOND = 1_000_000_000n;

function unixNanos(value: unknown): bigint | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  return undefined;
}

function hrTime(nanos: bigint): HrTime {
  return [
    Number(nanos / NANOS_PER_SECOND),
    Number(nanos % NANOS_PER_SECOND),
  ];
}

function integer(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

type Primitive = string | number | boolean;

function primitive(value: unknown): Primitive | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (value.intValue !== undefined) return integer(value.intValue);
  if (typeof value.doubleValue === "number") return value.doubleValue;
  return undefined;
}

/**
 * OTLP AnyValue → SDK AttributeValue. Span attributes only allow primitives
 * and homogeneous primitive arrays; kvlist and bytes values are dropped.
 */
function attributeValue(value: unknown): AttributeValue | undefined {
  const scalar = primitive(value);
  if (scalar !== undefined) return scalar;
  if (!isRecord(value) || !isRecord(value.arrayValue)) return undefined;
  const items = list(value.arrayValue.values).map(primitive);
  if (items.some((item) => item === undefined)) return undefined;
  const types = new Set(items.map((item) => typeof item));
  if (types.size > 1) return undefined;
  return items as AttributeValue;
}

function attributes(
  value: unknown,
  limit: number,
): { attributes: Attributes; dropped: number } {
  const out: Attributes = {};
  let kept = 0;
  let dropped = 0;
  for (const entry of list(value)) {
    if (!isRecord(entry) || typeof entry.key !== "string" || !entry.key) {
      dropped += 1;
      continue;
    }
    const key = entry.key;
    const converted = attributeValue(entry.value);
    if (converted === undefined || kept >= limit) {
      dropped += 1;
      continue;
    }
    out[key] = converted;
    kept += 1;
  }
  return { attributes: out, dropped };
}

// OTLP span flags (trace.proto SpanFlags): low 8 bits are W3C trace flags;
// bit 8 says whether bit 9 (parent is remote) is meaningful.
const SPAN_FLAGS_TRACE_FLAGS_MASK = 0xff;
const SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK = 0x100;
const SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK = 0x200;

// trace.proto Span.SpanKind: 0 unspecified, 1 internal … 5 consumer;
// the API enum has no "unspecified", so it is offset by one.
const API_SPAN_KINDS: readonly SpanKind[] = [
  SpanKind.INTERNAL,
  SpanKind.SERVER,
  SpanKind.CLIENT,
  SpanKind.PRODUCER,
  SpanKind.CONSUMER,
];

function spanKind(value: unknown): SpanKind {
  const proto = integer(value) ?? 0;
  return API_SPAN_KINDS[proto - 1] ?? SpanKind.INTERNAL;
}

function statusCode(value: unknown): SpanStatusCode {
  const code = integer(value);
  return code === SpanStatusCode.OK || code === SpanStatusCode.ERROR
    ? code
    : SpanStatusCode.UNSET;
}

interface ScopeContext {
  resource: Resource;
  scope: { name: string; version?: string; schemaUrl?: string };
}

function decodeSpan(
  raw: unknown,
  { resource, scope }: ScopeContext,
  limits: OtlpIngestLimits,
): ReadableSpan | undefined {
  if (!isRecord(raw)) return undefined;
  const ids = { traceId: traceId(raw.traceId), spanId: spanId(raw.spanId) };
  const start = unixNanos(raw.startTimeUnixNano);
  const end = unixNanos(raw.endTimeUnixNano);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!ids.traceId || !ids.spanId || !name) return undefined;
  if (start === undefined || end === undefined || end < start) return undefined;

  const flags = integer(raw.flags);
  // The SDK only exports sampled spans; absent flags mean "sampled".
  const traceFlags =
    flags === undefined
      ? TraceFlags.SAMPLED
      : flags & SPAN_FLAGS_TRACE_FLAGS_MASK;
  const context: SpanContext = {
    traceId: ids.traceId,
    spanId: ids.spanId,
    traceFlags,
  };
  const parentId = spanId(raw.parentSpanId);
  const parentSpanContext: SpanContext | undefined = parentId
    ? {
        traceId: ids.traceId,
        spanId: parentId,
        traceFlags,
        ...(flags !== undefined &&
        flags & SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK
          ? { isRemote: (flags & SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK) !== 0 }
          : {}),
      }
    : undefined;

  const spanAttributes = attributes(raw.attributes, limits.maxAttributes);
  const rawEvents = list(raw.events);
  const events: TimedEvent[] = [];
  for (const event of rawEvents.slice(0, limits.maxEvents)) {
    if (!isRecord(event) || typeof event.name !== "string") continue;
    const time = unixNanos(event.timeUnixNano);
    if (time === undefined) continue;
    const decoded = attributes(event.attributes, limits.maxAttributes);
    events.push({
      name: event.name,
      time: hrTime(time),
      attributes: decoded.attributes,
      droppedAttributesCount:
        decoded.dropped + (integer(event.droppedAttributesCount) ?? 0),
    });
  }
  const rawLinks = list(raw.links);
  const links: Link[] = [];
  for (const link of rawLinks.slice(0, limits.maxLinks)) {
    if (!isRecord(link)) continue;
    const linkTrace = traceId(link.traceId);
    const linkSpan = spanId(link.spanId);
    if (!linkTrace || !linkSpan) continue;
    const decoded = attributes(link.attributes, limits.maxAttributes);
    const linkFlags = integer(link.flags);
    links.push({
      context: {
        traceId: linkTrace,
        spanId: linkSpan,
        traceFlags:
          linkFlags === undefined
            ? TraceFlags.NONE
            : linkFlags & SPAN_FLAGS_TRACE_FLAGS_MASK,
      },
      attributes: decoded.attributes,
      droppedAttributesCount: decoded.dropped,
    });
  }
  const status = isRecord(raw.status) ? raw.status : {};

  return {
    name,
    kind: spanKind(raw.kind),
    spanContext: () => context,
    ...(parentSpanContext ? { parentSpanContext } : {}),
    startTime: hrTime(start),
    endTime: hrTime(end),
    duration: hrTime(end - start),
    status: {
      code: statusCode(status.code),
      ...(typeof status.message === "string" && status.message
        ? { message: status.message }
        : {}),
    },
    attributes: spanAttributes.attributes,
    links,
    events,
    ended: true,
    resource,
    instrumentationScope: scope,
    droppedAttributesCount:
      spanAttributes.dropped + (integer(raw.droppedAttributesCount) ?? 0),
    droppedEventsCount:
      rawEvents.length - Math.min(rawEvents.length, limits.maxEvents) +
      (integer(raw.droppedEventsCount) ?? 0),
    droppedLinksCount:
      rawLinks.length - Math.min(rawLinks.length, limits.maxLinks) +
      (integer(raw.droppedLinksCount) ?? 0),
  };
}

/** Decode an ExportTraceServiceRequest in OTLP JSON encoding. */
export function decodeOtlpJsonTraces(
  body: unknown,
  limits: OtlpIngestLimits = DEFAULT_OTLP_INGEST_LIMITS,
): OtlpDecodeResult {
  if (!isRecord(body) || !Array.isArray(body.resourceSpans))
    return { ok: false, error: "expected an ExportTraceServiceRequest" };
  const spans: ReadableSpan[] = [];
  let rejected = 0;
  for (const resourceSpans of body.resourceSpans) {
    if (!isRecord(resourceSpans)) continue;
    const resourceAttributes = isRecord(resourceSpans.resource)
      ? attributes(resourceSpans.resource.attributes, limits.maxAttributes)
          .attributes
      : {};
    // One Resource object per entry so exporters group these spans together.
    const resource = resourceFromAttributes(resourceAttributes);
    for (const scopeSpans of list(resourceSpans.scopeSpans)) {
      if (!isRecord(scopeSpans)) continue;
      const rawScope = isRecord(scopeSpans.scope) ? scopeSpans.scope : {};
      const scope = {
        name:
          typeof rawScope.name === "string" && rawScope.name
            ? rawScope.name
            : "unknown",
        ...(typeof rawScope.version === "string" && rawScope.version
          ? { version: rawScope.version }
          : {}),
        ...(typeof scopeSpans.schemaUrl === "string" && scopeSpans.schemaUrl
          ? { schemaUrl: scopeSpans.schemaUrl }
          : {}),
      };
      for (const raw of list(scopeSpans.spans)) {
        const span =
          spans.length < limits.maxSpans
            ? decodeSpan(raw, { resource, scope }, limits)
            : undefined;
        if (span) spans.push(span);
        else rejected += 1;
      }
    }
  }
  return { ok: true, spans, rejected };
}
