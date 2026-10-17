/**
 * Node adapters + composition for the platform-agnostic metadata service
 * (`@clash/metadata-service`, issue #138). Same module as the Cloudflare
 * metadata Worker; only the adapters differ:
 *
 *   identity   → clsh_ token (shared-runtime authenticateApiToken over
 *                Postgres api_token), then the Node Better Auth session
 *   authorizer → shared project authorization policy over Postgres
 *   projects / metadata / tokens → Postgres (shared-cloud-schema/postgres)
 *   previews   → none (Node project cards carry no canvas previews yet)
 *
 * Compose into the Node monolith (`mountMetadataService(app, ports)`, opt-in
 * via createNodeCloudApp({ metadataService })) or run it alone as a
 * microservice (`createMetadataServer`, src/metadata-server.ts).
 */
import { Hono } from "hono";
import {
  createMetadataService,
  matchMetadataRoute,
  type MetadataRoute,
  type MetadataServicePorts,
  type ProjectRow,
} from "@clash/metadata-service";
import {
  authenticateApiToken,
  createProjectAuthenticator,
} from "@clash/shared-runtime/project-authorization";
import { createPostgresProjectAuthorizationStore } from "@clash/shared-runtime/project-authorization-postgres";
import type { NodeAuth } from "./auth.ts";

interface Pg {
  query<Row extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

const date = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(v as string));
const iso = (v: unknown): string | null => date(v)?.toISOString() ?? null;

function projectRow(r: Record<string, unknown>): ProjectRow {
  return {
    id: r.id as string,
    ownerId: r.owner_id as string,
    tenantId: (r.tenant_id as string | null) ?? null,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
    deletedAt: date(r.deleted_at),
  };
}

export function createNodeMetadataPorts(options: { db: Pg; auth?: NodeAuth }): MetadataServicePorts {
  const { db, auth } = options;
  const authority = createPostgresProjectAuthorizationStore(db as never);
  const sessionUser = async (request: Request) => {
    if (!auth || !request.headers.get("cookie")) return null;
    const s = await auth.api.getSession({ headers: request.headers }).catch(() => null);
    return s ? { session: s.session, user: s.user } : null;
  };
  const authenticator = createProjectAuthenticator({
    store: authority,
    resolveSession: async (request) => {
      const s = await sessionUser(request);
      return s
        ? {
            session: { id: s.session.id, expiresAt: new Date(s.session.expiresAt).getTime() },
            user: { id: s.user.id, name: s.user.name ?? undefined, image: s.user.image ?? undefined },
          }
        : null;
    },
  });
  return {
    identity: {
      async verify(request, accept) {
        if (accept === "any" && /^Bearer\s+clsh_/i.test(request.headers.get("authorization") ?? "")) {
          const row = await authenticateApiToken(request, authority).catch(() => null);
          if (row) return { userId: row.userId };
        }
        const s = await sessionUser(request);
        return s ? { userId: s.user.id } : null;
      },
    },
    authorizer: {
      async authorize(request, projectId, policy) {
        try {
          return { userId: (await authenticator.authenticate(request, projectId, policy)).userId };
        } catch {
          return null;
        }
      },
    },
    projects: {
      async list(ownerId, limit) {
        const { rows } = await db.query(
          "SELECT id, owner_id, tenant_id, name, description, created_at, updated_at, deleted_at FROM project WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2",
          [ownerId, limit],
        );
        return rows.map(projectRow);
      },
      async get(ownerId, id) {
        const { rows } = await db.query(
          "SELECT id, owner_id, tenant_id, name, description, created_at, updated_at, deleted_at FROM project WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL LIMIT 1",
          [id, ownerId],
        );
        return rows[0] ? projectRow(rows[0]) : null;
      },
    },
    previews: {
      nodes: async () => [],
      assetsByIds: async () => [],
      importedAssets: async () => [],
      sign: async (key) => key,
    },
    metadata: {
      async read(projectId) {
        const { rows } = await db.query(
          "SELECT id, name, description, created_at, updated_at, deleted_at FROM project WHERE id = $1 LIMIT 1",
          [projectId],
        );
        const r = rows[0];
        return r
          ? {
              projectId: r.id as string,
              name: r.name as string,
              description: (r.description as string | null) ?? null,
              createdAt: iso(r.created_at)!,
              updatedAt: iso(r.updated_at)!,
              deletedAt: iso(r.deleted_at),
            }
          : null;
      },
      async write(m) {
        // Same last-writer-wins rule as D1: an equal timestamp wins, an older one is stale.
        const { rows } = await db.query(
          `UPDATE project SET name = $2, description = $3, updated_at = $4, deleted_at = $5
            WHERE id = $1 AND updated_at <= $4 RETURNING id`,
          [m.projectId, m.name, m.description, m.updatedAt, m.deletedAt],
        );
        if (rows.length) return { status: "written" };
        const current = await this.read(m.projectId);
        return current ? { status: "stale", current } : { status: "not-found" };
      },
    },
    tokens: {
      async list(userId) {
        const { rows } = await db.query(
          "SELECT id, name, token_prefix, last_used_at, created_at FROM api_token WHERE user_id = $1 ORDER BY created_at DESC",
          [userId],
        );
        return rows.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          tokenPrefix: r.token_prefix as string,
          lastUsedAt: date(r.last_used_at),
          createdAt: date(r.created_at),
        }));
      },
    },
  };
}

/** Monolith mode: serve the metadata routes inside an existing Hono app.
 * Mount before routes it should take precedence over. */
export function mountMetadataService(
  app: Hono<any>,
  ports: MetadataServicePorts,
  options: { routes?: MetadataRoute["kind"][] } = {},
) {
  const service = createMetadataService(ports);
  app.use("*", async (c, next) => {
    const route = matchMetadataRoute(c.req.method, c.req.path);
    if (!route || (options.routes && !options.routes.includes(route.kind))) return next();
    const response = await service.handle(c.req.raw);
    if (response) return response;
    return next();
  });
  return service;
}

/** Microservice mode: a process that serves only the metadata routes. */
export function createMetadataServer(ports: MetadataServicePorts) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok", service: "clash-meta" }));
  mountMetadataService(app, ports);
  return app;
}
