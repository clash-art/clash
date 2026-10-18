import type { Env } from "../config";

/**
 * The browser-visible origin of this deployment, without a trailing slash.
 *
 * WORKER_PUBLIC_URL names the Web gateway origin users load; without it the request's own origin
 * is used, which is the same thing whenever the gateway forwards the original URL.
 */
export function publicOrigin(request: Request, env: Pick<Env, "WORKER_PUBLIC_URL">): string {
  return (env.WORKER_PUBLIC_URL ?? new URL(request.url).origin).replace(/\/+$/u, "");
}
