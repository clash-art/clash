import { describe, expect, it } from "vitest";
import {
  PROJECT_ASSET_IMPORT_STAGING_PREFIX,
  createCapabilityResolver,
  createD1ProjectAccessAuthorizer,
} from "./project-content-cloud";

type ProjectRow = {
  owner_id: string;
  tenant_id: string | null;
  deleted_at: number | null;
};

function d1With(row: ProjectRow | null) {
  return {
    prepare(sql: string) {
      return {
        bind(..._values: unknown[]) {
          return {
            async first<T>() {
              return sql.includes("FROM project") ? (row as T | null) : null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              return {};
            },
          };
        },
      };
    },
  };
}

const resource = {
  id: "sha256:" + "a".repeat(64),
  kind: "video" as const,
  digest: { algorithm: "sha256" as const, value: "a".repeat(64) },
  byteLength: 4,
  contentType: "video/mp4",
};

const claims = {
  operation: "read",
  purpose: "preview",
  resourceId: resource.id,
  scope: { tenantId: "personal:owner", projectId: "project" },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

describe("capability resolver Project owner branches", () => {
  it("serves an owner preview read without a Host replica and caches it", async () => {
    const reads: string[] = [];
    const resolver = createCapabilityResolver(
      () => ({
        authorize: async () => null,
        authorizeProject: createD1ProjectAccessAuthorizer(
          d1With({ owner_id: "owner", tenant_id: null, deleted_at: null }) as never,
        ),
        resource: async () => {
          reads.push("resource");
          return resource;
        },
      }),
      () => ({ resource: async () => ({ kind: "video" }) }),
      { now: () => Date.now(), cacheTtlMs: 10_000 },
    );
    expect(await resolver(claims, {} as never)).toMatchObject({
      contentType: "video/mp4",
      byteLength: 4,
    });
    expect(await resolver(claims, {} as never)).toMatchObject({
      contentType: "video/mp4",
    });
    expect(reads).toEqual(["resource"]);
  });

  it("rejects a deleted Project, a cross-tenant scope, or a missing reference", async () => {
    const deleted = createCapabilityResolver(
      () => ({
        authorize: async () => null,
        authorizeProject: createD1ProjectAccessAuthorizer(
          d1With({ owner_id: "owner", tenant_id: null, deleted_at: 1 }) as never,
        ),
        resource: async () => resource,
      }),
      () => ({ resource: async () => ({ kind: "video" }) }),
    );
    expect(await deleted(claims, {} as never)).toBeUndefined();
    const otherTenant = createCapabilityResolver(
      () => ({
        authorize: async () => null,
        authorizeProject: createD1ProjectAccessAuthorizer(
          d1With({ owner_id: "owner", tenant_id: null, deleted_at: null }) as never,
        ),
        resource: async () => resource,
      }),
      () => ({ resource: async () => ({ kind: "video" }) }),
    );
    expect(
      await otherTenant(
        { ...claims, scope: { ...claims.scope, tenantId: "personal:other" } },
        {} as never,
      ),
    ).toBeUndefined();
    const noReference = createCapabilityResolver(
      () => ({
        authorize: async () => null,
        authorizeProject: createD1ProjectAccessAuthorizer(
          d1With({ owner_id: "owner", tenant_id: null, deleted_at: null }) as never,
        ),
        resource: async () => resource,
      }),
      () => ({ resource: async () => undefined }),
    );
    expect(await noReference(claims, {} as never)).toBeUndefined();
  });

  it("admits a signed chunked-import staging key only below the import prefix", async () => {
    const stage: string[] = [];
    const resolver = createCapabilityResolver(
      () => ({
        authorize: async () => null,
        authorizeProject: createD1ProjectAccessAuthorizer(
          d1With({ owner_id: "owner", tenant_id: null, deleted_at: null }) as never,
        ),
        resource: async () => {
          stage.push("registry");
          return resource;
        },
      }),
      () => ({
        resource: async () => {
          stage.push("reference");
          return { kind: "video" };
        },
      }),
    );
    const uploadClaims = {
      operation: "upload",
      purpose: "host-staging",
      resourceId: "import-session:x",
      scope: { tenantId: "personal:owner", projectId: "project" },
      byteLength: 4,
      contentType: "video/mp4",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      importSession: {
        ownerId: "owner",
        stagingKey: `${PROJECT_ASSET_IMPORT_STAGING_PREFIX}session`,
        kind: "video",
        projectAssetId: "asset:one",
        fileName: "clip.mp4",
      },
    };
    expect(await resolver(uploadClaims, {} as never)).toMatchObject({
      storageKey: `${PROJECT_ASSET_IMPORT_STAGING_PREFIX}session`,
      byteLength: 4,
    });
    expect(stage).toEqual([]);
    expect(
      await resolver(
        {
          ...uploadClaims,
          importSession: {
            ...uploadClaims.importSession,
            stagingKey: "arbitrary/object",
          },
        },
        {} as never,
      ),
    ).toBeUndefined();
  });
});
