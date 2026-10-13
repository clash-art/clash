import { isIPv4 } from "node:net";

const V4_MAPPED_PREFIX = "::ffff:";

/**
 * Whether a socket peer address is this machine's loopback: 127.0.0.0/8, ::1,
 * or an IPv4-mapped 127.x.x.x. Anything unparseable is not loopback.
 */
export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  const v4 = normalized.startsWith(V4_MAPPED_PREFIX)
    ? normalized.slice(V4_MAPPED_PREFIX.length)
    : normalized;
  return isIPv4(v4) && v4.startsWith("127.");
}

/**
 * Peer address of the Node socket behind a request served by
 * `@hono/node-server`. Request headers (`X-Forwarded-For`, `Host`) are caller
 * supplied and never consulted. A request with no socket has no address.
 */
export function socketRemoteAddress(env: unknown): string | undefined {
  const incoming = (env as { incoming?: unknown } | null | undefined)?.incoming;
  const socket = (incoming as { socket?: unknown } | null | undefined)?.socket;
  const address = (socket as { remoteAddress?: unknown } | null | undefined)
    ?.remoteAddress;
  return typeof address === "string" ? address : undefined;
}
