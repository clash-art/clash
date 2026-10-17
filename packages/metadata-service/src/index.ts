/**
 * Platform-agnostic Project metadata service (issue #138).
 *
 * Serves the hot, small, D1-only metadata reads plus Project metadata
 * replication with api-cf's exact wire contract:
 *
 *   GET  /api/projects                 project cards (session)
 *   GET  /api/projects/:id             one project card (session)
 *   GET  /api/v1/projects/:id          one project card (token or session)
 *   GET  /api/settings/tokens          API token list (session)
 *   GET  /loro/:id/metadata            metadata envelope (project authorization)
 *   PUT  /loro/:id/metadata            last-writer-wins metadata write
 *
 * It depends only on injected ports, so the same module runs as a lean
 * Cloudflare Worker, in-process in api-node (monolith) or as its own Node
 * process (microservice). Nothing here imports a platform SDK, an auth
 * library, an ORM or the shared-types barrel.
 */
import {
  ProjectMetadataEnvelopeSchema,
  type ProjectMetadata,
} from "@clash/shared-types/project-metadata";
import {
  resolveProjectPreviews,
  type ProjectPreview,
  type ProjectPreviewPorts,
} from "./previews.js";

export * from "./previews.js";
export * from "./routes.js";
import { DEFERRED_HEADER, REQUIRE_IDENTITY_HEADER, matchMetadataRoute, type MetadataRoute as Route } from "./routes.js";

export const PROJECT_METADATA_NAME_MAX = 512;
export const PROJECT_METADATA_DESCRIPTION_MAX = 64 * 1024;
/** "defer": the platform auth library must handle this request (for example
 * a sliding session refresh that writes); the service calls `ports.defer`. */
export type Verdict<T> = T | null | "defer";

export interface IdentityVerifier {
  /** `session`: Better Auth session only. `any`: clsh_ API token, then session. */
  verify(
    request: Request,
    accept: "session" | "any",
  ): Promise<Verdict<{ userId: string }>>;
}

export interface ProjectAuthorizer {
  /** Project transport authorization (owner, token/session/JWT). Throws or
   * returns null when unauthorized. */
  authorize(
    request: Request,
    projectId: string,
    policy: { allowDeleted?: boolean },
  ): Promise<Verdict<{ userId: string }>>;
}

export interface ProjectRow {
  id: string;
  ownerId: string;
  tenantId: string | null;
  name: string;
  description: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  deletedAt: Date | null;
}

export interface ProjectDirectory {
  /** Active projects of the owner, newest created first. */
  list(ownerId: string, limit: number): Promise<ProjectRow[]>;
  /** Active project by id and owner. */
  get(ownerId: string, id: string): Promise<ProjectRow | null>;
}

export interface ProjectMetadataStore {
  read(projectId: string): Promise<ProjectMetadata | null>;
  write(
    metadata: ProjectMetadata,
  ): Promise<
    | { status: "written" }
    | { status: "stale"; current: ProjectMetadata }
    | { status: "not-found" }
  >;
}

export interface ApiTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt: Date | null;
  createdAt: Date | null;
}

export interface TokenDirectory {
  list(userId: string): Promise<ApiTokenSummary[]>;
}

export interface MetadataServicePorts {
  identity: IdentityVerifier;
  authorizer: ProjectAuthorizer;
  projects: ProjectDirectory;
  previews: ProjectPreviewPorts;
  metadata: ProjectMetadataStore;
  tokens: TokenDirectory;
  /** Host fallback for "defer" verdicts (api-cf in-process). Without it a
   * deferred request is answered 503. */
  defer?: (request: Request) => Promise<Response>;
  log?: (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=UTF-8" } });

class Deferred extends Error {}

export function createMetadataService(ports: MetadataServicePorts) {
  const card = async (userId: string, project: ProjectRow) => {
    const assets: ProjectPreview[] = await resolveProjectPreviews(ports.previews, userId, project);
    return { ...project, assets, assetCount: assets.length };
  };
  const who = async (request: Request, accept: "session" | "any") => {
    const verdict = await ports.identity.verify(request, accept);
    if (verdict === "defer") throw new Deferred();
    return verdict?.userId ?? null;
  };
  const authorized = async (request: Request, projectId: string) => {
    let verdict: Verdict<{ userId: string }>;
    try {
      verdict = await ports.authorizer.authorize(request, projectId, { allowDeleted: true });
    } catch {
      return null;
    }
    if (verdict === "defer") throw new Deferred();
    return verdict?.userId ?? null;
  };

  async function route(request: Request, r: Route): Promise<Response> {
    const required = request.headers.get(REQUIRE_IDENTITY_HEADER) === "1";
    switch (r.kind) {
      case "projects-list": {
        const userId = await who(request, "session");
        if (!userId) return json({ error: "Unauthorized" }, 401);
        const rows = await ports.projects.list(userId, 100);
        return json(await Promise.all(rows.map((p) => card(userId, p))));
      }
      case "project-get": {
        const userId = await who(request, "session");
        if (!userId) return text("Unauthorized", 401);
        const p = await ports.projects.get(userId, r.id);
        return p ? json(await card(userId, p)) : json({ error: "Not found" }, 404);
      }
      case "v1-project-get": {
        const userId = await who(request, "any");
        if (!userId)
          return required
            ? json({ error: "Unauthorized" }, 401)
            : json({ error: "unauthorized" }, 401);
        const p = await ports.projects.get(userId, r.id);
        return p ? json(await card(userId, p)) : json({ error: "Project not found" }, 404);
      }
      case "tokens-list": {
        const userId = await who(request, "session");
        if (!userId) return text("Unauthorized", 401);
        return json(await ports.tokens.list(userId));
      }
      case "metadata-get": {
        if (!(await authorized(request, r.projectId))) return text("Unauthorized", 401);
        const metadata = await ports.metadata.read(r.projectId);
        return metadata
          ? json({ schemaVersion: 1, metadata })
          : json({ error: "Project metadata not found" }, 404);
      }
      case "metadata-put": {
        if (!(await authorized(request, r.projectId))) return text("Unauthorized", 401);
        const parsed = ProjectMetadataEnvelopeSchema.safeParse(
          await request.json().catch(() => null),
        );
        if (!parsed.success || parsed.data.metadata.projectId !== r.projectId)
          return json({ error: "Invalid Project metadata envelope" }, 400);
        if (
          parsed.data.metadata.name.length > PROJECT_METADATA_NAME_MAX ||
          (parsed.data.metadata.description?.length ?? 0) > PROJECT_METADATA_DESCRIPTION_MAX
        )
          return json({ error: "Project metadata too large" }, 413);
        const result = await ports.metadata.write(parsed.data.metadata);
        if (result.status === "written") return new Response(null, { status: 204 });
        if (result.status === "stale")
          return json(
            { error: "Project metadata is stale", schemaVersion: 1, metadata: result.current },
            409,
          );
        return json({ error: "Project metadata not found" }, 404);
      }
    }
  }

  return {
    match: (request: Request) => matchMetadataRoute(request.method, new URL(request.url).pathname),
    /** Serve a matched request; returns null when the route is not ours. */
    async handle(request: Request): Promise<Response | null> {
      const r = matchMetadataRoute(request.method, new URL(request.url).pathname);
      if (!r) return null;
      // A body can only be read once: keep an untouched copy for defer.
      const original = ports.defer && r.kind === "metadata-put" ? request.clone() : request;
      try {
        return await route(request, r);
      } catch (error) {
        if (!(error instanceof Deferred)) throw error;
        ports.log?.("info", "metadata_service.deferred", { route: r.kind });
        if (!ports.defer) return json({ error: "Session refresh unavailable" }, 503);
        const forwarded = new Request(original);
        forwarded.headers.set(DEFERRED_HEADER, "1");
        return ports.defer(forwarded);
      }
    },
  };
}

export type MetadataService = ReturnType<typeof createMetadataService>;
export type { ProjectMetadata };
