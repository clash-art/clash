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
export function readConfig(env: Record<string, string | undefined>) {
  const connectionString = databaseUrl(env);
  if (!env.CLOUD_PUBLIC_URL) throw Error("CLOUD_PUBLIC_URL is required");
  let url: URL;
  try {
    url = new URL(env.CLOUD_PUBLIC_URL);
  } catch {
    throw Error("CLOUD_PUBLIC_URL must be an HTTP origin");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error("CLOUD_PUBLIC_URL must be an HTTP origin");
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("PORT must be an integer between 1 and 65535");
  return {
    connectionString,
    publicUrl: url.origin,
    port,
    hostname: env.HOST ?? "127.0.0.1",
  };
}
