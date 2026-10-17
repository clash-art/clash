import type { D1Database } from "@cloudflare/workers-types";
import {
  TOKEN_TOUCH_INTERVAL_S,
  shouldTouchToken,
} from "@clash/shared-runtime/project-authorization";

// Split from session.ts (issue #130) so token-only callers (the upload Worker)
// do not load better-auth at startup.
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getUserIdFromApiToken(
  request: Request,
  env: { DB: D1Database },
): Promise<string | null> {
  const auth = request.headers.get("authorization") ?? "";
  let token: string | null = null;
  if (auth.startsWith("Bearer clsh_")) {
    token = auth.slice(7);
  } else {
    const url = new URL(request.url);
    const q = url.searchParams.get("token");
    if (q?.startsWith("clsh_")) token = q;
  }
  if (!token) return null;
  const hash = await sha256Hex(token);
  const { results } = await env.DB.prepare(
    "SELECT user_id, last_used_at FROM api_token WHERE token_hash = ? LIMIT 1",
  )
    .bind(hash)
    .all<{ user_id: string; last_used_at: number | null }>();
  const row = results?.[0];
  if (!row) return null;
  // Usage is recorded at most every 5 min (#141): every write hits the D1
  // primary, and the guard keeps concurrent first requests to one write.
  if (shouldTouchToken(row.last_used_at == null ? null : row.last_used_at * 1000))
    env.DB.prepare(
      `UPDATE api_token SET last_used_at = unixepoch()
        WHERE token_hash = ? AND (last_used_at IS NULL OR last_used_at < unixepoch() - ?)`,
    )
      .bind(hash, TOKEN_TOUCH_INTERVAL_S)
      .run()
      .catch(() => {});
  return row.user_id ?? null;
}

