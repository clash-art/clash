import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Asset } from "@clash/shared-types";

import {
  createLocalAssetInspectionService,
  type LocalAssetInspector,
} from "./local-asset-inspections.js";
import { assetPathForWrite } from "./local-asset-paths.js";
import { createLocalGlobalAssetService } from "./local-global-assets.js";
import { createLocalMetadataStore } from "./local-metadata-store.js";
import {
  createLocalResourceStore,
  resourceIdForSha256,
} from "./local-resource-store.js";

const temporaryDirectories: string[] = [];
const nodeRequire = createRequire(import.meta.url);

function downgradeResourceToPrePromotionRow(
  dataDir: string,
  resourceId: string,
): void {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const database = new DatabaseSync(join(dataDir, "local.sqlite"));
  try {
    database
      .prepare(
        `UPDATE local_resources
         SET content_type = NULL, facts_verified = 0
         WHERE resource_id = ?`,
      )
      .run(resourceId);
  } finally {
    database.close();
  }
}

const inspectFixtureAsset: LocalAssetInspector = async ({ resource }) =>
  resource.kind === "image"
    ? {
        width: 1,
        height: 1,
        rotationDegrees: 0,
        ...(resource.contentType ? { contentType: resource.contentType } : {}),
      }
    : resource.kind === "video"
      ? {
          width: 1,
          height: 1,
          rotationDegrees: 0,
          durationMs: 1_000,
          frameRate: 24,
          videoCodec: "h264",
          hasAudio: false,
          ...(resource.contentType
            ? { contentType: resource.contentType }
            : {}),
        }
      : resource.kind === "audio"
        ? {
            durationMs: 2_000,
            hasAudio: true,
            audioCodec: "aac",
            sampleRate: 48_000,
            channelCount: 2,
            channelLayout: "stereo",
            ...(resource.contentType
              ? { contentType: resource.contentType }
              : {}),
          }
        : resource.contentType
          ? { contentType: resource.contentType }
          : {};

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-global-assets-"));
  temporaryDirectories.push(dataDir);
  const service = createLocalGlobalAssetService({
    dataDir,
    projectionOrigin: "http://127.0.0.1:49152",
    assetInspection: createLocalAssetInspectionService({
      dataDir,
      inspectResource: inspectFixtureAsset,
    }),
  });
  return { dataDir, service };
}

async function seedLegacyPersonalGlobalAsset(input: {
  dataDir: string;
  asset: Asset;
  bytes: Uint8Array;
}): Promise<void> {
  const path = await assetPathForWrite(input.dataDir, input.asset.srcR2Key);
  await writeFile(path, input.bytes);
  const metadata = createLocalMetadataStore(input.dataDir);
  const state = await metadata.load();
  state.assets = [...state.assets, input.asset];
  state.libraryAssetRefs = [
    ...(state.libraryAssetRefs ?? []),
    { assetId: input.asset.id, userId: input.asset.userId, addedAt: 1 },
  ];
  await metadata.save(state, { replaceLegacyAssetMigrationInput: true });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local Global Asset library", () => {
  it("promotes current v4 media facts for a pre-v4 Resource without a MIME before Global publication", async () => {
    const { dataDir } = await fixture();
    const resources = createLocalResourceStore({ dataDir });
    const bytes = new TextEncoder().encode("legacy global PNG without MIME");
    const legacy = await resources.install({ kind: "image", bytes });
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => ({
        contentType: "image/png",
        width: 320,
        height: 180,
        rotationDegrees: 0,
      }),
    });
    await assetInspection.inspect({ source: legacy });
    const service = createLocalGlobalAssetService({
      dataDir,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection,
    });

    await expect(
      service.importBytes({
        libraryId: "team:no-mime",
        globalAssetId: "global:legacy-no-mime",
        kind: "image",
        bytes,
        contentType: "image/png",
        metadata: {},
      }),
    ).resolves.toMatchObject({
      id: "global:legacy-no-mime",
      status: "ready",
      metadata: { contentType: "image/png", width: 320, height: 180 },
    });
  });

  it("repairs the old v4-receipt/no-MIME migration state before resolving an existing Global entry", async () => {
    const { dataDir, service } = await fixture();
    const published = await service.importBytes({
      libraryId: "team:old-v4-no-mime",
      globalAssetId: "global:old-v4-no-mime",
      kind: "image",
      bytes: new TextEncoder().encode("published Global PNG"),
      contentType: "image/png",
      metadata: {},
    });
    const entry = await service.readEntry("team:old-v4-no-mime", published.id);
    expect(entry).not.toBeNull();
    downgradeResourceToPrePromotionRow(dataDir, entry!.resourceId);
    const restarted = createLocalGlobalAssetService({
      dataDir,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        inspectResource: async () => {
          throw new Error("the persisted current-v4 receipt must be reused");
        },
      }),
    });

    await expect(
      restarted.read("team:old-v4-no-mime", "global:old-v4-no-mime"),
    ).resolves.toMatchObject({
      status: "ready",
      metadata: { contentType: "image/png" },
    });
    await expect(
      createLocalResourceStore({ dataDir }).resolve(entry!.resourceId),
    ).resolves.toMatchObject({
      resource: { contentType: "image/png" },
    });
  });

  it("materializes legacy personal-library membership through verified canonical Global entries", async () => {
    const { dataDir, service } = await fixture();
    const bytes = new TextEncoder().encode("legacy personal image bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await seedLegacyPersonalGlobalAsset({
      dataDir,
      bytes,
      asset: {
        id: "legacy-personal-image",
        userId: "local-user",
        kind: "image",
        srcR2Key: "uploads/legacy-personal.png",
        coverR2Key: null,
        metadata: {
          bytes: bytes.byteLength,
          contentHash: digest,
          contentType: "image/png",
          originalName: "legacy-personal.png",
        },
        sourceModel: null,
        sourcePrompt: null,
        sourceTaskId: null,
        sources: null,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await expect(service.list("personal")).resolves.toMatchObject([
      {
        id: "legacy-personal-image",
        kind: "image",
        lifecycle: { state: "active" },
        status: "ready",
        metadata: {
          bytes: bytes.byteLength,
          contentType: "image/png",
          width: 1,
          height: 1,
          rotationDegrees: 0,
          originalName: "legacy-personal.png",
        },
      },
    ]);
    await expect(
      createLocalMetadataStore(dataDir).readGlobalAsset(
        "personal",
        "legacy-personal-image",
      ),
    ).resolves.toMatchObject({
      id: "legacy-personal-image",
      resourceId: resourceIdForSha256(digest),
    });
  });

  it("leaves no partial Global entries or completed migration when one legacy member has no bytes", async () => {
    const { dataDir, service } = await fixture();
    const validBytes = new TextEncoder().encode("valid legacy image bytes");
    const validDigest = createHash("sha256").update(validBytes).digest("hex");
    await seedLegacyPersonalGlobalAsset({
      dataDir,
      bytes: validBytes,
      asset: {
        id: "legacy-a-valid-image",
        userId: "local-user",
        kind: "image",
        srcR2Key: "uploads/legacy-valid.png",
        coverR2Key: null,
        metadata: {
          bytes: validBytes.byteLength,
          contentHash: validDigest,
          contentType: "image/png",
        },
        sourceModel: null,
        sourcePrompt: null,
        sourceTaskId: null,
        sources: null,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const missingBytes = new TextEncoder().encode("missing legacy image bytes");
    const missingDigest = createHash("sha256")
      .update(missingBytes)
      .digest("hex");
    const metadata = createLocalMetadataStore(dataDir);
    const state = await metadata.load();
    state.assets.push({
      id: "legacy-z-missing-image",
      userId: "local-user",
      kind: "image",
      srcR2Key: "uploads/legacy-missing.png",
      coverR2Key: null,
      metadata: {
        bytes: missingBytes.byteLength,
        contentHash: missingDigest,
        contentType: "image/png",
      },
      sourceModel: null,
      sourcePrompt: null,
      sourceTaskId: null,
      sources: null,
      createdAt: 1,
      updatedAt: 1,
    });
    state.libraryAssetRefs = [
      ...(state.libraryAssetRefs ?? []),
      {
        assetId: "legacy-z-missing-image",
        userId: "local-user",
        addedAt: 2,
      },
    ];
    await metadata.save(state, { replaceLegacyAssetMigrationInput: true });

    await expect(service.list("personal")).rejects.toMatchObject({
      code: "GLOBAL_ASSET_UNAVAILABLE",
    });
    await expect(
      metadata.readGlobalAsset("personal", "legacy-a-valid-image"),
    ).resolves.toBeNull();

    const missingPath = await assetPathForWrite(
      dataDir,
      "uploads/legacy-missing.png",
    );
    await writeFile(missingPath, missingBytes);
    const migrated = await service.list("personal");
    expect(migrated.map((asset) => asset.id).sort()).toEqual([
      "legacy-a-valid-image",
      "legacy-z-missing-image",
    ]);
  });

  it("does not rescan legacy personal membership after the one-way migration completes", async () => {
    const { dataDir, service } = await fixture();
    const bytes = new TextEncoder().encode("one-time legacy member");
    await seedLegacyPersonalGlobalAsset({
      dataDir,
      bytes,
      asset: {
        id: "legacy-before-cutover",
        userId: "local-user",
        kind: "image",
        srcR2Key: "uploads/legacy-before-cutover.png",
        coverR2Key: null,
        metadata: {
          bytes: bytes.byteLength,
          contentHash: createHash("sha256").update(bytes).digest("hex"),
          contentType: "image/png",
        },
        sourceModel: null,
        sourcePrompt: null,
        sourceTaskId: null,
        sources: null,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await expect(service.list("personal")).resolves.toHaveLength(1);

    const metadata = createLocalMetadataStore(dataDir);
    const state = await metadata.load();
    state.assets.push({
      id: "legacy-after-cutover",
      userId: "local-user",
      kind: "image",
      srcR2Key: "uploads/legacy-after-cutover-missing.png",
      coverR2Key: null,
      metadata: { contentType: "image/png" },
      sourceModel: null,
      sourcePrompt: null,
      sourceTaskId: null,
      sources: null,
      createdAt: 2,
      updatedAt: 2,
    });
    state.libraryAssetRefs = [
      ...(state.libraryAssetRefs ?? []),
      {
        assetId: "legacy-after-cutover",
        userId: "local-user",
        addedAt: 2,
      },
    ];
    await metadata.save(state, { replaceLegacyAssetMigrationInput: true });

    const canonical = await service.list("personal");
    expect(canonical.map((asset) => asset.id)).toEqual([
      "legacy-before-cutover",
    ]);
  });

  it("materializes a legacy identity before rejecting a conflicting personal import", async () => {
    const { dataDir, service } = await fixture();
    const legacyBytes = new TextEncoder().encode("legacy identity winner");
    const legacyDigest = createHash("sha256").update(legacyBytes).digest("hex");
    await seedLegacyPersonalGlobalAsset({
      dataDir,
      bytes: legacyBytes,
      asset: {
        id: "legacy-import-collision",
        userId: "local-user",
        kind: "image",
        srcR2Key: "uploads/legacy-import-collision.png",
        coverR2Key: null,
        metadata: {
          bytes: legacyBytes.byteLength,
          contentHash: legacyDigest,
          contentType: "image/png",
        },
        sourceModel: null,
        sourcePrompt: null,
        sourceTaskId: null,
        sources: null,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await expect(
      service.importBytes({
        libraryId: "personal",
        globalAssetId: "legacy-import-collision",
        kind: "image",
        bytes: new TextEncoder().encode("different new import bytes"),
        contentType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "GLOBAL_ASSET_FACT_MISMATCH" });
    await expect(
      service.readEntry("personal", "legacy-import-collision"),
    ).resolves.toMatchObject({
      resourceId: resourceIdForSha256(legacyDigest),
    });
  });

  it("materializes a legacy personal member on direct canonical read", async () => {
    const { dataDir, service } = await fixture();
    const bytes = new TextEncoder().encode("directly read legacy image");
    await seedLegacyPersonalGlobalAsset({
      dataDir,
      bytes,
      asset: {
        id: "legacy-direct-read",
        userId: "local-user",
        kind: "image",
        srcR2Key: "uploads/legacy-direct-read.png",
        coverR2Key: null,
        metadata: {
          bytes: bytes.byteLength,
          contentHash: createHash("sha256").update(bytes).digest("hex"),
          contentType: "image/png",
        },
        sourceModel: null,
        sourcePrompt: null,
        sourceTaskId: null,
        sources: null,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await expect(
      service.read("personal", "legacy-direct-read"),
    ).resolves.toMatchObject({
      id: "legacy-direct-read",
      lifecycle: { state: "active" },
      status: "ready",
    });
  });

  it("does not admit another legacy user's library membership into the personal library", async () => {
    const { dataDir, service } = await fixture();
    const bytes = new TextEncoder().encode("another user's legacy image");
    await seedLegacyPersonalGlobalAsset({
      dataDir,
      bytes,
      asset: {
        id: "legacy-other-user",
        userId: "other-user",
        kind: "image",
        srcR2Key: "uploads/legacy-other-user.png",
        coverR2Key: null,
        metadata: {
          bytes: bytes.byteLength,
          contentHash: createHash("sha256").update(bytes).digest("hex"),
          contentType: "image/png",
        },
        sourceModel: null,
        sourcePrompt: null,
        sourceTaskId: null,
        sources: null,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await expect(service.list("personal")).resolves.toEqual([]);
    await expect(
      createLocalMetadataStore(dataDir).readGlobalAsset(
        "personal",
        "legacy-other-user",
      ),
    ).resolves.toBeNull();
  });

  it("does not admit a legacy membership whose Asset belongs to another user", async () => {
    const { dataDir, service } = await fixture();
    const bytes = new TextEncoder().encode("foreign-owned legacy image");
    await seedLegacyPersonalGlobalAsset({
      dataDir,
      bytes,
      asset: {
        id: "legacy-foreign-owner",
        userId: "other-user",
        kind: "image",
        srcR2Key: "uploads/legacy-foreign-owner.png",
        coverR2Key: null,
        metadata: {
          bytes: bytes.byteLength,
          contentHash: createHash("sha256").update(bytes).digest("hex"),
          contentType: "image/png",
        },
        sourceModel: null,
        sourcePrompt: null,
        sourceTaskId: null,
        sources: null,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const metadata = createLocalMetadataStore(dataDir);
    const state = await metadata.load();
    state.libraryAssetRefs = state.libraryAssetRefs?.map((reference) => ({
      ...reference,
      userId: "local-user",
    }));
    await metadata.save(state, { replaceLegacyAssetMigrationInput: true });

    await expect(service.list("personal")).resolves.toEqual([]);
  });

  it("refuses a new Global Asset publication when no Host byte inspector is configured", async () => {
    const { dataDir } = await fixture();
    const service = createLocalGlobalAssetService({
      dataDir,
      projectionOrigin: "http://127.0.0.1:49152",
    });

    await expect(
      service.importBytes({
        libraryId: "personal",
        globalAssetId: "global:no-inspector",
        kind: "image",
        bytes: new TextEncoder().encode("unverified Global bytes"),
        contentType: "image/png",
        metadata: { width: 640, height: 360 },
      }),
    ).rejects.toThrow();
    await expect(
      service.readEntry("personal", "global:no-inspector"),
    ).resolves.toBeNull();
  });

  it("publishes Host facts instead of conflicting Global caller hints", async () => {
    const { dataDir } = await fixture();
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async ({ resource }) => ({
        contentType: resource.contentType,
        durationMs: 1_250,
        hasAudio: true,
        audioCodec: "aac",
        sampleRate: 48_000,
        channelCount: 2,
        channelLayout: "stereo",
      }),
    });
    const service = createLocalGlobalAssetService({
      dataDir,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection,
    });

    await service.importBytes({
      libraryId: "personal",
      globalAssetId: "global:host-facts-win",
      kind: "audio",
      bytes: new TextEncoder().encode("audio bytes verified by the Host"),
      contentType: "audio/mp4",
      metadata: {
        width: 999,
        durationMs: 9_999,
        hasAudio: false,
        audioCodec: "caller-codec",
      },
    });

    const entry = await service.readEntry("personal", "global:host-facts-win");
    expect(entry?.metadata).toMatchObject({
      durationMs: 1_250,
      hasAudio: true,
      audioCodec: "aac",
    });
    expect(entry?.metadata).not.toHaveProperty("width");
  });

  it("publishes canonical v4 content type when reopening a sealed legacy alias", async () => {
    const { dataDir } = await fixture();
    const resources = createLocalResourceStore({ dataDir });
    const source = await resources.install({
      kind: "image",
      bytes: new TextEncoder().encode("legacy Global JPEG alias"),
      contentType: "image/jpg",
    });
    const service = createLocalGlobalAssetService({
      dataDir,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        inspectResource: async () => ({
          contentType: "image/jpeg",
          width: 640,
          height: 360,
          rotationDegrees: 0,
        }),
      }),
    });

    await service.publishResource({
      libraryId: "personal",
      globalAssetId: "global:legacy-jpeg-alias",
      resourceId: source.resource.id,
      kind: "image",
      metadata: { contentType: "image/jpg" },
    });

    await expect(
      service.readEntry("personal", "global:legacy-jpeg-alias"),
    ).resolves.toMatchObject({
      metadata: { contentType: "image/jpeg" },
    });
  });

  it("rejects a frozen media-type assertion when the same Global bytes are already sealed under another type", async () => {
    const { service } = await fixture();
    const bytes = new TextEncoder().encode("one immutable Global image");

    await service.importBytes({
      libraryId: "personal",
      globalAssetId: "global:sealed-png",
      kind: "image",
      bytes,
      contentType: "image/png",
      provenance: { kind: "import" },
    });

    await expect(
      service.importBytes({
        libraryId: "personal",
        globalAssetId: "global:conflicting-jpeg",
        kind: "image",
        bytes,
        contentType: "image/jpeg",
        provenance: { kind: "import" },
      }),
    ).rejects.toThrow("image/jpeg");
    await expect(
      service.readEntry("personal", "global:conflicting-jpeg"),
    ).resolves.toBeNull();
  });

  it("accepts a canonical media-type alias when reusing sealed Global bytes", async () => {
    const { service } = await fixture();
    const bytes = new TextEncoder().encode("one aliased Global JPEG");

    await service.importBytes({
      libraryId: "personal",
      globalAssetId: "global:canonical-jpeg",
      kind: "image",
      bytes,
      contentType: "image/jpeg",
      provenance: { kind: "import" },
    });

    await expect(
      service.importBytes({
        libraryId: "personal",
        globalAssetId: "global:aliased-jpeg",
        kind: "image",
        bytes,
        contentType: "image/jpg",
        provenance: { kind: "import" },
      }),
    ).resolves.toMatchObject({
      id: "global:aliased-jpeg",
      metadata: { contentType: "image/jpeg" },
    });
  });

  it("keeps non-frozen Global media hints subordinate to Host facts on sealed-byte reuse", async () => {
    const { service } = await fixture();
    const bytes = new TextEncoder().encode("one Global image with stale hints");

    await service.importBytes({
      libraryId: "personal",
      globalAssetId: "global:sealed-hints-source",
      kind: "image",
      bytes,
      contentType: "image/png",
      provenance: { kind: "import" },
    });

    await expect(
      service.importBytes({
        libraryId: "personal",
        globalAssetId: "global:sealed-hints-reuse",
        kind: "image",
        bytes,
        metadata: { width: 999, height: 999 },
        provenance: { kind: "import" },
      }),
    ).resolves.toMatchObject({
      id: "global:sealed-hints-reuse",
      metadata: {
        contentType: "image/png",
        width: 1,
        height: 1,
      },
    });
  });

  it("stores Host-inspected media facts in the Global authority before returning an import", async () => {
    const { dataDir } = await fixture();
    const bytes = new TextEncoder().encode("Host-inspected Global video");
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async ({ resource }) => ({
        width: 1_920,
        height: 1_080,
        rotationDegrees: 0,
        durationMs: 2_500,
        frameRate: 24,
        videoCodec: "h264",
        hasAudio: true,
        audioCodec: "aac",
        sampleRate: 48_000,
        channelCount: 2,
        channelLayout: "stereo",
        contentType: resource.contentType,
      }),
    });
    const service = createLocalGlobalAssetService({
      dataDir,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection,
    });

    await service.importBytes({
      libraryId: "personal",
      globalAssetId: "global:inspected-video",
      kind: "video",
      bytes,
      contentType: "video/mp4",
      originalName: "clip.mp4",
      metadata: {},
      provenance: { kind: "import" },
    });

    await expect(
      service.readEntry("personal", "global:inspected-video"),
    ).resolves.toMatchObject({
      metadata: {
        width: 1_920,
        height: 1_080,
        durationMs: 2_500,
        frameRate: 24,
        videoCodec: "h264",
        audioCodec: "aac",
        bytes: bytes.byteLength,
        contentType: "video/mp4",
        originalName: "clip.mp4",
      },
    });
  });

  it("does not publish caller waveform samples as canonical Global metadata", async () => {
    const { dataDir } = await fixture();
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async ({ resource }) => ({
        durationMs: 1_000,
        contentType: resource.contentType,
        hasAudio: true,
        audioCodec: "aac",
        sampleRate: 48_000,
        channelCount: 2,
        channelLayout: "stereo",
      }),
    });
    const service = createLocalGlobalAssetService({
      dataDir,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection,
    });

    await service.importBytes({
      libraryId: "personal",
      globalAssetId: "global:legacy-waveform",
      kind: "audio",
      bytes: new TextEncoder().encode("audio with client waveform"),
      contentType: "audio/aac",
      metadata: { waveform: [0.1, 0.4, 0.2] },
    });

    const entry = await service.readEntry("personal", "global:legacy-waveform");
    expect(entry?.metadata).toMatchObject({
      durationMs: 1_000,
      hasAudio: true,
      audioCodec: "aac",
    });
    expect(entry?.metadata).not.toHaveProperty("waveform");
  });

  it("reuses one versioned Resource inspection across idempotent Global publication retries", async () => {
    const { dataDir } = await fixture();
    let probes = 0;
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        probes += 1;
        return {
          width: 1_280,
          height: 720,
          rotationDegrees: 0,
          durationMs: 1_500,
          frameRate: 30,
          videoCodec: "h264",
          hasAudio: false,
        };
      },
    });
    const service = createLocalGlobalAssetService({
      dataDir,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection,
    });
    const resources = createLocalResourceStore({ dataDir });
    const installed = await resources.install({
      kind: "video",
      bytes: new TextEncoder().encode("one reusable Global Resource"),
      contentType: "video/mp4",
      originalName: "reusable.mp4",
    });
    const publish = () =>
      service.publishResource({
        libraryId: "personal",
        globalAssetId: "global:publication-retry",
        resourceId: installed.resource.id,
        kind: "video",
        name: "Reusable",
        metadata: {},
        provenance: { kind: "admission" },
      });

    const first = await publish();
    const retried = await publish();

    expect(retried).toEqual(first);
    expect(probes).toBe(1);
    await expect(
      service.readEntry("personal", "global:publication-retry"),
    ).resolves.toMatchObject({
      metadata: {
        width: 1_280,
        height: 720,
        durationMs: 1_500,
        frameRate: 30,
        videoCodec: "h264",
      },
    });
  });

  it("keeps staged CAS bytes but creates no Global entry when Host inspection fails", async () => {
    const { dataDir } = await fixture();
    const bytes = new TextEncoder().encode("temporarily unprobeable video");
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      inspectResource: async () => {
        throw new Error("temporary decoder failure");
      },
    });
    const service = createLocalGlobalAssetService({
      dataDir,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection,
    });

    await expect(
      service.importBytes({
        libraryId: "personal",
        globalAssetId: "global:probe-failure",
        kind: "video",
        bytes,
        contentType: "video/mp4",
      }),
    ).rejects.toMatchObject({
      code: "GLOBAL_ASSET_UNAVAILABLE",
      cause: expect.objectContaining({ message: "temporary decoder failure" }),
    });
    await expect(
      service.readEntry("personal", "global:probe-failure"),
    ).resolves.toBeNull();

    const digest = createHash("sha256").update(bytes).digest("hex");
    const resources = createLocalResourceStore({ dataDir });
    const resource = await resources.resolveStaged(resourceIdForSha256(digest));
    expect(resource).toMatchObject({
      byteLength: bytes.byteLength,
      resourceId: resourceIdForSha256(digest),
    });
    await expect(
      resources.resolve(resourceIdForSha256(digest)),
    ).resolves.toBeUndefined();
  });

  it("keeps library membership and lifecycle independent while deduplicating Resource bytes", async () => {
    const { service } = await fixture();
    const bytes = new TextEncoder().encode("same immutable image");
    const first = await service.importBytes({
      libraryId: "personal",
      globalAssetId: "global:first",
      kind: "image",
      bytes,
      contentType: "image/png",
      originalName: "first.png",
      metadata: { width: 64, height: 32 },
      provenance: { kind: "import" },
    });
    const second = await service.importBytes({
      libraryId: "team",
      globalAssetId: "global:second",
      kind: "image",
      bytes,
      contentType: "image/png",
      originalName: "second.png",
      provenance: { kind: "import" },
    });

    const firstProjection = await service.openProjection("personal", first.id);
    const secondProjection = await service.openProjection("team", second.id);
    expect(firstProjection.resource.id).toBe(secondProjection.resource.id);
    expect(firstProjection.path).toBe(secondProjection.path);

    await service.trash({
      libraryId: "personal",
      globalAssetId: first.id,
      deleteOperationId: "delete:first",
      deletedAt: "2026-08-13T00:00:00.000Z",
      purgeAfter: "2026-08-20T00:00:00.000Z",
    });
    await expect(service.read("personal", first.id)).resolves.toMatchObject({
      id: first.id,
      status: "unavailable",
    });
    await expect(service.read("team", second.id)).resolves.toMatchObject({
      id: second.id,
      status: "ready",
    });
    await expect(service.list("personal")).resolves.toHaveLength(1);
    await expect(service.list("team")).resolves.toHaveLength(1);
  });

  it("rejects a stale restore after another consumer restored and trashed a newer delete operation", async () => {
    const { service } = await fixture();
    const created = await service.importBytes({
      libraryId: "personal",
      globalAssetId: "global:restore-cas",
      kind: "image",
      bytes: new TextEncoder().encode("restore CAS image"),
      contentType: "image/png",
    });
    await service.trash({
      libraryId: "personal",
      globalAssetId: created.id,
      deleteOperationId: "delete:operation-1",
      deletedAt: "2026-08-13T00:00:00.000Z",
      purgeAfter: "2026-08-20T00:00:00.000Z",
    });
    const consumerAObservation = await service.read("personal", created.id);
    expect(consumerAObservation?.lifecycle).toEqual({
      state: "trashed",
      deleteOperationId: "delete:operation-1",
      deletedAt: "2026-08-13T00:00:00.000Z",
      purgeAfter: "2026-08-20T00:00:00.000Z",
    });

    await service.restore({
      libraryId: "personal",
      globalAssetId: created.id,
      deleteOperationId: "delete:operation-1",
    });
    await service.trash({
      libraryId: "personal",
      globalAssetId: created.id,
      deleteOperationId: "delete:operation-2",
      deletedAt: "2026-08-14T00:00:00.000Z",
      purgeAfter: "2026-08-21T00:00:00.000Z",
    });

    await expect(
      service.restore({
        libraryId: "personal",
        globalAssetId: created.id,
        deleteOperationId: "delete:operation-1",
      }),
    ).rejects.toMatchObject({ code: "GLOBAL_ASSET_FACT_MISMATCH" });
    await expect(service.read("personal", created.id)).resolves.toMatchObject({
      lifecycle: {
        state: "trashed",
        deleteOperationId: "delete:operation-2",
      },
    });

    await service.restore({
      libraryId: "personal",
      globalAssetId: created.id,
      deleteOperationId: "delete:operation-2",
    });
    await expect(
      service.restore({
        libraryId: "personal",
        globalAssetId: created.id,
        deleteOperationId: "delete:operation-1",
      }),
    ).rejects.toMatchObject({ code: "GLOBAL_ASSET_FACT_MISMATCH" });
  });

  it("replays the same restore operation after its first result is lost", async () => {
    const { service } = await fixture();
    const created = await service.importBytes({
      libraryId: "personal",
      globalAssetId: "global:restore-retry",
      kind: "image",
      bytes: new TextEncoder().encode("restore retry image"),
      contentType: "image/png",
    });
    await service.trash({
      libraryId: "personal",
      globalAssetId: created.id,
      deleteOperationId: "delete:retry",
      deletedAt: "2026-08-13T00:00:00.000Z",
      purgeAfter: "2026-08-20T00:00:00.000Z",
    });
    const restore = () =>
      service.restore({
        libraryId: "personal",
        globalAssetId: created.id,
        deleteOperationId: "delete:retry",
      });

    await restore();
    await expect(restore()).resolves.toMatchObject({
      id: created.id,
      lifecycle: { state: "active" },
    });
  });

  it("returns one storage-neutral ResolvedAsset shape and persists across Host restarts", async () => {
    const { dataDir, service } = await fixture();
    const bytes = new TextEncoder().encode("audio bytes");
    await service.importBytes({
      libraryId: "library-a",
      globalAssetId: "global:audio",
      kind: "audio",
      bytes,
      contentType: "audio/mpeg",
      originalName: "voice.mp3",
      metadata: { durationMs: 2_000 },
    });

    const restarted = createLocalGlobalAssetService({
      dataDir,
      projectionOrigin: "http://127.0.0.1:49152",
    });
    const resolved = await restarted.read("library-a", "global:audio");
    expect(resolved).toEqual({
      id: "global:audio",
      kind: "audio",
      name: "voice.mp3",
      metadata: {
        durationMs: 2_000,
        hasAudio: true,
        audioCodec: "aac",
        sampleRate: 48_000,
        channelCount: 2,
        channelLayout: "stereo",
        bytes: bytes.byteLength,
        contentType: "audio/mpeg",
        originalName: "voice.mp3",
      },
      lifecycle: { state: "active" },
      status: "ready",
      url: "http://127.0.0.1:49152/api/v1/libraries/library-a/assets/global%3Aaudio/media",
    });
    expect(JSON.stringify(resolved)).not.toMatch(
      /resourceId|storageKey|signedUrl|srcR2Key|path/,
    );
  });

  it("publishes another Global identity from an existing immutable Resource", async () => {
    const { dataDir, service } = await fixture();
    const resources = createLocalResourceStore({ dataDir });
    const installed = await resources.install({
      kind: "video",
      bytes: new TextEncoder().encode("video bytes"),
      contentType: "video/mp4",
      originalName: "source.mp4",
    });

    const resolved = await service.publishResource({
      libraryId: "library-a",
      globalAssetId: "global:published",
      resourceId: installed.resource.id,
      kind: "video",
      name: "Published",
      metadata: { durationMs: 1_000 },
      provenance: { kind: "admission" },
    });

    expect(resolved).toMatchObject({
      id: "global:published",
      kind: "video",
      name: "Published",
      metadata: {
        durationMs: 1_000,
        bytes: installed.resource.byteLength,
        contentType: "video/mp4",
      },
      provenance: { kind: "admission" },
      status: "ready",
    });
    expect((await service.openProjection("library-a", resolved.id)).path).toBe(
      installed.path,
    );
  });

  it("reuses original image media for thumbnails and leaves video derivation to presentation clients", async () => {
    const { service } = await fixture();
    const image = await service.importBytes({
      libraryId: "library-preview",
      globalAssetId: "global:image-preview",
      kind: "image",
      bytes: new TextEncoder().encode("image bytes"),
      contentType: "image/png",
    });
    const video = await service.importBytes({
      libraryId: "library-preview",
      globalAssetId: "global:video-preview",
      kind: "video",
      bytes: new TextEncoder().encode("video bytes"),
      contentType: "video/mp4",
    });

    expect(image.thumbnailUrl).toBe(image.url);
    expect(video).not.toHaveProperty("thumbnailUrl");
  });

  it("reports Resource bytes whose length changed as LOCAL_RESOURCE_SIZE_MISMATCH", async () => {
    const { service } = await fixture();
    await service.importBytes({
      libraryId: "library-a",
      globalAssetId: "global:tampered",
      kind: "image",
      bytes: new TextEncoder().encode("original"),
      contentType: "image/png",
    });
    const projection = await service.openProjection(
      "library-a",
      "global:tampered",
    );
    await chmod(projection.path, 0o600);
    await writeFile(projection.path, new TextEncoder().encode("truncated!"));

    // Reads stat the file; the digest is only re-checked on cloud upload.
    await expect(
      service.read("library-a", "global:tampered"),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "LOCAL_RESOURCE_SIZE_MISMATCH",
      error: expect.stringContaining("LOCAL_RESOURCE_SIZE_MISMATCH"),
    });
    await expect(
      service.openProjection("library-a", "global:tampered"),
    ).rejects.toMatchObject({ code: "LOCAL_RESOURCE_SIZE_MISMATCH" });
  });

  it("persists purge as a logical tombstone without physically reclaiming shared bytes", async () => {
    const { service } = await fixture();
    const created = await service.importBytes({
      libraryId: "library-a",
      globalAssetId: "global:purged",
      kind: "image",
      bytes: new TextEncoder().encode("retained bytes"),
      contentType: "image/png",
    });
    const projection = await service.openProjection("library-a", created.id);
    await service.trash({
      libraryId: "library-a",
      globalAssetId: created.id,
      deleteOperationId: "delete:purge",
      deletedAt: "2026-08-13T00:00:00.000Z",
      purgeAfter: "2026-08-20T00:00:00.000Z",
    });
    await service.purge({
      libraryId: "library-a",
      globalAssetId: created.id,
      deleteOperationId: "delete:purge",
      purgedAt: "2026-08-21T00:00:00.000Z",
    });

    expect((await stat(projection.path)).isFile()).toBe(true);
    await expect(readFile(projection.path, "utf8")).resolves.toBe(
      "retained bytes",
    );
    await expect(service.read("library-a", created.id)).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(
      service.restore({
        libraryId: "library-a",
        globalAssetId: created.id,
        deleteOperationId: "delete:purge",
      }),
    ).rejects.toThrow(/purged/);
  });
});
