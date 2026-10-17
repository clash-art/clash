/** Route table of the metadata service. No schema or platform imports, so
 * gateways can use the forwarding predicate without loading zod. */
/** Set by the web gateway on /api/v1/*: 401 when no credential validates. */
export const REQUIRE_IDENTITY_HEADER = "x-clash-require-identity";
/** Marks a request this service handed back to its host (prevents loops). */
export const DEFERRED_HEADER = "x-clash-meta-deferred";

export type MetadataRoute =
  | { kind: "projects-list" }
  | { kind: "project-get"; id: string }
  | { kind: "v1-project-get"; id: string }
  | { kind: "tokens-list" }
  | { kind: "metadata-get"; projectId: string }
  | { kind: "metadata-put"; projectId: string };

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function matchMetadataRoute(method: string, path: string): MetadataRoute | null {
  if (method === "GET") {
    if (path === "/api/projects" || path === "/api/projects/") return { kind: "projects-list" };
    let m = /^\/api\/projects\/([^/]+)$/.exec(path);
    if (m) return { kind: "project-get", id: m[1]! };
    m = /^\/api\/v1\/projects\/([^/]+)$/.exec(path);
    if (m) return { kind: "v1-project-get", id: m[1]! };
    if (path === "/api/settings/tokens") return { kind: "tokens-list" };
  }
  const m = /^\/loro\/([^/]+)\/metadata$/.exec(path);
  if (m && method === "GET") return { kind: "metadata-get", projectId: decode(m[1]!) };
  if (m && method === "PUT") return { kind: "metadata-put", projectId: decode(m[1]!) };
  return null;
}

/** Whether a request belongs to this service (gateway forwarding predicate). */
export function isMetadataServiceRequest(method: string, path: string): boolean {
  return matchMetadataRoute(method, path) !== null;
}

