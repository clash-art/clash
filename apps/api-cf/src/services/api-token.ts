import type { D1Database } from "@cloudflare/workers-types";

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
    "SELECT user_id FROM api_token WHERE token_hash = ? LIMIT 1",
  )
    .bind(hash)
    .all();
  if (!results?.[0]) return null;
  env.DB.prepare(
    "UPDATE api_token SET last_used_at = unixepoch() WHERE token_hash = ?",
  )
    .bind(hash)
    .run()
    .catch(() => {});
  return (results[0] as { user_id: string }).user_id ?? null;
}

