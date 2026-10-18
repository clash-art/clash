import { expect, it, vi } from "vitest";
import type { ResolvedAsset } from "@clash/shared-types";
import {
  createInMemoryAssetDeliveryStore,
  MultipartAssemblyError,
} from "@clash/asset-sdk/upload-service";
import type { AssetDeliveryStore } from "@clash/asset-sdk/delivery";
import {
  createProjectAssetImportSession,
  createHmacProjectAssetImportSessionTokens,
  finalizeProjectAssetImportSession,
  handleProjectAssetImportSessionContent,
  PROJECT_ASSET_DUPLICATE_CONTENT,
  PROJECT_ASSET_ID_COLLISION,
  PROJECT_ASSET_IMPORT_ASSEMBLY_FAILED,
  PROJECT_ASSET_IMPORT_DIGEST_MISMATCH,
  PROJECT_ASSET_IMPORT_SESSION_TTL_MS,
  PROJECT_ASSET_IMPORT_STAGING_CLEANUP_FAILED,
  PROJECT_ASSET_TRASHED,
  sweepProjectAssetImportStaging,
  type ProjectAssetImportSessionPorts,
} from "./project-asset-import-sessions.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

const SESSION_START = Date.parse("2026-01-01T00:00:00.000Z");
const asset = {
  id: "asset:1",
  kind: "video",
  status: "ready",
  url: "https://host.example/api/v1/projects/p/assets/asset:1/media",
  lifecycle: { state: "active" },
} as unknown as ResolvedAsset;

function stagingStore(overrides: Partial<AssetDeliveryStore> = {}) {
  const objects = new Map<string, Uint8Array>();
  const digests = new Map<string, string>();
  const store: AssetDeliveryStore = {
    head(locator) {
      const bytes = objects.get(locator);
      return bytes ? { size: bytes.byteLength } : undefined;
    },
    get(locator) {
      const bytes = objects.get(locator);
      return bytes
        ? {
            body: new Response(new Uint8Array(bytes)).body!,
            size: bytes.byteLength,
          }
        : undefined;
    },
    put(locator, bytes) {
      objects.set(locator, new Uint8Array(bytes));
    },
    delete(locator) {
      objects.delete(locator);
    },
    ...overrides,
  };
  return {
    objects,
    digests,
    port: {
      store,
      delete: async (locator: string) => {
        objects.delete(locator);
        digests.delete(locator);
      },
      digest: (locator: string) => digests.get(locator),
    },
  };
}

function fixture() {
  let now = SESSION_START;
  const clock = { now: () => now };
  const staging = stagingStore();
  const committed = new Map<string, ResolvedAsset>();
  const commit = vi.fn(async (input: Parameters<ProjectAssetImportSessionPorts["commit"]>[0]) => {
    committed.set(input.projectAssetId, asset);
    return asset;
  });
  const ports: ProjectAssetImportSessionPorts = {
    clock,
    newId: () => "00000000-0000-4000-8000-000000000001",
    tokens: createHmacProjectAssetImportSessionTokens({
      secret: "test-import-session-secret",
      now: clock.now,
    }),
    access: {
      canAccessProject: vi.fn(async () => true),
    },
    staging: staging.port,
    uploadUrl: (sessionId) =>
      `https://host.example/api/v1/projects/p/assets/import-sessions/${encodeURIComponent(sessionId)}/content`,
    commit,
    resolveCommitted: vi.fn(async ({ projectAssetId }) =>
      committed.get(projectAssetId) ?? null,
    ),
  };
  return {
    ports,
    staging,
    commit,
    advance: (ms: number) => {
      now += ms;
    },
    session: (overrides: Record<string, unknown> = {}) =>
      createProjectAssetImportSession(
        {
          projectId: "p",
          ownerId: "owner-a",
          body: {
            kind: "video",
            projectAssetId: "asset:1",
            fileName: "clip.mp4",
            byteLength: 4,
            contentType: "video/mp4",
            ...overrides,
          },
        },
        ports,
      ),
  };
}

const claimsOf = async (
  sessionId: string,
  ports: ProjectAssetImportSessionPorts,
) => {
  const claims = await ports.tokens.verify(sessionId);
  if (!claims) throw new Error("expected a verifiable session token");
  return claims;
};

it("creates a signed session and finalizes staged bytes through the commit port", async () => {
  const f = fixture();
  const created = await f.session();
  expect(created.status).toBe(201);
  if (created.status !== 201) return;
  const claims = await claimsOf(created.body.sessionId, f.ports);
  expect(claims).toMatchObject({
    ownerId: "owner-a",
    projectId: "p",
    projectAssetId: "asset:1",
    kind: "video",
    fileName: "clip.mp4",
    byteLength: 4,
    contentType: "video/mp4",
  });
  expect(created.body.upload.url).toContain(
    encodeURIComponent(created.body.sessionId),
  );
  expect(claims.expiresAt).toBe(
    new Date(SESSION_START + PROJECT_ASSET_IMPORT_SESSION_TTL_MS).toISOString(),
  );
  f.staging.objects.set(claims.stagingLocator, utf8ToBytes("data"));
  const get = vi.spyOn(f.ports.staging.store, "get");
  const finalized = await finalizeProjectAssetImportSession(
    { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
    f.ports,
  );
  expect(finalized).toEqual({ status: 201, body: asset });
  expect(f.commit).toHaveBeenCalledOnce();
  expect(f.commit.mock.calls[0]![0]).toMatchObject({
    ownerId: "owner-a",
    projectId: "p",
    projectAssetId: "asset:1",
    kind: "video",
    fileName: "clip.mp4",
    byteLength: 4,
  });
  // Finalize does not read the staged bytes itself: the commit path's
  // openSource is their one read, and it computes the digest.
  expect(get).not.toHaveBeenCalled();
  expect(f.commit.mock.calls[0]![0]).not.toHaveProperty("digest");
  // Staging is transport-private once the Asset is committed.
  expect(f.staging.objects.has(claims.stagingLocator)).toBe(false);
});

it("validates an optional sha256 and decides replay or conflict before an upload URL", async () => {
  const f = fixture();
  const sha = "a".repeat(64);
  const existing = { ...asset, id: "asset:existing" } as ResolvedAsset;
  const inspect = vi.fn(async () => existing);
  f.ports.inspectExistingImport = inspect;
  expect(await f.session({ sha256: sha })).toEqual({
    status: 200,
    body: existing,
    replayed: true,
  });
  expect(inspect).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "p",
      ownerId: "owner-a",
      projectAssetId: "asset:1",
      sha256: sha,
    }),
  );

  f.ports.inspectExistingImport = vi.fn(async () => {
    throw Object.assign(new Error("different bytes"), {
      code: "PROJECT_ASSET_ID_COLLISION",
      projectAssetId: "asset:1",
    });
  });
  expect(await f.session({ sha256: "b".repeat(64) })).toMatchObject({
    status: 409,
    body: { code: "PROJECT_ASSET_ID_COLLISION", projectAssetId: "asset:1" },
  });

  for (const invalid of ["A".repeat(64), "a".repeat(63), "not-a-digest", ""])
    expect((await f.session({ sha256: invalid })).status).toBe(400);

  // Older clients send no digest: the session path is unchanged.
  const noDigest = await f.session();
  expect(noDigest.status).toBe(201);
});

it("maps only the three known create-time conflicts to 409 and rethrows other errors", async () => {
  const f = fixture();
  const sha = "a".repeat(64);
  const conflicts = [
    {
      code: PROJECT_ASSET_DUPLICATE_CONTENT,
      projectAssetId: "asset:1",
      existingProjectAssetIds: ["asset:existing"],
    },
    {
      code: PROJECT_ASSET_ID_COLLISION,
      projectAssetId: "asset:1",
    },
    {
      code: PROJECT_ASSET_TRASHED,
      projectAssetId: "asset:1",
    },
  ] as const;
  for (const conflict of conflicts) {
    const message = `${conflict.code} decided before upload`;
    f.ports.inspectExistingImport = vi.fn(async () => {
      throw Object.assign(new Error(message), conflict);
    });
    expect(await f.session({ sha256: sha })).toEqual({
      status: 409,
      body: { error: message, ...conflict },
    });
  }

  // Errno/SQLite/local-resource failures are not conflicts: the adapter's own
  // route must map them instead of receiving a fabricated 409.
  for (const code of ["ENOENT", "EACCES", "SQLITE_BUSY"]) {
    const failure = Object.assign(new Error(`${code}: transport failure`), {
      code,
    });
    f.ports.inspectExistingImport = vi.fn(async () => {
      throw failure;
    });
    await expect(f.session({ sha256: sha })).rejects.toBe(failure);
  }
});

it("stores the declared digest and rejects a mismatched assembly, deleting staging", async () => {
  const f = fixture();
  const sha = "a".repeat(64);
  const created = await f.session({ sha256: sha });
  if (created.status !== 201) throw new Error("session not created");
  const claims = await claimsOf(created.body.sessionId, f.ports);
  expect(claims.sha256).toBe(sha);
  f.staging.objects.set(claims.stagingLocator, utf8ToBytes("data"));
  f.staging.digests.set(claims.stagingLocator, "b".repeat(64));
  const finalized = await finalizeProjectAssetImportSession(
    { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
    f.ports,
  );
  expect(finalized).toMatchObject({
    status: 409,
    body: { code: PROJECT_ASSET_IMPORT_DIGEST_MISMATCH },
  });
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.staging.objects.has(claims.stagingLocator)).toBe(false);
});

it("passes a matching declared digest to the commit path", async () => {
  const f = fixture();
  const sha = "a".repeat(64);
  const created = await f.session({ sha256: sha });
  if (created.status !== 201) throw new Error("session not created");
  const claims = await claimsOf(created.body.sessionId, f.ports);
  f.staging.objects.set(claims.stagingLocator, utf8ToBytes("data"));
  f.staging.digests.set(claims.stagingLocator, sha);
  await finalizeProjectAssetImportSession(
    { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
    f.ports,
  );
  expect(f.commit.mock.calls[0]![0]).toMatchObject({ sha256: sha });
});

it("rejects an expired session token", async () => {
  const f = fixture();
  const created = await f.session();
  if (created.status !== 201) throw new Error("session not created");
  f.staging.objects.set(
    (await claimsOf(created.body.sessionId, f.ports)).stagingLocator,
    utf8ToBytes("data"),
  );
  f.advance(PROJECT_ASSET_IMPORT_SESSION_TTL_MS + 1);
  expect(
    await finalizeProjectAssetImportSession(
      { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
      f.ports,
    ),
  ).toMatchObject({ status: 403 });
  expect(f.commit).not.toHaveBeenCalled();
});

it("rejects a forged session token", async () => {
  const f = fixture();
  const created = await f.session();
  if (created.status !== 201) throw new Error("session not created");
  const forged =
    created.body.sessionId.slice(0, -1) +
    (created.body.sessionId.endsWith("0") ? "1" : "0");
  expect(
    await finalizeProjectAssetImportSession(
      { projectId: "p", sessionId: forged, ownerId: "owner-a" },
      f.ports,
    ),
  ).toMatchObject({ status: 403 });
  // A payload edit without re-signing is forged too.
  const [payload, signature] = created.body.sessionId.split(".") as [
    string,
    string,
  ];
  const tampered = `${payload[0] === "7" ? "8" : "7"}${payload.slice(1)}.${signature}`;
  expect(
    await finalizeProjectAssetImportSession(
      { projectId: "p", sessionId: tampered, ownerId: "owner-a" },
      f.ports,
    ),
  ).toMatchObject({ status: 403 });
  expect(f.commit).not.toHaveBeenCalled();
});

it("rejects a finalize by a different owner or for a different Project", async () => {
  const f = fixture();
  const created = await f.session();
  if (created.status !== 201) throw new Error("session not created");
  f.staging.objects.set(
    (await claimsOf(created.body.sessionId, f.ports)).stagingLocator,
    utf8ToBytes("data"),
  );
  expect(
    await finalizeProjectAssetImportSession(
      { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-b" },
      f.ports,
    ),
  ).toMatchObject({ status: 403 });
  expect(
    await finalizeProjectAssetImportSession(
      {
        projectId: "other",
        sessionId: created.body.sessionId,
        ownerId: "owner-a",
      },
      f.ports,
    ),
  ).toMatchObject({ status: 403 });
  expect(f.commit).not.toHaveBeenCalled();
});

it("rejects a staged size mismatch and deletes staging immediately", async () => {
  const f = fixture();
  const created = await f.session();
  if (created.status !== 201) throw new Error("session not created");
  const claims = await claimsOf(created.body.sessionId, f.ports);
  f.staging.objects.set(claims.stagingLocator, utf8ToBytes("abc"));
  expect(
    await finalizeProjectAssetImportSession(
      { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
      f.ports,
    ),
  ).toEqual({
    status: 409,
    body: {
      error: "Import session byte length does not match",
      code: "PROJECT_ASSET_IMPORT_SIZE_MISMATCH",
    },
  });
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.staging.objects.has(claims.stagingLocator)).toBe(false);
});

it("returns the committed Asset for an idempotent finalize retry", async () => {
  const f = fixture();
  const created = await f.session();
  if (created.status !== 201) throw new Error("session not created");
  f.staging.objects.set(
    (await claimsOf(created.body.sessionId, f.ports)).stagingLocator,
    utf8ToBytes("data"),
  );
  const first = await finalizeProjectAssetImportSession(
    { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
    f.ports,
  );
  const again = await finalizeProjectAssetImportSession(
    { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
    f.ports,
  );
  expect(again).toEqual(first);
  expect(f.commit).toHaveBeenCalledOnce();
  expect(f.ports.resolveCommitted).toHaveBeenCalledOnce();
});

it("keeps the 201 when post-commit staging cleanup fails and leaves it for the sweep", async () => {
  const f = fixture();
  const created = await f.session();
  if (created.status !== 201) throw new Error("session not created");
  const claims = await claimsOf(created.body.sessionId, f.ports);
  f.staging.objects.set(claims.stagingLocator, utf8ToBytes("data"));

  const cleanupFailure = new Error("staging volume unavailable");
  const onCleanupFailure = vi.fn();
  let deleteAttempts = 0;
  f.ports.staging = {
    ...f.ports.staging,
    // The post-commit delete fails; the sweep's retry succeeds.
    delete: async (locator) => {
      deleteAttempts += 1;
      if (deleteAttempts === 1) throw cleanupFailure;
      f.staging.objects.delete(locator);
    },
    onCleanupFailure,
  };

  const finalized = await finalizeProjectAssetImportSession(
    { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
    f.ports,
  );
  expect(finalized).toEqual({ status: 201, body: asset });
  expect(onCleanupFailure).toHaveBeenCalledOnce();
  const [locator, error] = onCleanupFailure.mock.calls[0]!;
  expect(locator).toBe(claims.stagingLocator);
  expect(error).toMatchObject({
    code: PROJECT_ASSET_IMPORT_STAGING_CLEANUP_FAILED,
    locator: claims.stagingLocator,
    message: expect.stringContaining("staging volume unavailable"),
  });
  // The object is still listed, so the sweep can retry it.
  expect(f.staging.objects.has(claims.stagingLocator)).toBe(true);

  const swept = await sweepProjectAssetImportStaging({
    now: SESSION_START + 2 * PROJECT_ASSET_IMPORT_SESSION_TTL_MS + 1,
    list: () => [{ locator: claims.stagingLocator, createdAt: SESSION_START }],
    delete: (entryLocator) => f.ports.staging.delete(entryLocator),
  });
  expect(swept).toEqual({ scanned: 1, deleted: 1, failed: [] });
  expect(f.staging.objects.has(claims.stagingLocator)).toBe(false);
});

it("sweeps staging older than the default cutoff and keeps young entries", async () => {
  const now = SESSION_START + 10 * PROJECT_ASSET_IMPORT_SESSION_TTL_MS;
  const deleted: string[] = [];
  const result = await sweepProjectAssetImportStaging({
    now,
    list: () => [
      { locator: "old", createdAt: now - 2 * PROJECT_ASSET_IMPORT_SESSION_TTL_MS - 1 },
      { locator: "young", createdAt: now - PROJECT_ASSET_IMPORT_SESSION_TTL_MS },
    ],
    delete: async (locator) => {
      deleted.push(locator);
    },
  });
  expect(result).toEqual({ scanned: 2, deleted: 1, failed: [] });
  expect(deleted).toEqual(["old"]);
});

it("reports one failed delete and continues sweeping the rest", async () => {
  const now = SESSION_START + 10 * PROJECT_ASSET_IMPORT_SESSION_TTL_MS;
  const deleted: string[] = [];
  const result = await sweepProjectAssetImportStaging(
    {
      now,
      list: () => [
        { locator: "bad", createdAt: now - 3 * PROJECT_ASSET_IMPORT_SESSION_TTL_MS },
        { locator: "good", createdAt: now - 3 * PROJECT_ASSET_IMPORT_SESSION_TTL_MS },
      ],
      delete: async (locator) => {
        if (locator === "bad") throw new Error("permission denied");
        deleted.push(locator);
      },
    },
    { olderThanMs: 2 * PROJECT_ASSET_IMPORT_SESSION_TTL_MS },
  );
  expect(result).toEqual({
    scanned: 2,
    deleted: 1,
    failed: [{ locator: "bad", message: "permission denied" }],
  });
  expect(deleted).toEqual(["good"]);
});

it("serves the multipart protocol on the signed upload URL", async () => {
  const f = fixture();
  const inner = createInMemoryAssetDeliveryStore();
  const store: AssetDeliveryStore = {
    ...inner,
    delete(locator) {
      inner.objects.delete(locator);
    },
  };
  const ports: ProjectAssetImportSessionPorts = {
    ...f.ports,
    staging: {
      store,
      delete: async (locator) => {
        inner.objects.delete(locator);
      },
    },
  };
  const created = await createProjectAssetImportSession(
    {
      projectId: "p",
      ownerId: "owner-a",
      body: {
        kind: "video",
        projectAssetId: "asset:2",
        fileName: "clip.mp4",
        byteLength: 4,
        contentType: "video/mp4",
      },
    },
    ports,
  );
  if (created.status !== 201) throw new Error("session not created");
  const uploadId = "unit-session-0001";
  const upload = (query: string, body?: Uint8Array) =>
    handleProjectAssetImportSessionContent(
      new Request(`${created.body.upload.url}?upload=${query}&uploadId=${uploadId}`, {
        method: "PUT",
        ...(body ? { body } : {}),
      }),
      { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
      ports,
    );
  expect((await upload("begin")).status).toBe(200);
  expect((await upload("part&partNumber=1", utf8ToBytes("data"))).status).toBe(
    204,
  );
  expect((await upload("complete")).status).toBe(204);
  expect(
    await finalizeProjectAssetImportSession(
      { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
      ports,
    ),
  ).toEqual({ status: 201, body: asset });
});

it("returns the existing Asset as an explicit replay from the commit port", async () => {
  const f = fixture();
  const created = await f.session();
  if (created.status !== 201) throw new Error("session not created");
  const claims = await claimsOf(created.body.sessionId, f.ports);
  f.staging.objects.set(claims.stagingLocator, utf8ToBytes("data"));
  f.commit.mockResolvedValueOnce({ replayed: asset });

  const result = await finalizeProjectAssetImportSession(
    { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
    f.ports,
  );

  expect(result).toEqual({ status: 200, body: asset, replayed: true });
  expect(f.staging.objects.has(claims.stagingLocator)).toBe(false);
});

it("deletes staging when commit fails so a failed finalize leaves no object", async () => {
  const f = fixture();
  const created = await f.session();
  if (created.status !== 201) throw new Error("session not created");
  const claims = await claimsOf(created.body.sessionId, f.ports);
  f.staging.objects.set(claims.stagingLocator, utf8ToBytes("data"));
  f.commit.mockRejectedValueOnce(new Error("probe failed"));

  await expect(
    finalizeProjectAssetImportSession(
      { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
      f.ports,
    ),
  ).rejects.toThrow("probe failed");
  expect(f.staging.objects.has(claims.stagingLocator)).toBe(false);
});

it("logs PROJECT_ASSET_IMPORT_STAGING_CLEANUP_FAILED when a failed finalize cannot delete staging", async () => {
  const f = fixture();
  const created = await f.session();
  if (created.status !== 201) throw new Error("session not created");
  const claims = await claimsOf(created.body.sessionId, f.ports);
  f.staging.objects.set(claims.stagingLocator, utf8ToBytes("data"));
  f.commit.mockRejectedValueOnce(new Error("commit failed"));
  const onCleanupFailure = vi.fn();
  f.ports.staging = {
    ...f.ports.staging,
    delete: async () => {
      throw new Error("staging volume unavailable");
    },
    onCleanupFailure,
  };

  await expect(
    finalizeProjectAssetImportSession(
      { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
      f.ports,
    ),
  ).rejects.toThrow("commit failed");
  expect(onCleanupFailure).toHaveBeenCalledOnce();
  expect(onCleanupFailure.mock.calls[0]![1]).toMatchObject({
    code: PROJECT_ASSET_IMPORT_STAGING_CLEANUP_FAILED,
    locator: claims.stagingLocator,
    message: expect.stringContaining("staging volume unavailable"),
  });
  // The object is still listed, so the sweep retries it.
  expect(f.staging.objects.has(claims.stagingLocator)).toBe(true);
});

it("maps a mid-assembly failure to a coded PROJECT_ASSET_IMPORT_ASSEMBLY_FAILED response", async () => {
  const f = fixture();
  const cause = Object.assign(new Error("no space left on device"), {
    code: "ENOSPC",
  });
  const failure = new MultipartAssemblyError(
    "Multipart object assembly failed (ENOSPC): no space left on device",
    { cause },
  );
  const inner = createInMemoryAssetDeliveryStore();
  const store: AssetDeliveryStore = {
    ...inner,
    multipart: {
      ...inner.multipart!,
      async complete() {
        throw failure;
      },
    },
  };
  const ports: ProjectAssetImportSessionPorts = {
    ...f.ports,
    staging: {
      store,
      delete: async (locator) => {
        inner.objects.delete(locator);
      },
    },
  };
  const created = await createProjectAssetImportSession(
    {
      projectId: "p",
      ownerId: "owner-a",
      body: {
        kind: "video",
        projectAssetId: "asset:assembly",
        fileName: "clip.mp4",
        byteLength: 4,
        contentType: "video/mp4",
      },
    },
    ports,
  );
  if (created.status !== 201) throw new Error("session not created");

  const response = await handleProjectAssetImportSessionContent(
    new Request(
      `${created.body.upload.url}?upload=complete&uploadId=assembly-failure-0001`,
      { method: "PUT" },
    ),
    { projectId: "p", sessionId: created.body.sessionId, ownerId: "owner-a" },
    ports,
  );

  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toEqual({
    error: failure.message,
    code: PROJECT_ASSET_IMPORT_ASSEMBLY_FAILED,
    cause: "ENOSPC",
  });
});
