/** In-memory adapters: unit tests and the Node mono/micro smoke composition. */
import type {
  ApiTokenSummary,
  IdentityVerifier,
  MetadataServicePorts,
  ProjectAuthorizer,
  ProjectMetadata,
  ProjectRow,
} from "./index.js";

export interface MemoryMetadataState {
  /** session cookie value or bearer token -> userId */
  sessions: Map<string, string>;
  apiTokens: Map<string, string>;
  projects: Map<string, ProjectRow>;
  tokens: Map<string, ApiTokenSummary & { userId: string }>;
}

export function createMemoryMetadataState(): MemoryMetadataState {
  return { sessions: new Map(), apiTokens: new Map(), projects: new Map(), tokens: new Map() };
}

function bearer(request: Request): string | null {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}
function sessionCookie(request: Request): string | null {
  return /(?:^|;\s*)session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const toSeconds = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);

export function createMemoryMetadataPorts(state: MemoryMetadataState): MetadataServicePorts {
  const identity: IdentityVerifier = {
    async verify(request, accept) {
      const token = bearer(request);
      if (accept === "any" && token) {
        const userId = state.apiTokens.get(token);
        if (userId) return { userId };
      }
      const cookie = sessionCookie(request);
      const userId = cookie ? state.sessions.get(cookie) : undefined;
      return userId ? { userId } : null;
    },
  };
  const authorizer: ProjectAuthorizer = {
    async authorize(request, projectId, policy) {
      const who = await identity.verify(request, "any");
      if (!who || who === "defer") return who;
      const p = state.projects.get(projectId);
      if (!p || p.ownerId !== who.userId || (p.deletedAt && !policy.allowDeleted)) return null;
      return who;
    },
  };
  return {
    identity,
    authorizer,
    projects: {
      async list(ownerId, limit) {
        return [...state.projects.values()]
          .filter((p) => p.ownerId === ownerId && !p.deletedAt)
          .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
          .slice(0, limit);
      },
      async get(ownerId, id) {
        const p = state.projects.get(id);
        return p && p.ownerId === ownerId && !p.deletedAt ? p : null;
      },
    },
    previews: {
      nodes: async () => [],
      assetsByIds: async () => [],
      importedAssets: async () => [],
      sign: async (key) => `/assets/${key}`,
    },
    metadata: {
      async read(projectId) {
        const p = state.projects.get(projectId);
        if (!p) return null;
        return {
          projectId: p.id,
          name: p.name,
          description: p.description,
          createdAt: iso(p.createdAt)!,
          updatedAt: iso(p.updatedAt)!,
          deletedAt: iso(p.deletedAt),
        } satisfies ProjectMetadata;
      },
      async write(m) {
        const p = state.projects.get(m.projectId);
        if (!p) return { status: "not-found" };
        const next = toSeconds(new Date(m.updatedAt));
        if (p.updatedAt && p.updatedAt.getTime() > next.getTime())
          return { status: "stale", current: (await this.read(m.projectId))! };
        state.projects.set(p.id, {
          ...p,
          name: m.name,
          description: m.description,
          updatedAt: next,
          deletedAt: m.deletedAt ? toSeconds(new Date(m.deletedAt)) : null,
        });
        return { status: "written" };
      },
    },
    tokens: {
      async list(userId) {
        return [...state.tokens.values()]
          .filter((t) => t.userId === userId)
          .map(({ userId: _u, ...t }) => t);
      },
    },
  };
}
