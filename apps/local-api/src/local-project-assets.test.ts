import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";

import {
  createActionAssetBinding,
  createProjectAsset,
  createProjectTimeline,
  listActionAssetBindings,
  listActionAssetReferences,
  listProjectAssets,
  markActionAssetBindingAuthority,
  markProjectAssetAuthority,
  PROJECT_PRESENTATION_CONTAINER,
  projectAssetAuthorityVersion,
  readActionAssetBinding,
  readProjectAsset,
  type Asset,
  type ActionAssetBinding,
  type ProjectAssetEntry,
} from "@clash/shared-types";

import { FileReplicaStore } from "./loro/file-replica-store.js";
import { createLocalMetadataStore } from "./local-metadata-store.js";
import {
  createLocalAssetInspectionService,
  type LocalAssetInspector,
} from "./local-asset-inspections.js";
import { createLocalResourceStore } from "./local-resource-store.js";
import {
  LocalProjectAssetMigrationError,
  createLocalProjectAssetService,
  publishLocalProjectAssetWithBindings,
} from "./local-project-assets.js";

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
            durationMs: 1_000,
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
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-project-assets-"));
  const dataDir = join(clashRoot, "local-api");
  return {
    clashRoot,
    dataDir,
    replicas: new FileReplicaStore(join(dataDir, "projects")),
    metadata: createLocalMetadataStore(dataDir),
    service: createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: inspectFixtureAsset,
      }),
    }),
  };
}

function legacyAsset(input: {
  id: string;
  storageKey: string;
  digest?: string;
  bytes: number;
}): Asset {
  return {
    id: input.id,
    userId: "local-user",
    kind: "image",
    srcR2Key: input.storageKey,
    coverR2Key: null,
    metadata: {
      bytes: input.bytes,
      contentType: "image/png",
      ...(input.digest ? { contentHash: input.digest } : {}),
      originalName: "legacy.png",
    },
    sourceModel: null,
    sourcePrompt: null,
    sourceTaskId: null,
    sources: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function seedLegacyAsset(
  store: ReturnType<typeof createLocalMetadataStore>,
  asset: Asset,
  ref: { assetId: string; projectId: string; importedAt: number },
): Promise<void> {
  const state = await store.load();
  state.assets = [
    ...state.assets.filter((item) => item.id !== asset.id),
    asset,
  ];
  state.assetRefs = [
    ...state.assetRefs.filter(
      (item) =>
        item.assetId !== ref.assetId || item.projectId !== ref.projectId,
    ),
    ref,
  ];
  await store.save(state, { replaceLegacyAssetMigrationInput: true });
}

describe("Local Project Asset service", () => {
  it("refuses a new Project Asset publication when no Host byte inspector is configured", async () => {
    const { clashRoot, dataDir } = await fixture();
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
    });

    await expect(
      service.installOwned({
        projectId: "project-no-inspector",
        projectAssetId: "asset:no-inspector",
        kind: "image",
        bytes: new TextEncoder().encode("bytes awaiting Host verification"),
        contentType: "image/png",
        name: "unverified.png",
        metadata: { width: 640, height: 360 },
        provenance: { kind: "import" },
      }),
    ).rejects.toThrow();
    await expect(
      service.readEntry("project-no-inspector", "asset:no-inspector"),
    ).resolves.toBeNull();
  });

  it("refuses publication when the inspection registry has no byte-probe adapter", async () => {
    const { clashRoot, dataDir } = await fixture();
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
      }),
    });

    await expect(
      service.installOwned({
        projectId: "project-missing-probe-adapter",
        projectAssetId: "asset:missing-probe-adapter",
        kind: "image",
        bytes: new TextEncoder().encode("bytes need a real decoder"),
        contentType: "image/png",
        metadata: { width: 640, height: 360 },
      }),
    ).rejects.toThrow();
    await expect(
      service.readEntry(
        "project-missing-probe-adapter",
        "asset:missing-probe-adapter",
      ),
    ).resolves.toBeNull();
  });

  it("promotes current v4 media facts for a pre-v4 Resource without a MIME before the Project commit", async () => {
    const { clashRoot, dataDir } = await fixture();
    const resources = createLocalResourceStore({ dataDir, clashRoot });
    const bytes = new TextEncoder().encode("legacy PNG without MIME");
    const legacy = await resources.install({ kind: "image", bytes });
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      clashRoot,
      inspectResource: async () => ({
        contentType: "image/png",
        width: 320,
        height: 180,
        rotationDegrees: 0,
      }),
    });
    await assetInspection.inspect({ source: legacy });
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection,
    });

    await expect(
      service.installOwned({
        projectId: "project-legacy-no-mime",
        projectAssetId: "asset:legacy-no-mime",
        kind: "image",
        bytes,
        contentType: "image/png",
        metadata: {},
      }),
    ).resolves.toMatchObject({
      id: "asset:legacy-no-mime",
      status: "ready",
      metadata: { contentType: "image/png", width: 320, height: 180 },
    });
    await expect(
      service.readEntry("project-legacy-no-mime", "asset:legacy-no-mime"),
    ).resolves.toMatchObject({
      metadata: { contentType: "image/png" },
    });
  });

  it("repairs the old v4-receipt/no-MIME migration state before resolving an existing Project entry", async () => {
    const { clashRoot, dataDir, service } = await fixture();
    const bytes = new TextEncoder().encode("published Project PNG");
    const published = await service.installOwned({
      projectId: "project-old-v4-no-mime",
      projectAssetId: "asset:old-v4-no-mime",
      kind: "image",
      bytes,
      contentType: "image/png",
      metadata: {},
    });
    const entry = await service.readEntry(
      "project-old-v4-no-mime",
      published.id,
    );
    expect(entry).not.toBeNull();
    downgradeResourceToPrePromotionRow(dataDir, entry!.source.resourceId);
    const restarted = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: async () => {
          throw new Error("the persisted current-v4 receipt must be reused");
        },
      }),
    });

    await expect(
      restarted.read("project-old-v4-no-mime", "asset:old-v4-no-mime"),
    ).resolves.toMatchObject({
      status: "ready",
      metadata: { contentType: "image/png" },
    });
    await expect(
      createLocalResourceStore({ dataDir, clashRoot }).resolve(
        entry!.source.resourceId,
      ),
    ).resolves.toMatchObject({
      resource: { contentType: "image/png" },
    });
  });

  it("repairs an unverified pre-v4 Resource declaration but rejects a second interpretation", async () => {
    const { clashRoot, dataDir } = await fixture();
    const resources = createLocalResourceStore({ dataDir, clashRoot });
    const bytes = new TextEncoder().encode("legacy image bytes");
    await resources.install({
      kind: "video",
      bytes,
      contentType: "video/mp4",
    });
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: async ({ resource }) =>
          resource.kind === "image"
            ? {
                contentType: "image/png",
                width: 320,
                height: 180,
                rotationDegrees: 0,
              }
            : {
                contentType: "video/mp4",
                width: 320,
                height: 180,
                rotationDegrees: 0,
                durationMs: 1_000,
                frameRate: 24,
                videoCodec: "h264",
                hasAudio: false,
              },
      }),
    });

    await expect(
      service.installOwned({
        projectId: "project-repair-pre-v4",
        projectAssetId: "asset:repaired-image",
        kind: "image",
        bytes,
        contentType: "image/png",
        metadata: {},
      }),
    ).resolves.toMatchObject({ status: "ready", kind: "image" });
    await expect(
      service.installOwned({
        projectId: "project-repair-pre-v4",
        projectAssetId: "asset:second-interpretation",
        kind: "video",
        bytes,
        contentType: "video/mp4",
        metadata: {},
      }),
    ).rejects.toThrow();
    await expect(
      service.readEntry("project-repair-pre-v4", "asset:second-interpretation"),
    ).resolves.toBeNull();
  });

  it("publishes Host facts instead of conflicting caller media hints", async () => {
    const { clashRoot, dataDir } = await fixture();
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      clashRoot,
      inspectResource: async ({ resource }) => ({
        contentType: resource.contentType,
        width: 1_920,
        height: 1_080,
        rotationDegrees: 0,
        durationMs: 2_500,
        frameRate: 24,
        videoCodec: "h264",
        hasAudio: false,
      }),
    });
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection,
    });

    await service.installOwned({
      projectId: "project-host-facts-win",
      projectAssetId: "asset:host-facts-win",
      kind: "video",
      bytes: new TextEncoder().encode("video bytes verified by the Host"),
      contentType: "video/mp4",
      name: "clip.mp4",
      metadata: {
        width: 320,
        height: 180,
        durationMs: 9_999,
        frameRate: 60,
        videoCodec: "caller-codec",
        hasAudio: true,
        audioCodec: "caller-audio",
      },
      provenance: { kind: "import" },
    });

    const entry = await service.readEntry(
      "project-host-facts-win",
      "asset:host-facts-win",
    );
    expect(entry?.metadata).toMatchObject({
      width: 1_920,
      height: 1_080,
      durationMs: 2_500,
      frameRate: 24,
      videoCodec: "h264",
      hasAudio: false,
    });
    expect(entry?.metadata).not.toHaveProperty("audioCodec");
  });

  it("publishes canonical v4 content type when reopening a sealed legacy alias", async () => {
    const { clashRoot, dataDir } = await fixture();
    const resources = createLocalResourceStore({ dataDir, clashRoot });
    const source = await resources.install({
      kind: "image",
      bytes: new TextEncoder().encode("legacy Project JPEG alias"),
      contentType: "image/jpg",
    });
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: async () => ({
          contentType: "image/jpeg",
          width: 640,
          height: 360,
          rotationDegrees: 0,
        }),
      }),
    });

    await service.publishStagedOwnedWithBindings({
      projectId: "project-legacy-jpeg-alias",
      projectAssetId: "asset:legacy-jpeg-alias",
      resourceId: source.resource.id,
      kind: "image",
      metadata: { contentType: "image/jpg" },
      bindings: [],
    });

    await expect(
      service.readEntry("project-legacy-jpeg-alias", "asset:legacy-jpeg-alias"),
    ).resolves.toMatchObject({
      metadata: { contentType: "image/jpeg" },
    });
  });

  it("rejects a caller kind assertion that does not match the decoded bytes", async () => {
    const { clashRoot, dataDir } = await fixture();
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        clashRoot,
        inspectResource: async ({ resource }) => {
          if (resource.kind !== "image") {
            throw new Error("decoded bytes are an image, not video");
          }
          return {
            contentType: "image/png",
            width: 640,
            height: 360,
            rotationDegrees: 0,
          };
        },
      }),
    });

    await expect(
      service.installOwned({
        projectId: "project-kind-assertion",
        projectAssetId: "asset:kind-assertion",
        kind: "video",
        bytes: new TextEncoder().encode("image bytes with a video assertion"),
        contentType: "video/mp4",
        metadata: {},
      }),
    ).rejects.toThrow("decoded bytes are an image, not video");
    await expect(
      service.readEntry("project-kind-assertion", "asset:kind-assertion"),
    ).resolves.toBeNull();
  });

  it("can finalize staged bytes after the caller corrects a rejected media-type assertion", async () => {
    const { clashRoot, dataDir } = await fixture();
    const bytes = new TextEncoder().encode("one immutable PNG byte sequence");
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      clashRoot,
      inspectResource: async ({ resource }) => {
        if (resource.contentType !== "image/png") {
          throw new Error("decoded bytes are PNG, not JPEG");
        }
        return {
          contentType: "image/png",
          width: 640,
          height: 360,
          rotationDegrees: 0,
        };
      },
    });
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection,
    });
    const command = {
      projectId: "project-corrected-l0",
      projectAssetId: "asset:corrected-l0",
      kind: "image" as const,
      bytes,
      name: "frame.png",
      metadata: {},
      provenance: { kind: "import" as const },
    };

    await expect(
      service.installOwned({ ...command, contentType: "image/jpeg" }),
    ).rejects.toThrow("decoded bytes are PNG, not JPEG");
    await expect(
      service.readEntry(command.projectId, command.projectAssetId),
    ).resolves.toBeNull();

    await expect(
      service.installOwned({ ...command, contentType: "image/png" }),
    ).resolves.toMatchObject({
      id: command.projectAssetId,
      metadata: {
        contentType: "image/png",
        width: 640,
        height: 360,
      },
    });
  });

  it("rejects a frozen media-type assertion when the same bytes are already sealed under another type", async () => {
    const { service } = await fixture();
    const bytes = new TextEncoder().encode("one immutable Project image");

    await service.installOwned({
      projectId: "project-sealed-media-type",
      projectAssetId: "asset:sealed-png",
      kind: "image",
      bytes,
      contentType: "image/png",
      metadata: {},
      provenance: { kind: "import" },
    });

    await expect(
      service.installOwned({
        projectId: "project-sealed-media-type",
        projectAssetId: "asset:conflicting-jpeg",
        kind: "image",
        bytes,
        contentType: "image/jpeg",
        metadata: {},
        provenance: { kind: "import" },
      }),
    ).rejects.toThrow("image/jpeg");
    await expect(
      service.readEntry("project-sealed-media-type", "asset:conflicting-jpeg"),
    ).resolves.toBeNull();
  });

  it("accepts a canonical media-type alias when reusing sealed Project bytes", async () => {
    const { service } = await fixture();
    const bytes = new TextEncoder().encode("one aliased Project JPEG");

    await service.installOwned({
      projectId: "project-sealed-media-alias",
      projectAssetId: "asset:canonical-jpeg",
      kind: "image",
      bytes,
      contentType: "image/jpeg",
      metadata: {},
      provenance: { kind: "import" },
    });

    await expect(
      service.installOwned({
        projectId: "project-sealed-media-alias",
        projectAssetId: "asset:aliased-jpeg",
        kind: "image",
        bytes,
        contentType: "image/jpg",
        metadata: {},
        provenance: { kind: "import" },
      }),
    ).resolves.toMatchObject({
      id: "asset:aliased-jpeg",
      metadata: { contentType: "image/jpeg" },
    });
  });

  it("keeps non-frozen Project media hints subordinate to Host facts on sealed-byte reuse", async () => {
    const { service } = await fixture();
    const bytes = new TextEncoder().encode(
      "one Project image with stale hints",
    );

    await service.installOwned({
      projectId: "project-sealed-hints",
      projectAssetId: "asset:sealed-hints-source",
      kind: "image",
      bytes,
      contentType: "image/png",
      metadata: {},
      provenance: { kind: "import" },
    });

    await expect(
      service.installOwned({
        projectId: "project-sealed-hints",
        projectAssetId: "asset:sealed-hints-reuse",
        kind: "image",
        bytes,
        metadata: { width: 999, height: 999 },
        provenance: { kind: "import" },
      }),
    ).resolves.toMatchObject({
      id: "asset:sealed-hints-reuse",
      metadata: {
        contentType: "image/png",
        width: 1,
        height: 1,
      },
    });
  });

  it("publishes Host-inspected media facts into the Project authority", async () => {
    const { clashRoot, dataDir } = await fixture();
    const bytes = new TextEncoder().encode("video bytes inspected by the Host");
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      clashRoot,
      inspectResource: async ({ resource }) => ({
        contentType: resource.contentType,
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
      }),
    });
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection,
    });

    await service.installOwned({
      projectId: "project-inspected",
      projectAssetId: "asset:video",
      kind: "video",
      bytes,
      contentType: "video/mp4",
      name: "clip.mp4",
      metadata: {},
      provenance: { kind: "import" },
    });

    await expect(
      service.readEntry("project-inspected", "asset:video"),
    ).resolves.toMatchObject({
      metadata: {
        width: 1_920,
        height: 1_080,
        durationMs: 2_500,
        frameRate: 24,
        videoCodec: "h264",
        hasAudio: true,
        audioCodec: "aac",
        bytes: bytes.byteLength,
        contentType: "video/mp4",
        originalName: "clip.mp4",
      },
    });
  });

  it("does not publish a caller waveform as canonical Resource metadata", async () => {
    const { clashRoot, dataDir } = await fixture();
    const bytes = new TextEncoder().encode("canonical audio bytes");
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      clashRoot,
      inspectResource: async () => ({
        durationMs: 2_000,
        hasAudio: true,
        audioCodec: "aac",
        sampleRate: 48_000,
        channelCount: 2,
        channelLayout: "stereo",
      }),
    });
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection,
    });

    await service.installOwned({
      projectId: "project-audio",
      projectAssetId: "asset:audio",
      kind: "audio",
      bytes,
      contentType: "audio/mp4",
      name: "voice.m4a",
      metadata: { waveform: [0.25, 0.75] },
      provenance: { kind: "generation", actionRunId: "run:audio" },
    });

    const entry = await service.readEntry("project-audio", "asset:audio");
    expect(entry?.metadata).toMatchObject({
      durationMs: 2_000,
      hasAudio: true,
      audioCodec: "aac",
      bytes: bytes.byteLength,
      contentType: "audio/mp4",
    });
    expect(entry?.metadata).not.toHaveProperty("waveform");
  });

  it("prepares staged bytes with Host-inspected facts before any Project mutation", async () => {
    const { clashRoot, dataDir } = await fixture();
    const bytes = new TextEncoder().encode("durable staged video bytes");
    const assetInspection = createLocalAssetInspectionService({
      dataDir,
      clashRoot,
      inspectResource: async () => ({
        width: 1_280,
        height: 720,
        rotationDegrees: 0,
        durationMs: 1_500,
        frameRate: 30,
        videoCodec: "h264",
        hasAudio: false,
      }),
    });
    const service = createLocalProjectAssetService({
      dataDir,
      clashRoot,
      projectionOrigin: "http://127.0.0.1:49152",
      assetInspection,
    });
    const staged = await service.stageOwned({
      kind: "video",
      bytes,
      contentType: "video/mp4",
      name: "generated.mp4",
    });

    const entry = await service.prepareStagedOwnedEntry({
      projectAssetId: "asset:durable-video",
      kind: "video",
      resourceId: staged.resourceId,
      name: "generated.mp4",
      metadata: { contentType: "video/mp4" },
      provenance: {
        kind: "generation",
        actionRunId: "run:durable-video",
      },
    });

    expect(entry).toMatchObject({
      id: "asset:durable-video",
      source: { kind: "owned", resourceId: staged.resourceId },
      metadata: {
        width: 1_280,
        height: 720,
        durationMs: 1_500,
        frameRate: 30,
        videoCodec: "h264",
        bytes: bytes.byteLength,
        contentType: "video/mp4",
        originalName: "generated.mp4",
      },
    });
    await expect(
      service.readEntry("project-durable", entry.id),
    ).resolves.toBeNull();
  });

  it("publishes one Project Asset and its immutable bindings atomically and idempotently", () => {
    const doc = new LoroDoc();
    const entry: ProjectAssetEntry = {
      id: "generated-output",
      kind: "image",
      source: {
        kind: "owned",
        resourceId: `sha256:${"a".repeat(64)}`,
      },
      lifecycle: { state: "active" },
      metadata: { bytes: 10, contentType: "image/png" },
    };
    const output: ActionAssetBinding = {
      id: "run-1:output:0",
      owner: {
        kind: "run",
        actionId: "action-1",
        actionRevisionId: "revision-1",
        actionRunId: "run-1",
      },
      direction: "output",
      slot: "output:0",
      projectAssetId: entry.id,
      role: "primary",
    };

    expect(publishLocalProjectAssetWithBindings(doc, entry, [output])).toEqual({
      entry,
      bindings: [output],
      changed: true,
    });
    expect(publishLocalProjectAssetWithBindings(doc, entry, [output])).toEqual({
      entry,
      bindings: [output],
      changed: false,
    });

    const conflictDoc = new LoroDoc();
    const otherEntry: ProjectAssetEntry = {
      ...entry,
      id: "other-output",
      source: {
        kind: "owned",
        resourceId: `sha256:${"b".repeat(64)}`,
      },
    };
    const laterConflict: ActionAssetBinding = {
      ...output,
      id: "run-1:output:1",
      slot: "output:1",
    };
    expect(createProjectAsset(conflictDoc, otherEntry)).toMatchObject({
      ok: true,
    });
    expect(
      createActionAssetBinding(conflictDoc, {
        ...laterConflict,
        projectAssetId: otherEntry.id,
      }),
    ).toMatchObject({ ok: true });

    expect(() =>
      publishLocalProjectAssetWithBindings(conflictDoc, entry, [
        output,
        laterConflict,
      ]),
    ).toThrow(/already identifies different facts/);
    expect(readProjectAsset(conflictDoc, entry.id)).toBeNull();
    expect(readActionAssetBinding(conflictDoc, output.id)).toBeNull();
    expect(readActionAssetBinding(conflictDoc, laterConflict.id)).toMatchObject(
      {
        projectAssetId: otherEntry.id,
      },
    );
  });

  it("persists an invalid Project cover selector cleanup after authority cutover", async () => {
    const doc = new LoroDoc();
    expect(markProjectAssetAuthority(doc)).toMatchObject({ ok: true });
    expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
    doc
      .getMap(PROJECT_PRESENTATION_CONTAINER)
      .set("coverBindingId", "missing-cover-binding");
    let save = false;
    const { dataDir } = await fixture();
    const service = createLocalProjectAssetService({
      dataDir,
      projectionOrigin: "http://127.0.0.1:49152",
      replica: {
        inspect: async (_projectId, read) => read(doc),
        mutate: async (_projectId, mutation) => {
          const result = await mutation(doc);
          save = result.save === true;
          return result.value;
        },
      },
    });

    await service.materialize("project-with-stale-cover");

    expect(save).toBe(true);
    expect(
      doc.getMap(PROJECT_PRESENTATION_CONTAINER).get("coverBindingId"),
    ).toBeUndefined();
  });

  it("does not treat legacy Timeline fields as a live binding index after cutover", async () => {
    const doc = new LoroDoc();
    expect(
      createProjectAsset(doc, {
        id: "timeline-source",
        kind: "video",
        source: {
          kind: "owned",
          resourceId: `sha256:${"a".repeat(64)}`,
        },
        lifecycle: { state: "active" },
        metadata: { bytes: 1, contentType: "video/mp4" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      createProjectTimeline(doc, {
        id: "timeline-1",
        name: "Timeline",
        state: {
          tracks: [
            {
              id: "track-1",
              items: [
                {
                  id: "clip-1",
                  type: "video",
                  assetId: "timeline-source",
                  from: 0,
                  durationInFrames: 30,
                },
              ],
            },
          ],
        },
      }),
    ).toMatchObject({ ok: true });
    expect(markProjectAssetAuthority(doc)).toMatchObject({ ok: true });
    expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
    expect(listActionAssetReferences(doc, "timeline-source")).toEqual([]);

    const { dataDir } = await fixture();
    const service = createLocalProjectAssetService({
      dataDir,
      projectionOrigin: "http://127.0.0.1:49152",
      replica: {
        inspect: async (_projectId, read) => read(doc),
        mutate: async (_projectId, mutation) => (await mutation(doc)).value,
      },
    });
    await service.materialize("project-after-cutover");

    expect(listActionAssetReferences(doc, "timeline-source")).toEqual([]);
  });

  it("materializes legacy rows and their bytes before marking Project Loro authoritative", async () => {
    const { dataDir, metadata, replicas, service } = await fixture();
    const projectId = "legacy-project";
    const bytes = new TextEncoder().encode("legacy image bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const storageKey = "generated/legacy.png";
    const path = join(dataDir, "assets", storageKey);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
    const asset = legacyAsset({
      id: "legacy-asset",
      storageKey,
      digest,
      bytes: bytes.byteLength,
    });
    await seedLegacyAsset(metadata, asset, {
      assetId: asset.id,
      projectId,
      importedAt: 1,
    });

    await service.materialize(projectId);

    const doc = await replicas.recover(projectId);
    expect(projectAssetAuthorityVersion(doc)).toBe(1);
    expect(listProjectAssets(doc)).toEqual([
      expect.objectContaining({
        id: "legacy-asset",
        source: { kind: "owned", resourceId: `sha256:${digest}` },
      }),
    ]);
    await expect(service.list(projectId)).resolves.toEqual([
      expect.objectContaining({ id: "legacy-asset", status: "ready" }),
    ]);
  });

  it("leaves the authority marker absent when legacy digest verification fails", async () => {
    const { dataDir, metadata, replicas, service } = await fixture();
    const projectId = "bad-legacy-project";
    const bytes = new TextEncoder().encode("actual bytes");
    const storageKey = "generated/bad.png";
    const path = join(dataDir, "assets", storageKey);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
    const asset = legacyAsset({
      id: "bad-asset",
      storageKey,
      digest: "a".repeat(64),
      bytes: bytes.byteLength,
    });
    await seedLegacyAsset(metadata, asset, {
      assetId: asset.id,
      projectId,
      importedAt: 1,
    });

    await expect(service.materialize(projectId)).rejects.toMatchObject({
      code: "RESOURCE_DIGEST_MISMATCH",
    });
    expect(
      projectAssetAuthorityVersion(await replicas.recover(projectId)),
    ).toBeUndefined();
  });

  it("never falls back to legacy membership after the one-way cutover", async () => {
    const { dataDir, metadata, service } = await fixture();
    const projectId = "cut-over-project";
    await service.materialize(projectId);
    const bytes = new TextEncoder().encode("late legacy write");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const storageKey = "generated/late.png";
    const path = join(dataDir, "assets", storageKey);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
    const asset = legacyAsset({
      id: "late-asset",
      storageKey,
      digest,
      bytes: bytes.byteLength,
    });
    await seedLegacyAsset(metadata, asset, {
      assetId: asset.id,
      projectId,
      importedAt: 2,
    });

    await expect(service.list(projectId)).resolves.toEqual([]);
  });

  it("scopes media projection reads to the Project authority", async () => {
    const { service } = await fixture();
    const installed = await service.installOwned({
      projectId: "project-a",
      projectAssetId: "output-1",
      kind: "video",
      bytes: new TextEncoder().encode("video bytes"),
      contentType: "video/mp4",
      name: "result.mp4",
      metadata: { durationMs: 1000 },
      provenance: { kind: "generation", actionRunId: "run-1" },
    });

    await expect(
      service.openProjection("project-a", installed.id),
    ).resolves.toMatchObject({ resource: { kind: "video" } });
    await expect(
      service.openProjection("project-b", installed.id),
    ).rejects.toMatchObject({ code: "PROJECT_ASSET_NOT_FOUND" });
  });

  it("reuses original image media for thumbnails and advertises missing video/audio derivations", async () => {
    const { service } = await fixture();
    const image = await service.installOwned({
      projectId: "project-preview",
      projectAssetId: "image-preview",
      kind: "image",
      bytes: new TextEncoder().encode("image bytes"),
      contentType: "image/png",
      metadata: {},
    });
    const video = await service.installOwned({
      projectId: "project-preview",
      projectAssetId: "video-preview",
      kind: "video",
      bytes: new TextEncoder().encode("video bytes"),
      contentType: "video/mp4",
      metadata: {},
    });
    const audio = await service.installOwned({
      projectId: "project-preview",
      projectAssetId: "audio-preview",
      kind: "audio",
      bytes: new TextEncoder().encode("audio bytes"),
      contentType: "audio/mpeg",
      metadata: {},
    });

    expect(image.thumbnailUrl).toBe(image.url);
    // Missing derivations with no failure stay addressable so the card request
    // can derive them on demand.
    expect(video.thumbnailUrl).toBe(
      "http://127.0.0.1:49152/api/v1/projects/project-preview/assets/video-preview/thumbnail",
    );
    expect(video).not.toHaveProperty("proxyUrl");
    expect(video).not.toHaveProperty("representationFailure");
    expect(audio).not.toHaveProperty("thumbnailUrl");
    expect(audio.waveformUrl).toBe(
      "http://127.0.0.1:49152/api/v1/projects/project-preview/assets/audio-preview/waveform",
    );
  });

  it("resolves a Host-private staged Resource without writing Loro", async () => {
    const { replicas, service } = await fixture();
    const bytes = new TextEncoder().encode("staged plugin output");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const staged = await service.stageOwned({
      kind: "image",
      bytes,
      contentType: "image/png",
      name: "result.png",
    });

    await expect(
      service.resolveStagedOwned(`sha256:${digest}`),
    ).resolves.toEqual(staged);
    expect(
      projectAssetAuthorityVersion(await replicas.recover("project-a")),
    ).toBeUndefined();
  });

  it("keeps staged bytes but publishes no Project facts when a binding identity collides", async () => {
    const { replicas, service } = await fixture();
    const projectId = "atomic-edit-project";
    const source = await service.installOwned({
      projectId,
      projectAssetId: "source:image",
      kind: "image",
      bytes: new TextEncoder().encode("source image"),
      contentType: "image/png",
      name: "source.png",
      metadata: {},
    });
    const staged = await service.stageOwned({
      kind: "image",
      bytes: new TextEncoder().encode("edited image"),
      contentType: "image/png",
      name: "edited.png",
    });
    const owner = {
      kind: "run" as const,
      actionId: "image-editor",
      actionRevisionId: "revision-1",
      actionRunId: "edit:run-1",
    };
    const outputAssetId = "edit:output-1";
    const inputBinding: ActionAssetBinding = {
      id: "action-asset:edit:run-1:source:input",
      owner,
      direction: "input",
      slot: "source",
      projectAssetId: source.id,
      role: "source",
    };
    const outputBinding: ActionAssetBinding = {
      id: "action-asset:edit:run-1:output",
      owner,
      direction: "output",
      slot: "output",
      projectAssetId: outputAssetId,
      role: "primary",
    };
    const conflictingBinding: ActionAssetBinding = {
      ...outputBinding,
      slot: "already-claimed",
      projectAssetId: source.id,
    };
    await service.bind(projectId, conflictingBinding);

    await expect(
      service.publishStagedOwnedWithBindings({
        projectId,
        projectAssetId: outputAssetId,
        kind: "image",
        resourceId: staged.resourceId,
        name: "edited.png",
        metadata: { contentType: "image/png" },
        provenance: {
          kind: "edit",
          actionRunId: owner.actionRunId,
          model: "implicit:image-editor",
        },
        bindings: [inputBinding, outputBinding],
      }),
    ).rejects.toMatchObject({
      code: "ACTION_ASSET_BINDING_ID_COLLISION",
    });

    const doc = await replicas.recover(projectId);
    expect(readProjectAsset(doc, outputAssetId)).toBeNull();
    expect(readActionAssetBinding(doc, inputBinding.id)).toBeNull();
    expect(readActionAssetBinding(doc, outputBinding.id)).toEqual(
      conflictingBinding,
    );
    expect(
      listActionAssetBindings(doc).filter(
        (binding) =>
          binding.owner.kind === "run" &&
          binding.owner.actionRunId === owner.actionRunId,
      ),
    ).toEqual([conflictingBinding]);
    await expect(
      service.resolveStagedOwned(staged.resourceId),
    ).resolves.toEqual(staged);
  });

  it("reads the Host-private Project membership entry after materialization", async () => {
    const { service } = await fixture();
    const installed = await service.installOwned({
      projectId: "project-a",
      projectAssetId: "owned-entry",
      kind: "image",
      bytes: new TextEncoder().encode("owned bytes"),
      contentType: "image/png",
      name: "owned.png",
      metadata: {},
    });

    const entry = await service.readEntry("project-a", installed.id);

    expect(entry).toMatchObject({
      id: "owned-entry",
      kind: "image",
      name: "owned.png",
      source: {
        kind: "owned",
        resourceId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
      lifecycle: { state: "active" },
    });
  });

  it("uses immutable ensure semantics for authority binding retries", async () => {
    const { service } = await fixture();
    const installed = await service.installOwned({
      projectId: "binding-project",
      projectAssetId: "binding-target",
      kind: "image",
      bytes: new TextEncoder().encode("binding target"),
      contentType: "image/png",
      metadata: {},
    });
    const expected: ActionAssetBinding = {
      id: "stable-output-binding",
      owner: {
        kind: "run",
        actionId: "action-1",
        actionRevisionId: "revision-1",
        actionRunId: "run-1",
      },
      direction: "output",
      slot: "output:0",
      projectAssetId: installed.id,
    };

    await expect(service.bind("binding-project", expected)).resolves.toEqual(
      expected,
    );
    await expect(service.bind("binding-project", expected)).resolves.toEqual(
      expected,
    );
    await expect(
      service.bind("binding-project", {
        ...expected,
        slot: "output:1",
      }),
    ).rejects.toMatchObject({ code: "ACTION_ASSET_BINDING_ID_COLLISION" });
  });

  it("admits a linked Global Resource without copying bytes or exposing storage identity", async () => {
    const { service } = await fixture();
    const bytes = new TextEncoder().encode("shared global bytes");
    const global = await service.installOwned({
      projectId: "global-catalog",
      projectAssetId: "global-entry",
      kind: "image",
      bytes,
      contentType: "image/png",
      name: "shared.png",
      metadata: {},
    });
    const globalEntry = await service.readEntry("global-catalog", global.id);
    expect(globalEntry?.source.kind).toBe("owned");
    const resourceId = globalEntry!.source.resourceId;

    const linked = await service.admitLinked({
      projectId: "project-a",
      kind: "image",
      resourceId,
      originLibraryId: "personal",
      originEntryId: "global-entry",
      name: "shared.png",
      metadata: {
        bytes: bytes.byteLength,
        contentType: "image/png",
        originalName: "shared.png",
      },
    });

    expect(linked.id).toMatch(/^asset:[0-9a-f-]{36}$/);
    expect(linked).toMatchObject({
      kind: "image",
      name: "shared.png",
      status: "ready",
    });
    expect(JSON.stringify(linked)).not.toMatch(/resourceId|storageKey|sha256:/);
    await expect(
      service.readEntry("project-a", linked.id),
    ).resolves.toMatchObject({
      id: linked.id,
      source: {
        kind: "linked",
        resourceId,
        origin: {
          scope: "global",
          libraryId: "personal",
          entryId: "global-entry",
        },
      },
    });

    const globalProjection = await service.openProjection(
      "global-catalog",
      global.id,
    );
    const linkedProjection = await service.openProjection(
      "project-a",
      linked.id,
    );
    expect(linkedProjection.path).toBe(globalProjection.path);
    expect(linkedProjection.storageKey).toBe(globalProjection.storageKey);
  });

  it("fails a migration with a structured error when legacy bytes are missing", async () => {
    const { metadata, service } = await fixture();
    const projectId = "missing-bytes";
    const asset = legacyAsset({
      id: "missing-asset",
      storageKey: "generated/missing.png",
      bytes: 10,
    });
    await seedLegacyAsset(metadata, asset, {
      assetId: asset.id,
      projectId,
      importedAt: 1,
    });

    await expect(service.materialize(projectId)).rejects.toBeInstanceOf(
      LocalProjectAssetMigrationError,
    );
    await expect(service.materialize(projectId)).rejects.toMatchObject({
      code: "RESOURCE_DIGEST_UNAVAILABLE",
    });
  });

  it("refuses to reinterpret an already-published Project Asset as different bytes", async () => {
    const { service } = await fixture();
    await service.installOwned({
      projectId: "project-a",
      projectAssetId: "stable-output",
      kind: "image",
      bytes: new TextEncoder().encode("first output"),
      contentType: "image/png",
      metadata: {},
    });

    await expect(
      service.installOwned({
        projectId: "project-a",
        projectAssetId: "stable-output",
        kind: "image",
        bytes: new TextEncoder().encode("different output"),
        contentType: "image/png",
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: "PROJECT_ASSET_ID_COLLISION" });
  });
});

it("returns the committed Asset when the post-commit read fails", async () => {
  const clashRoot = await mkdtemp(join(tmpdir(), "clash-project-assets-read-"));
  const dataDir = join(clashRoot, "local-api");
  const replicas = new FileReplicaStore(join(dataDir, "projects"));
  let readFailures = 0;
  const service = createLocalProjectAssetService({
    dataDir,
    clashRoot,
    projectionOrigin: "http://127.0.0.1:49152",
    assetInspection: createLocalAssetInspectionService({
      dataDir,
      clashRoot,
      inspectResource: inspectFixtureAsset,
    }),
    replica: {
      async inspect(projectId, read) {
        const doc = await replicas.recover(projectId);
        const committed = listProjectAssets(doc).some(
          (entry) => entry.id === "asset:read-failure",
        );
        if (committed) {
          readFailures += 1;
          throw new Error("injected post-commit read failure");
        }
        return read(doc);
      },
      mutate(projectId, mutation) {
        return replicas.updateSnapshotAtomic(projectId, mutation);
      },
    },
  });

  const published = await service.installOwned({
    projectId: "project-read-failure",
    projectAssetId: "asset:read-failure",
    kind: "image",
    bytes: new TextEncoder().encode("committed read failure bytes"),
    contentType: "image/png",
    metadata: {},
  });

  expect(readFailures).toBe(2);
  expect(published).toMatchObject({
    id: "asset:read-failure",
    kind: "image",
    status: "ready",
    metadata: { contentType: "image/png" },
  });
  await expect(
    service.readEntry("project-read-failure", "asset:read-failure"),
  ).rejects.toThrow("injected post-commit read failure");
});
