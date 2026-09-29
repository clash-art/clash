import type { ProxyOptions } from "vite";
/** Keep browser requests same-origin so session cookies and CSRF checks agree. */
export function nodeBackendProxy(
  value?: string,
): Record<string, ProxyOptions> | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("CLASH_NODE_API_URL must be an HTTP origin");
  return Object.fromEntries(
    ["/api", "^/assets/", "/loro", "/sync", "/agents"].map((path) => [
      path,
      { target: url.origin, changeOrigin: false, ws: true },
    ]),
  );
}
