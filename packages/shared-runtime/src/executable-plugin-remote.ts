/**
 * The `remote` binding of the shared PluginExecutionPort.
 *
 * A third-party plugin runs behind a user-configured HTTPS endpoint, a
 * different trust class from first-party code: the endpoint is untrusted,
 * receives no credentials and no storage locators, and must replay a repeated
 * `Idempotency-Key` instead of starting new work. Realm-neutral: fetch and
 * WebCrypto are injected or global, so the Cloudflare adapter and the Node
 * adapter bind the same protocol.
 *
 * POST <endpoint>
 *   x-clash-protocol: clash.plugin.invoke/v1
 *   x-clash-plugin-id / x-clash-version / x-clash-export-id / x-clash-schema-hash
 *   idempotency-key: invocationId (== durableRunIdempotencyKey(run), every attempt)
 *   x-clash-timestamp: unix seconds
 *   x-clash-signature: hex(HMAC-SHA256(secret, timestamp "\n" idempotency-key "\n" hex(sha256(body))))
 *   body: { invocation, references }  (references: short-lived signed URLs only)
 * 200 → ExecutablePluginResult; 409 → same key, different body.
 */
import {
  ProviderExecutionError,
  providerHttpFailure,
} from "@clash/action-sdk/executable-failure";
import {
  ExecutablePluginResultSchema,
  type ExecutablePluginResult,
} from "@clash/shared-types/executable-plugin";

import { durableRunIdempotencyKey } from "./durable-run-engine.js";
import type {
  PluginExecutionPort,
  PluginExecutionRequest,
} from "./executable-plugin-port.js";
import { sha256Hex } from "./sha256-hex.js";

export const REMOTE_PLUGIN_PROTOCOL = "clash.plugin.invoke/v1";
/** One remote call never outlives this, even with a longer attempt lease. */
export const REMOTE_PLUGIN_TIMEOUT_CAP_MS = 60_000;
/** A remote response is untrusted input; never buffer an unbounded body. */
export const REMOTE_PLUGIN_RESPONSE_MAX_BYTES = 1024 * 1024;

export class RemotePluginEndpointError extends Error {
  override name = "RemotePluginEndpointError";
}

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Names that resolve inside a private network rather than on the public Internet. */
const INTERNAL_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "private",
  "corp",
  "home",
  "lan",
  "home.arpa",
  "arpa",
  "test",
  "invalid",
  "example",
];

/**
 * Validate a third-party endpoint when it is saved. A Worker cannot pin DNS,
 * so this rejects every form that names a non-public host directly: non-https
 * schemes, embedded credentials, IP literals, single-label names, localhost
 * and private/internal suffixes. Returns the normalized URL.
 */
export function validateRemotePluginEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new RemotePluginEndpointError(
      "Plugin endpoint must be an absolute URL.",
    );
  }
  if (url.protocol !== "https:") {
    throw new RemotePluginEndpointError("Plugin endpoint must use https.");
  }
  if (url.username || url.password) {
    throw new RemotePluginEndpointError(
      "Plugin endpoint must not embed credentials.",
    );
  }
  // WHATWG URL normalizes decimal/hex/octal IPv4 spellings to dotted form.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || IPV4_LITERAL.test(host)) {
    throw new RemotePluginEndpointError(
      "Plugin endpoint must not be an IP literal.",
    );
  }
  const labels = host.split(".");
  if (labels.length < 2) {
    throw new RemotePluginEndpointError(
      "Plugin endpoint must be a public DNS name.",
    );
  }
  if (
    INTERNAL_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  ) {
    throw new RemotePluginEndpointError(
      "Plugin endpoint must not name a local or internal host.",
    );
  }
  url.hash = "";
  return url.href;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** `hex(HMAC-SHA256(secret, timestamp "\n" idempotencyKey "\n" hex(sha256(body))))`. */
export async function remotePluginSignature(input: {
  secret: string;
  timestamp: string;
  idempotencyKey: string;
  body: string;
}): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(
        `${input.timestamp}\n${input.idempotencyKey}\n${sha256Hex(input.body)}`,
      ),
    ),
  );
}

/** One asset reference delivered as a short-lived signed URL. */
export interface RemotePluginReference {
  slot: string;
  index: number;
  url: string;
  expiresAt: string;
}

export interface RemotePluginTarget {
  endpoint: string;
  secret: string;
  references: RemotePluginReference[];
}

export interface RemotePluginExecutionOptions {
  /** Endpoint, secret and signed reference URLs for one invocation; never journaled. */
  target(request: PluginExecutionRequest): Promise<RemotePluginTarget>;
  fetch?: typeof fetch;
  now?: () => number;
}

function contractViolation(
  message: string,
  requestState: "unknown" | "accepted",
): ProviderExecutionError {
  return new ProviderExecutionError({
    code: "contract_violation",
    message,
    retryable: false,
    requestState,
  });
}

function oversizedResponse(
  pluginId: string,
  settled: "unknown" | "accepted",
): ProviderExecutionError {
  return contractViolation(
    `Remote plugin ${pluginId} returned a response larger than ${REMOTE_PLUGIN_RESPONSE_MAX_BYTES} bytes.`,
    // A response proves the endpoint received the request. For a submit it may
    // already have done the work, so report `accepted` even though a 409 remains
    // `unknown`: retrying an oversized answer could charge the user twice.
    settled === "unknown" ? "accepted" : settled,
  );
}

/**
 * Read a remote response without buffering more than the protocol cap.
 *
 * A declared `content-length` above the cap is rejected before touching the
 * body. Otherwise the body is streamed and the reader is cancelled as soon as
 * one chunk would cross the cap, so the host retains at most cap + one chunk.
 */
async function readRemotePluginResponse(
  response: Response,
  pluginId: string,
  settled: "unknown" | "accepted",
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const declaredBytes = Number(declaredLength);
    if (
      Number.isFinite(declaredBytes) &&
      declaredBytes > REMOTE_PLUGIN_RESPONSE_MAX_BYTES
    ) {
      throw oversizedResponse(pluginId, settled);
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > REMOTE_PLUGIN_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw oversizedResponse(pluginId, settled);
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export function createRemotePluginExecution(
  options: RemotePluginExecutionOptions,
): PluginExecutionPort {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return {
    async invoke(request): Promise<ExecutablePluginResult> {
      const { invocation } = request;
      const idempotencyKey = durableRunIdempotencyKey(request.run);
      if (invocation.invocationId !== idempotencyKey) {
        throw new Error(
          `Remote plugin invocation ${invocation.invocationId} is not the durable key ${idempotencyKey}.`,
        );
      }
      const operation = invocation.operation;
      const target = await options.target(request);
      const endpoint = validateRemotePluginEndpoint(target.endpoint);
      const body = JSON.stringify({
        invocation,
        references: target.references,
      });
      const timestamp = String(Math.floor(now() / 1000));
      const response = await fetchImpl(endpoint, {
        method: "POST",
        // A redirect could point at a host the endpoint check never saw.
        redirect: "manual",
        signal: AbortSignal.timeout(
          Math.min(request.timeoutMs, REMOTE_PLUGIN_TIMEOUT_CAP_MS),
        ),
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-clash-protocol": REMOTE_PLUGIN_PROTOCOL,
          "x-clash-plugin-id": invocation.target.pluginId,
          "x-clash-version": invocation.target.version,
          "x-clash-export-id": invocation.target.exportId,
          "x-clash-schema-hash": invocation.target.schemaHash,
          "x-clash-timestamp": timestamp,
          "x-clash-signature": await remotePluginSignature({
            secret: target.secret,
            timestamp,
            idempotencyKey,
            body,
          }),
        },
        body,
      });
      const settled = operation === "submit" ? "unknown" : "accepted";
      if (response.status === 409 || !response.ok) {
        // Neither path reads the body; release it unread so an error page of
        // any size costs nothing and keeps its retry classification.
        await response.body?.cancel().catch(() => undefined);
      }
      if (response.status === 409) {
        throw contractViolation(
          `Remote plugin ${invocation.target.pluginId} rejected Idempotency-Key ${idempotencyKey}: ` +
            "the key was already used with a different request.",
          settled,
        );
      }
      if (!response.ok) {
        throw new ProviderExecutionError(
          providerHttpFailure({
            status: response.status,
            operation,
            message: `Remote plugin ${invocation.target.pluginId} answered HTTP ${response.status}.`,
          }),
        );
      }
      const text = await readRemotePluginResponse(
        response,
        invocation.target.pluginId,
        settled,
      );
      let parsed: ExecutablePluginResult;
      try {
        parsed = ExecutablePluginResultSchema.parse(JSON.parse(text));
      } catch (error) {
        throw contractViolation(
          `Remote plugin ${invocation.target.pluginId} returned an invalid result: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "accepted",
        );
      }
      if (parsed.invocationId !== idempotencyKey) {
        throw contractViolation(
          `Remote plugin ${invocation.target.pluginId} answered invocation ` +
            `${parsed.invocationId}, expected ${idempotencyKey}.`,
          "accepted",
        );
      }
      return parsed;
    },
  };
}
