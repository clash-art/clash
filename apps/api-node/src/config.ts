export function databaseUrl(env: Record<string, string | undefined>): string {
  const value = env.DATABASE_URL;
  if (!value) throw Error("DATABASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw Error("DATABASE_URL must be a PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol))
    throw Error("DATABASE_URL must be a PostgreSQL URL");
  return value;
}
/** An http(s) origin: no credentials, path, query or fragment. */
function httpOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error(`${name} must be an HTTP origin`);
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error(`${name} must be an HTTP origin`);
  return url.origin;
}
export function publicUrl(env: Record<string, string | undefined>): string {
  if (!env.CLOUD_PUBLIC_URL) throw Error("CLOUD_PUBLIC_URL is required");
  return httpOrigin(env.CLOUD_PUBLIC_URL, "CLOUD_PUBLIC_URL");
}
/**
 * Optional apps/render-server origin. Unset, Timeline render is not wired and
 * `request_timeline_render` answers 501. Set, the API server and the outbox
 * worker must share it, BETTER_AUTH_SECRET and CLOUD_PUBLIC_URL: the worker
 * signs media URLs that the API server verifies.
 */
export function renderServerUrl(
  env: Record<string, string | undefined>,
): string | undefined {
  if (!env.RENDER_SERVER_URL) return undefined;
  const origin = httpOrigin(env.RENDER_SERVER_URL, "RENDER_SERVER_URL");
  if (!env.BETTER_AUTH_SECRET)
    throw Error("RENDER_SERVER_URL requires BETTER_AUTH_SECRET");
  return origin;
}
export function readConfig(env: Record<string, string | undefined>) {
  const connectionString = databaseUrl(env);
  const origin = publicUrl(env);
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("PORT must be an integer between 1 and 65535");
  const providerSecretKey = env.ACTION_SECRET_KEY?.trim();
  if (env.ACTION_SECRET_KEY !== undefined && !providerSecretKey)
    throw Error("ACTION_SECRET_KEY must not be empty");
  return {
    connectionString,
    publicUrl: origin,
    port,
    hostname: env.HOST ?? "127.0.0.1",
    renderServerUrl: renderServerUrl(env),
    providerSecretKey,
  };
}
