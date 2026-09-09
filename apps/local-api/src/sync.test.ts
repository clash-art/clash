import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import {
  CrdtType,
  MessageType,
  UpdateStatusCode,
  decode,
  encode,
  type ProtocolMessage,
} from "loro-protocol";

import { createMockExternalAigcService } from "./local-aigc.js";
import {
  Canvas,
  DOCUMENT_ASSET_REVISIONS_CONTAINER,
  DOCUMENT_ASSET_SCHEMA_CONTAINER,
  DOCUMENT_ATTACHMENTS_CONTAINER,
  GENERATOR_ACTION_RUNS_CONTAINER,
  GENERATOR_OUTPUT_COMMITS_CONTAINER,
  GENERATOR_REVISIONS_CONTAINER,
  GENERATOR_SCHEMA_CONTAINER,
  PROJECT_DOCUMENT_ASSETS_CONTAINER,
  PROJECT_GENERATORS_CONTAINER,
  createActionAssetBinding,
  createProjectDocumentAsset,
  createProjectGenerator,
  createProjectAsset,
  createProjectTimeline,
  ensureActionRunRequest,
  ensureDocumentAttachment,
  ensureOutputCommit,
  listActionAssetReferences,
  markDocumentAssetAuthority,
  markGeneratorAuthority,
  markActionAssetBindingAuthority,
  MODEL_CARDS,
  purgeProjectAsset,
  readActionAssetBinding,
  readProjectAsset,
  resolveOutputCommitAssetType,
  requestTimelineRender,
  trashProjectAssetIfUnreferenced,
  unbindActionAssetBinding,
  updateActionAssetBinding,
} from "@clash/shared-types";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachLocalSync,
  createHttpRemoteLoroPersistence,
  createRemoteLoroPersistenceFromEnv,
  LocalLoroRoom,
  LocalLoroRoomHub,
} from "./sync";
import { createLocalWorkflowProcessor } from "./local-processor";
import { createLocalMetadataStore } from "./local-metadata-store";
import { FileReplicaStore } from "./loro/file-replica-store";
import { createLocalResourceStore } from "./local-resource-store";
import { createLocalPluginAssetStagingStore } from "./local-plugin-asset-staging";
import { createSqliteDurableRunJournal } from "./durable-run-journal";
import { createLocalAssetInspectionService } from "./local-asset-inspections";

let dataDir = "";

function openSqlite() {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): {
        get(...params: unknown[]): Record<string, unknown> | undefined;
        all(...params: unknown[]): Array<Record<string, unknown>>;
      };
      close(): void;
    };
  };
  return new DatabaseSync(join(dataDir, "local.sqlite"));
}

function testAssetInspection(
  options: {
    video?: { width: number; height: number; durationMs: number };
  } = {},
) {
  const video = options.video ?? {
    width: 720,
    height: 1_280,
    durationMs: 4_000,
  };
  return createLocalAssetInspectionService({
    dataDir,
    inspectResource: async ({ resource }) => {
      const contentType = resource.contentType
        ? { contentType: resource.contentType }
        : {};
      if (resource.kind === "image") {
        return {
          ...contentType,
          width: 1_024,
          height: 576,
          rotationDegrees: 0,
        };
      }
      if (resource.kind === "video") {
        return {
          ...contentType,
          ...video,
          rotationDegrees: 0,
          frameRate: 24,
          videoCodec: "h264",
          hasAudio: false,
        };
      }
      if (resource.kind === "audio") {
        return {
          ...contentType,
          durationMs: 3_000,
          hasAudio: true,
          audioCodec: "pcm_s16le",
          sampleRate: 44_100,
          channelCount: 1,
          channelLayout: "mono",
        };
      }
      return contentType;
    },
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clash-local-sync-"));
});

afterEach(async () => {
  vi.useRealTimers();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

function countUpdateLogRecords(log: Buffer): number {
  let count = 0;
  let offset = 0;
  while (offset < log.byteLength) {
    if (offset + 4 > log.byteLength)
      throw new Error("truncated update log header");
    const length = log.readUInt32BE(offset);
    offset += 4 + length;
    if (offset > log.byteLength) throw new Error("truncated update log record");
    count += 1;
  }
  return count;
}

function updateId(update: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of update) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${update.byteLength}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

const generatorDefinitionRef = {
  pluginId: "clash.stage",
  definitionId: "director-stage",
  version: "1.0.0",
  schemaHash: `sha256:${"a".repeat(64)}`,
} as const;

function seedGeneratorAuthority(doc: LoroDoc): void {
  expect(markGeneratorAuthority(doc)).toMatchObject({ ok: true });
  expect(
    createProjectAsset(doc, {
      id: "asset-result",
      kind: "image",
      source: { kind: "owned", resourceId: "resource-result" },
      lifecycle: { state: "active" },
      metadata: {},
    }),
  ).toMatchObject({ ok: true });
  expect(
    createProjectGenerator(doc, {
      head: { id: "stage-1", headRevisionId: "stage-rev-1" },
      revision: {
        id: "stage-rev-1",
        generatorId: "stage-1",
        definitionRef: generatorDefinitionRef,
        state: { scene: "courtyard" },
        persistentInputRefs: [],
      },
    }),
  ).toMatchObject({ ok: true });
  expect(
    ensureActionRunRequest(doc, {
      actionRunId: "run-stage-1",
      generatorRevision: {
        generatorId: "stage-1",
        generatorRevisionId: "stage-rev-1",
      },
      actionId: "render-still",
      executor: {
        pluginId: generatorDefinitionRef.pluginId,
        version: generatorDefinitionRef.version,
        exportId: "render-still",
        schemaHash: generatorDefinitionRef.schemaHash,
      },
      invocationFingerprint: `sha256:${"b".repeat(64)}`,
      parameters: {},
      invocationInputRefs: [],
      outputContract: [
        {
          slot: "image",
          assetType: { kind: "media", mediaKind: "image" },
          cardinality: { minItems: 1, maxItems: 1 },
        },
      ],
    }),
  ).toMatchObject({ ok: true });
  expect(
    ensureOutputCommit(
      doc,
      {
        actionRunId: "run-stage-1",
        outputSlot: "image",
        asset: { kind: "media", projectAssetId: "asset-result" },
      },
      resolveOutputCommitAssetType,
    ),
  ).toMatchObject({ ok: true });
}

function seedDocumentAssetAuthority(doc: LoroDoc): void {
  expect(markDocumentAssetAuthority(doc)).toMatchObject({ ok: true });
  expect(
    createProjectAsset(doc, {
      id: "video-1",
      kind: "video",
      source: { kind: "owned", resourceId: "resource:video-1" },
      lifecycle: { state: "active" },
      metadata: {
        contentType: "video/mp4",
        width: 1,
        height: 1,
        durationMs: 1_000,
      },
    }),
  ).toMatchObject({ ok: true });
  expect(
    createProjectDocumentAsset(doc, {
      id: "transcript:r1",
      documentAssetId: "transcript",
      documentKind: "media.transcript",
      schemaVersion: 1,
      mutability: "versioned",
      body: {
        digest: `sha256:${"c".repeat(64)}`,
        byteLength: 128,
        contentType: "application/json",
      },
      producer: { kind: "actor", actor: { kind: "agent" } },
      sourceRefs: [
        {
          slot: "source",
          target: { kind: "media", projectAssetId: "video-1" },
        },
      ],
    }),
  ).toMatchObject({ ok: true });
  expect(
    ensureDocumentAttachment(doc, {
      id: "video-transcript",
      target: { kind: "project-asset", projectAssetId: "video-1" },
      slot: "transcript",
      document: {
        kind: "document",
        documentAssetId: "transcript",
        revisionId: "transcript:r1",
      },
    }),
  ).toMatchObject({ ok: true });
}

type HostOwnedAuthorityContainerCase = {
  domain: "Generator" | "Document Asset";
  label: string;
  container: string;
  seed(doc: LoroDoc): void;
  forge(doc: LoroDoc): void;
  remove(doc: LoroDoc): void;
};

const HOST_OWNED_AUTHORITY_CONTAINER_CASES = [
  {
    domain: "Generator",
    label: "Generator schema marker",
    container: GENERATOR_SCHEMA_CONTAINER,
    seed: seedGeneratorAuthority,
    forge: (doc) =>
      doc
        .getMap(GENERATOR_SCHEMA_CONTAINER)
        .ensureMergeableMap("authorityVersions")
        .set("1", false),
    remove: (doc) =>
      doc.getMap(GENERATOR_SCHEMA_CONTAINER).delete("authorityVersions"),
  },
  {
    domain: "Generator",
    label: "Project Generator head",
    container: PROJECT_GENERATORS_CONTAINER,
    seed: seedGeneratorAuthority,
    forge: (doc) =>
      doc
        .getMap(PROJECT_GENERATORS_CONTAINER)
        .ensureMergeableMap("stage-1")
        .set("head", { revisionId: "stage-rev-forged" }),
    remove: (doc) => doc.getMap(PROJECT_GENERATORS_CONTAINER).delete("stage-1"),
  },
  {
    domain: "Generator",
    label: "Generator revision",
    container: GENERATOR_REVISIONS_CONTAINER,
    seed: seedGeneratorAuthority,
    forge: (doc) =>
      doc
        .getMap(GENERATOR_REVISIONS_CONTAINER)
        .ensureMergeableMap("stage-1")
        .set("stage-rev-1", { forged: true }),
    remove: (doc) =>
      doc.getMap(GENERATOR_REVISIONS_CONTAINER).delete("stage-1"),
  },
  {
    domain: "Generator",
    label: "Generator Action Run",
    container: GENERATOR_ACTION_RUNS_CONTAINER,
    seed: seedGeneratorAuthority,
    forge: (doc) =>
      doc
        .getMap(GENERATOR_ACTION_RUNS_CONTAINER)
        .ensureMergeableMap("run-stage-1")
        .set("request", { forged: true }),
    remove: (doc) =>
      doc.getMap(GENERATOR_ACTION_RUNS_CONTAINER).delete("run-stage-1"),
  },
  {
    domain: "Generator",
    label: "Generator output commit",
    container: GENERATOR_OUTPUT_COMMITS_CONTAINER,
    seed: seedGeneratorAuthority,
    forge: (doc) =>
      doc
        .getMap(GENERATOR_OUTPUT_COMMITS_CONTAINER)
        .ensureMergeableMap("run-stage-1")
        .set("image", { forged: true }),
    remove: (doc) =>
      doc.getMap(GENERATOR_OUTPUT_COMMITS_CONTAINER).delete("run-stage-1"),
  },
  {
    domain: "Document Asset",
    label: "Document Asset schema marker",
    container: DOCUMENT_ASSET_SCHEMA_CONTAINER,
    seed: seedDocumentAssetAuthority,
    forge: (doc) =>
      doc
        .getMap(DOCUMENT_ASSET_SCHEMA_CONTAINER)
        .ensureMergeableMap("authorityVersions")
        .set("1", false),
    remove: (doc) =>
      doc.getMap(DOCUMENT_ASSET_SCHEMA_CONTAINER).delete("authorityVersions"),
  },
  {
    domain: "Document Asset",
    label: "Project Document Asset head",
    container: PROJECT_DOCUMENT_ASSETS_CONTAINER,
    seed: seedDocumentAssetAuthority,
    forge: (doc) =>
      doc
        .getMap(PROJECT_DOCUMENT_ASSETS_CONTAINER)
        .ensureMergeableMap("transcript")
        .set("headRevisionId", "transcript:forged"),
    remove: (doc) =>
      doc.getMap(PROJECT_DOCUMENT_ASSETS_CONTAINER).delete("transcript"),
  },
  {
    domain: "Document Asset",
    label: "Document Asset revision",
    container: DOCUMENT_ASSET_REVISIONS_CONTAINER,
    seed: seedDocumentAssetAuthority,
    forge: (doc) =>
      doc
        .getMap(DOCUMENT_ASSET_REVISIONS_CONTAINER)
        .ensureMergeableMap("transcript")
        .set("transcript:r1", { forged: true }),
    remove: (doc) =>
      doc.getMap(DOCUMENT_ASSET_REVISIONS_CONTAINER).delete("transcript"),
  },
  {
    domain: "Document Asset",
    label: "Document attachment",
    container: DOCUMENT_ATTACHMENTS_CONTAINER,
    seed: seedDocumentAssetAuthority,
    forge: (doc) =>
      doc
        .getMap(DOCUMENT_ATTACHMENTS_CONTAINER)
        .ensureMergeableMap("video-transcript")
        .set("slot", "forged"),
    remove: (doc) =>
      doc.getMap(DOCUMENT_ATTACHMENTS_CONTAINER).delete("video-transcript"),
  },
] satisfies HostOwnedAuthorityContainerCase[];

describe("LocalLoroRoom", () => {
  /**
   * A generator the test names, rather than one the host falls into.
   *
   * These cases are about the room -- that a pending node is processed, that a generated path cannot
   * escape the asset store through a symlink -- and neither needs a vendor. The host no longer
   * reaches a placeholder on its own, so the stand-in has to be handed in here, where it is visible.
   */
  function testAigc() {
    return createLocalWorkflowProcessor({
      dataDir,
      assetInspection: testAssetInspection(),
      aigc: createMockExternalAigcService({
        // Named here, in the test, rather than reached by default. The host refuses a route that
        // resolves to nothing, so the stand-in has to be selected like any other provider.
        providerAccounts: async () => [
          {
            id: "mock-primary",
            providerId: "mock",
            upstreamId: "mock",
            enabled: true,
          },
        ],
      }),
    });
  }

  async function peerTimelineSubmission(projectId: string) {
    const assetId = "asset:timeline-input";
    const timelineId = "timeline-canonical";
    const renderNodeId = "timeline-render-node";
    const actionRunId = `timeline-render:${renderNodeId}`;
    const slot = "timeline:item:clip-1";
    const bindingId =
      `action-asset:run:${encodeURIComponent(actionRunId)}` +
      `:input:${encodeURIComponent(slot)}`;
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });
    await room.mutateProject((doc) => {
      for (const [id, digestCharacter] of [
        [assetId, "e"],
        ["asset:other-timeline-input", "f"],
      ] as const) {
        expect(
          createProjectAsset(doc, {
            id,
            kind: "image",
            source: {
              kind: "owned",
              resourceId: `sha256:${digestCharacter.repeat(64)}`,
            },
            lifecycle: { state: "active" },
            metadata: { contentType: "image/png", width: 1, height: 1 },
          }),
        ).toMatchObject({ ok: true });
      }
      expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
      return { value: undefined };
    });
    const peer = room.addPeer(() => {});
    const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
    const version = clientDoc.version();
    expect(
      createProjectTimeline(clientDoc, {
        id: timelineId,
        name: "Canonical Timeline",
        state: {
          compositionWidth: 1_920,
          compositionHeight: 1_080,
          fps: 30,
          tracks: [
            {
              id: "video",
              items: [
                {
                  id: "clip-1",
                  type: "image",
                  from: 0,
                  durationInFrames: 30,
                  assetId,
                },
              ],
            },
          ],
        },
      }),
    ).toMatchObject({ ok: true });
    expect(
      requestTimelineRender(clientDoc, {
        timelineId,
        actorUserId: "local-user",
        generateId: () => renderNodeId,
      }),
    ).toMatchObject({ ok: true, renderNodeId });
    const binding = readActionAssetBinding(clientDoc, bindingId);
    expect(binding).not.toBeNull();
    if (!binding || binding.owner.kind !== "run") {
      throw new Error("Expected a frozen Timeline run input binding.");
    }
    return {
      actionRunId,
      assetId,
      binding,
      bindingId,
      clientDoc,
      peer,
      renderNodeId,
      room,
      version,
    };
  }

  it("drains in-flight Project work and cancels future polls when its hub closes", async () => {
    let releaseWork!: () => void;
    let notifyStarted!: () => void;
    const workStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let processCalls = 0;
    const hub = new LocalLoroRoomHub(dataDir, undefined, {
      minimumPollDelayMs: 1,
      async process() {
        processCalls += 1;
        notifyStarted();
        await workGate;
        return false;
      },
      async nextWakeAt() {
        return Date.now() + 10;
      },
    });

    const opening = hub.room("project/shutdown-drain");
    await workStarted;
    let closeResolved = false;
    const closing = hub.close().then(() => {
      closeResolved = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(closeResolved).toBe(false);

    releaseWork();
    await opening;
    await closing;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    expect(processCalls).toBe(1);
  });

  it("asynchronously refreshes the persisted Main canvas preview after a Project update", async () => {
    const projectId = "project/async-main-preview";
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);

    await hub.mutateProject(projectId, (doc) => {
      doc.getMap("nodes").set("hero", {
        id: "hero",
        type: "image",
        canvasId: "main",
        position: { x: 120, y: 80 },
        width: 640,
        height: 360,
        data: {
          label: "Hero",
          assetId: "asset-hero",
        },
      });
      return { value: undefined };
    });

    const store = new FileReplicaStore(join(dataDir, "projects"));
    await vi.waitFor(
      async () => {
        await expect(store.readCanvasPreview(projectId)).resolves.toMatchObject(
          {
            sourceVersion: expect.any(String),
            preview: {
              canvasId: "main",
              bounds: { x: 120, y: 80, width: 640, height: 360 },
              nodes: [
                expect.objectContaining({
                  id: "hero",
                  assetId: "asset-hero",
                }),
              ],
            },
          },
        );
      },
      { timeout: 2_000, interval: 25 },
    );

    await hub.close();
  });

  it("keeps an imported snapshot invisible to Project rooms until the receiver commit finishes", async () => {
    const projectId = "project/import-reservation";
    const imported = new LoroDoc();
    imported.getMap("nodes").set("portable", {
      id: "portable",
      type: "text",
      position: { x: 0, y: 0 },
      data: { label: "Portable" },
    });
    let notifySnapshotInstalled!: () => void;
    let releaseReceiverCommit!: () => void;
    const snapshotInstalled = new Promise<void>((resolve) => {
      notifySnapshotInstalled = resolve;
    });
    const receiverCommit = new Promise<void>((resolve) => {
      releaseReceiverCommit = resolve;
    });
    const hub = new LocalLoroRoomHub(dataDir, undefined, null);

    const installing = hub.installImportedProject(
      projectId,
      "bundle:" + "a".repeat(64),
      imported.export({ mode: "snapshot" }),
      async () => {
        notifySnapshotInstalled();
        await receiverCommit;
        return "committed";
      },
    );
    await snapshotInstalled;

    await expect(hub.room(projectId)).rejects.toMatchObject({
      code: "PROJECT_BUSY",
      projectId,
    });
    await expect(
      hub.inspectProject(projectId, () => "visible"),
    ).rejects.toMatchObject({ code: "PROJECT_BUSY" });

    releaseReceiverCommit();
    await expect(installing).resolves.toBe("committed");
    await expect(
      hub.inspectProject(
        projectId,
        (doc) =>
          (doc.getMap("nodes").get("portable") as { data: { label: string } })
            .data.label,
      ),
    ).resolves.toBe("Portable");
    await hub.close();
  });

  it("persists a failed import reservation across Hub restart and permits only its exact retry", async () => {
    const projectId = "project/import-retry";
    const reservationId = `workspace-import:${"b".repeat(64)}`;
    const imported = new LoroDoc();
    imported.getMap("nodes").set("portable", {
      id: "portable",
      type: "text",
      position: { x: 0, y: 0 },
      data: { label: "Retryable" },
    });
    const snapshot = imported.export({ mode: "snapshot" });
    const failedHub = new LocalLoroRoomHub(dataDir, undefined, null);

    await expect(
      failedHub.installImportedProject(
        projectId,
        reservationId,
        snapshot,
        async () => {
          throw new Error("injected receiver commit failure");
        },
      ),
    ).rejects.toThrow("injected receiver commit failure");
    await expect(failedHub.room(projectId)).rejects.toMatchObject({
      code: "PROJECT_BUSY",
    });
    await failedHub.close();

    const restartedHub = new LocalLoroRoomHub(dataDir, undefined, null);
    await expect(restartedHub.room(projectId)).rejects.toMatchObject({
      code: "PROJECT_BUSY",
    });
    await expect(
      restartedHub.installImportedProject(
        projectId,
        `workspace-import:${"c".repeat(64)}`,
        snapshot,
        async () => "wrong reservation",
      ),
    ).rejects.toThrow(/another Workspace import/u);
    await expect(
      restartedHub.installImportedProject(
        projectId,
        reservationId,
        snapshot,
        async () => "committed after retry",
      ),
    ).resolves.toBe("committed after retry");
    await expect(
      restartedHub.inspectProject(
        projectId,
        (doc) =>
          (doc.getMap("nodes").get("portable") as { data: { label: string } })
            .data.label,
      ),
    ).resolves.toBe("Retryable");
    await restartedHub.close();
  });

  it("reconciles only an exact committed Workspace import after restart", async () => {
    const projectId = "project/import-receipt-crash";
    const reservationId = `workspace-import:${"d".repeat(64)}`;
    const imported = new LoroDoc();
    imported.getMap("nodes").set("portable", { label: "Committed" });
    const snapshot = imported.export({ mode: "snapshot" });
    const snapshotSha256 = createHash("sha256").update(snapshot).digest("hex");
    const store = new FileReplicaStore(join(dataDir, "projects"));
    const reservation = {
      schemaVersion: 1 as const,
      kind: "clash.workspace.import-reservation" as const,
      reservationId,
      snapshotSha256,
    };
    await store.reserveImportedProject(projectId, reservation);
    await store.installSnapshotIfAbsent(projectId, snapshot);

    const restartedHub = new LocalLoroRoomHub(dataDir, undefined, null);
    await expect(restartedHub.room(projectId)).rejects.toMatchObject({
      code: "PROJECT_BUSY",
    });
    await expect(
      restartedHub.reconcileCommittedImport(
        projectId,
        reservationId,
        snapshotSha256,
      ),
    ).resolves.toBeUndefined();
    await expect(store.readImportReservation(projectId)).resolves.toBeNull();
    await expect(
      restartedHub.inspectProject(
        projectId,
        (doc) =>
          (doc.getMap("nodes").get("portable") as { label: string }).label,
      ),
    ).resolves.toBe("Committed");
    await restartedHub.close();
  });

  it("keeps mismatched or corrupt committed-import recovery fail closed", async () => {
    const imported = new LoroDoc();
    imported.getMap("nodes").set("portable", { label: "Expected" });
    const snapshot = imported.export({ mode: "snapshot" });
    const snapshotSha256 = createHash("sha256").update(snapshot).digest("hex");
    const store = new FileReplicaStore(join(dataDir, "projects"));

    const mismatchedProject = "project/import-reconcile-mismatch";
    await store.reserveImportedProject(mismatchedProject, {
      schemaVersion: 1,
      kind: "clash.workspace.import-reservation",
      reservationId: "workspace-import:other",
      snapshotSha256,
    });
    await store.installSnapshotIfAbsent(mismatchedProject, snapshot);

    const corruptProject = "project/import-reconcile-corrupt";
    await store.reserveImportedProject(corruptProject, {
      schemaVersion: 1,
      kind: "clash.workspace.import-reservation",
      reservationId: "workspace-import:expected",
      snapshotSha256,
    });
    const different = new LoroDoc();
    different.getMap("nodes").set("portable", { label: "Different" });
    await store.installSnapshotIfAbsent(
      corruptProject,
      different.export({ mode: "snapshot" }),
    );

    const hub = new LocalLoroRoomHub(dataDir, undefined, null);
    await expect(
      hub.reconcileCommittedImport(
        mismatchedProject,
        "workspace-import:expected",
        snapshotSha256,
      ),
    ).rejects.toThrow(/another Workspace import/u);
    await expect(
      hub.reconcileCommittedImport(
        corruptProject,
        "workspace-import:expected",
        snapshotSha256,
      ),
    ).rejects.toThrow(/does not match/u);
    await expect(
      store.readImportReservation(mismatchedProject),
    ).resolves.not.toBeNull();
    await expect(
      store.readImportReservation(corruptProject),
    ).resolves.not.toBeNull();
    await hub.close();
  });

  it("acknowledges a peer update after persisting it", async () => {
    const order: string[] = [];
    const originalAppendUpdate = FileReplicaStore.prototype.appendUpdate;
    vi.spyOn(FileReplicaStore.prototype, "appendUpdate").mockImplementation(
      async function (this: FileReplicaStore, projectId, update) {
        order.push("append");
        await originalAppendUpdate.call(this, projectId, update);
      },
    );
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/sync-ack",
      workflowProcessor: null,
    });
    const sideband: Record<string, unknown>[] = [];
    const peer = room.addPeer(() => {}, {
      sendJson: (message) => {
        sideband.push(message);
        if (message.type === "sync_ack") order.push("ack");
      },
    });
    const clientDoc = new LoroDoc();
    clientDoc.getMap("nodes").set("pending-node", {
      id: "pending-node",
      type: "video",
      position: { x: 0, y: 0 },
      data: { status: "pending" },
    });

    const update = clientDoc.export({ mode: "snapshot" });
    await room.receive(peer, update);

    expect(sideband).toContainEqual({
      type: "sync_ack",
      updateId: updateId(update),
    });
    expect(order.indexOf("append")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("ack")).toBeGreaterThan(order.indexOf("append"));
  });

  it("rejects a peer-authored Project Asset before it can bypass Host L0/L1 publication", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/asset-authority-boundary",
      workflowProcessor: null,
    });
    const sideband: Record<string, unknown>[] = [];
    const peer = room.addPeer(() => {}, {
      sendJson: (message) => sideband.push(message),
    });
    const clientDoc = new LoroDoc();
    expect(
      createProjectAsset(clientDoc, {
        id: "asset:forged",
        kind: "image",
        source: { kind: "owned", resourceId: `sha256:${"f".repeat(64)}` },
        lifecycle: { state: "active" },
        metadata: { contentType: "image/png", width: 1, height: 1 },
      }),
    ).toMatchObject({ ok: true });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "snapshot" })),
    ).rejects.toThrow(/Project Asset authority/i);

    expect(
      readProjectAsset(LoroDoc.fromSnapshot(room.snapshot()), "asset:forged"),
    ).toBeNull();
    expect(sideband).not.toContainEqual(
      expect.objectContaining({ type: "sync_ack" }),
    );
  });

  describe.each(HOST_OWNED_AUTHORITY_CONTAINER_CASES)(
    "$label peer authority boundary",
    ({ container, domain, forge, remove, seed }) => {
      const authorityError = new RegExp(`${domain} authority`, "i");

      it("rejects creation through a raw peer update", async () => {
        const room = await LocalLoroRoom.open({
          dataDir,
          projectId: `project/${encodeURIComponent(container)}-peer-create`,
          workflowProcessor: null,
        });
        const peer = room.addPeer(() => {});
        const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
        const version = clientDoc.version();
        const before = clientDoc.getMap(container).toJSON();
        forge(clientDoc);
        expect(clientDoc.getMap(container).toJSON()).not.toEqual(before);

        await expect(
          room.receive(
            peer,
            clientDoc.export({ mode: "update", from: version }),
          ),
        ).rejects.toThrow(authorityError);

        expect(
          LoroDoc.fromSnapshot(room.snapshot()).getMap(container).toJSON(),
        ).toEqual(before);
      });

      it("accepts an ordinary edit from an existing replica but rejects mutation of its Host-owned facts", async () => {
        const room = await LocalLoroRoom.open({
          dataDir,
          projectId: `project/${encodeURIComponent(container)}-peer-update`,
          workflowProcessor: null,
        });
        await room.mutateProject((doc) => {
          seed(doc);
          return { value: undefined };
        });
        const peer = room.addPeer(() => {});
        const replica = LoroDoc.fromSnapshot(room.snapshot());
        const authorityBefore = replica.getMap(container).toJSON();
        expect(authorityBefore).not.toEqual({});
        const replicaVersion = replica.version();
        replica.getMap("nodes").set("ordinary-peer-node", {
          id: "ordinary-peer-node",
          type: "text",
          position: { x: 0, y: 0 },
          data: { text: "ordinary peer edit" },
        });

        await expect(
          room.receive(
            peer,
            replica.export({ mode: "update", from: replicaVersion }),
          ),
        ).resolves.toBeUndefined();
        expect(
          LoroDoc.fromSnapshot(room.snapshot()).getMap(container).toJSON(),
        ).toEqual(authorityBefore);

        const attacker = LoroDoc.fromSnapshot(room.snapshot());
        const attackerVersion = attacker.version();
        forge(attacker);
        expect(attacker.getMap(container).toJSON()).not.toEqual(
          authorityBefore,
        );

        await expect(
          room.receive(
            peer,
            attacker.export({ mode: "update", from: attackerVersion }),
          ),
        ).rejects.toThrow(authorityError);
        expect(
          LoroDoc.fromSnapshot(room.snapshot()).getMap(container).toJSON(),
        ).toEqual(authorityBefore);
      });

      it("rejects deletion through a raw peer update", async () => {
        const room = await LocalLoroRoom.open({
          dataDir,
          projectId: `project/${encodeURIComponent(container)}-peer-delete`,
          workflowProcessor: null,
        });
        await room.mutateProject((doc) => {
          seed(doc);
          return { value: undefined };
        });
        const peer = room.addPeer(() => {});
        const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
        const version = clientDoc.version();
        const before = clientDoc.getMap(container).toJSON();
        remove(clientDoc);
        expect(clientDoc.getMap(container).toJSON()).not.toEqual(before);

        await expect(
          room.receive(
            peer,
            clientDoc.export({ mode: "update", from: version }),
          ),
        ).rejects.toThrow(authorityError);
        expect(
          LoroDoc.fromSnapshot(room.snapshot()).getMap(container).toJSON(),
        ).toEqual(before);
      });
    },
  );

  it("accepts peer-authored draft inputs but rejects peer-authored run output lineage", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/binding-authority-boundary",
      workflowProcessor: null,
    });
    await room.mutateProject((doc) => {
      expect(
        createProjectAsset(doc, {
          id: "asset:verified",
          kind: "image",
          source: {
            kind: "owned",
            resourceId: `sha256:${"a".repeat(64)}`,
          },
          lifecycle: { state: "active" },
          metadata: { contentType: "image/png", width: 1, height: 1 },
        }),
      ).toMatchObject({ ok: true });
      expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
      return { value: undefined };
    });

    const peer = room.addPeer(() => {});
    const draftDoc = LoroDoc.fromSnapshot(room.snapshot());
    const draftVersion = draftDoc.version();
    expect(
      createActionAssetBinding(draftDoc, {
        id: "binding:draft-input",
        owner: { kind: "draft", actionId: "action:draft" },
        direction: "input",
        slot: "reference",
        projectAssetId: "asset:verified",
      }),
    ).toMatchObject({ ok: true });
    await expect(
      room.receive(
        peer,
        draftDoc.export({ mode: "update", from: draftVersion }),
      ),
    ).resolves.toBeUndefined();

    const forgedDoc = LoroDoc.fromSnapshot(room.snapshot());
    const forgedVersion = forgedDoc.version();
    expect(
      createActionAssetBinding(forgedDoc, {
        id: "binding:forged-output",
        owner: {
          kind: "run",
          actionId: "action:forged",
          actionRevisionId: "revision:forged",
          actionRunId: "run:forged",
        },
        direction: "output",
        slot: "output",
        projectAssetId: "asset:verified",
      }),
    ).toMatchObject({ ok: true });

    await expect(
      room.receive(
        peer,
        forgedDoc.export({ mode: "update", from: forgedVersion }),
      ),
    ).rejects.toThrow(/output lineage/i);
    expect(
      readActionAssetBinding(
        LoroDoc.fromSnapshot(room.snapshot()),
        "binding:forged-output",
      ),
    ).toBeNull();
  });

  it("rejects a peer-authored removal of Host-published output lineage", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/binding-output-removal",
      workflowProcessor: null,
    });
    await room.mutateProject((doc) => {
      expect(
        createProjectAsset(doc, {
          id: "asset:output",
          kind: "image",
          source: {
            kind: "owned",
            resourceId: `sha256:${"b".repeat(64)}`,
          },
          lifecycle: { state: "active" },
          metadata: { contentType: "image/png", width: 1, height: 1 },
        }),
      ).toMatchObject({ ok: true });
      expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
      expect(
        createActionAssetBinding(doc, {
          id: "binding:host-output",
          owner: {
            kind: "run",
            actionId: "action:host",
            actionRevisionId: "revision:host",
            actionRunId: "run:host",
          },
          direction: "output",
          slot: "output",
          projectAssetId: "asset:output",
        }),
      ).toMatchObject({ ok: true });
      return { value: undefined };
    });
    const peer = room.addPeer(() => {});
    const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
    const version = clientDoc.version();
    expect(
      unbindActionAssetBinding(clientDoc, "binding:host-output"),
    ).toMatchObject({ ok: true });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/output lineage/i);
    expect(
      readActionAssetBinding(
        LoroDoc.fromSnapshot(room.snapshot()),
        "binding:host-output",
      ),
    ).not.toBeNull();
  });

  it("rejects peer-authored Action binding authority markers", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/binding-schema-authority",
      workflowProcessor: null,
    });
    const peer = room.addPeer(() => {});
    const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
    const version = clientDoc.version();
    expect(markActionAssetBindingAuthority(clientDoc)).toMatchObject({
      ok: true,
    });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/binding authority/i);
  });

  it("rejects a peer-authored draft input whose Project Asset is not active", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/binding-inactive-target",
      workflowProcessor: null,
    });
    await room.mutateProject((doc) => {
      expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
      return { value: undefined };
    });
    const peer = room.addPeer(() => {});
    const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
    const version = clientDoc.version();
    clientDoc.getMap("actionAssetBindings").set("binding:missing-target", {
      id: "binding:missing-target",
      owner: { kind: "draft", actionId: "action:draft" },
      direction: "input",
      slot: "reference",
      projectAssetId: "asset:missing",
    });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/not active/i);
  });

  it("rejects a stale peer draft input after its Project Asset was purged without importing it", async () => {
    const projectId = "project/binding-purged-target";
    const assetId = "asset:purged-draft-input";
    const bindingId = "binding:purged-draft-input";
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });
    await room.mutateProject((doc) => {
      expect(
        createProjectAsset(doc, {
          id: assetId,
          kind: "image",
          source: {
            kind: "owned",
            resourceId: "sha256:" + "1".repeat(64),
          },
          lifecycle: { state: "active" },
          metadata: { contentType: "image/png", width: 1, height: 1 },
        }),
      ).toMatchObject({ ok: true });
      expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
      return { value: undefined };
    });

    const peer = room.addPeer(() => {});
    const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
    const version = clientDoc.version();
    expect(
      createActionAssetBinding(clientDoc, {
        id: bindingId,
        owner: { kind: "draft", actionId: "action:draft" },
        direction: "input",
        slot: "reference",
        projectAssetId: assetId,
      }),
    ).toMatchObject({ ok: true });

    await room.mutateProject((doc) => {
      expect(
        trashProjectAssetIfUnreferenced(doc, {
          id: assetId,
          deleteOperationId: "delete-purged-draft-input",
          deletedAt: "2026-08-13T00:00:00.000Z",
          purgeAfter: "2026-08-20T00:00:00.000Z",
        }),
      ).toMatchObject({ ok: true });
      expect(
        purgeProjectAsset(doc, {
          id: assetId,
          deleteOperationId: "delete-purged-draft-input",
          purgedAt: "2026-08-21T00:00:00.000Z",
        }),
      ).toMatchObject({ ok: true });
      return { value: undefined };
    });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/not active/i);

    expect(
      readActionAssetBinding(LoroDoc.fromSnapshot(room.snapshot()), bindingId),
    ).toBeNull();
    const persisted = await new FileReplicaStore(
      join(dataDir, "projects"),
    ).recover(projectId);
    expect(readActionAssetBinding(persisted, bindingId)).toBeNull();
  });

  it("rejects peer-authored frozen run inputs outside a matching Timeline submission", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/forged-run-input",
      workflowProcessor: null,
    });
    await room.mutateProject((doc) => {
      expect(
        createProjectAsset(doc, {
          id: "asset:input",
          kind: "image",
          source: {
            kind: "owned",
            resourceId: `sha256:${"c".repeat(64)}`,
          },
          lifecycle: { state: "active" },
          metadata: { contentType: "image/png", width: 1, height: 1 },
        }),
      ).toMatchObject({ ok: true });
      expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
      return { value: undefined };
    });
    const peer = room.addPeer(() => {});
    const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
    const version = clientDoc.version();
    expect(
      createActionAssetBinding(clientDoc, {
        id: "binding:forged-run-input",
        owner: {
          kind: "run",
          actionId: "action:forged",
          actionRevisionId: "revision:forged",
          actionRunId: "run:forged",
        },
        direction: "input",
        slot: "reference",
        projectAssetId: "asset:input",
      }),
    ).toMatchObject({ ok: true });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/frozen run input/i);
  });

  it("rejects a peer run input vouched for only by forged Timeline fields on a non-Timeline node", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/forged-run-input-node",
      workflowProcessor: null,
    });
    await room.mutateProject((doc) => {
      expect(
        createProjectAsset(doc, {
          id: "asset:forged-input",
          kind: "image",
          source: {
            kind: "owned",
            resourceId: `sha256:${"d".repeat(64)}`,
          },
          lifecycle: { state: "active" },
          metadata: { contentType: "image/png", width: 1, height: 1 },
        }),
      ).toMatchObject({ ok: true });
      expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
      return { value: undefined };
    });
    const peer = room.addPeer(() => {});
    const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
    const version = clientDoc.version();
    clientDoc.getMap("nodes").set("forged-text-node", {
      id: "forged-text-node",
      type: "text",
      data: {
        status: "pending",
        sourceTimelineActionId: "timeline:forged",
        sourceTimelineRevisionId: "revision:forged",
        sourceTimelineActionRunId: "timeline-render:forged-text-node",
      },
    });
    expect(
      createActionAssetBinding(clientDoc, {
        id: "binding:forged-node-run-input",
        owner: {
          kind: "run",
          actionId: "timeline:forged",
          actionRevisionId: "revision:forged",
          actionRunId: "timeline-render:forged-text-node",
        },
        direction: "input",
        slot: "timeline:item:forged",
        projectAssetId: "asset:forged-input",
        role: "source",
      }),
    ).toMatchObject({ ok: true });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/matching Timeline submission/i);
  });

  it("accepts the exact frozen inputs created by a canonical peer Timeline submission", async () => {
    const { clientDoc, peer, room, version } = await peerTimelineSubmission(
      "project/canonical-peer-timeline-submission",
    );

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).resolves.toBeUndefined();
  });

  it("rejects a canonical peer Timeline run input after its Project Asset was purged", async () => {
    const projectId = "project/purged-peer-timeline-input";
    const { assetId, bindingId, clientDoc, peer, room, version } =
      await peerTimelineSubmission(projectId);
    await room.mutateProject((doc) => {
      expect(
        trashProjectAssetIfUnreferenced(doc, {
          id: assetId,
          deleteOperationId: "delete-purged-timeline-input",
          deletedAt: "2026-08-13T00:00:00.000Z",
          purgeAfter: "2026-08-20T00:00:00.000Z",
        }),
      ).toMatchObject({ ok: true });
      expect(
        purgeProjectAsset(doc, {
          id: assetId,
          deleteOperationId: "delete-purged-timeline-input",
          purgedAt: "2026-08-21T00:00:00.000Z",
        }),
      ).toMatchObject({ ok: true });
      return { value: undefined };
    });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/not active/i);
    expect(
      readActionAssetBinding(LoroDoc.fromSnapshot(room.snapshot()), bindingId),
    ).toBeNull();
  });

  it("rejects a non-video render node even when its Timeline lineage is otherwise canonical", async () => {
    const { clientDoc, peer, renderNodeId, room, version } =
      await peerTimelineSubmission("project/forged-peer-timeline-node-type");
    const renderNode = clientDoc.getMap("nodes").get(renderNodeId) as Record<
      string,
      unknown
    >;
    clientDoc.getMap("nodes").set(renderNodeId, {
      ...renderNode,
      type: "text",
    });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/matching Timeline submission/i);
  });

  it("rejects a peer Timeline run input whose self-reported revision differs from the canonical Timeline", async () => {
    const {
      assetId,
      binding,
      bindingId,
      clientDoc,
      peer,
      renderNodeId,
      room,
      version,
    } = await peerTimelineSubmission("project/forged-peer-timeline-revision");
    expect(
      updateActionAssetBinding(clientDoc, {
        ...binding,
        owner: {
          ...binding.owner,
          actionRevisionId: "revision:forged",
        },
        projectAssetId: assetId,
      }),
    ).toMatchObject({ ok: true });
    const renderNode = clientDoc.getMap("nodes").get(renderNodeId) as Record<
      string,
      any
    >;
    clientDoc.getMap("nodes").set(renderNodeId, {
      ...renderNode,
      data: {
        ...renderNode.data,
        sourceTimelineRevisionId: "revision:forged",
      },
    });
    expect(readActionAssetBinding(clientDoc, bindingId)?.owner).toMatchObject({
      actionRevisionId: "revision:forged",
    });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/matching Timeline submission/i);
  });

  it("rejects a peer Timeline submission with an extra frozen run input", async () => {
    const { assetId, binding, clientDoc, peer, room, version } =
      await peerTimelineSubmission("project/forged-peer-timeline-input-set");
    expect(
      createActionAssetBinding(clientDoc, {
        id: "binding:extra-timeline-run-input",
        owner: binding.owner,
        direction: "input",
        slot: "timeline:item:extra",
        projectAssetId: assetId,
        role: "source",
      }),
    ).toMatchObject({ ok: true });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/matching Timeline submission/i);
  });

  it("rejects a peer Timeline submission whose frozen input is rewired from its canonical item", async () => {
    const { binding, clientDoc, peer, room, version } =
      await peerTimelineSubmission("project/rewired-peer-timeline-input-set");
    expect(
      updateActionAssetBinding(clientDoc, {
        ...binding,
        projectAssetId: "asset:other-timeline-input",
      }),
    ).toMatchObject({ ok: true });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/matching Timeline submission/i);
  });

  it("rejects a peer Timeline submission whose render DSL differs from its canonical revision", async () => {
    const { clientDoc, peer, renderNodeId, room, version } =
      await peerTimelineSubmission("project/forged-peer-timeline-dsl");
    const renderNode = clientDoc.getMap("nodes").get(renderNodeId) as Record<
      string,
      any
    >;
    clientDoc.getMap("nodes").set(renderNodeId, {
      ...renderNode,
      data: {
        ...renderNode.data,
        timelineDsl: {
          ...renderNode.data.timelineDsl,
          tracks: [
            {
              id: "video",
              items: [
                {
                  id: "forged-clip",
                  type: "image",
                  from: 0,
                  durationInFrames: 30,
                  assetId: "asset:timeline-input",
                },
              ],
            },
          ],
        },
      },
    });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/matching Timeline submission/i);
  });

  it("rejects a peer Timeline run id that is not derived from its render node id", async () => {
    const { binding, clientDoc, peer, renderNodeId, room, version } =
      await peerTimelineSubmission("project/forged-peer-timeline-run-id");
    const forgedRunId = "timeline-render:another-node";
    expect(
      updateActionAssetBinding(clientDoc, {
        ...binding,
        owner: { ...binding.owner, actionRunId: forgedRunId },
      }),
    ).toMatchObject({ ok: true });
    const renderNode = clientDoc.getMap("nodes").get(renderNodeId) as Record<
      string,
      any
    >;
    clientDoc.getMap("nodes").set(renderNodeId, {
      ...renderNode,
      data: {
        ...renderNode.data,
        sourceTimelineActionRunId: forgedRunId,
      },
    });

    await expect(
      room.receive(peer, clientDoc.export({ mode: "update", from: version })),
    ).rejects.toThrow(/matching Timeline submission/i);
  });

  it("restores a trashed Project Asset when a concurrent input binding arrives", async () => {
    const projectId = "project/asset-binding-race";
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });
    await room.mutateProject((doc) => {
      expect(
        createProjectAsset(doc, {
          id: "asset-1",
          kind: "image",
          source: { kind: "owned", resourceId: "sha256:asset-1" },
          lifecycle: { state: "active" },
          metadata: {},
        }),
      ).toMatchObject({ ok: true });
      expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
      return { value: undefined };
    });

    const snapshot = room.snapshot();
    const bindingPeer = LoroDoc.fromSnapshot(snapshot);
    const bindingVersion = bindingPeer.version();
    expect(
      createActionAssetBinding(bindingPeer, {
        id: "binding-1",
        owner: { kind: "draft", actionId: "action-1" },
        direction: "input",
        slot: "reference",
        projectAssetId: "asset-1",
        role: "reference",
      }),
    ).toMatchObject({ ok: true });

    await room.mutateProject((doc) => {
      expect(
        trashProjectAssetIfUnreferenced(doc, {
          id: "asset-1",
          deleteOperationId: "delete-1",
          deletedAt: "2026-08-13T00:00:00.000Z",
          purgeAfter: "2026-08-20T00:00:00.000Z",
        }),
      ).toMatchObject({ ok: true });
      return { value: undefined };
    });
    expect(
      readProjectAsset(LoroDoc.fromSnapshot(room.snapshot()), "asset-1")
        ?.lifecycle.state,
    ).toBe("trashed");

    const observerUpdates: Uint8Array[] = [];
    const observer = new LoroDoc();
    room.addPeer((update) => observerUpdates.push(update));
    observer.import(observerUpdates.shift()!);
    const bindingSender = room.addPeer(() => {});
    await room.receive(
      bindingSender,
      bindingPeer.export({ mode: "update", from: bindingVersion }),
    );
    for (const update of observerUpdates) observer.import(update);

    expect(readProjectAsset(observer, "asset-1")?.lifecycle).toEqual({
      state: "active",
    });
    expect(readActionAssetBinding(observer, "binding-1")).toMatchObject({
      projectAssetId: "asset-1",
      direction: "input",
    });
    const persisted = await new FileReplicaStore(
      join(dataDir, "projects"),
    ).recover(projectId);
    expect(readProjectAsset(persisted, "asset-1")?.lifecycle.state).toBe(
      "active",
    );
  });

  it("serializes concurrent pending-work scans so one Canvas execute submits once", async () => {
    let releaseGeneration!: () => void;
    let markStarted!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const generateVideo = vi.fn(async () => {
      markStarted();
      await generationGate;
      return {
        bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
        contentType: "video/mp4",
        provider: "google",
        modelEndpoint: "gemini-omni-flash-preview",
      };
    });
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/concurrent-provider-submit",
      workflowProcessor: createLocalWorkflowProcessor({
        dataDir,
        aigc: {
          generateVideo,
          generateImage: vi.fn(),
          generateAudio: vi.fn(),
          generateText: vi.fn(),
        },
      }),
    });
    const firstPeer = room.addPeer(() => {});
    const secondPeer = room.addPeer(() => {});
    const executeDoc = new LoroDoc();
    executeDoc.getMap("nodes").set("gemini-output", {
      id: "gemini-output",
      type: "video",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "video-gen",
        prompt: "text @[Image](node:image-ref) text",
        modelId: "gemini-omni-flash",
        duration: 3,
        aspectRatio: "16:9",
      },
    });

    const firstReceive = room.receive(
      firstPeer,
      executeDoc.export({ mode: "snapshot" }),
    );
    await generationStarted;

    const concurrentDoc = new LoroDoc();
    concurrentDoc.import(room.snapshot());
    concurrentDoc.getMap("e2e").set("heartbeat", Date.now());
    const secondReceive = room.receive(
      secondPeer,
      concurrentDoc.export({ mode: "snapshot" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(generateVideo).toHaveBeenCalledTimes(1);
    releaseGeneration();
    await Promise.all([firstReceive, secondReceive]);
    expect(generateVideo).toHaveBeenCalledTimes(1);
  });

  it("schedules durable recovery from the processor journal wake time, not node poll fields", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const projectId = "project/durable-provider-wake";
    const seedRoom = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });
    const seedPeer = seedRoom.addPeer(() => {});
    const seed = new LoroDoc();
    seed.getMap("nodes").set("legacy-private-state", {
      id: "legacy-private-state",
      type: "video",
      position: { x: 0, y: 0 },
      data: {
        status: "generating",
        actionType: "video-gen",
        providerPollState: { taskId: "legacy-task" },
        providerPollAt: now + 100,
      },
    });
    await seedRoom.receive(seedPeer, seed.export({ mode: "snapshot" }));

    const process = vi.fn(async () => false);
    const nextWakeAt = vi
      .fn()
      .mockResolvedValueOnce(now + 5_000)
      .mockResolvedValue(undefined);
    await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: { process, nextWakeAt },
    });
    await vi.advanceTimersByTimeAsync(4_999);

    expect(process).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(process).toHaveBeenCalledTimes(2);
    expect(nextWakeAt).toHaveBeenCalledWith(projectId);
  });

  it("flattens authored inline references only at the local provider boundary", async () => {
    const generateText = vi.fn(async () => ({
      text: "Compared",
      provider: "mock",
    }));
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/local-interleaved-text",
      workflowProcessor: createLocalWorkflowProcessor({
        dataDir,
        aigc: {
          generateText,
          generateVideo: vi.fn(),
          generateImage: vi.fn(),
          generateAudio: vi.fn(),
        },
      }),
    });
    const peer = room.addPeer(() => {});
    const clientDoc = new LoroDoc();
    clientDoc.getMap("nodes").set("text-node", {
      id: "text-node",
      type: "text",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "text-gen",
        prompt: "Compare @[First](node:image-a), then @[Second](node:image-b).",
        modelId: "gpt-5.4",
        modelParams: {},
      },
    });

    await room.receive(peer, clientDoc.export({ mode: "snapshot" }));

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Compare First, then Second.",
      }),
    );
  });

  it("maps the unified H3 start/end card slots before calling the desktop provider", async () => {
    const generateVideo = vi.fn(async () => ({
      bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
      contentType: "video/mp4",
      provider: "minimax",
      modelEndpoint: "MiniMax-H3",
    }));
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/h3-startend",
      workflowProcessor: createLocalWorkflowProcessor({
        dataDir,
        aigc: {
          generateVideo,
          generateImage: vi.fn(),
          generateAudio: vi.fn(),
          generateText: vi.fn(),
        },
      }),
    });
    await room.mutateProject((doc) => {
      for (const [id, originalName] of [
        ["asset-start", "start.png"],
        ["asset-end", "end.png"],
      ] as const) {
        expect(
          createProjectAsset(doc, {
            id,
            kind: "image",
            source: { kind: "owned", resourceId: `sha256:${id}` },
            lifecycle: { state: "active" },
            metadata: { contentType: "image/png", originalName },
          }),
        ).toMatchObject({ ok: true });
      }
      return { value: undefined };
    });
    const peer = room.addPeer(() => {});
    const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
    const clientVersion = clientDoc.version();
    clientDoc.getMap("nodes").set("h3-startend-node", {
      id: "h3-startend-node",
      type: "video",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "video-gen",
        prompt: "transition between frames",
        modelId: "minimax-h3-startend",
        referenceImageAssetIds: ["asset-start", "asset-end"],
      },
    });

    await room.receive(
      peer,
      clientDoc.export({ mode: "update", from: clientVersion }),
    );

    expect(generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "minimax-h3-startend",
        references: [
          {
            slot: "startFrame",
            index: 0,
            asset: {
              assetId: "asset-start",
              uri: "clash-asset://asset-start",
              kind: "image",
              mediaType: "image/png",
            },
          },
          {
            slot: "endFrame",
            index: 0,
            asset: {
              assetId: "asset-end",
              uri: "clash-asset://asset-end",
              kind: "image",
              mediaType: "image/png",
            },
          },
        ],
      }),
    );
    expect(generateVideo).toHaveBeenCalledWith(
      expect.not.objectContaining({
        referenceImageUrls: expect.anything(),
      }),
    );
  });

  it("uses a hot-loaded plugin model Card when interpreting pending Canvas inputs", async () => {
    const generateVideo = vi.fn(async () => ({
      bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
      contentType: "video/mp4",
      provider: "agent-provider",
      modelEndpoint: "agent/start-end",
    }));
    const baseStartEnd = MODEL_CARDS.find(
      (model) => model.id === "minimax-h3-startend",
    )!;
    const pluginCard = {
      ...baseStartEnd,
      id: "agent-start-end",
      aliases: [],
      name: "Agent Start End",
    };
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/plugin-card-startend",
      workflowProcessor: createLocalWorkflowProcessor({
        dataDir,
        modelCards: async () => [...MODEL_CARDS, pluginCard],
        aigc: {
          generateVideo,
          generateImage: vi.fn(),
          generateAudio: vi.fn(),
          generateText: vi.fn(),
        },
      }),
    });
    await room.mutateProject((doc) => {
      for (const [id, originalName] of [
        ["plugin-asset-start", "start.png"],
        ["plugin-asset-end", "end.png"],
      ] as const) {
        expect(
          createProjectAsset(doc, {
            id,
            kind: "image",
            source: { kind: "owned", resourceId: `sha256:${id}` },
            lifecycle: { state: "active" },
            metadata: { contentType: "image/png", originalName },
          }),
        ).toMatchObject({ ok: true });
      }
      return { value: undefined };
    });
    const peer = room.addPeer(() => {});
    const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
    const clientVersion = clientDoc.version();
    clientDoc.getMap("nodes").set("plugin-startend-node", {
      id: "plugin-startend-node",
      type: "video",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "video-gen",
        prompt: "transition",
        modelId: "agent-start-end",
        referenceImageAssetIds: ["plugin-asset-start", "plugin-asset-end"],
      },
    });

    await room.receive(
      peer,
      clientDoc.export({ mode: "update", from: clientVersion }),
    );

    expect(generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "agent-start-end",
        references: [
          {
            slot: "startFrame",
            index: 0,
            asset: {
              assetId: "plugin-asset-start",
              uri: "clash-asset://plugin-asset-start",
              kind: "image",
              mediaType: "image/png",
            },
          },
          {
            slot: "endFrame",
            index: 0,
            asset: {
              assetId: "plugin-asset-end",
              uri: "clash-asset://plugin-asset-end",
              kind: "image",
              mediaType: "image/png",
            },
          },
        ],
      }),
    );
  });

  it("executes a pinned local action plugin directly without legacy runtime registration", async () => {
    const binding = {
      pluginId: "test.agent-caption-actions",
      version: "1.2.0",
      exportId: "run-caption-helper",
      schemaHash: `sha256:${"c".repeat(64)}`,
    } as const;
    const executablePluginAction = vi.fn(async () => ({
      protocol: "clash.plugin.result/v1" as const,
      invocationId: "result-action-1",
      status: "completed" as const,
      outputs: [
        { slot: "result", kind: "value" as const, value: { text: "Done" } },
      ],
    }));
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/plugin-action",
      workflowProcessor: createLocalWorkflowProcessor({
        dataDir,
        executablePluginAction,
        aigc: {
          generateVideo: vi.fn(),
          generateImage: vi.fn(),
          generateAudio: vi.fn(),
          generateText: vi.fn(),
        },
      }),
    });
    const peer = room.addPeer(() => {});
    const clientDoc = new LoroDoc();
    clientDoc.getMap("nodes").set("plugin-action-node", {
      id: "plugin-action-node",
      type: "text",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "custom:caption-helper",
        customActionId: "test.caption-helper",
        customActionParams: { tone: "concise" },
        outputType: "text",
        prompt: "Caption this",
        pluginBinding: binding,
        actorType: "user",
        actorUserId: "local-user",
      },
    });

    await room.receive(peer, clientDoc.export({ mode: "snapshot" }));

    expect(executablePluginAction).toHaveBeenCalledWith(
      expect.objectContaining({
        binding,
        taskId: expect.stringMatching(
          /^project:project\/plugin-action:node:plugin-action-node:revision:[a-f0-9]{64}$/,
        ),
        projectId: "project/plugin-action",
        nodeId: "plugin-action-node",
        input: {
          values: { prompt: "Caption this", tone: "concise" },
          references: [],
        },
        actor: { kind: "user", id: "local-user" },
      }),
    );
    const finalDoc = new LoroDoc();
    finalDoc.import(room.snapshot());
    expect(finalDoc.getMap("nodes").get("plugin-action-node")).toMatchObject({
      data: { status: "completed", content: "Done", pluginBinding: binding },
    });
  });

  it("publishes a staged plugin output and its Action binding in the live Project replica", async () => {
    const projectId = "project/plugin-media-action";
    const staging = createLocalPluginAssetStagingStore({ dataDir });
    const binding = {
      pluginId: "test.agent-image-actions",
      version: "1.0.0",
      exportId: "run-image-helper",
      schemaHash: `sha256:${"d".repeat(64)}`,
    } as const;
    let actionRunId = "";
    const executablePluginAction = vi.fn(
      async (request: { taskId: string }) => {
        actionRunId = request.taskId;
        const staged = await staging.stage({
          projectId,
          taskId: request.taskId,
          slot: "media",
          pluginId: binding.pluginId,
          pluginVersion: binding.version,
          invocationId: "invoke-media-1",
          kind: "image",
          mediaType: "image/png",
          bytes: new Uint8Array([1, 2, 3]),
        });
        return {
          protocol: "clash.plugin.result/v1" as const,
          invocationId: "result-media-1",
          status: "completed" as const,
          outputs: [
            {
              slot: "media",
              kind: "asset" as const,
              asset: {
                assetId: staged.projectAssetId,
                uri: `clash-asset://${staged.projectAssetId}`,
                kind: "image" as const,
                mediaType: "image/png",
              },
            },
          ],
        };
      },
    );
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: createLocalWorkflowProcessor({
        dataDir,
        assetInspection: testAssetInspection(),
        executablePluginAction,
        aigc: {
          generateVideo: vi.fn(),
          generateImage: vi.fn(),
          generateAudio: vi.fn(),
          generateText: vi.fn(),
        },
      }),
    });
    const peer = room.addPeer(() => {});
    const clientDoc = new LoroDoc();
    clientDoc.getMap("nodes").set("plugin-media-node", {
      id: "plugin-media-node",
      type: "image",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "custom:image-helper",
        customActionId: "test.image-helper",
        outputType: "image",
        prompt: "Create this",
        pluginBinding: binding,
      },
    });

    await room.receive(peer, clientDoc.export({ mode: "snapshot" }));
    const staged = await staging.resolve({
      projectId,
      projectAssetId: staging.projectAssetId({
        projectId,
        taskId: actionRunId,
        slot: "media",
      }),
    });
    expect(staged).toBeDefined();
    if (!staged) throw new Error("Expected the Action output to be staged.");

    const finalDoc = new LoroDoc();
    finalDoc.import(room.snapshot());
    expect(finalDoc.getMap("nodes").get("plugin-media-node")).toMatchObject({
      data: { status: "completed", assetId: staged.projectAssetId },
    });
    expect(readProjectAsset(finalDoc, staged.projectAssetId)).toMatchObject({
      id: staged.projectAssetId,
      kind: "image",
      source: { kind: "owned", resourceId: staged.resourceId },
      lifecycle: { state: "active" },
    });
    expect(listActionAssetReferences(finalDoc, staged.projectAssetId)).toEqual([
      expect.objectContaining({
        direction: "output",
        slot: "media",
        projectAssetId: staged.projectAssetId,
        owner: expect.objectContaining({ actionRunId }),
      }),
    ]);
  });

  it("pins the exact executable provider plugin binding on the generated Canvas node", async () => {
    const authoredBinding = {
      pluginId: "clash.minimax",
      version: "0.1.0",
      exportId: "minimax-execute",
      schemaHash: `sha256:${"b".repeat(64)}`,
    } as const;
    const generateVideo = vi.fn(async () => ({
      bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
      contentType: "video/mp4",
      provider: "fal",
      modelEndpoint: "minimax/h3/text-to-video",
      pluginBinding: authoredBinding,
    }));
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/plugin-binding",
      workflowProcessor: createLocalWorkflowProcessor({
        dataDir,
        aigc: {
          generateVideo,
          generateImage: vi.fn(),
          generateAudio: vi.fn(),
          generateText: vi.fn(),
        },
      }),
    });
    const peer = room.addPeer(() => {});
    const clientDoc = new LoroDoc();
    clientDoc.getMap("nodes").set("h3-plugin-node", {
      id: "h3-plugin-node",
      type: "video",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "video-gen",
        prompt: "paper city",
        modelId: "minimax-h3",
        pluginBinding: authoredBinding,
      },
    });

    await room.receive(peer, clientDoc.export({ mode: "snapshot" }));

    expect(generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project/plugin-binding",
        nodeId: "h3-plugin-node",
        pluginBinding: authoredBinding,
      }),
    );
    const finalDoc = new LoroDoc();
    finalDoc.import(room.snapshot());
    expect(finalDoc.getMap("nodes").get("h3-plugin-node")).toMatchObject({
      data: { pluginBinding: authoredBinding },
    });
  });

  it("carries authored H3 reference badges to the desktop provider in order", async () => {
    const generateVideo = vi.fn(async () => ({
      bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
      contentType: "video/mp4",
      provider: "minimax",
      modelEndpoint: "MiniMax-H3",
    }));
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/h3-ordered",
      workflowProcessor: createLocalWorkflowProcessor({
        dataDir,
        aigc: {
          generateVideo,
          generateImage: vi.fn(),
          generateAudio: vi.fn(),
          generateText: vi.fn(),
        },
      }),
    });
    const referenceAssets = [
      {
        id: "asset-image",
        kind: "image" as const,
        contentType: "image/png",
        originalName: "subject.png",
      },
      {
        id: "asset-video",
        kind: "video" as const,
        contentType: "video/mp4",
        originalName: "motion.mp4",
      },
      {
        id: "asset-audio",
        kind: "audio" as const,
        contentType: "audio/mpeg",
        originalName: "ambience.mp3",
      },
    ];
    await room.mutateProject((doc) => {
      for (const asset of referenceAssets) {
        expect(
          createProjectAsset(doc, {
            id: asset.id,
            kind: asset.kind,
            source: {
              kind: "owned",
              resourceId: `sha256:${asset.id}`,
            },
            lifecycle: { state: "active" },
            metadata: {
              contentType: asset.contentType,
              originalName: asset.originalName,
            },
          }),
        ).toMatchObject({ ok: true });
      }
      return { value: undefined };
    });
    const peer = room.addPeer(() => {});
    const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
    const clientVersion = clientDoc.version();
    clientDoc.getMap("nodes").set("image-ref", {
      id: "image-ref",
      type: "image",
      position: { x: 0, y: 0 },
      data: { status: "completed", assetId: "asset-image" },
    });
    clientDoc.getMap("nodes").set("video-ref", {
      id: "video-ref",
      type: "video",
      position: { x: 0, y: 0 },
      data: { status: "completed", assetId: "asset-video" },
    });
    clientDoc.getMap("nodes").set("h3-ref-node", {
      id: "h3-ref-node",
      type: "video",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "video-gen",
        prompt:
          "Use @[Subject](node:image-ref), then @[Motion](node:video-ref).",
        modelId: "minimax-h3-ref",
        referenceImageAssetIds: ["asset-image"],
        referenceVideoAssetIds: ["asset-video"],
        referenceAudioAssetIds: ["asset-audio"],
      },
    });

    await room.receive(
      peer,
      clientDoc.export({ mode: "update", from: clientVersion }),
    );

    expect(generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        references: [
          {
            slot: "content",
            index: 0,
            text: { nodeId: "h3-ref-node:prompt:0", value: "Use " },
          },
          {
            slot: "content",
            index: 1,
            asset: {
              assetId: "asset-image",
              uri: "clash-asset://asset-image",
              kind: "image",
              mediaType: "image/png",
            },
          },
          {
            slot: "content",
            index: 2,
            text: { nodeId: "h3-ref-node:prompt:2", value: ", then " },
          },
          {
            slot: "content",
            index: 3,
            asset: {
              assetId: "asset-video",
              uri: "clash-asset://asset-video",
              kind: "video",
              mediaType: "video/mp4",
            },
          },
          {
            slot: "content",
            index: 4,
            text: { nodeId: "h3-ref-node:prompt:4", value: "." },
          },
          {
            slot: "content",
            index: 5,
            asset: {
              assetId: "asset-audio",
              uri: "clash-asset://asset-audio",
              kind: "audio",
              mediaType: "audio/mpeg",
            },
          },
        ],
      }),
    );
  });

  it("broadcasts structured agent node add and update activity with its Canvas target", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/agent-follow",
      workflowProcessor: null,
    });
    const browserSideband: Record<string, unknown>[] = [];
    const agent = room.addPeer(() => {}, {
      presence: {
        id: "agent-peer",
        clientType: "agent",
        userId: "local-user",
        name: "Codex",
      },
    });
    room.addPeer(() => {}, {
      presence: {
        id: "browser-peer",
        clientType: "browser",
        userId: "local-user",
        name: "Local User",
      },
      sendJson: (message) => browserSideband.push(message),
    });
    browserSideband.length = 0;

    const agentDoc = new LoroDoc();
    agentDoc.getMap("nodes").set("agent-shot", {
      canvasId: "storyboard",
      type: "image",
      data: { label: "Agent shot" },
      position: { x: 900, y: 400 },
    });

    await room.receive(agent, agentDoc.export({ mode: "snapshot" }));

    expect(browserSideband).toContainEqual({
      type: "activity",
      actor: { clientType: "agent", name: "Codex" },
      action: "added",
      nodeId: "agent-shot",
      nodeType: "image",
      label: "Agent shot",
      canvasId: "storyboard",
      timestamp: expect.any(Number),
    });

    browserSideband.length = 0;
    const updateFrom = agentDoc.version();
    agentDoc.getMap("nodes").set("agent-shot", {
      canvasId: "storyboard",
      type: "image",
      data: { label: "Agent shot revised" },
      position: { x: 1100, y: 520 },
    });
    await room.receive(
      agent,
      agentDoc.export({ mode: "update", from: updateFrom }),
    );

    expect(browserSideband).toContainEqual({
      type: "activity",
      actor: { clientType: "agent", name: "Codex" },
      action: "updated",
      nodeId: "agent-shot",
      nodeType: "image",
      label: "Agent shot revised",
      canvasId: "storyboard",
      timestamp: expect.any(Number),
    });
  });

  it("persists and broadcasts graph repair updates after importing an orphan edge", async () => {
    const projectId = "project/orphan-repair";
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });
    const sender = room.addPeer(() => {});
    const peerUpdates: Uint8Array[] = [];
    room.addPeer((update) => peerUpdates.push(update));
    peerUpdates.length = 0;

    const clientDoc = new LoroDoc();
    clientDoc
      .getMap("nodes")
      .set("target", { canvasId: "main", type: "image_gen", data: {} });
    clientDoc
      .getMap("nodeUpstreams")
      .ensureMergeableMap("target")
      .set("orphan", {
        nodeId: "missing-source",
        edgeId: "orphan",
        type: "default",
      });
    clientDoc.getMap("edgeIdentity").set("orphan", { target: "target" });

    await room.receive(sender, clientDoc.export({ mode: "snapshot" }));

    expect(peerUpdates).toHaveLength(2);
    const peerDoc = new LoroDoc();
    for (const update of peerUpdates) peerDoc.import(update);
    expect(new Canvas(peerDoc, () => {}, "main").listEdges()).toEqual([]);
    expect(peerDoc.getMap("edgeIdentity").get("orphan")).toEqual({
      deleted: true,
    });

    const reopened = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });
    const persisted = new LoroDoc();
    persisted.import(reopened.snapshot());
    expect(new Canvas(persisted, () => {}, "main").listEdges()).toEqual([]);
    expect(persisted.getMap("edgeIdentity").get("orphan")).toEqual({
      deleted: true,
    });
  });

  it("rejects legacy custom-action registration sideband messages", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/custom-register",
      workflowProcessor: null,
    });
    const sideband: Record<string, unknown>[] = [];
    const peer = room.addPeer(() => {}, {
      runtimeId: "runtime-1",
      sendJson: (message) => sideband.push(message),
    });

    await room.receiveJson(peer, {
      type: "register_custom_actions",
      actions: [
        {
          id: "grid-split",
          name: "Grid Split",
          outputType: "image",
          promptModalities: ["text", "image"],
        },
      ],
    });

    expect(sideband).toContainEqual({
      type: "register_custom_actions.rejected",
      code: "LEGACY_CUSTOM_ACTION_PROTOCOL_RETIRED",
      error:
        "Legacy ClashAgent custom-action transport is retired; install a clash.plugin/v1 executable plugin.",
    });
    const doc = new LoroDoc();
    doc.import(room.snapshot());
    expect(doc.getMap("customActions").get("grid-split")).toBeUndefined();
  });

  it("fails legacy custom-action nodes without dispatching sideband work", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/custom-dispatch",
      workflowProcessor: testAigc(),
    });
    const sideband: Record<string, unknown>[] = [];
    const peer = room.addPeer(() => {}, {
      runtimeId: "runtime-1",
      sendJson: (msg) => sideband.push(msg),
    });

    const clientDoc = new LoroDoc();
    clientDoc.getMap("nodes").set("custom-child", {
      id: "custom-child",
      type: "image",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "custom:grid-split",
        customActionId: "grid-split",
        outputType: "image",
        customActionParams: { grid_size: "2x2" },
        actorType: "user",
        actorUserId: "local-user",
      },
    });

    await room.receive(peer, clientDoc.export({ mode: "snapshot" }));

    expect(sideband).not.toContainEqual(
      expect.objectContaining({ type: "custom_task_assigned" }),
    );

    const doc = new LoroDoc();
    doc.import(room.snapshot());
    expect((doc.getMap("nodes").get("custom-child") as any).data).toMatchObject(
      {
        status: "failed",
        failureCode: "LEGACY_CUSTOM_ACTION_PROTOCOL_RETIRED",
        error:
          "Legacy custom action grid-split has no executable plugin binding. Install a clash.plugin/v1 plugin and recreate the Action.",
      },
    );
    expect(doc.getMap("tasks").size).toBe(0);
  });

  it("imports a client update, broadcasts it to peers, and persists a snapshot", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/one",
    });
    const peerA: Uint8Array[] = [];
    const peerB: Uint8Array[] = [];
    const a = room.addPeer((data) => peerA.push(data));
    room.addPeer((data) => peerB.push(data));
    peerA.length = 0;
    peerB.length = 0;

    const clientDoc = new LoroDoc();
    clientDoc
      .getMap("nodes")
      .set("node-1", { type: "text", data: { label: "Local" } });
    const update = clientDoc.export({ mode: "snapshot" });

    await room.receive(a, update);

    expect(peerB).toHaveLength(1);
    const peerDoc = new LoroDoc();
    peerDoc.import(peerB[0]);
    expect((peerDoc.getMap("nodes").get("node-1") as any).data.label).toBe(
      "Local",
    );

    const reopened = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/one",
    });
    const snapshot = reopened.snapshot();
    const persisted = new LoroDoc();
    persisted.import(snapshot);
    expect((persisted.getMap("nodes").get("node-1") as any).data.label).toBe(
      "Local",
    );
  });

  it("does not invent a workflow processor for a bare CRDT room", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/crdt-only",
    });
    const peer = room.addPeer(() => {});
    const clientDoc = new LoroDoc();
    clientDoc.getMap("nodes").set("pending-image", {
      id: "pending-image",
      type: "image",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "image-gen",
        prompt: "must remain pending",
        modelId: "gemini-3.1-flash-image",
      },
    });

    await room.receive(peer, clientDoc.export({ mode: "snapshot" }));

    const finalDoc = new LoroDoc();
    finalDoc.import(room.snapshot());
    expect(
      (finalDoc.getMap("nodes").get("pending-image") as any).data,
    ).toMatchObject({
      status: "pending",
      prompt: "must remain pending",
    });
  });

  it("processes pending image generation nodes through the local mock fal service", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/local-gen",
      workflowProcessor: testAigc(),
    });
    const peerUpdates: Uint8Array[] = [];
    const peer = room.addPeer((data) => peerUpdates.push(data));
    peerUpdates.length = 0;

    const clientDoc = new LoroDoc();
    clientDoc.getMap("nodes").set("image-node-1", {
      id: "image-node-1",
      type: "image",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "image-gen",
        prompt: "小狗一只",
        modelId: "gemini-3.1-flash-image",
        modelParams: { aspect_ratio: "16:9" },
        actorType: "user",
        actorUserId: "local-user",
      },
    });

    await room.receive(peer, clientDoc.export({ mode: "snapshot" }));

    const finalDoc = new LoroDoc();
    finalDoc.import(room.snapshot());
    const imageNode = finalDoc.getMap("nodes").get("image-node-1") as any;
    expect(imageNode.data.status).toBe("completed");
    expect(imageNode.data.assetId).toEqual(expect.any(String));
    expect(imageNode.data.pendingTask).toBeUndefined();

    const asset = readProjectAsset(finalDoc, imageNode.data.assetId);
    expect(asset).toMatchObject({
      id: imageNode.data.assetId,
      kind: "image",
      source: { kind: "owned", resourceId: expect.stringMatching(/^sha256:/) },
      metadata: { contentType: "image/svg+xml", bytes: expect.any(Number) },
      provenance: {
        kind: "generation",
        actionRunId: expect.stringMatching(
          /^project:project\/local-gen:node:image-node-1:revision:[a-f0-9]{64}$/,
        ),
        model: expect.stringContaining("fal-ai/"),
        prompt: "小狗一只",
      },
    });
    const projection = await createLocalResourceStore({ dataDir }).resolve(
      asset!.source.resourceId,
    );
    const generated = await readFile(projection!.path, "utf8");
    expect(generated).toContain("小狗一只");
    expect(generated).toContain("Mock fal");
    expect(peerUpdates.length).toBeGreaterThan(0);
  });

  it("renders pending Timeline video nodes through the bundled Remotion Action", async () => {
    const importedAt = Math.floor(Date.now() / 1000);
    await mkdir(join(dataDir, "assets", "uploads"), { recursive: true });
    await writeFile(
      join(dataDir, "assets", "uploads", "music.wav"),
      "music bytes",
    );
    const metadata = createLocalMetadataStore(dataDir);
    const legacy = await metadata.load();
    legacy.assets.push({
      id: "music-asset-1",
      userId: "local-user",
      kind: "audio",
      srcR2Key: "uploads/music.wav",
      coverR2Key: null,
      metadata: { contentType: "audio/wav", durationMs: 2000 },
      sourceModel: null,
      sourcePrompt: null,
      sourceTaskId: null,
      sources: null,
      signedUrl: "http://127.0.0.1:49431/assets/uploads/music.wav",
      signedUrlExp: importedAt + 3600,
      createdAt: importedAt,
      updatedAt: importedAt,
      projectId: "project/local-render",
    });
    legacy.assetRefs.push({
      assetId: "music-asset-1",
      projectId: "project/local-render",
      importedAt,
    });
    await metadata.save(legacy, {
      replaceLegacyAssetMigrationInput: true,
    });
    const binding = {
      pluginId: "clash.remotion",
      version: "0.1.0",
      exportId: "render-timeline",
      schemaHash: `sha256:${"e".repeat(64)}`,
    } as const;
    const staging = createLocalPluginAssetStagingStore({ dataDir });
    const renderTimeline = vi.fn(async (request: Record<string, any>) => {
      const outputSlot = String(request.input.values.outputSlot);
      const invocationId = `${request.taskId}:sync-remotion`;
      const staged = await staging.stage({
        projectId: request.projectId,
        taskId: request.taskId,
        slot: outputSlot,
        pluginId: binding.pluginId,
        pluginVersion: binding.version,
        invocationId,
        kind: "video",
        mediaType: "video/mp4",
        bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
      });
      return {
        protocol: "clash.plugin.result/v1" as const,
        invocationId,
        status: "completed" as const,
        outputs: [
          {
            slot: outputSlot,
            kind: "asset" as const,
            asset: {
              assetId: staged.projectAssetId,
              uri: `clash-asset://${staged.projectAssetId}`,
              kind: "video" as const,
              mediaType: "video/mp4",
            },
          },
        ],
      };
    });
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/local-render",
      workflowProcessor: createLocalWorkflowProcessor({
        dataDir,
        assetInspection: testAssetInspection({
          video: { width: 1_920, height: 1_080, durationMs: 2_000 },
        }),
        executablePluginAction: renderTimeline,
        resolvePluginBinding: async () => binding,
      }),
    });
    const peer = room.addPeer(() => {});
    const clientDoc = LoroDoc.fromSnapshot(room.snapshot());
    const timelineState = {
      compositionWidth: 1920,
      compositionHeight: 1080,
      fps: 30,
      durationInFrames: 60,
      tracks: [
        {
          id: "music",
          role: "music",
          items: [
            {
              id: "music-1",
              type: "audio",
              from: 0,
              durationInFrames: 60,
              assetId: "music-asset-1",
              audioDucking: {
                amountDb: -18,
                attackFrames: 6,
                releaseFrames: 12,
              },
            },
          ],
        },
      ],
    };
    expect(
      createProjectTimeline(clientDoc, {
        id: "timeline-1",
        name: "Timeline",
        state: timelineState,
      }),
    ).toMatchObject({ ok: true });
    expect(
      requestTimelineRender(clientDoc, {
        timelineId: "timeline-1",
        actorUserId: "local-user",
        generateId: () => "render-node-1",
      }),
    ).toMatchObject({ ok: true, renderNodeId: "render-node-1" });

    await room.receive(peer, clientDoc.export({ mode: "snapshot" }));

    expect(renderTimeline).toHaveBeenCalledTimes(1);
    const renderRequest = renderTimeline.mock.calls[0]![0];
    expect(renderRequest).toMatchObject({
      binding,
      projectId: "project/local-render",
      taskId: "timeline-render:render-node-1",
      input: {
        values: {
          timeline: {
            name: "Timeline",
            owner: { kind: "project" },
            state: {
              durationInFrames: 60,
              tracks: [
                expect.objectContaining({
                  items: [
                    expect.objectContaining({
                      id: "music-1",
                      assetId: "music-asset-1",
                      audioDucking: {
                        amountDb: -18,
                        attackFrames: 6,
                        releaseFrames: 12,
                      },
                    }),
                  ],
                }),
              ],
            },
          },
        },
        references: [
          {
            slot: "timeline:item:music-1",
            index: 0,
            asset: {
              assetId: "music-asset-1",
              uri: "clash-asset://music-asset-1",
              kind: "audio",
              mediaType: "audio/wav",
            },
          },
        ],
      },
    });
    expect(
      renderRequest.input.values.timeline.state.tracks[0].items[0],
    ).not.toHaveProperty("src");
    const finalDoc = new LoroDoc();
    finalDoc.import(room.snapshot());
    expect(finalDoc.getMap("nodes").get("render-node-1")).toMatchObject({
      data: {
        status: "completed",
        assetId: expect.any(String),
      },
    });
  });

  it("rejects generated asset writes when the generated storage parent escapes through a symlink", async () => {
    const outsideDir = await mkdtemp(
      join(tmpdir(), "clash-local-sync-outside-generated-"),
    );
    try {
      await mkdir(join(dataDir, "assets"), { recursive: true });
      await symlink(outsideDir, join(dataDir, "assets", "blobs"));
      const room = await LocalLoroRoom.open({
        dataDir,
        projectId: "project/local-gen-symlink",
        workflowProcessor: testAigc(),
      });
      const peer = room.addPeer(() => {});

      const clientDoc = new LoroDoc();
      clientDoc.getMap("nodes").set("image-node-symlink", {
        id: "image-node-symlink",
        type: "image",
        position: { x: 0, y: 0 },
        data: {
          status: "pending",
          actionType: "image-gen",
          prompt: "must not escape",
          modelId: "gemini-3.1-flash-image",
        },
      });

      await room.receive(peer, clientDoc.export({ mode: "snapshot" }));

      const journal = createSqliteDurableRunJournal(dataDir);
      const matchingRuns = (
        await journal.listRecoverable("local-api", Number.MAX_SAFE_INTEGER)
      ).filter(
        (run) =>
          !!run.executorInput &&
          typeof run.executorInput === "object" &&
          !Array.isArray(run.executorInput) &&
          (run.executorInput as Record<string, unknown>).nodeId ===
            "image-node-symlink",
      );
      expect(matchingRuns).toHaveLength(1);
      const identity = {
        actionRunId: matchingRuns[0]!.actionRunId,
        outputSlot: matchingRuns[0]!.outputSlot,
      };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const wakeAt = (await journal.load(identity))?.nextAttemptAt;
        if (wakeAt !== undefined) {
          vi.useFakeTimers();
          vi.setSystemTime(wakeAt);
        }
        await (room as any).processPendingWork();
      }

      const finalDoc = new LoroDoc();
      finalDoc.import(room.snapshot());
      const imageNode = finalDoc
        .getMap("nodes")
        .get("image-node-symlink") as any;
      expect(imageNode.data.status).toBe("failed");
      expect(imageNode.data.assetId).toBeUndefined();
      expect(imageNode.data.error).toBe(
        "Generation failed. See the owning Host for private diagnostics.",
      );
      await expect(journal.load(identity)).resolves.toMatchObject({
        failure: { message: "Asset path escapes local asset storage" },
      });
      await expect(readdir(outsideDir)).resolves.toEqual([]);
      const sqlite = openSqlite();
      try {
        expect(
          sqlite.prepare("select count(*) as count from local_resources").get(),
        ).toEqual({ count: 0 });
      } finally {
        sqlite.close();
      }
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("processes pending video and audio generation nodes with media-aware mock outputs", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/local-media-gen",
      workflowProcessor: testAigc(),
    });
    const peer = room.addPeer(() => {});

    const clientDoc = new LoroDoc();
    clientDoc.getMap("nodes").set("video-node-1", {
      id: "video-node-1",
      type: "video",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "video-gen",
        prompt: "竖屏小狗视频",
        modelId: "sora-2",
        modelParams: { aspect_ratio: "9:16", duration: 4 },
        aspectRatio: "9:16",
        duration: 4,
      },
    });
    clientDoc.getMap("nodes").set("audio-node-1", {
      id: "audio-node-1",
      type: "audio",
      position: { x: 0, y: 360 },
      data: {
        status: "pending",
        actionType: "audio-gen",
        prompt: "这是一段三秒 mock 音频",
        modelId: "gemini-3.1-flash-tts",
        modelParams: { duration: 3 },
      },
    });

    await room.receive(peer, clientDoc.export({ mode: "snapshot" }));

    const finalDoc = new LoroDoc();
    finalDoc.import(room.snapshot());
    const videoNode = finalDoc.getMap("nodes").get("video-node-1") as any;
    const audioNode = finalDoc.getMap("nodes").get("audio-node-1") as any;
    expect(videoNode.data.status).toBe("completed");
    expect(audioNode.data.status).toBe("completed");
    expect(videoNode.data.assetId).toEqual(expect.any(String));
    expect(audioNode.data.assetId).toEqual(expect.any(String));

    const videoAsset = readProjectAsset(finalDoc, videoNode.data.assetId);
    const audioAsset = readProjectAsset(finalDoc, audioNode.data.assetId);
    expect(videoAsset).toMatchObject({
      kind: "video",
      provenance: {
        kind: "generation",
        prompt: "竖屏小狗视频",
        actionRunId: expect.stringMatching(
          /^project:project\/local-media-gen:node:video-node-1:revision:[a-f0-9]{64}$/,
        ),
        model: expect.stringContaining("fal-ai/"),
      },
      metadata: {
        width: 720,
        height: 1280,
        durationMs: 4000,
        contentType: "video/mp4",
      },
    });
    expect(audioAsset).toMatchObject({
      kind: "audio",
      provenance: {
        kind: "generation",
        prompt: "这是一段三秒 mock 音频",
        actionRunId: expect.stringMatching(
          /^project:project\/local-media-gen:node:audio-node-1:revision:[a-f0-9]{64}$/,
        ),
      },
      metadata: {
        durationMs: 3000,
        contentType: "audio/wav",
      },
    });
    expect(audioAsset!.metadata).not.toHaveProperty("waveform");
    const audioProjection = await createLocalResourceStore({ dataDir }).resolve(
      audioAsset!.source.resourceId,
    );
    const audioBytes = await readFile(audioProjection!.path, "utf8");
    expect(audioBytes).toContain("这是一段三秒 mock 音频");
  });

  it("processes pending text generation nodes in place", async () => {
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/local-text-gen",
      workflowProcessor: testAigc(),
    });
    const peer = room.addPeer(() => {});

    const clientDoc = new LoroDoc();
    clientDoc.getMap("nodes").set("text-node-1", {
      id: "text-node-1",
      type: "text",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "text-gen",
        prompt: "Write three title options",
        modelId: "gpt-5.4",
        modelParams: {},
      },
    });

    await room.receive(peer, clientDoc.export({ mode: "snapshot" }));

    const finalDoc = new LoroDoc();
    finalDoc.import(room.snapshot());
    const textNode = finalDoc.getMap("nodes").get("text-node-1") as any;
    expect(textNode.data.status).toBe("completed");
    expect(textNode.data.content).toContain("Generated text (gpt-5.4)");
    expect(textNode.data.content).toContain("Write three title options");
    expect(textNode.data.assetId).toBeUndefined();
    expect(textNode.data.pendingTask).toBeUndefined();

    const metadataStore = createLocalMetadataStore(dataDir);
    const loaded = await metadataStore.load();
    expect(loaded.assets).toHaveLength(0);
    const revisions = await metadataStore.listTextRevisions({
      projectId: "project/local-text-gen",
      nodeId: "text-node-1",
    });
    expect(revisions).toHaveLength(1);
    const revision = revisions[0]!;
    expect(revision).toMatchObject({
      textId: "text:project/local-text-gen:text-node-1",
      projectId: "project/local-text-gen",
      nodeId: "text-node-1",
      hashAlgorithm: "sha256-64",
      sourceFilePath: "workflow/text-node-1.md",
    });
    expect(revision.revisionId).toEqual(
      expect.stringMatching(/^txrev-[a-f0-9]{16}-/),
    );
    expect(revision.contentHash).toBe(revision.sourceFileHash);
    const revisionBodyPath = join(
      dataDir,
      "text-revision-blobs",
      revision.contentHash.slice(0, 2),
      `${revision.contentHash}.md`,
    );
    expect(await readFile(revisionBodyPath, "utf8")).toBe(
      textNode.data.content,
    );
    expect((await stat(revisionBodyPath)).mode & 0o222).toBe(0);
    const audits = await metadataStore.listMutationAudit({
      operation: "text_generate",
      entityId: revision.revisionId,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      operation: "text_generate",
      entity: { kind: "text-revision", id: revision.revisionId },
      actorClientType: null,
      accepted: true,
      reason: "workflow generated text",
      resultEntityId: revision.revisionId,
    });
    expect(audits[0]?.mutation).toMatchObject({
      operation: "text_generate",
      entity: { kind: "text-revision", id: revision.revisionId },
      accepted: true,
      resultEntityId: revision.revisionId,
    });
    expect(audits[0]?.mutation.expectedReadToken).toBeUndefined();
    expect(audits[0]?.mutation.beforeReadToken).toBeUndefined();
    expect(audits[0]?.mutation.afterReadToken).toBeUndefined();
  });

  it("processes pending local-agent text generation nodes through a local text agent", async () => {
    const generate = vi.fn(async ({ prompt, modelParams }) => ({
      text: `agent generated: ${prompt} (${String(modelParams?.acp_model ?? "")})`,
      provider: "local-acp",
      modelEndpoint: "codex-acp",
    }));
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/local-agent-text-gen",
      workflowProcessor: createLocalWorkflowProcessor({
        dataDir,
        textAgent: { generate },
      }),
    });
    const peer = room.addPeer(() => {});

    const clientDoc = new LoroDoc();
    clientDoc.getMap("nodes").set("text-node-agent", {
      id: "text-node-agent",
      type: "text",
      position: { x: 0, y: 0 },
      data: {
        status: "pending",
        actionType: "text-gen",
        prompt: "Write three title options",
        modelId: "local-acp",
        modelParams: { acp_model: "gpt-5.4" },
      },
    });

    await room.receive(peer, clientDoc.export({ mode: "snapshot" }));

    const finalDoc = new LoroDoc();
    finalDoc.import(room.snapshot());
    const textNode = finalDoc.getMap("nodes").get("text-node-agent") as any;
    expect(textNode.data).toMatchObject({
      status: "completed",
      content: "agent generated: Write three title options (gpt-5.4)",
      provider: "local-acp",
      modelEndpoint: "codex-acp",
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "local-acp",
        modelParams: { acp_model: "gpt-5.4" },
      }),
    );
  });

  it("mirrors received updates to optional remote persistence", async () => {
    const appendUpdate = vi.fn(
      async (_projectId: string, _update: Uint8Array) => {},
    );
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/remote",
      remotePersistence: { appendUpdate },
      workflowProcessor: null,
    });
    const peer = room.addPeer(() => {});

    const clientDoc = new LoroDoc();
    clientDoc
      .getMap("nodes")
      .set("node-remote", { type: "text", data: { label: "Mirror" } });
    const update = clientDoc.export({ mode: "snapshot" });

    await room.receive(peer, update);

    expect(appendUpdate).toHaveBeenCalledTimes(1);
    expect(appendUpdate).toHaveBeenCalledWith(
      "project/remote",
      expect.any(Uint8Array),
    );
    expect(Array.from(appendUpdate.mock.calls[0][1])).toEqual(
      Array.from(update),
    );
  });

  it("attaches a server-to-server replica link and durably imports cloud updates", async () => {
    const published: Uint8Array[] = [];
    let cloudCommit:
      ((batchId: string, updates: Uint8Array[]) => Promise<void>) | undefined;
    const link = {
      start: vi.fn(),
      publish: vi.fn((update: Uint8Array) => {
        published.push(update);
      }),
      close: vi.fn(),
    };
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/cloud-link",
      remotePersistence: {
        appendUpdate: vi.fn(),
        createLink: ({ commit }) => {
          cloudCommit = commit;
          return link;
        },
      },
      workflowProcessor: null,
    });
    expect(link.start).toHaveBeenCalledTimes(1);

    const local = new LoroDoc();
    local
      .getMap("nodes")
      .set("local", { type: "text", data: { label: "Local" } });
    await room.receive(
      room.addPeer(() => {}),
      local.export({ mode: "snapshot" }),
    );
    expect(published.length).toBeGreaterThan(0);

    const cloud = new LoroDoc();
    cloud
      .getMap("nodes")
      .set("cloud", { type: "text", data: { label: "Cloud" } });
    await cloudCommit?.("0x0000000000000099", [
      cloud.export({ mode: "snapshot" }),
    ]);

    const reopened = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/cloud-link",
      workflowProcessor: null,
    });
    expect(
      await reopened.inspectProject((doc) => doc.getMap("nodes").get("cloud")),
    ).toMatchObject({ data: { label: "Cloud" } });
    await room.close();
    expect(link.close).toHaveBeenCalledTimes(1);
  });

  it("resolves remote persistence dynamically for later mirrored updates", async () => {
    const appendUpdate = vi.fn(
      async (_projectId: string, _update: Uint8Array) => {},
    );
    let remotePersistence:
      | { appendUpdate(projectId: string, update: Uint8Array): Promise<void> }
      | undefined;
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/dynamic-remote",
      remotePersistence: () => remotePersistence,
      workflowProcessor: null,
    });
    const peer = room.addPeer(() => {});

    const firstDoc = new LoroDoc();
    firstDoc
      .getMap("nodes")
      .set("node-local-only", { type: "text", data: { label: "Local only" } });
    await room.receive(peer, firstDoc.export({ mode: "snapshot" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendUpdate).not.toHaveBeenCalled();

    remotePersistence = { appendUpdate };
    const secondDoc = new LoroDoc();
    secondDoc
      .getMap("nodes")
      .set("node-cloud-sync", { type: "text", data: { label: "Cloud sync" } });
    const secondUpdate = secondDoc.export({ mode: "snapshot" });
    await room.receive(peer, secondUpdate);
    await vi.waitFor(() => expect(appendUpdate).toHaveBeenCalledTimes(1));
    expect(appendUpdate).toHaveBeenCalledWith(
      "project/dynamic-remote",
      expect.any(Uint8Array),
    );
  });

  it("keeps local persistence and peer broadcast when remote persistence fails", async () => {
    const appendUpdate = vi.fn(
      async (_projectId: string, _update: Uint8Array) => {
        throw new Error("remote unavailable");
      },
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/offline",
      remotePersistence: { appendUpdate },
    });
    const peerA: Uint8Array[] = [];
    const peerB: Uint8Array[] = [];
    const a = room.addPeer((data) => peerA.push(data));
    room.addPeer((data) => peerB.push(data));
    peerA.length = 0;
    peerB.length = 0;

    const clientDoc = new LoroDoc();
    clientDoc
      .getMap("nodes")
      .set("node-local", { type: "text", data: { label: "Offline" } });
    const update = clientDoc.export({ mode: "snapshot" });

    await room.receive(a, update);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(peerB).toHaveLength(1);
    const reopened = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/offline",
    });
    const persisted = new LoroDoc();
    persisted.import(reopened.snapshot());
    expect(
      (persisted.getMap("nodes").get("node-local") as any).data.label,
    ).toBe("Offline");
    expect(errorSpy).toHaveBeenCalledWith(
      "[local-sync] failed to mirror update to remote persistence",
      expect.any(Error),
    );
  });

  it("imports remote snapshots on open and writes the merged state locally", async () => {
    const remoteDoc = new LoroDoc();
    remoteDoc
      .getMap("nodes")
      .set("node-cloud", { type: "text", data: { label: "Cloud" } });
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/hybrid",
      remotePersistence: {
        loadSnapshot: vi.fn(async () => remoteDoc.export({ mode: "snapshot" })),
        appendUpdate: vi.fn(
          async (_projectId: string, _update: Uint8Array) => {},
        ),
      },
    });

    const opened = new LoroDoc();
    opened.import(room.snapshot());
    expect((opened.getMap("nodes").get("node-cloud") as any).data.label).toBe(
      "Cloud",
    );

    const reopened = await LocalLoroRoom.open({
      dataDir,
      projectId: "project/hybrid",
    });
    const persisted = new LoroDoc();
    persisted.import(reopened.snapshot());
    expect(
      (persisted.getMap("nodes").get("node-cloud") as any).data.label,
    ).toBe("Cloud");
  });

  it("keeps an appended checkpoint committed when threshold compaction fails and retries later", async () => {
    const projectId = "project/compact-failure-commit";
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });

    const compactSpy = vi
      .spyOn(FileReplicaStore.prototype, "saveReplicaCheckpointCursor")
      .mockRejectedValueOnce(new Error("injected compaction failure"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let committedEdit = 0;
      while (compactSpy.mock.calls.length === 0 && committedEdit < 64) {
        committedEdit += 1;
        await expect(
          room.mutateProject((doc) => {
            doc
              .getMap("checkpoint-regression")
              .set(`edit-${committedEdit}`, committedEdit);
            return { value: undefined };
          }),
        ).resolves.toBeUndefined();
      }
      if (compactSpy.mock.calls.length === 0) {
        throw new Error("Test setup did not reach the compaction threshold");
      }
      expect(
        await room.inspectCheckpointedProject((doc) =>
          doc.getMap("checkpoint-regression").toJSON(),
        ),
      ).toHaveProperty(`edit-${committedEdit}`, committedEdit);

      const retryEdit = committedEdit + 1;
      await room.mutateProject((doc) => {
        doc.getMap("checkpoint-regression").set(`edit-${retryEdit}`, retryEdit);
        return { value: undefined };
      });
      expect(
        await room.inspectCheckpointedProject((doc) =>
          doc.getMap("checkpoint-regression").toJSON(),
        ),
      ).toMatchObject({
        [`edit-${committedEdit}`]: committedEdit,
        [`edit-${retryEdit}`]: retryEdit,
      });
      expect(
        (
          await readFile(
            join(
              dataDir,
              "projects",
              encodeURIComponent(projectId),
              "loro",
              "updates.log",
            ),
          )
        ).byteLength,
      ).toBe(0);

      const reopened = await LocalLoroRoom.open({
        dataDir,
        projectId,
        workflowProcessor: null,
      });
      expect(
        await reopened.inspectProject((doc) =>
          doc.getMap("checkpoint-regression").toJSON(),
        ),
      ).toMatchObject({
        [`edit-${committedEdit}`]: committedEdit,
        [`edit-${retryEdit}`]: retryEdit,
      });
    } finally {
      compactSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("does not let a Project read callback mutate the live replica", async () => {
    const projectId = "project/read-isolation";
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });

    await room.inspectProject((doc) => {
      doc.getMap("read-callback-leak").set("created", true);
    });

    expect(
      await room.inspectProject((doc) =>
        doc.getMap("read-callback-leak").toJSON(),
      ),
    ).toEqual({});
    expect(
      await room.inspectCheckpointedProject((doc) =>
        doc.getMap("read-callback-leak").toJSON(),
      ),
    ).toEqual({});
  });

  it("rolls a failed Host mutation back to its last committed checkpoint", async () => {
    const projectId = "project/mutation-rollback";
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });
    await room.mutateProject((doc) => {
      doc.getMap("checkpoint-regression").set("prefix", "committed");
      return { value: undefined };
    });

    await expect(
      room.mutateProject((doc) => {
        doc.getMap("checkpoint-regression").set("suffix", "dirty");
        throw new Error("mutation failed after editing");
      }),
    ).rejects.toThrow("mutation failed after editing");
    expect(
      await room.inspectProject((doc) =>
        doc.getMap("checkpoint-regression").toJSON(),
      ),
    ).toEqual({ prefix: "committed" });

    for (let i = 0; i < 40; i += 1) {
      await room.mutateProject((doc) => {
        doc.getMap("checkpoint-regression").set(`later-${i}`, i);
        return { value: undefined };
      });
    }
    const reopened = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });
    expect(
      await reopened.inspectProject((doc) =>
        doc.getMap("checkpoint-regression").toJSON(),
      ),
    ).not.toHaveProperty("suffix");
  });

  it("rolls only the dirty suffix of a failed checkpointed Host mutation back", async () => {
    const projectId = "project/checkpointed-mutation-rollback";
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });

    await expect(
      room.mutateProjectWithCheckpoint(async (doc, checkpoint) => {
        doc.getMap("checkpoint-regression").set("prefix", "committed");
        await checkpoint();
        doc.getMap("checkpoint-regression").set("suffix", "dirty");
        throw new Error("checkpointed mutation failed after editing");
      }),
    ).rejects.toThrow("checkpointed mutation failed after editing");
    expect(
      await room.inspectProject((doc) =>
        doc.getMap("checkpoint-regression").toJSON(),
      ),
    ).toEqual({ prefix: "committed" });

    for (let i = 0; i < 40; i += 1) {
      await room.mutateProject((doc) => {
        doc.getMap("checkpoint-regression").set(`later-${i}`, i);
        return { value: undefined };
      });
    }
    const reopened = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });
    expect(
      await reopened.inspectProject((doc) =>
        doc.getMap("checkpoint-regression").toJSON(),
      ),
    ).not.toHaveProperty("suffix");
  });

  it("rolls only the dirty suffix of a failed workflow processor back", async () => {
    const projectId = "project/workflow-mutation-rollback";
    let armed = false;
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: {
        async process({ doc, checkpoint }) {
          if (!armed) return false;
          doc.getMap("checkpoint-regression").set("prefix", "committed");
          if (!checkpoint) throw new Error("workflow checkpoint unavailable");
          await checkpoint();
          doc.getMap("checkpoint-regression").set("suffix", "dirty");
          throw new Error("workflow failed after editing");
        },
      },
    });
    armed = true;

    await expect((room as any).processPendingWork()).rejects.toThrow(
      "workflow failed after editing",
    );
    expect(
      await room.inspectProject((doc) =>
        doc.getMap("checkpoint-regression").toJSON(),
      ),
    ).toEqual({ prefix: "committed" });

    for (let i = 0; i < 40; i += 1) {
      await room.mutateProject((doc) => {
        doc.getMap("checkpoint-regression").set(`later-${i}`, i);
        return { value: undefined };
      });
    }
    const reopened = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });
    expect(
      await reopened.inspectProject((doc) =>
        doc.getMap("checkpoint-regression").toJSON(),
      ),
    ).not.toHaveProperty("suffix");
  });

  it("periodically compacts local update log records instead of keeping one record per edit", async () => {
    const projectId = "project/compact-log";
    const room = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });
    const peer = room.addPeer(() => {});

    for (let i = 0; i < 40; i += 1) {
      const clientDoc = new LoroDoc();
      clientDoc
        .getMap("nodes")
        .set(`node-${i}`, { type: "text", data: { label: `Edit ${i}` } });
      await room.receive(peer, clientDoc.export({ mode: "snapshot" }));
    }

    const logPath = join(
      dataDir,
      "projects",
      encodeURIComponent(projectId),
      "loro",
      "updates.log",
    );
    const log = await readFile(logPath);
    expect(countUpdateLogRecords(log)).toBeLessThan(40);

    const reopened = await LocalLoroRoom.open({
      dataDir,
      projectId,
      workflowProcessor: null,
    });
    const persisted = new LoroDoc();
    persisted.import(reopened.snapshot());
    expect((persisted.getMap("nodes").get("node-0") as any).data.label).toBe(
      "Edit 0",
    );
    expect((persisted.getMap("nodes").get("node-39") as any).data.label).toBe(
      "Edit 39",
    );
  });
});

describe("attachLocalSync", () => {
  it("serves the official Loro protocol over the same local project room", async () => {
    const server = createServer();
    const hub = attachLocalSync(server, { dataDir });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const projectId = "project/protocol";
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/sync/${encodeURIComponent(projectId)}?protocol=loro-v1`,
    );
    const messages: ProtocolMessage[] = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) messages.push(decode(new Uint8Array(data as Buffer)));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.send(
      encode({
        type: MessageType.JoinRequest,
        crdt: CrdtType.Loro,
        roomId: projectId,
        auth: new Uint8Array(),
        version: new LoroDoc().version().encode(),
      }),
    );
    await vi.waitFor(() => {
      expect(
        messages.some((message) => message.type === MessageType.JoinResponseOk),
      ).toBe(true);
    });

    const source = new LoroDoc();
    source.getMap("nodes").set("protocol-node", {
      type: "text",
      data: { label: "Protocol" },
    });
    const update = source.export({ mode: "snapshot" });
    const batchId = "0x0000000000000021" as const;
    ws.send(
      encode({
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId: projectId,
        updates: [update],
        batchId,
      }),
    );

    await vi.waitFor(() => {
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: MessageType.Ack,
          refId: batchId,
          status: UpdateStatusCode.Ok,
        }),
      );
    });
    expect(
      await hub.inspectProject(projectId, (doc) =>
        doc.getMap("nodes").get("protocol-node"),
      ),
    ).toMatchObject({ data: { label: "Protocol" } });

    await closeWebSocket(ws);
    await hub.close();
    await closeServer(server);
  });

  it("broadcasts local agent presence and structured Canvas activity", async () => {
    const server = createServer();
    attachLocalSync(server, { dataDir });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const browser = new WebSocket(
      `ws://127.0.0.1:${port}/sync/${encodeURIComponent("project/presence")}`,
    );
    const agent = new WebSocket(
      `ws://127.0.0.1:${port}/sync/${encodeURIComponent("project/presence")}`,
      {
        headers: {
          "x-client-type": "agent",
          "x-agent-name": "Mock ACP",
        },
      },
    );
    const browserPresence: any[] = [];
    const browserActivity: any[] = [];

    browser.on("message", (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(String(data));
      if (msg.type === "presence") browserPresence.push(msg);
      if (msg.type === "activity") browserActivity.push(msg);
    });

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        browser.once("open", resolve);
        browser.once("error", reject);
      }),
      new Promise<void>((resolve, reject) => {
        agent.once("open", resolve);
        agent.once("error", reject);
      }),
    ]);

    await vi.waitFor(() => {
      expect(browserPresence.at(-1)?.clients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            clientType: "browser",
            userId: "local-user",
            name: "Local User",
          }),
          expect.objectContaining({
            clientType: "agent",
            userId: "local-user",
            name: "Mock ACP",
          }),
        ]),
      );
    });

    const agentDoc = new LoroDoc();
    agentDoc.getMap("nodes").set("ws-agent-shot", {
      canvasId: "shot-board",
      type: "image",
      data: { label: "WebSocket agent shot" },
      position: { x: 400, y: 200 },
    });
    agent.send(agentDoc.export({ mode: "snapshot" }));

    await vi.waitFor(() => {
      expect(browserActivity).toContainEqual({
        type: "activity",
        actor: { clientType: "agent", name: "Mock ACP" },
        action: "added",
        nodeId: "ws-agent-shot",
        nodeType: "image",
        label: "WebSocket agent shot",
        canvasId: "shot-board",
        timestamp: expect.any(Number),
      });
    });

    await closeWebSocket(agent);

    await vi.waitFor(() => {
      const clients = browserPresence.at(-1)?.clients ?? [];
      expect(clients).toEqual([
        expect.objectContaining({
          clientType: "browser",
          userId: "local-user",
        }),
      ]);
    });

    await closeWebSocket(browser);
    await closeServer(server);
  });

  it("ignores text sideband messages instead of importing them as Loro updates", async () => {
    const server = createServer();
    attachLocalSync(server, { dataDir });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/sync/${encodeURIComponent("project/one")}`,
    );

    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({ type: "activity", clientId: "client-1" }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(errorSpy).not.toHaveBeenCalledWith(
      "[local-sync] failed to import update",
      expect.anything(),
    );

    await closeWebSocket(ws);
    await closeServer(server);
  });
});

describe("createHttpRemoteLoroPersistence", () => {
  it("loads remote snapshots over HTTP with optional bearer auth", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://remote.example/loro/project%2Fone/snapshot",
        );
        expect(init?.method).toBe("GET");
        expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
        return new Response(new Uint8Array([1, 2, 3]));
      },
    );
    const persistence = createHttpRemoteLoroPersistence({
      baseUrl: "https://remote.example/",
      token: "secret",
      fetch: fetchImpl,
    });

    await expect(persistence.loadSnapshot?.("project/one")).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("treats missing remote snapshots as empty state", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const persistence = createHttpRemoteLoroPersistence({
      baseUrl: "https://remote.example",
      fetch: fetchImpl,
    });

    await expect(persistence.loadSnapshot?.("missing")).resolves.toBeNull();
  });

  it("appends exact update bytes over HTTP", async () => {
    let postedBody: BodyInit | null = null;
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://remote.example/loro/project%2Fone/updates",
        );
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({
          "content-type": "application/octet-stream",
        });
        postedBody = init?.body ?? null;
        return new Response(null, { status: 204 });
      },
    );
    const persistence = createHttpRemoteLoroPersistence({
      baseUrl: "https://remote.example",
      fetch: fetchImpl,
    });
    const arena = new Uint8Array([0, 9, 8, 7, 0]);

    await persistence.appendUpdate("project/one", arena.subarray(1, 4));

    expect(postedBody).toBeInstanceOf(ArrayBuffer);
    const postedBuffer = postedBody as unknown as ArrayBuffer;
    expect(Array.from(new Uint8Array(postedBuffer))).toEqual([9, 8, 7]);
  });

  it("round-trips versioned project metadata over the same host-neutral transport", async () => {
    const metadata = {
      projectId: "project/one",
      name: "Remote project",
      description: "Mirrored metadata",
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:01:00.000Z",
      deletedAt: null,
    };
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://remote.example/loro/project%2Fone/metadata",
        );
        expect(init?.headers).toMatchObject({
          authorization: "Bearer secret",
        });
        if (init?.method === "GET") {
          return Response.json({ schemaVersion: 1, metadata });
        }
        expect(init?.method).toBe("PUT");
        expect(init?.headers).toMatchObject({
          "content-type": "application/json",
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          schemaVersion: 1,
          metadata,
        });
        return new Response(null, { status: 204 });
      },
    );
    const persistence = createHttpRemoteLoroPersistence({
      baseUrl: "https://remote.example/",
      token: "secret",
      fetch: fetchImpl,
    });

    await expect(
      persistence.loadProjectMetadata?.("project/one"),
    ).resolves.toEqual(metadata);
    await expect(
      persistence.saveProjectMetadata?.("project/one", metadata),
    ).resolves.toBeUndefined();
  });
});

describe("createRemoteLoroPersistenceFromEnv", () => {
  it("leaves remote persistence disabled when no remote URL is configured", () => {
    expect(createRemoteLoroPersistenceFromEnv({})).toBeUndefined();
  });

  it("creates an HTTP persistence adapter from environment configuration", async () => {
    const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer env-token",
      });
      return new Response(null, { status: 204 });
    });
    const persistence = createRemoteLoroPersistenceFromEnv(
      {
        CLASH_REMOTE_LORO_URL: "https://remote.example/",
        CLASH_REMOTE_LORO_TOKEN: "env-token",
      },
      fetchImpl,
    );

    expect(persistence).toBeDefined();
    await persistence?.appendUpdate("project/one", new Uint8Array([1]));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://remote.example/loro/project%2Fone/updates",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.once("close", resolve);
    ws.close();
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
