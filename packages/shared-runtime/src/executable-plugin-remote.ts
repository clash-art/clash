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
      const text = await response.text();
      const settled = operation === "submit" ? "unknown" : "accepted";
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
