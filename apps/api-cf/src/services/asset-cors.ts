import type { Env } from "../config";

/**
 * Signed Asset URLs are consumed by <img>/<video> and by the cross-origin
 * render frame's mediabunny probes. Echo only configured deployment origins;
 * a wildcard would let any origin read a leaked capability URL.
 */
export function assetCorsOrigin(
  requestOrigin: string | null | undefined,
  env: Pick<
    Env,
    "RENDER_FRAME_ORIGIN" | "WEB_PUBLIC_ORIGIN" | "WORKER_PUBLIC_URL"
  >,
): string | null {
  if (!requestOrigin) return null;
  const allowed = [
    env.RENDER_FRAME_ORIGIN,
    env.WEB_PUBLIC_ORIGIN,
    env.WORKER_PUBLIC_URL,
  ]
    .map((value) => value?.trim().replace(/\/+$/, ""))
    .filter((value): value is string => Boolean(value));
  return allowed.includes(requestOrigin) ? requestOrigin : null;
}
