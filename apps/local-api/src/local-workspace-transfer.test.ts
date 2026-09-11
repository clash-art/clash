import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createActionAssetBinding,
  createProjectAsset,
  createProjectDocumentAsset,
  createProjectGenerator,
  createProjectTimeline,
  commitActionRunOutcome,
  ensureActionRunRequest,
  markActionRunStarted,
  markActionAssetBindingAuthority,
  projectDirectorStageRevisionId,
  projectTimelineRevisionId,
  readDocumentAssetRevision,
  readGeneratorRevision,
  readProjectAsset,
  requestTimelineRender,
  unbindActionAssetBinding,
} from "@clash/shared-types";
import { PROJECT_ASSET_RENDER_CANVAS_ID } from "@clash/shared-types/timeline-contract";
import {
  canonicalMetadataBody,
  createWorkspaceBundleManifest,
  storeMetadataBody,
} from "@clash/shared-runtime";
import { LoroDoc, LoroMap } from "loro-crdt";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalMetadataStore } from "./local-metadata-store";
import { createLocalResourceStore } from "./local-resource-store";
import {
  createLocalAssetInspectionService,
  createLocalFfprobeAssetInspector,
} from "./local-asset-inspections";
import { localFfprobePath } from "./local-media-binaries";
import {
  storeTextRevisionContentBlob,
  textRevisionContentHash,
} from "./text-revision-content";
import {
  LocalWorkspaceTransferError,
  createLocalWorkspaceTransferService,
} from "./local-workspace-transfer";
import { FileReplicaStore } from "./loro/file-replica-store";
import { LocalLoroRoomHub } from "./sync";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clash-workspace-transfer-"));
  roots.push(root);
  return root;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture() {
  const dataDir = await tempDataDir();
  const projectId = "portable-project";
  const doc = new LoroDoc();
  const resources = createLocalResourceStore({ dataDir });
  const png = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const staged = await resources.stage({
    bytes: png,
    originalName: "pixel.png",
  });
  const ffprobePath = localFfprobePath();
  expect(ffprobePath).toBeTruthy();
  const inspection = createLocalAssetInspectionService({
    dataDir,
    inspectResource: createLocalFfprobeAssetInspector({
      ffprobePath: ffprobePath!,
    }),
  });
  const installed = await inspection.finalize({
    resourceId: staged.resourceId,
    kind: "image",
    contentType: "image/png",
  });
  const asset = createProjectAsset(doc, {
    id: "asset-linked",
    kind: "image",
    source: {
      kind: "linked",
      resourceId: installed.source.resource.id,
      origin: {
        scope: "global",
        libraryId: "personal",
        entryId: "global-donor",
      },
    },
    lifecycle: { state: "active" },
    metadata: {
      ...installed.facts,
      bytes: installed.source.resource.byteLength,
      originalName: "pixel.png",
    },
    provenance: { kind: "generation", model: "model-portable-v1" },
  });
  expect(asset.ok).toBe(true);

  const firstBody = await storeMetadataBody({
    dataDir,
    body: {
      schemaVersion: 1,
      kind: "media.description",
      text: "first revision",
      sourceHash: installed.source.resource.id,
    },
  });
  const secondBody = await storeMetadataBody({
    dataDir,
    body: {
      schemaVersion: 1,
      kind: "media.description",
      text: "second revision",
      sourceHash: installed.source.resource.id,
    },
  });
  const document = createProjectDocumentAsset(doc, {
    id: "revision-1",
    documentAssetId: "document-1",
    documentKind: "media.description",
    schemaVersion: 1,
    mutability: "versioned",
    body: {
      digest: firstBody.contentHash,
      byteLength: firstBody.bytes,
      contentType: "application/json",
    },
    producer: { kind: "actor", actor: { kind: "agent" } },
    sourceRefs: [],
  });
  expect(document.ok).toBe(true);
  // Insert a second immutable historical body directly into the revision authority. The head is
  // intentionally left on revision-1: an exporter that only walks heads would miss this body.
  doc
    .getMap("documentAssetRevisions")
    .ensureMergeableMap("document-1")
    .set("revision-2", {
      id: "revision-2",
      documentAssetId: "document-1",
      documentKind: "media.description",
      schemaVersion: 1,
      mutability: "versioned",
      parentRevisionId: "revision-1",
      body: {
        digest: secondBody.contentHash,
        byteLength: secondBody.bytes,
        contentType: "application/json",
      },
      producer: { kind: "actor", actor: { kind: "agent" } },
      sourceRefs: [],
    });

  const definitionRef = {
    pluginId: "clash.asr",
    definitionId: "speech-transcription",
    version: "1.0.0",
    schemaHash: `sha256:${"a".repeat(64)}`,
  } as const;
  const generator = createProjectGenerator(doc, {
    head: { id: "generator-1", headRevisionId: "generator-revision-1" },
    revision: {
      id: "generator-revision-1",
      generatorId: "generator-1",
      definitionRef,
      state: {},
      persistentInputRefs: [],
    },
  });
  expect(generator.ok).toBe(true);

  const metadata = createLocalMetadataStore(dataDir);
  await metadata.save({
    projects: [
      {
        id: projectId,
        ownerId: "source-owner-private",
        name: "Portable Project",
        description: "Safe display metadata",
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        deletedAt: null,
        assets: [],
      },
    ],
    assets: [],
    assetRefs: [],
    assetNodeRefs: [],
    sessions: [],
    agentMembers: [],
    sessionMessages: [],
  });
  const content = "portable text history\n";
  const revision = {
    schemaVersion: 1 as const,
    kind: "clash.text.revision" as const,
    textId: "text-1",
    revisionId: "text-revision-1",
    projectId,
    nodeId: "script-node",
    createdAt: "2026-08-14T00:00:00.000Z",
    contentHash: textRevisionContentHash(content),
    hashAlgorithm: "sha256-64" as const,
    sourceFilePath: "drafts/script.md",
    sourceFileHash: textRevisionContentHash(content),
  };
  await storeTextRevisionContentBlob(dataDir, revision, content);
  await metadata.upsertTextRevision(revision);

  const authority = {
    inspect: async <T>(
      requestedProjectId: string,
      read: (candidate: LoroDoc) => T | Promise<T>,
    ): Promise<T> => {
      expect(requestedProjectId).toBe(projectId);
      return read(doc);
    },
  };
  const service = createLocalWorkspaceTransferService({
    dataDir,
    authority,
    assetInspection: inspection,
  });
  return {
    dataDir,
    projectId,
    doc,
    definitionRef,
    installed,
    inspection,
    authority,
    service,
  };
}

describe("local Workspace transfer authority", () => {
  it("expires every import capability and bounds active sessions", async () => {
    const dataDir = await tempDataDir();
    const ffprobePath = localFfprobePath();
    expect(ffprobePath).toBeTruthy();
    let clock = 1_000;
    const service = createLocalWorkspaceTransferService({
      dataDir,
      authority: {
        inspect: async <T>(
          _projectId: string,
          read: (candidate: LoroDoc) => T | Promise<T>,
        ) => read(new LoroDoc()),
      },
      importAuthority: {
        reconcileCommittedImport: async () => undefined,
        install: async (
          _projectId,
          _reservationId,
          _snapshot,
          commitReceiverAuthority,
        ) => commitReceiverAuthority(),
      },
      receiverOwnerId: "receiver-owner",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        inspectResource: createLocalFfprobeAssetInspector({
          ffprobePath: ffprobePath!,
        }),
      }),
      now: () => clock,
      importTtlMs: 10,
      maxActiveImports: 3,
    });
    const makeStart = (projectId: string, marker: number) => {
      const projectBytes = new Uint8Array([marker]);
      const manifest = createWorkspaceBundleManifest({
        schemaVersion: 1,
        kind: "clash.workspace.bundle",
        source: { projectId, display: { name: projectId } },
        content: {
          workspaceRoot: "workspace",
          project: {
            path: "project.bin",
            codec: "loro-shallow-snapshot",
            codecVersion: 1,
          },
          resources: [],
          documentBodies: [],
          textRevisions: [],
        },
        semanticRequirements: {
          generatorDefinitions: [],
          modelReferences: [],
        },
        files: [
          {
            path: "project.bin",
            role: "project",
            bytes: projectBytes.byteLength,
            sha256: sha256(projectBytes),
            mode: "0644",
          },
        ],
        excluded: [],
      });
      return {
        schemaVersion: 1 as const,
        kind: "clash.workspace.import-start" as const,
        idempotencyKey: `workspace-import:${manifest.integrity.bundleDigest}`,
        bundleDigest: manifest.integrity.bundleDigest,
        manifest,
      };
    };
    const getStart = makeStart("project-expired-get", 1);
    const uploadStart = makeStart("project-expired-upload", 2);
    const commitStart = makeStart("project-expired-commit", 3);
    const concurrentStart = makeStart("project-concurrent-start", 9);
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => service.createImport(concurrentStart)),
    );
    expect(new Set(concurrent.map((session) => session.importId))).toEqual(
      new Set([concurrent[0]!.importId]),
    );
    const [getSession, uploadSession, commitSession] = await Promise.all([
      service.createImport(getStart),
      service.createImport(uploadStart),
      service.createImport(commitStart),
    ]);
    clock = 1_011;

    await expect(service.getImport(getSession.importId)).rejects.toMatchObject({
      code: "WORKSPACE_IMPORT_EXPIRED",
    });
    await expect(
      service.putImportFile(
        uploadSession.importId,
        uploadSession.files[0]!.fileId,
        new Uint8Array([2]),
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_IMPORT_EXPIRED" });
    await expect(
      service.commitImport(commitSession.importId, {
        schemaVersion: 1,
        kind: "clash.workspace.import-commit",
        idempotencyKey: commitStart.idempotencyKey,
        bundleDigest: commitStart.bundleDigest,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_IMPORT_EXPIRED" });

    const restarted = await service.createImport(getStart);
    expect(restarted.importId).not.toBe(getSession.importId);
    await expect(service.getImport(restarted.importId)).resolves.toMatchObject({
      status: "staging",
    });

    const capped = createLocalWorkspaceTransferService({
      dataDir: await tempDataDir(),
      authority: {
        inspect: async <T>(
          _projectId: string,
          read: (candidate: LoroDoc) => T | Promise<T>,
        ) => read(new LoroDoc()),
      },
      importAuthority: {
        reconcileCommittedImport: async () => undefined,
        install: async (
          _projectId,
          _reservationId,
          _snapshot,
          commitReceiverAuthority,
        ) => commitReceiverAuthority(),
      },
      receiverOwnerId: "receiver-owner",
      assetInspection: createLocalAssetInspectionService({
        dataDir,
        inspectResource: createLocalFfprobeAssetInspector({
          ffprobePath: ffprobePath!,
        }),
      }),
      maxActiveImports: 1,
    });
    const first = await capped.createImport(makeStart("project-cap-one", 4));
    const second = await capped.createImport(makeStart("project-cap-two", 5));
    await expect(capped.getImport(first.importId)).rejects.toMatchObject({
      code: "WORKSPACE_IMPORT_NOT_FOUND",
    });
    await expect(capped.getImport(second.importId)).resolves.toBeDefined();
  });

  it("rejects a canonical Document body that violates its declared kind schema", async () => {
    const source = await fixture();
    const invalidBody = await storeMetadataBody({
      dataDir: source.dataDir,
      body: { text: "hash-correct but not a media.description body" },
    });
    source.doc
      .getMap("documentAssetRevisions")
      .ensureMergeableMap("document-1")
      .set("revision-invalid", {
        id: "revision-invalid",
        documentAssetId: "document-1",
        documentKind: "media.description",
        schemaVersion: 1,
        mutability: "versioned",
        parentRevisionId: "revision-2",
        body: {
          digest: invalidBody.contentHash,
          byteLength: invalidBody.bytes,
          contentType: "application/json",
        },
        producer: { kind: "actor", actor: { kind: "agent" } },
        sourceRefs: [],
      });

    await expect(
      source.service.createExport({
        projectId: source.projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it("exports the portable current Project authority and complete immutable content closure", async () => {
    const { service, projectId, definitionRef, installed } = await fixture();

    const plan = await service.createExport({
      projectId,
      sourceWorkspaceId: "external:portable-project:source-path",
    });

    expect(plan.source).toEqual({
      projectId,
      sourceWorkspaceId: "external:portable-project:source-path",
      display: {
        name: "Portable Project",
        description: "Safe display metadata",
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    });
    expect(plan).not.toHaveProperty("ownerId");
    expect(plan.semanticRequirements.generatorDefinitions).toEqual([
      definitionRef,
    ]);
    expect(plan.semanticRequirements.modelReferences).toEqual([
      { modelId: "model-portable-v1" },
    ]);
    expect(plan.content.resources).toEqual([
      expect.objectContaining({
        resource: installed.source.resource,
        path: expect.stringMatching(/^objects\/sha256\/[a-f0-9]{64}$/u),
      }),
    ]);
    expect(plan.content.documentBodies).toHaveLength(2);
    expect(plan.content.textRevisions).toEqual([
      expect.objectContaining({
        revision: expect.objectContaining({
          revisionId: "text-revision-1",
          sourceFilePath: "drafts/script.md",
        }),
      }),
    ]);
    expect(plan.content.project).toEqual({
      path: "project.bin",
      codec: "loro-shallow-snapshot",
      codecVersion: 1,
    });
    expect(plan.files.map((file) => file.role).sort()).toEqual([
      "object",
      "object",
      "object",
      "object",
      "project",
    ]);

    for (const file of plan.files) {
      const bytes = await service.readExportFile(plan.exportId, file.fileId);
      expect(bytes.byteLength).toBe(file.bytes);
      expect(sha256(bytes)).toBe(file.sha256);
    }
    await expect(
      service.readExportFile(plan.exportId, "project/snapshot.bin"),
    ).rejects.toMatchObject({ code: "WORKSPACE_EXPORT_FILE_NOT_FOUND" });
  });

  it("preserves the public Asset admission timestamp in an exported Project snapshot", async () => {
    const { service, doc, projectId } = await fixture();
    const original = readProjectAsset(doc, "asset-linked")!;
    const createdAt = Date.now();
    const created = createProjectAsset(doc, {
      ...original,
      id: "asset-timestamped",
      createdAt,
    });
    expect(created.ok).toBe(true);
    const admitted = readProjectAsset(doc, "asset-timestamped")!;
    const plan = await service.createExport({
      projectId,
      sourceWorkspaceId: "timestamp-source",
    });
    const file = plan.files.find((file) => file.role === "project")!;
    const exported = new LoroDoc();
    exported.import(await service.readExportFile(plan.exportId, file.fileId));
    expect(readProjectAsset(exported, admitted.id)?.createdAt).toBe(
      admitted.createdAt,
    );
  });

  it("garbage-collects overwritten private Loro history from project.bin", async () => {
    const { service, doc, projectId } = await fixture();
    const sentinel = "WORKSPACE_PRIVATE_HISTORY_SENTINEL";
    doc.getMap("nodes").set("history-node", {
      id: "history-node",
      type: "text",
      data: { apiKey: sentinel },
      position: { x: 0, y: 0 },
    });
    doc.getMap("nodes").set("history-node", {
      id: "history-node",
      type: "text",
      data: { status: "completed", label: "Portable current state" },
      position: { x: 0, y: 0 },
    });

    const plan = await service.createExport({
      projectId,
      sourceWorkspaceId: "external:portable-project:source-path",
    });
    const projectFile = plan.files.find((file) => file.role === "project")!;
    const bytes = await service.readExportFile(
      plan.exportId,
      projectFile.fileId,
    );
    expect(Buffer.from(bytes).includes(Buffer.from(sentinel))).toBe(false);

    const restored = new LoroDoc();
    restored.import(bytes);
    expect(restored.getMap("nodes").get("history-node")).toMatchObject({
      data: { status: "completed", label: "Portable current state" },
    });
    expect(readProjectAsset(restored, "asset-linked")).not.toBeNull();
    expect(
      readGeneratorRevision(restored, {
        generatorId: "generator-1",
        generatorRevisionId: "generator-revision-1",
      }),
    ).not.toBeNull();
    expect(
      readDocumentAssetRevision(restored, {
        documentAssetId: "document-1",
        revisionId: "revision-1",
      }),
    ).not.toBeNull();
  });

  it("rejects a private concurrent loser retained by a Loro shallow snapshot", async () => {
    const source = await fixture();
    source.doc.setPeerId("999");
    source.doc.getMap("nodes").set("conflicted-node", {
      id: "conflicted-node",
      type: "text",
      data: { label: "base" },
      position: { x: 0, y: 0 },
    });
    source.doc.commit();
    const base = source.doc.export({ mode: "snapshot" });

    const conflicted = new LoroDoc();
    conflicted.import(base);
    conflicted.setPeerId("1");
    conflicted.getMap("nodes").set("conflicted-node", {
      id: "conflicted-node",
      type: "text",
      data: { apiKey: "CONCURRENT_SECRET_SENTINEL" },
      position: { x: 0, y: 0 },
    });
    conflicted.commit();

    const safe = new LoroDoc();
    safe.import(base);
    safe.setPeerId("2");
    safe.getMap("nodes").set("conflicted-node", {
      id: "conflicted-node",
      type: "text",
      data: { label: "safe" },
      position: { x: 0, y: 0 },
    });
    safe.commit();
    conflicted.import(safe.export({ mode: "update" }));
    expect(conflicted.getMap("nodes").get("conflicted-node")).toMatchObject({
      data: { label: "safe" },
    });

    const service = createLocalWorkspaceTransferService({
      dataDir: source.dataDir,
      authority: {
        inspect: async <T>(
          _projectId: string,
          read: (doc: LoroDoc) => T | Promise<T>,
        ) => read(conflicted),
      },
      assetInspection: source.inspection,
    });
    await expect(
      service.createExport({
        projectId: source.projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it("rejects any unresolved Map register conflict retained by a shallow snapshot", async () => {
    const source = await fixture();
    source.doc.setPeerId("999");
    source.doc.getMap("nodes").set("conflicted-safe-node", {
      id: "conflicted-safe-node",
      type: "text",
      data: { label: "base" },
      position: { x: 0, y: 0 },
    });
    source.doc.commit();
    const base = source.doc.export({ mode: "snapshot" });
    const left = new LoroDoc();
    left.import(base);
    left.setPeerId("1");
    left.getMap("nodes").set("conflicted-safe-node", {
      id: "conflicted-safe-node",
      type: "text",
      data: { label: "loser" },
      position: { x: 0, y: 0 },
    });
    left.commit();
    const right = new LoroDoc();
    right.import(base);
    right.setPeerId("2");
    right.getMap("nodes").set("conflicted-safe-node", {
      id: "conflicted-safe-node",
      type: "text",
      data: { label: "winner" },
      position: { x: 0, y: 0 },
    });
    right.commit();
    left.import(right.export({ mode: "update" }));

    const service = createLocalWorkspaceTransferService({
      dataDir: source.dataDir,
      authority: {
        inspect: async <T>(
          _projectId: string,
          read: (doc: LoroDoc) => T | Promise<T>,
        ) => read(left),
      },
      assetInspection: source.inspection,
    });
    await expect(
      service.createExport({
        projectId: source.projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it("publishes one CAS object when Document and text semantics share bytes", async () => {
    const source = await fixture();
    const body = canonicalMetadataBody({
      schemaVersion: 1,
      kind: "media.description",
      text: "first revision",
      sourceHash: source.installed.source.resource.id,
    });
    const revision = {
      schemaVersion: 1 as const,
      kind: "clash.text.revision" as const,
      textId: "text-shared-object",
      revisionId: "text-revision-shared-object",
      projectId: source.projectId,
      nodeId: "shared-object-node",
      createdAt: "2026-08-14T00:01:00.000Z",
      contentHash: textRevisionContentHash(body),
      hashAlgorithm: "sha256-64" as const,
      sourceFilePath: "drafts/shared-object.json",
      sourceFileHash: textRevisionContentHash(body),
    };
    await storeTextRevisionContentBlob(source.dataDir, revision, body);
    await createLocalMetadataStore(source.dataDir).upsertTextRevision(revision);

    const plan = await source.service.createExport({
      projectId: source.projectId,
      sourceWorkspaceId: "external:portable-project:source-path",
    });
    const documentRevision = readDocumentAssetRevision(source.doc, {
      documentAssetId: "document-1",
      revisionId: "revision-1",
    })!;
    const documentPath = plan.content.documentBodies.find(
      (entry) => entry.contentHash === documentRevision.body.digest,
    )!.path;
    const textPath = plan.content.textRevisions.find(
      (entry) => entry.revision.revisionId === revision.revisionId,
    )!.path;

    expect(textPath).toBe(documentPath);
    expect(plan.files.filter((file) => file.path === documentPath)).toEqual([
      expect.objectContaining({ role: "object" }),
    ]);
  });

  it("fails closed with stable ids while public work is non-terminal", async () => {
    const { service, doc, projectId, definitionRef } = await fixture();
    const requested = ensureActionRunRequest(doc, {
      actionRunId: "run-stable-1",
      generatorRevision: {
        generatorId: "generator-1",
        generatorRevisionId: "generator-revision-1",
      },
      actionId: "transcribe",
      executor: {
        pluginId: definitionRef.pluginId,
        version: definitionRef.version,
        exportId: "transcribe",
        schemaHash: definitionRef.schemaHash,
      },
      invocationFingerprint: `sha256:${"b".repeat(64)}`,
      parameters: {},
      invocationInputRefs: [],
      outputContract: [
        {
          slot: "transcript",
          assetType: {
            kind: "document",
            documentKind: "media.description",
            schemaVersion: 1,
          },
          cardinality: { minItems: 1, maxItems: 1 },
        },
      ],
    });
    expect(requested.ok).toBe(true);
    expect(markActionRunStarted(doc, "run-stable-1").ok).toBe(true);

    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_NOT_QUIESCENT",
      blockers: [
        { kind: "generator-action-run", id: "run-stable-1", status: "running" },
      ],
    });
  });

  it("rejects nested machine-private JSON in a Generator revision state", async () => {
    const { service, doc, projectId } = await fixture();
    const revisions = doc
      .getMap("generatorRevisions")
      .get("generator-1") as LoroMap;
    const current = revisions.get("generator-revision-1") as Record<
      string,
      unknown
    >;
    revisions.set("generator-revision-1", {
      ...current,
      state: {
        visual: { ratio: "16:9" },
        runtime: { providerAccountId: "source-provider-private" },
      },
    });

    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it("rejects nested machine-private JSON in terminal Action Run parameters", async () => {
    const { service, doc, projectId, definitionRef } = await fixture();
    const requested = ensureActionRunRequest(doc, {
      actionRunId: "run-private-parameters",
      generatorRevision: {
        generatorId: "generator-1",
        generatorRevisionId: "generator-revision-1",
      },
      actionId: "transcribe",
      executor: {
        pluginId: definitionRef.pluginId,
        version: definitionRef.version,
        exportId: "transcribe",
        schemaHash: definitionRef.schemaHash,
      },
      invocationFingerprint: `sha256:${"b".repeat(64)}`,
      parameters: {
        request: [{ auth: { accessToken: "source-token-private" } }],
      },
      invocationInputRefs: [],
      outputContract: [
        {
          slot: "transcript",
          assetType: {
            kind: "document",
            documentKind: "media.description",
            schemaVersion: 1,
          },
          cardinality: { minItems: 1, maxItems: 1 },
        },
      ],
    });
    expect(requested.ok).toBe(true);
    expect(
      commitActionRunOutcome(doc, {
        actionRunId: "run-private-parameters",
        status: "failed",
      }).ok,
    ).toBe(true);

    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it.each([
    {
      surface: "Canvas node data",
      mutate: (doc: LoroDoc) =>
        doc.getMap("nodes").set("private-node", {
          id: "private-node",
          type: "text",
          data: { status: "completed", nested: { credentials: "private" } },
          position: { x: 0, y: 0 },
        }),
    },
    {
      surface: "Canvas node style",
      mutate: (doc: LoroDoc) =>
        doc.getMap("nodes").set("private-style", {
          id: "private-style",
          type: "text",
          data: { status: "completed" },
          position: { x: 0, y: 0 },
          style: { nested: { workerUrl: "http://127.0.0.1:4321" } },
        }),
    },
    {
      surface: "Timeline state",
      mutate: (doc: LoroDoc) => {
        const state = { tracks: [], nested: { apiKey: "private" } };
        const timeline = doc
          .getMap("timelines")
          .ensureMergeableMap("private-timeline");
        timeline.set("name", "Private Timeline");
        timeline.set("revision", {
          state,
          revisionId: projectTimelineRevisionId("private-timeline", state),
        });
      },
    },
    {
      surface: "Director state",
      mutate: (doc: LoroDoc) => {
        const state = {
          schemaVersion: 1 as const,
          scene: {
            backgroundColor: "#171816",
            grid: { visible: true, snap: false, size: 1 },
          },
          objects: [],
          cameras: [],
          shots: [],
          nested: { runtimeId: "private-runtime" },
        };
        const stage = doc
          .getMap("directorStages")
          .ensureMergeableMap("private-stage");
        stage.set("name", "Private Stage");
        stage.set("revision", {
          state,
          revisionId: projectDirectorStageRevisionId("private-stage", state),
        });
      },
    },
  ])("rejects nested machine-private JSON in $surface", async ({ mutate }) => {
    const { service, doc, projectId } = await fixture();
    mutate(doc);
    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it.each([
    {
      surface: "Project Asset fields",
      mutate: async (doc: LoroDoc) => {
        (doc.getMap("projectAssets").get("asset-linked") as LoroMap).set(
          "apiKey",
          "private",
        );
      },
    },
    {
      surface: "Project Generator fields",
      mutate: async (doc: LoroDoc) => {
        (doc.getMap("projectGenerators").get("generator-1") as LoroMap).set(
          "token",
          "private",
        );
      },
    },
    {
      surface: "Action Run fields",
      mutate: async (doc: LoroDoc, definitionRef: any) => {
        expect(
          ensureActionRunRequest(doc, {
            actionRunId: "run-reader-hidden",
            generatorRevision: {
              generatorId: "generator-1",
              generatorRevisionId: "generator-revision-1",
            },
            actionId: "transcribe",
            executor: {
              pluginId: definitionRef.pluginId,
              version: definitionRef.version,
              exportId: "transcribe",
              schemaHash: definitionRef.schemaHash,
            },
            invocationFingerprint: `sha256:${"c".repeat(64)}`,
            parameters: {},
            invocationInputRefs: [],
            outputContract: [
              {
                slot: "transcript",
                assetType: {
                  kind: "document",
                  documentKind: "media.description",
                  schemaVersion: 1,
                },
                cardinality: { minItems: 1, maxItems: 1 },
              },
            ],
          }).ok,
        ).toBe(true);
        expect(
          commitActionRunOutcome(doc, {
            actionRunId: "run-reader-hidden",
            status: "failed",
          }).ok,
        ).toBe(true);
        (
          doc.getMap("generatorActionRuns").get("run-reader-hidden") as LoroMap
        ).set("credentials", "private");
      },
    },
    {
      surface: "Document head fields",
      mutate: async (doc: LoroDoc) => {
        (doc.getMap("projectDocumentAssets").get("document-1") as LoroMap).set(
          "localPath",
          "/private/document",
        );
      },
    },
    {
      surface: "Document attachment fields",
      mutate: async (doc: LoroDoc) => {
        const fields = doc
          .getMap("documentAttachments")
          .ensureMergeableMap("attachment-reader-hidden");
        fields.set("target", {
          kind: "project-asset",
          projectAssetId: "asset-linked",
        });
        fields.set("slot", "description");
        fields.set("document", {
          documentAssetId: "document-1",
          revisionId: "revision-1",
        });
        fields.set("workerUrl", "http://127.0.0.1:4321");
      },
    },
    ...[
      "projectAssetSchema",
      "generatorSchema",
      "documentAssetSchema",
      "actionAssetBindingSchema",
      "graphSchema",
    ].map((container) => ({
      surface: `${container} marker fields`,
      mutate: async (doc: LoroDoc) => {
        doc.getMap(container).set("apiKey", "private");
      },
    })),
  ])("rejects reader-hidden $surface", async ({ mutate }) => {
    const { service, doc, projectId, definitionRef } = await fixture();
    await mutate(doc, definitionRef);
    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it.each([
    {
      surface: "Generator parent",
      mutate: (doc: LoroDoc, definitionRef: any) => {
        (doc.getMap("generatorRevisions").get("generator-1") as LoroMap).set(
          "generator-revision-orphan",
          {
            id: "generator-revision-orphan",
            generatorId: "generator-1",
            definitionRef,
            parentRevisionId: "missing-generator-parent",
            state: {},
            persistentInputRefs: [],
          },
        );
      },
    },
    {
      surface: "Document parent",
      mutate: (doc: LoroDoc) => {
        const parent = readDocumentAssetRevision(doc, {
          documentAssetId: "document-1",
          revisionId: "revision-1",
        })!;
        (doc.getMap("documentAssetRevisions").get("document-1") as LoroMap).set(
          "document-revision-orphan",
          {
            ...parent,
            id: "document-revision-orphan",
            parentRevisionId: "missing-document-parent",
          },
        );
      },
    },
  ])("rejects a missing immutable $surface", async ({ mutate }) => {
    const { service, doc, projectId, definitionRef } = await fixture();
    mutate(doc, definitionRef);
    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it("rejects an Output Commit whose outer Action Run is missing", async () => {
    const { service, doc, projectId } = await fixture();
    doc
      .getMap("generatorOutputCommits")
      .ensureMergeableMap("missing-run")
      .set("transcript", {
        actionRunId: "missing-run",
        outputSlot: "transcript",
        asset: {
          kind: "document",
          documentAssetId: "document-1",
          revisionId: "revision-1",
        },
      });
    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it("rejects a succeeded Action Run without its required output", async () => {
    const { service, doc, projectId, definitionRef } = await fixture();
    expect(
      ensureActionRunRequest(doc, {
        actionRunId: "succeeded-without-output",
        generatorRevision: {
          generatorId: "generator-1",
          generatorRevisionId: "generator-revision-1",
        },
        actionId: "transcribe",
        executor: {
          pluginId: definitionRef.pluginId,
          version: definitionRef.version,
          exportId: "transcribe",
          schemaHash: definitionRef.schemaHash,
        },
        invocationFingerprint: `sha256:${"d".repeat(64)}`,
        parameters: {},
        invocationInputRefs: [],
        outputContract: [
          {
            slot: "transcript",
            assetType: {
              kind: "document",
              documentKind: "media.description",
              schemaVersion: 1,
            },
            cardinality: { minItems: 1, maxItems: 1 },
          },
        ],
      }).ok,
    ).toBe(true);
    (
      doc
        .getMap("generatorActionRuns")
        .get("succeeded-without-output") as LoroMap
    ).set("outcome", {
      actionRunId: "succeeded-without-output",
      status: "succeeded",
    });
    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it("rejects a terminal Action Run whose executor differs from its Generator revision", async () => {
    const { service, doc, projectId, definitionRef } = await fixture();
    expect(
      ensureActionRunRequest(doc, {
        actionRunId: "run-wrong-executor",
        generatorRevision: {
          generatorId: "generator-1",
          generatorRevisionId: "generator-revision-1",
        },
        actionId: "transcribe",
        executor: {
          pluginId: definitionRef.pluginId,
          version: definitionRef.version,
          exportId: "transcribe",
          schemaHash: definitionRef.schemaHash,
        },
        invocationFingerprint: `sha256:${"e".repeat(64)}`,
        parameters: {},
        invocationInputRefs: [],
        outputContract: [
          {
            slot: "transcript",
            assetType: {
              kind: "document",
              documentKind: "media.description",
              schemaVersion: 1,
            },
            cardinality: { minItems: 1, maxItems: 1 },
          },
        ],
      }).ok,
    ).toBe(true);
    expect(
      commitActionRunOutcome(doc, {
        actionRunId: "run-wrong-executor",
        status: "failed",
      }).ok,
    ).toBe(true);
    const run = doc
      .getMap("generatorActionRuns")
      .get("run-wrong-executor") as LoroMap;
    const request = run.get("request") as Record<string, unknown>;
    run.set("request", {
      ...request,
      executor: {
        ...(request.executor as Record<string, unknown>),
        pluginId: "other.plugin",
      },
    });
    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it("blocks legacy Canvas, Timeline, custom, and provider nodes with unfinished public state", async () => {
    const { service, doc, projectId } = await fixture();
    doc.getMap("nodes").set("timeline-render-stable", {
      id: "timeline-render-stable",
      type: "video",
      data: { status: "pending", timelineDsl: { tracks: [] } },
    });
    doc.getMap("nodes").set("ordinary-draft", {
      id: "ordinary-draft",
      type: "text",
      data: { status: "idle" },
    });
    doc.getMap("nodes").set("terminal-output", {
      id: "terminal-output",
      type: "image",
      data: { status: "completed" },
    });

    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_NOT_QUIESCENT",
      blockers: [
        {
          kind: "project-node",
          id: "timeline-render-stable",
          status: "pending",
        },
      ],
    });
  });

  it("rejects invalid raw authority entries instead of silently omitting them", async () => {
    const { service, doc, projectId } = await fixture();
    doc.getMap("projectAssets").set("corrupt-asset", "not-an-entry");

    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_AUTHORITY_INVALID",
    });
  });

  it("preserves valid Action binding tombstones in the exact Project snapshot", async () => {
    const { service, doc, projectId } = await fixture();
    expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
    expect(
      createActionAssetBinding(doc, {
        id: "binding-tombstone",
        owner: { kind: "draft", actionId: "portable-action" },
        direction: "input",
        slot: "source",
        projectAssetId: "asset-linked",
        role: "source",
      }),
    ).toMatchObject({ ok: true });
    expect(unbindActionAssetBinding(doc, "binding-tombstone")).toMatchObject({
      ok: true,
    });

    const plan = await service.createExport({
      projectId,
      sourceWorkspaceId: "external:portable-project:source-path",
    });
    const projectFile = plan.files.find((file) => file.role === "project")!;
    const restored = new LoroDoc();
    restored.import(
      await service.readExportFile(plan.exportId, projectFile.fileId),
    );

    expect(
      (
        restored
          .getMap("actionAssetBindings")
          .get("binding-tombstone") as LoroMap
      ).get("unbound"),
    ).toBe(true);
  });

  it("exports a terminal standalone Timeline render from the internal Project Asset scope", async () => {
    const source = await fixture();
    expect(markActionAssetBindingAuthority(source.doc)).toMatchObject({
      ok: true,
    });
    expect(
      createProjectTimeline(source.doc, {
        id: "timeline-internal-render",
        name: "Internal render",
        state: {
          compositionWidth: 1,
          compositionHeight: 1,
          fps: 30,
          durationInFrames: 30,
          tracks: [
            {
              id: "image-track",
              items: [
                {
                  id: "source-image",
                  type: "image",
                  from: 0,
                  durationInFrames: 30,
                  assetId: "asset-linked",
                },
              ],
            },
          ],
        },
      }),
    ).toMatchObject({ ok: true });
    expect(
      requestTimelineRender(source.doc, {
        timelineId: "timeline-internal-render",
        actorUserId: "portable-user",
        generateId: () => "render-internal-completed",
      }),
    ).toMatchObject({
      ok: true,
      renderNodeId: "render-internal-completed",
      target: { kind: "project-assets" },
    });
    const pending = source.doc
      .getMap("nodes")
      .get("render-internal-completed") as Record<string, unknown>;
    source.doc.getMap("nodes").set("render-internal-completed", {
      ...pending,
      data: {
        ...(pending.data as Record<string, unknown>),
        status: "completed",
        assetId: "asset-linked",
      },
    });
    expect([...source.doc.getMap("canvases").keys()]).not.toContain(
      PROJECT_ASSET_RENDER_CANVAS_ID,
    );

    const plan = await source.service.createExport({
      projectId: source.projectId,
      sourceWorkspaceId: "external:portable-project:source-path",
    });
    const projectFile = plan.files.find((file) => file.role === "project")!;
    const restored = new LoroDoc();
    restored.import(
      await source.service.readExportFile(plan.exportId, projectFile.fileId),
    );

    expect(
      restored.getMap("nodes").get("render-internal-completed"),
    ).toMatchObject({
      canvasId: PROJECT_ASSET_RENDER_CANVAS_ID,
      type: "video",
      data: {
        status: "completed",
        assetId: "asset-linked",
        sourceTimelineId: "timeline-internal-render",
        renderTarget: { kind: "project-assets" },
      },
    });
    expect([...restored.getMap("canvases").keys()]).not.toContain(
      PROJECT_ASSET_RENDER_CANVAS_ID,
    );
  });

  it("rejects a Canvas node targeting an unregistered non-system Canvas", async () => {
    const source = await fixture();
    source.doc.getMap("nodes").set("dangling-canvas-node", {
      id: "dangling-canvas-node",
      canvasId: "unregistered-canvas",
      type: "text",
      data: { status: "completed" },
      position: { x: 0, y: 0 },
    });

    await expect(
      source.service.createExport({
        projectId: source.projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_AUTHORITY_INVALID",
      message:
        "Canvas node dangling-canvas-node points to missing Canvas unregistered-canvas.",
    });
  });

  it.each([
    ["Canvas", (doc: LoroDoc) => doc.getMap("canvases").set("broken", "bad")],
    [
      "node",
      (doc: LoroDoc) =>
        doc.getMap("nodes").set("broken", { type: "image", data: "bad" }),
    ],
    [
      "node upstream",
      (doc: LoroDoc) => doc.getMap("nodeUpstreams").set("missing-node", "bad"),
    ],
    [
      "edge identity",
      (doc: LoroDoc) =>
        doc.getMap("edgeIdentity").set("broken-edge", { target: 42 }),
    ],
    [
      "Timeline",
      (doc: LoroDoc) =>
        doc.getMap("timelines").set("broken", { revision: "bad" }),
    ],
    [
      "Director stage",
      (doc: LoroDoc) =>
        doc.getMap("directorStages").set("broken", { revision: "bad" }),
    ],
    [
      "Project presentation",
      (doc: LoroDoc) =>
        doc.getMap("projectPresentation").set("coverBindingId", 42),
    ],
  ] as const)(
    "rejects an invalid raw %s authority entry",
    async (_label, mutate) => {
      const source = await fixture();
      mutate(source.doc);

      await expect(
        source.service.createExport({
          projectId: source.projectId,
          sourceWorkspaceId: "external:portable-project:source-path",
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
    },
  );

  it("rejects machine-private Canvas node projection fields", async () => {
    const source = await fixture();
    source.doc.getMap("nodes").set("leaky-node", {
      type: "image",
      data: {
        status: "completed",
        assetId: "asset-linked",
        signedUrl: "https://machine.invalid/capability",
        storageKey: "private/resource/path",
      },
      position: { x: 0, y: 0 },
    });

    await expect(
      source.service.createExport({
        projectId: source.projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it("rejects machine-private Timeline media projections", async () => {
    const source = await fixture();
    const timeline = source.doc
      .getMap("timelines")
      .ensureMergeableMap("timeline-leaky");
    timeline.set("name", "Leaky Timeline");
    timeline.set("owner", { kind: "project" });
    timeline.set("revision", {
      revisionId: "timeline-revision-leaky",
      state: {
        tracks: [
          {
            id: "track-1",
            items: [
              {
                id: "item-1",
                type: "image",
                assetId: "asset-linked",
                src: "https://machine.invalid/capability",
                storageKey: "private/resource/path",
              },
            ],
          },
        ],
      },
    });

    await expect(
      source.service.createExport({
        projectId: source.projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it("requires migration before exporting legacy custom Action runtime definitions", async () => {
    const source = await fixture();
    source.doc.getMap("customActions").set("legacy-runtime", {
      id: "legacy-runtime",
      runtime: "worker",
      workerUrl: "https://machine.invalid/worker.js",
    });

    await expect(
      source.service.createExport({
        projectId: source.projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_MIGRATION_REQUIRED" });
  });

  it("refuses legacy owner-private task state instead of carrying it in project.bin", async () => {
    const source = await fixture();
    source.doc.getMap("tasks").set("private-task", {
      status: "pending",
      providerAccountId: "machine-account",
    });

    await expect(
      source.service.createExport({
        projectId: source.projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_MIGRATION_REQUIRED" });
  });

  it("rejects unknown Loro root containers instead of treating project.bin as an opaque secret carrier", async () => {
    const source = await fixture();
    source.doc.getMap("providerAccounts").set("account-1", {
      apiKey: "machine-secret",
    });

    await expect(
      source.service.createExport({
        projectId: source.projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_MIGRATION_REQUIRED" });
  });

  it("requires synchronized Asset L1 facts to match the current Host v4 inspection", async () => {
    const { service, doc, projectId } = await fixture();
    const fields = doc.getMap("projectAssets").get("asset-linked");
    expect(fields).toBeInstanceOf(LoroMap);
    const metadata = (fields as LoroMap).get("metadata") as Record<
      string,
      unknown
    >;
    (fields as LoroMap).set("metadata", { ...metadata, width: 999 });

    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CONTENT_MISMATCH" });
  });

  it("derives model hints from frozen Generator state and canonical Canvas node fields", async () => {
    const { service, doc, projectId } = await fixture();
    const revisions = doc
      .getMap("generatorRevisions")
      .get("generator-1") as LoroMap;
    const revision = revisions.get("generator-revision-1") as Record<
      string,
      unknown
    >;
    revisions.set("generator-revision-1", {
      ...revision,
      state: { modelId: "native-asr-model" },
    });
    doc.getMap("nodes").set("completed-canvas-output", {
      id: "completed-canvas-output",
      type: "image",
      data: { status: "completed", modelId: "canvas-image-model" },
    });

    const plan = await service.createExport({
      projectId,
      sourceWorkspaceId: "external:portable-project:source-path",
    });

    expect(plan.semanticRequirements.modelReferences).toEqual([
      { modelId: "canvas-image-model" },
      { modelId: "model-portable-v1" },
      { modelId: "native-asr-model" },
    ]);
  });

  it("rejects semantic references to purged media whose bytes are intentionally absent", async () => {
    const { service, doc, projectId, installed } = await fixture();
    const purged = createProjectAsset(doc, {
      id: "asset-purged",
      kind: "image",
      source: {
        kind: "owned",
        resourceId: installed.source.resource.id,
      },
      lifecycle: {
        state: "purged",
        deleteOperationId: "delete-1",
        deletedAt: "2026-08-14T01:00:00.000Z",
        purgedAt: "2026-08-14T02:00:00.000Z",
      },
      metadata: {
        ...installed.facts,
        bytes: installed.source.resource.byteLength,
      },
    });
    expect(purged.ok).toBe(true);
    const revisions = doc
      .getMap("generatorRevisions")
      .get("generator-1") as LoroMap;
    const revision = revisions.get("generator-revision-1") as Record<
      string,
      unknown
    >;
    revisions.set("generator-revision-1", {
      ...revision,
      persistentInputRefs: [
        {
          slot: "source",
          target: { kind: "media", projectAssetId: "asset-purged" },
        },
      ],
    });

    await expect(
      service.createExport({
        projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });

  it("expires and forgets old opaque export capabilities", async () => {
    const base = await fixture();
    let now = Date.parse("2026-08-14T00:00:00.000Z");
    const service = createLocalWorkspaceTransferService({
      dataDir: base.dataDir,
      authority: base.authority,
      assetInspection: base.inspection,
      now: () => now,
      exportTtlMs: 10,
      maxActiveExports: 2,
    });
    const plan = await service.createExport({
      projectId: base.projectId,
      sourceWorkspaceId: "external:portable-project:source-path",
    });
    expect(plan.expiresAt).toBe(new Date(now + 10).toISOString());

    now += 11;
    await expect(
      service.readExportFile(plan.exportId, plan.files[0]!.fileId),
    ).rejects.toMatchObject({ code: "WORKSPACE_EXPORT_EXPIRED" });
    await expect(
      service.readExportFile(plan.exportId, plan.files[0]!.fileId),
    ).rejects.toMatchObject({ code: "WORKSPACE_EXPORT_NOT_FOUND" });
  });

  it("imports through staged Host verification into a fresh authority and survives trusted readback", async () => {
    const source = await fixture();
    const exportPlan = await source.service.createExport({
      projectId: source.projectId,
      sourceWorkspaceId: "external:portable-project:source-path",
    });
    const workspaceBody = new TextEncoder().encode("portable worktree\n");
    const authorityFiles = exportPlan.files.map(
      ({ fileId: _fileId, ...file }) => file,
    );
    const { sourceWorkspaceId: _sourceWorkspaceId, ...portableSource } =
      exportPlan.source;
    const manifest = createWorkspaceBundleManifest({
      schemaVersion: 1,
      kind: "clash.workspace.bundle",
      source: portableSource,
      content: exportPlan.content,
      semanticRequirements: exportPlan.semanticRequirements,
      files: [
        ...authorityFiles,
        {
          path: "workspace/README.md",
          role: "workspace" as const,
          bytes: workspaceBody.byteLength,
          sha256: sha256(workspaceBody),
          mode: "0644" as const,
        },
      ].sort((left, right) => left.path.localeCompare(right.path)),
      excluded: [],
    });

    const targetDataDir = await tempDataDir();
    const targetReplica = new FileReplicaStore(join(targetDataDir, "projects"));
    const targetFfprobe = localFfprobePath();
    expect(targetFfprobe).toBeTruthy();
    const targetInspection = createLocalAssetInspectionService({
      dataDir: targetDataDir,
      inspectResource: createLocalFfprobeAssetInspector({
        ffprobePath: targetFfprobe!,
      }),
    });
    const targetService = createLocalWorkspaceTransferService({
      dataDir: targetDataDir,
      authority: {
        inspect: async <T>(
          projectId: string,
          read: (candidate: LoroDoc) => T | Promise<T>,
        ) => read(await targetReplica.recover(projectId)),
      },
      importAuthority: {
        reconcileCommittedImport: async () => undefined,
        install: async (
          projectId,
          _reservationId,
          snapshot,
          commitReceiverAuthority,
        ) => {
          await targetReplica.installSnapshotIfAbsent(projectId, snapshot);
          return commitReceiverAuthority();
        },
      },
      receiverOwnerId: "receiver-local-user",
      assetInspection: targetInspection,
    });
    const idempotencyKey = `workspace-import:${manifest.integrity.bundleDigest}`;
    const importStart = {
      schemaVersion: 1 as const,
      kind: "clash.workspace.import-start" as const,
      idempotencyKey,
      bundleDigest: manifest.integrity.bundleDigest,
      manifest,
    };
    const importSession = await targetService.createImport(importStart);
    expect(
      importSession.files.some((file) => String(file.role) === "workspace"),
    ).toBe(false);
    for (const slot of importSession.files) {
      const sourceFile = exportPlan.files.find(
        (candidate) => candidate.path === slot.path,
      );
      expect(sourceFile).toBeDefined();
      const bytes = await source.service.readExportFile(
        exportPlan.exportId,
        sourceFile!.fileId,
      );
      await targetService.putImportFile(
        importSession.importId,
        slot.fileId,
        bytes,
      );
    }
    const committed = await targetService.commitImport(importSession.importId, {
      schemaVersion: 1,
      kind: "clash.workspace.import-commit",
      idempotencyKey,
      bundleDigest: manifest.integrity.bundleDigest,
    });
    expect(committed).toMatchObject({
      status: "committed",
      target: { projectId: source.projectId },
      source: {
        projectId: source.projectId,
      },
    });

    const restartedDoc = await new FileReplicaStore(
      join(targetDataDir, "projects"),
    ).recover(source.projectId);
    expect(readProjectAsset(restartedDoc, "asset-linked")).toMatchObject({
      id: "asset-linked",
      kind: "image",
    });
    expect(
      readDocumentAssetRevision(restartedDoc, {
        documentAssetId: "document-1",
        revisionId: "revision-2",
      }),
    ).not.toBeNull();
    const targetMetadata = createLocalMetadataStore(targetDataDir);
    expect(
      (await targetMetadata.load()).projects.find(
        (project) => project.id === source.projectId,
      ),
    ).toMatchObject({
      ownerId: "receiver-local-user",
      name: "Portable Project",
    });
    expect(
      await targetMetadata.listWorkspaceTextRevisions(source.projectId),
    ).toEqual([expect.objectContaining({ revisionId: "text-revision-1" })]);
    expect(
      await createLocalResourceStore({ dataDir: targetDataDir }).resolve(
        source.installed.source.resource.id,
      ),
    ).toMatchObject({
      resource: source.installed.source.resource,
    });

    await expect(
      targetService.createImport(importStart),
    ).resolves.toMatchObject({
      importId: importSession.importId,
      status: "committed",
    });

    const projectFile = manifest.files.find((file) => file.role === "project")!;
    const staleReservation = {
      schemaVersion: 1 as const,
      kind: "clash.workspace.import-reservation" as const,
      reservationId: `workspace-import:${manifest.integrity.bundleDigest}`,
      snapshotSha256: projectFile.sha256,
    };
    await targetReplica.reserveImportedProject(
      source.projectId,
      staleReservation,
    );
    const restartedHub = new LocalLoroRoomHub(targetDataDir, undefined, null);
    const restartedService = createLocalWorkspaceTransferService({
      dataDir: targetDataDir,
      authority: {
        inspect: async <T>(
          projectId: string,
          read: (candidate: LoroDoc) => T | Promise<T>,
        ) =>
          read(
            await new FileReplicaStore(join(targetDataDir, "projects")).recover(
              projectId,
            ),
          ),
      },
      importAuthority: {
        reconcileCommittedImport: (projectId, reservationId, snapshotSha256) =>
          restartedHub.reconcileCommittedImport(
            projectId,
            reservationId,
            snapshotSha256,
          ),
        install: (
          projectId,
          reservationId,
          snapshot,
          commitReceiverAuthority,
        ) =>
          restartedHub.installImportedProject(
            projectId,
            reservationId,
            snapshot,
            commitReceiverAuthority,
          ),
      },
      receiverOwnerId: "receiver-local-user",
      assetInspection: targetInspection,
    });
    const restartedCommitted = await restartedService.createImport(importStart);
    expect(restartedCommitted).toMatchObject({
      importId: `committed-${manifest.integrity.bundleDigest}`,
      status: "committed",
      committedAt: expect.any(String),
    });
    await expect(
      targetReplica.readImportReservation(source.projectId),
    ).resolves.toBeNull();
    await expect(
      restartedService.getImport(restartedCommitted.importId),
    ).resolves.toMatchObject({ status: "committed" });
    await expect(
      restartedService.commitImport(restartedCommitted.importId, {
        schemaVersion: 1,
        kind: "clash.workspace.import-commit",
        idempotencyKey,
        bundleDigest: manifest.integrity.bundleDigest,
      }),
    ).resolves.toMatchObject({ status: "already-committed" });
    await restartedHub.close();

    const conflictingManifest = createWorkspaceBundleManifest({
      schemaVersion: 1,
      kind: "clash.workspace.bundle",
      source: {
        ...manifest.source,
        display: { ...manifest.source.display, name: "Different bundle" },
      },
      content: manifest.content,
      semanticRequirements: manifest.semanticRequirements,
      files: manifest.files,
      excluded: manifest.excluded,
    });
    await expect(
      restartedService.createImport({
        ...importStart,
        idempotencyKey: `workspace-import:${conflictingManifest.integrity.bundleDigest}`,
        bundleDigest: conflictingManifest.integrity.bundleDigest,
        manifest: conflictingManifest,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_IMPORT_PROJECT_EXISTS" });
  });

  it("rejects deleted Projects and machine-private text source paths", async () => {
    const deleted = await fixture();
    const metadata = createLocalMetadataStore(deleted.dataDir);
    const state = await metadata.load();
    state.projects[0]!.deletedAt = "2026-08-14T01:00:00.000Z";
    await metadata.save(state);
    await expect(
      deleted.service.createExport({
        projectId: deleted.projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_PROJECT_DELETED" });

    const absolute = await fixture();
    const absoluteStore = createLocalMetadataStore(absolute.dataDir);
    const revision = (
      await absoluteStore.listTextRevisions({
        projectId: absolute.projectId,
      })
    )[0]!;
    await absoluteStore.upsertTextRevision({
      ...revision,
      revisionId: "absolute-source-revision",
      sourceFilePath: "/Users/source/private/script.md",
    });
    await expect(
      absolute.service.createExport({
        projectId: absolute.projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toBeInstanceOf(LocalWorkspaceTransferError);

    const secretLike = await fixture();
    const secretStore = createLocalMetadataStore(secretLike.dataDir);
    const secretRevision = (
      await secretStore.listTextRevisions({
        projectId: secretLike.projectId,
      })
    )[0]!;
    await secretStore.upsertTextRevision({
      ...secretRevision,
      revisionId: "secret-source-revision",
      sourceFilePath: "drafts/.env.local",
    });
    await expect(
      secretLike.service.createExport({
        projectId: secretLike.projectId,
        sourceWorkspaceId: "external:portable-project:source-path",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_AUTHORITY_INVALID" });
  });
});
