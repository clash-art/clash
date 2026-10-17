/**
 * Cloudflare adapters for `@clash/metadata-service` (issue #138): D1 with raw
 * SQL (no ORM), the one-query session cookie check (no better-auth), the
 * shared project authorization policy, ProjectRoom nodes for card previews
 * and JWT_SECRET-signed asset URLs. Used by the lean metadata Worker.
 */
import type { D1Database } from "@cloudflare/workers-types";
import * as jose from "jose";
import { createProjectAuthenticator } from "@clash/shared-runtime/project-authorization";
import type {
  ApiTokenSummary,
  MetadataServicePorts,
  PreviewAssetRow,
  PreviewRefRow,
  ProjectRow,
} from "@clash/metadata-service";
import { createD1ProjectAuthorizationStore } from "../loro/authorization-store";
import { createD1ProjectMetadataStore } from "./cloud-project-metadata";
import { getUserIdFromApiToken } from "./api-token";
import { signAssetPath } from "./asset-signing";
import {
  leanSessionCookieParams,
  verifySessionCookie,
  type FastSession,
} from "./session-cookie";

export interface MetadataCloudEnv {
  DB: D1Database;
  ROOM?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string): Promise<Response> } };
  JWT_SECRET?: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECURE_COOKIES?: string;
  BETTER_AUTH_SECRET?: string;
  AUTH_SECRET?: string;
  ENVIRONMENT?: string;
}

const seconds = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(Number(v) * 1000);

function projectRow(r: Record<string, unknown>): ProjectRow {
  return {
    id: r.id as string,
    ownerId: r.owner_id as string,
    tenantId: (r.tenant_id as string | null) ?? null,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    createdAt: seconds(r.created_at),
    updatedAt: seconds(r.updated_at),
    deletedAt: seconds(r.deleted_at),
  };
}

class DeferSession extends Error {}

async function session(request: Request, env: MetadataCloudEnv): Promise<FastSession | null> {
  if (!request.headers.get("cookie")) return null;
  const params = leanSessionCookieParams(env);
  if (!params) throw new DeferSession();
  const verdict = await verifySessionCookie(request, env.DB, await params);
  if (verdict === "fallback") throw new DeferSession();
  return verdict;
}

const PROJECT_COLUMNS = "id, owner_id, tenant_id, name, description, created_at, updated_at, deleted_at";

export function createCloudflareMetadataPorts(
  env: MetadataCloudEnv,
  defer?: (request: Request) => Promise<Response>,
): MetadataServicePorts {
  const authenticator = createProjectAuthenticator({
    store: createD1ProjectAuthorizationStore(env as never),
    development: env.ENVIRONMENT === "development",
    resolveSession: async (request) => {
      const s = await session(request, env);
      return s
        ? {
            session: { id: s.sessionId, expiresAt: s.expiresAt },
            user: {
              id: s.userId,
              ...(s.userName ? { name: s.userName } : {}),
              ...(s.userImage ? { image: s.userImage } : {}),
            },
            authorityChecked: true,
          }
        : null;
    },
    ...(env.JWT_SECRET
      ? {
          verifyJwt: async (token: string) =>
            (
              await jose.jwtVerify(token, new TextEncoder().encode(env.JWT_SECRET), {
                algorithms: ["HS256"],
              })
            ).payload,
        }
      : {}),
  });

  return {
    defer,
    identity: {
      async verify(request, accept) {
        const auth = request.headers.get("authorization") ?? "";
        if (accept === "any" && /^Bearer[\t ]+clsh_\S+$/i.test(auth.trim())) {
          const userId = await getUserIdFromApiToken(request, env).catch(() => null);
          if (userId) return { userId };
        }
        try {
          const s = await session(request, env);
          return s ? { userId: s.userId } : null;
        } catch (error) {
          if (error instanceof DeferSession) return "defer";
          return null;
        }
      },
    },
    authorizer: {
      async authorize(request, projectId, policy) {
        try {
          return { userId: (await authenticator.authenticate(request, projectId, policy)).userId };
        } catch (error) {
          if (error instanceof DeferSession) return "defer";
          return null;
        }
      },
    },
    projects: {
      async list(ownerId, limit) {
        const { results } = await env.DB.prepare(
          `SELECT ${PROJECT_COLUMNS} FROM project WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
        )
          .bind(ownerId, limit)
          .all<Record<string, unknown>>();
        return (results ?? []).map(projectRow);
      },
      async get(ownerId, id) {
        const row = await env.DB.prepare(
          `SELECT ${PROJECT_COLUMNS} FROM project WHERE id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1`,
        )
          .bind(id, ownerId)
          .first<Record<string, unknown>>();
        return row ? projectRow(row) : null;
      },
    },
    previews: {
      async nodes(projectId) {
        if (!env.ROOM) return [];
        try {
          const res = await env.ROOM.get(env.ROOM.idFromName(projectId)).fetch(
            `https://room/sync/${projectId}/nodes`,
          );
          return res.ok ? ((await res.json()) as unknown[]) : [];
        } catch {
          return [];
        }
      },
      async assetsByIds(ids) {
        const out: PreviewAssetRow[] = [];
        // D1 binds at most 100 parameters per statement.
        for (let i = 0; i < ids.length; i += 90) {
          const chunk = ids.slice(i, i + 90);
          const { results } = await env.DB.prepare(
            `SELECT id, src_r2_key, cover_r2_key FROM assets WHERE id IN (${chunk.map(() => "?").join(",")})`,
          )
            .bind(...chunk)
            .all<{ id: string; src_r2_key: string; cover_r2_key: string | null }>();
          for (const r of results ?? [])
            out.push({ id: r.id, srcR2Key: r.src_r2_key, coverR2Key: r.cover_r2_key });
        }
        return out;
      },
      async importedAssets(projectId, userId) {
        const { results } = await env.DB.prepare(
          `SELECT a.id, a.src_r2_key, a.cover_r2_key, a.kind, a.created_at, r.imported_at
             FROM assets a INNER JOIN asset_refs r ON r.asset_id = a.id
            WHERE r.project_id = ? AND a.user_id = ?
            ORDER BY r.imported_at DESC, a.created_at DESC LIMIT 1000`,
        )
          .bind(projectId, userId)
          .all<Record<string, unknown>>();
        return (results ?? []).map(
          (r): PreviewRefRow => ({
            id: r.id as string,
            srcR2Key: r.src_r2_key as string,
            coverR2Key: (r.cover_r2_key as string | null) ?? null,
            kind: r.kind as string,
            createdAt: seconds(r.created_at),
            importedAt: seconds(r.imported_at),
          }),
        );
      },
      sign: (key) => signAssetPath(env as never, key),
    },
    metadata: createD1ProjectMetadataStore(env.DB),
    tokens: {
      async list(userId) {
        const { results } = await env.DB.prepare(
          "SELECT id, name, token_prefix, last_used_at, created_at FROM api_token WHERE user_id = ? ORDER BY created_at DESC",
        )
          .bind(userId)
          .all<Record<string, unknown>>();
        return (results ?? []).map(
          (r): ApiTokenSummary => ({
            id: r.id as string,
            name: r.name as string,
            tokenPrefix: r.token_prefix as string,
            lastUsedAt: seconds(r.last_used_at),
            createdAt: seconds(r.created_at),
          }),
        );
      },
    },
  };
}
