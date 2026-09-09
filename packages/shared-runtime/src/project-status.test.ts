import { describe, expect, it } from "vitest";
import {
  buildProjectRecoveryPolicy,
  buildProjectStatus,
  projectWorkspaceId,
} from "./project-status";

const expectedTracePolicy = {
  schemaVersion: 1,
  agentSessionMetadata: {
    kind: "public-session-metadata",
    syncDefault: "sync-when-project-sync-enabled",
    rawAgentTrace: false,
  },
  rawAgentTraces: {
    kind: "private-runtime-trace",
    syncDefault: "local-only",
    optInRequiredForSync: true,
    excludedFromRoom: true,
    sensitiveFields: ["tool-logs", "local-file-paths", "scratch-context"],
    syncAdmission: {
      allowed: false,
      reason: "explicit-policy-required",
      requirements: ["user-opt-in-or-team-policy"],
      defaultAllowed: false,
    },
    retention: {
      default: "until-session-delete",
      scope: "per-session",
      api: "DELETE /api/v1/sessions",
      cliCommand: "clash sessions delete",
      clears: ["runtime_session", "chat_message"],
    },
  },
} as const;

function expectedProjectRoomPolicy(cloudSurface: "disabled" | "sequencer") {
  return {
    schemaVersion: 1,
    localSurface: "removed",
    localPersistence: false,
    localApiEndpoints: "404",
    cliCommand: "unregistered",
    cloudSurface,
    rawAgentTrace: false,
    agentDefaultChannels: ["sessions", "canvas", "actions"],
  } as const;
}

const expectedSyncMirrorPolicy = {
  canvas: {
    requirement: "canvas",
    source: "loro-project-replica",
    conflictPolicy: "loro-crdt",
  },
  assetMetadata: {
    requirement: "asset-metadata",
    source: "sqlite-asset-indexes",
    registries: ["assets", "asset_refs", "asset_node_refs"],
    mediaBlobsIncluded: false,
    conflictPolicy: "host-indexed-content-addressed-assets",
  },
  revisionContent: {
    requirement: "revision-content",
    source: "sqlite-index-and-content-addressed-revision-blobs",
    registries: ["text_revisions"],
    contentKinds: ["text-revision-content"],
    mediaAsset: false,
    agentWritable: false,
    conflictPolicy: "same-revision-id-same-hash-idempotent-conflict-otherwise",
  },
  projectMetadata: {
    requirement: "project-metadata",
    source: "hosted-project-metadata-store",
    fields: ["name", "description", "createdAt", "updatedAt", "deletedAt"],
    mediaBlobsIncluded: false,
    conflictPolicy: "updated-at-lww-with-stable-tie-breaker",
  },
} as const;

function expectedSyncPolicy(cloudAdmission: string) {
  return {
    schemaVersion: 1,
    cloudAdmission,
    mirror: expectedSyncMirrorPolicy,
    excluded: {
      rawAgentTraces: {
        syncDefault: "local-only",
        optInRequiredForSync: true,
      },
      localRuntimeSecrets: {
        syncDefault: "local-only",
        optInRequiredForSync: true,
      },
    },
  };
}

describe("project status path builder", () => {
  it("derives stable workspace ids without embedding project ids", () => {
    const first = projectWorkspaceId(
      "managed",
      "project/with spaces",
      "/tmp/workspace",
    );
    const second = projectWorkspaceId(
      "managed",
      "project/with spaces",
      "/tmp/workspace",
    );
    const differentWorkspace = projectWorkspaceId(
      "managed",
      "project/with spaces",
      "/tmp/other-workspace",
    );
    const external = projectWorkspaceId(
      "external",
      "project/with spaces",
      "/tmp/workspace",
    );

    expect(first).toMatch(/^managed:[a-f0-9]{16}$/);
    expect(first).toBe(second);
    expect(first).not.toContain("project");
    expect(first).not.toBe(differentWorkspace);
    expect(first).not.toBe(external);
    expect(external).toMatch(/^external:[a-f0-9]{16}$/);
  });

  it("keeps Project Timeline history in the canonical Loro replica", () => {
    const status = buildProjectStatus(
      { projectId: "timeline-history", source: "marker" },
      {
        clashRoot: "/tmp/clash-home",
        localApiDataDir: "/tmp/clash-home/local-api",
      },
    );

    expect(status.storage.canonicalReplica).toHaveProperty("projectState");
    expect(status.storage.canonicalReplica).not.toHaveProperty("canvas");
    expect(status.storage.canonicalReplica.contentBlobs).not.toHaveProperty(
      "timelineRevisions",
    );
    expect(status.storage.contentModel.timelines).toMatchObject({
      liveState: "loro-project-timeline-entity",
      revisionAuthority: "loro-project-history",
      revisionIdentity: "state-hash",
      downstreamRendersPinRevision: true,
    });
    expect(status.storage.contentModel.timelines).not.toHaveProperty(
      "revisionRegistry",
    );
    expect(status.storage.contentModel.timelines).not.toHaveProperty(
      "revisionBlobPath",
    );
    expect(status.storage.contentModel.timelines).not.toHaveProperty(
      "contentRegistry",
    );
    expect(
      status.collaboration.syncPolicy.mirror.revisionContent.registries,
    ).toEqual(["text_revisions"]);
  });

  it("builds agent-editable roots and protected local store paths", () => {
    const status = buildProjectStatus(
      { projectId: "project/one", source: "explicit" },
      {
        clashRoot: "/tmp/clash-home",
        localApiDataDir: "/tmp/clash-home/local-api",
      },
    );

    expect(status.projectWorkspaceRoot).toBe(
      "/tmp/clash-home/projects/project%2Fone",
    );
    expect(status.currentWorkspace).toEqual({
      schemaVersion: 1,
      role: "project-reference-and-draft-workspace",
      projectWorkspaceRoot: status.projectWorkspaceRoot,
      locatedInProjectWorkspace: null,
      markerStore: "unknown",
      ownsCanonicalSnapshot: false,
      ownsCanonicalMetadata: false,
      deletionDeletesProjectState: false,
    });
    expect(status.roots.projections).toBe(
      "/tmp/clash-home/projects/project%2Fone/projections",
    );
    expect(status.roots.timelines).toBe(
      "/tmp/clash-home/projects/project%2Fone/timelines",
    );
    expect(status.roots.assetLinks).toBe(
      "/tmp/clash-home/projects/project%2Fone/assets/links",
    );
    expect(status.roots.runtime).toBe(
      "/tmp/clash-home/projects/project%2Fone/runtime",
    );
    expect(status.runtimeRoot).toBe(status.roots.runtime);
    expect(status.localSqlitePath).toBe(
      "/tmp/clash-home/local-api/local.sqlite",
    );
    expect(status.storage.canonicalReplica.metadata.localConfig).toEqual({
      role: "user-editable-machine-config",
      format: "yaml",
      path: "/tmp/clash-home/config.yaml",
      sections: ["server", "harnesses", "audio", "sync"],
      syncDefault: "local-only",
      agentWritable: false,
      mutationSurface: "host-api-cli-or-editor",
      sqliteConfigRows: "migration-only",
    });
    expect(status.storage.localSecrets.files.hostCredentials.path).toBe(
      "/tmp/clash-home/credentials.json",
    );
    expect(status.loro.snapshotPath).toBe(
      "/tmp/clash-home/local-api/projects/project%2Fone/loro/snapshot.bin",
    );
    expect(status.storage.canonicalReplica.mediaAssets.path).toBe(
      "/tmp/clash-home/assets/blobs",
    );
    expect(
      status.storage.canonicalReplica.contentBlobs.textRevisions.path,
    ).toBe("/tmp/clash-home/local-api/text-revision-blobs");
    expect(status.storage.contentModel.textNodes.revisionRegistry).toBe(
      "text_revisions",
    );
    expect(status.storage.contentModel.textNodes.revisionBlobPath).toBe(
      status.storage.canonicalReplica.contentBlobs.textRevisions.path,
    );
    expect(status.storage.contentModel.textNodes.historyCommand).toBe(
      "clash text history",
    );
    expect(status.storage.contentModel.textNodes.contentCommand).toBe(
      "clash text content",
    );
    expect(status.storage.contentModel.textNodes.contentRegistry).toEqual({
      kind: "sqlite-non-media-revision-registry",
      table: "text_revisions",
      blobStore: "storage.canonicalReplica.contentBlobs.textRevisions",
      mediaAssetTable: false,
    });
    expect(status.storage.contentModel.textNodes.mediaAsset).toBe(false);
    expect(status.storage.contentModel.timelines.revisionAuthority).toBe(
      "loro-project-history",
    );
    expect(status.storage.contentModel.timelines.revisionIdentity).toBe(
      "state-hash",
    );
    expect(status.storage.contentModel.timelines.liveState).toBe(
      "loro-project-timeline-entity",
    );
    expect(status.storage.contentModel.timelines.projectionFilePattern).toBe(
      "<timeline-id>.timeline.yaml",
    );
    expect(status.storage.contentModel.timelines.publicCommands).toEqual([
      "clash timeline list",
      "clash timeline create --id <id> --name <name>",
      "clash timeline attach --timeline <id> --canvas <id> --node <action-node-id>",
      "clash timeline detach --timeline <id>",
      "clash timeline copy --timeline <id> --canvas <id> --new-timeline <id> --new-node <action-node-id>",
      "clash timeline pull --timeline <id>",
      "clash timeline apply --timeline <id>",
    ]);
    expect(
      status.storage.contentModel.timelines.copyOnWriteWhenReferenced,
    ).toBe(false);
    expect(
      status.storage.contentModel.timelines.downstreamRendersPinRevision,
    ).toBe(true);
    expect(status.storage.contentModel.timelines).not.toHaveProperty(
      "historyCommand",
    );
    expect(status.storage.contentModel.timelines).not.toHaveProperty(
      "restoreCommand",
    );
    expect(status.storage.contentModel.timelines).not.toHaveProperty(
      "contentRegistry",
    );
    expect(status.editablePaths).toContain(status.roots.drafts);
    expect(status.editablePaths).toContain(status.roots.timelines);
    expect(status.protectedPaths).toContain(status.loro.snapshotPath);
    expect(status.protectedPaths).toContain(
      status.storage.canonicalReplica.mediaAssets.path,
    );
    expect(status.protectedPaths).toContain(
      status.storage.canonicalReplica.contentBlobs.textRevisions.path,
    );
    expect(status.protectedPaths).toContain(
      status.storage.canonicalReplica.contentBlobs.assetMetadataBodies.path,
    );
    expect(status.protectedPaths).toContain(
      status.storage.canonicalReplica.metadata.localConfig.path,
    );
    expect(status.protectedPaths).toContain(
      status.storage.localSecrets.files.hostCredentials.path,
    );
    expect(status.protectedPaths).toContain(status.roots.runtime);
    expect(status.collaboration).toEqual({
      schemaVersion: 1,
      mode: "unknown",
      rawMode: "unknown",
      webOpenable: false,
      multiUser: false,
      roomAuthority: "local",
      cloudProjectRoom: "disabled",
      syncReadiness: {
        status: "disabled",
        ready: false,
        required: [
          "canvas",
          "asset-metadata",
          "revision-content",
          "project-metadata",
        ],
        missing: [
          "canvas",
          "asset-metadata",
          "revision-content",
          "project-metadata",
        ],
      },
      actions: {
        openInWeb: {
          allowed: false,
          reason: "sync-mode-unknown",
          requirements: ["sync-mode"],
        },
        enableSync: {
          allowed: true,
          reason: null,
          requirements: [],
        },
        shareProject: {
          allowed: false,
          reason: "sync-mode-unknown",
          requirements: ["sync-mode"],
        },
        runLocalAgent: {
          allowed: true,
          reason: null,
          requirements: ["owner-machine-online"],
        },
      },
      syncPolicy: expectedSyncPolicy("unknown-until-sync-mode-known"),
      localAgentRuntime: {
        requiredForLocalActions: true,
        availability: "owner-machine-online",
      },
      projectRoom: expectedProjectRoomPolicy("disabled"),
      tracePolicy: expectedTracePolicy,
    });
    expect(status.storage).toEqual({
      schemaVersion: 1,
      context: {
        role: "project-reference",
        projectId: "project/one",
        source: "explicit",
      },
      workspace: {
        role: "agent-draft-and-projection-workspace",
        root: status.projectWorkspaceRoot,
        ownsCanonicalSnapshot: false,
        ownsCanonicalMetadata: false,
        editablePaths: status.editablePaths,
        protectedPaths: [status.roots.runtime],
        viewFiles: {
          texts: {
            kind: "agent-editable-projection-files",
            path: "/tmp/clash-home/projects/project%2Fone/projections/text",
            defaultFilePattern: "<node-id>.md",
            applyCommand: "clash text apply",
            casRequired: true,
            ownsCanonicalState: false,
          },
          timelines: {
            kind: "agent-editable-view-files",
            path: "/tmp/clash-home/projects/project%2Fone/timelines",
            defaultFilePattern: "<timeline-id>.timeline.yaml",
            pullCommand: "clash timeline pull --timeline <id>",
            applyCommand: "clash timeline apply --timeline <id>",
            casRequired: true,
            ownsCanonicalState: false,
          },
          timelineProjections: {
            kind: "agent-editable-projection-files",
            path: "/tmp/clash-home/projects/project%2Fone/projections/timelines",
            defaultFilePattern: "<timeline-id>.timeline.yaml",
            applyCommand: "clash timeline apply --timeline <id>",
            casRequired: true,
            ownsCanonicalState: false,
          },
        },
      },
      canonicalReplica: {
        role: "single-machine-project-replica",
        scope: "machine",
        projectId: "project/one",
        metadata: {
          kind: "sqlite",
          path: status.localSqlitePath,
          agentWritable: false,
          localConfig: {
            role: "user-editable-machine-config",
            format: "yaml",
            path: "/tmp/clash-home/config.yaml",
            sections: ["server", "harnesses", "audio", "sync"],
            syncDefault: "local-only",
            agentWritable: false,
            mutationSurface: "host-api-cli-or-editor",
            sqliteConfigRows: "migration-only",
          },
        },
        projectState: {
          kind: "loro",
          replicaRoot: status.loro.replicaRoot,
          snapshotPath: status.loro.snapshotPath,
          updatesLogPath: status.loro.updatesLogPath,
          agentWritable: false,
        },
        mediaAssets: {
          kind: "content-addressed-files",
          path: "/tmp/clash-home/assets/blobs",
          storageKeyPrefix: "local-blobs/",
          immutable: true,
          deduplicatedBy: "sha256",
          agentWritable: false,
          referencedBy: "sqlite-asset-rows-and-project-asset-links",
        },
        contentBlobs: {
          textRevisions: {
            kind: "content-addressed-files",
            path: "/tmp/clash-home/local-api/text-revision-blobs",
            mediaType: "text/markdown",
            immutable: true,
            agentWritable: false,
          },
          assetMetadataBodies: {
            kind: "content-addressed-files",
            path: "/tmp/clash-home/local-api/metadata-blobs",
            mediaType: "application/json",
            immutable: true,
            agentWritable: false,
          },
        },
      },
      localSecrets: {
        role: "machine-local-secret-files",
        syncDefault: "local-only",
        agentWritable: false,
        files: {
          hostCredentials: {
            kind: "machine-credential-store",
            path: "/tmp/clash-home/credentials.json",
            agentWritable: false,
          },
        },
      },
      contentModel: {
        role: "agent-projections-over-host-owned-canonical-state",
        textNodes: {
          liveState: "loro-canvas-text-node-data",
          editableProjection: "storage.workspace.viewFiles.texts",
          projectionPath:
            "/tmp/clash-home/projects/project%2Fone/projections/text",
          applyCommand: "clash text apply",
          replaceCommand: "clash text replace",
          restoreCommand: "clash text restore",
          historyCommand: "clash text history",
          contentCommand: "clash text content",
          casRequired: true,
          copyOnWriteWhenReferenced: true,
          revisionRegistry: "text_revisions",
          revisionBlobPath: "/tmp/clash-home/local-api/text-revision-blobs",
          contentRegistry: {
            kind: "sqlite-non-media-revision-registry",
            table: "text_revisions",
            blobStore: "storage.canonicalReplica.contentBlobs.textRevisions",
            mediaAssetTable: false,
          },
          mediaAsset: false,
          agentWritableCanonicalState: false,
        },
        timelines: {
          liveState: "loro-project-timeline-entity",
          timelineIdentity: "timeline-id",
          editableProjection: "storage.workspace.viewFiles.timelines",
          projectionPath: "/tmp/clash-home/projects/project%2Fone/timelines",
          projectionFilePattern: "<timeline-id>.timeline.yaml",
          pullCommand: "clash timeline pull --timeline <id>",
          applyCommand: "clash timeline apply --timeline <id>",
          publicCommands: [
            "clash timeline list",
            "clash timeline create --id <id> --name <name>",
            "clash timeline attach --timeline <id> --canvas <id> --node <action-node-id>",
            "clash timeline detach --timeline <id>",
            "clash timeline copy --timeline <id> --canvas <id> --new-timeline <id> --new-node <action-node-id>",
            "clash timeline pull --timeline <id>",
            "clash timeline apply --timeline <id>",
          ],
          casRequired: true,
          copyOnWriteWhenReferenced: false,
          downstreamRendersPinRevision: true,
          revisionAuthority: "loro-project-history",
          revisionIdentity: "state-hash",
          agentWritableCanonicalState: false,
        },
      },
    });
    expect(status.storage.workspace.viewFiles).toEqual({
      texts: {
        kind: "agent-editable-projection-files",
        path: "/tmp/clash-home/projects/project%2Fone/projections/text",
        defaultFilePattern: "<node-id>.md",
        applyCommand: "clash text apply",
        casRequired: true,
        ownsCanonicalState: false,
      },
      timelines: {
        kind: "agent-editable-view-files",
        path: status.roots.timelines,
        defaultFilePattern: "<timeline-id>.timeline.yaml",
        pullCommand: "clash timeline pull --timeline <id>",
        applyCommand: "clash timeline apply --timeline <id>",
        casRequired: true,
        ownsCanonicalState: false,
      },
      timelineProjections: {
        kind: "agent-editable-projection-files",
        path: "/tmp/clash-home/projects/project%2Fone/projections/timelines",
        defaultFilePattern: "<timeline-id>.timeline.yaml",
        applyCommand: "clash timeline apply --timeline <id>",
        casRequired: true,
        ownsCanonicalState: false,
      },
    });
  });

  it("uses collision-resistant workspace path segments", () => {
    const first = buildProjectStatus(
      { projectId: "project/one", source: "explicit" },
      { clashRoot: "/tmp/clash-home" },
    );
    const second = buildProjectStatus(
      { projectId: "project_one", source: "explicit" },
      { clashRoot: "/tmp/clash-home" },
    );

    expect(first.projectWorkspaceRoot).not.toBe(second.projectWorkspaceRoot);
  });

  it("describes marker workspaces separately from canonical project roots", () => {
    const status = buildProjectStatus(
      {
        projectId: "project-one",
        source: "marker",
        markerPath: "/tmp/clash-vault/.clash/project.toml",
      },
      {
        clashRoot: "/tmp/clash-home",
        currentWorkingDirectory: "/tmp/clash-vault/drafts/scene-1",
        marker: {
          store: "managed",
          workspaceId: "workspace-1",
        },
      },
    );

    expect(status.currentWorkspace).toEqual({
      schemaVersion: 1,
      role: "project-reference-and-draft-workspace",
      currentWorkingDirectory: "/tmp/clash-vault/drafts/scene-1",
      markerPath: "/tmp/clash-vault/.clash/project.toml",
      markerRoot: "/tmp/clash-vault",
      markerStore: "managed",
      markerWorkspaceId: "workspace-1",
      projectWorkspaceRoot: "/tmp/clash-home/projects/project-one",
      locatedInProjectWorkspace: false,
      ownsCanonicalSnapshot: false,
      ownsCanonicalMetadata: false,
      deletionDeletesProjectState: false,
    });
    expect(status.storage.workspace.root).toBe("/tmp/clash-vault");
    expect(status.roots.timelines).toBe("/tmp/clash-vault/timelines");
    expect(status.roots.projections).toBe("/tmp/clash-vault/projections");
    expect(status.storage.workspace.protectedPaths).toEqual([]);
  });

  it("treats the project marker as a reference, never collaboration authority", () => {
    const canonicalLocal = buildProjectStatus(
      { projectId: "project-local", source: "marker" },
      {
        clashRoot: "/tmp/clash-home",
        marker: { sync: { mode: "shared" } },
        replicationState: { mode: "local-only" },
      } as Parameters<typeof buildProjectStatus>[1] & {
        marker: { sync: Record<string, unknown> };
        replicationState: Record<string, unknown>;
      },
    );
    const markerOnly = buildProjectStatus(
      { projectId: "project-marker-only", source: "marker" },
      {
        clashRoot: "/tmp/clash-home",
        marker: { sync: { mode: "shared" } },
      } as Parameters<typeof buildProjectStatus>[1] & {
        marker: { sync: Record<string, unknown> };
      },
    );

    expect(canonicalLocal.collaboration).toMatchObject({
      mode: "local-only",
      rawMode: "local-only",
      webOpenable: false,
      cloudProjectRoom: "disabled",
    });
    expect(markerOnly.collaboration).toMatchObject({
      mode: "unknown",
      rawMode: "unknown",
      webOpenable: false,
      cloudProjectRoom: "disabled",
    });
  });

  it("normalizes project collaboration modes into explicit local/cloud gates", () => {
    const local = buildProjectStatus(
      { projectId: "project-local", source: "explicit" },
      { clashRoot: "/tmp/clash-home", replicationState: { mode: "local" } },
    );
    const cloudSync = buildProjectStatus(
      { projectId: "project-synced", source: "explicit" },
      {
        clashRoot: "/tmp/clash-home",
        replicationState: { mode: "cloud-sync" },
      },
    );
    const shared = buildProjectStatus(
      { projectId: "project-shared", source: "explicit" },
      { clashRoot: "/tmp/clash-home", replicationState: { mode: "shared" } },
    );

    expect(local.collaboration).toMatchObject({
      mode: "local-only",
      rawMode: "local",
      webOpenable: false,
      multiUser: false,
      roomAuthority: "local",
      cloudProjectRoom: "disabled",
      syncPolicy: {
        cloudAdmission: "disabled-until-enable-sync",
      },
      syncReadiness: {
        status: "disabled",
        ready: false,
        missing: [
          "canvas",
          "asset-metadata",
          "revision-content",
          "project-metadata",
        ],
      },
      actions: {
        openInWeb: {
          allowed: false,
          reason: "project-is-local-only",
          requirements: ["enable-sync"],
        },
        enableSync: {
          allowed: true,
          reason: null,
          requirements: [],
        },
        shareProject: {
          allowed: false,
          reason: "project-is-local-only",
          requirements: ["enable-sync"],
        },
        runLocalAgent: {
          allowed: true,
          reason: null,
          requirements: ["owner-machine-online"],
        },
      },
    });
    expect(cloudSync.collaboration).toMatchObject({
      mode: "synced",
      rawMode: "cloud-sync",
      webOpenable: false,
      multiUser: false,
      roomAuthority: "local",
      cloudProjectRoom: "disabled",
      syncPolicy: {
        cloudAdmission: "blocked-until-requirements-ready",
      },
      syncReadiness: {
        status: "pending",
        ready: false,
        missing: [
          "canvas",
          "asset-metadata",
          "revision-content",
          "project-metadata",
        ],
      },
      actions: {
        openInWeb: {
          allowed: false,
          reason: "cloud-sync-not-ready",
          requirements: [
            "canvas",
            "asset-metadata",
            "revision-content",
            "project-metadata",
          ],
        },
        enableSync: {
          allowed: false,
          reason: "already-cloud-connected",
          requirements: [],
        },
        shareProject: {
          allowed: false,
          reason: "cloud-sync-not-ready",
          requirements: [
            "canvas",
            "asset-metadata",
            "revision-content",
            "project-metadata",
          ],
        },
        runLocalAgent: {
          allowed: true,
          reason: null,
          requirements: ["owner-machine-online"],
        },
      },
    });
    expect(shared.collaboration).toMatchObject({
      mode: "shared",
      rawMode: "shared",
      webOpenable: true,
      multiUser: true,
      roomAuthority: "cloud-sequencer",
      cloudProjectRoom: "sequencer",
      projectRoom: expectedProjectRoomPolicy("sequencer"),
      syncPolicy: {
        cloudAdmission: "cloud-sequencer",
      },
      syncReadiness: {
        status: "ready",
        ready: true,
        missing: [],
      },
      actions: {
        openInWeb: {
          allowed: true,
          reason: null,
          requirements: [],
        },
        enableSync: {
          allowed: false,
          reason: "already-cloud-connected",
          requirements: [],
        },
        shareProject: {
          allowed: true,
          reason: null,
          requirements: [],
        },
        runLocalAgent: {
          allowed: true,
          reason: null,
          requirements: ["owner-machine-online"],
        },
      },
    });
  });

  it("keeps one local replica and mutation surface across replication states", () => {
    const context = { projectId: "project-one", source: "marker" } as const;
    const local = buildProjectStatus(context, {
      clashRoot: "/tmp/clash-home",
      replicationState: { mode: "local-only" },
    });
    const synced = buildProjectStatus(context, {
      clashRoot: "/tmp/clash-home",
      replicationState: {
        mode: "cloud-sync",
        capabilities: {
          canvas: true,
          assetMetadata: true,
          revisionContent: true,
          projectMetadata: true,
        },
      },
    });

    expect(local.mode).toBe("local");
    expect(synced.mode).toBe("local");
    expect(local.syncMode).toBe("local-only");
    expect(synced.syncMode).toBe("cloud-sync");
    expect(synced.projectWorkspaceRoot).toBe(local.projectWorkspaceRoot);
    expect(synced.loro).toEqual(local.loro);
    expect(synced.roots).toEqual(local.roots);
    expect(synced.storage).toEqual(local.storage);
  });

  it("derives recovery policy from project collaboration status", () => {
    const local = buildProjectStatus(
      { projectId: "project-local", source: "explicit" },
      { clashRoot: "/tmp/clash-home", replicationState: { mode: "local" } },
    );
    const cloudSync = buildProjectStatus(
      { projectId: "project-synced", source: "explicit" },
      {
        clashRoot: "/tmp/clash-home",
        replicationState: {
          mode: "cloud-sync",
          capabilities: {
            canvas: true,
            assetMetadata: true,
            revisionContent: true,
            projectMetadata: true,
          },
        },
      },
    );
    const shared = buildProjectStatus(
      { projectId: "project-shared", source: "explicit" },
      { clashRoot: "/tmp/clash-home", replicationState: { mode: "shared" } },
    );
    const unknown = buildProjectStatus(
      { projectId: "project-unknown", source: "explicit" },
      { clashRoot: "/tmp/clash-home" },
    );

    expect(buildProjectRecoveryPolicy(local)).toMatchObject({
      scope: "local-canonical-replica",
      collaborationMode: "local-only",
      rawSyncMode: "local",
      localRestoreAllowed: true,
      cloudStateIncluded: false,
      cloudStateMutated: false,
      requiresCloudConflictReview: false,
      reason: "local-only-manual-review-required",
    });
    expect(buildProjectRecoveryPolicy(cloudSync)).toMatchObject({
      collaborationMode: "synced",
      rawSyncMode: "cloud-sync",
      roomAuthority: "local-with-cloud-mirror",
      syncReadinessStatus: "ready",
      localRestoreAllowed: true,
      cloudStateIncluded: false,
      cloudStateMutated: false,
      requiresCloudConflictReview: true,
      reason: "cloud-sync-local-replica-review-required",
    });
    expect(buildProjectRecoveryPolicy(shared)).toMatchObject({
      collaborationMode: "shared",
      rawSyncMode: "shared",
      roomAuthority: "cloud-sequencer",
      cloudProjectRoom: "sequencer",
      syncReadinessStatus: "ready",
      localRestoreAllowed: false,
      cloudStateIncluded: false,
      cloudStateMutated: false,
      requiresCloudConflictReview: true,
      reason: "shared-cloud-sequencer-restore-blocked",
    });
    expect(buildProjectRecoveryPolicy(unknown)).toMatchObject({
      collaborationMode: "unknown",
      localRestoreAllowed: false,
      requiresCloudConflictReview: true,
      reason: "sync-mode-unknown-local-replica-review-required",
    });
    expect(
      buildProjectRecoveryPolicy(cloudSync, { localRestoreAllowed: false }),
    ).toMatchObject({
      collaborationMode: "synced",
      localRestoreAllowed: false,
      reason: "cloud-sync-local-replica-review-required",
    });
  });

  it("keeps cloud-sync pending until canvas, asset metadata, and revision content sync are all ready", () => {
    const pending = buildProjectStatus(
      { projectId: "project-synced", source: "explicit" },
      {
        clashRoot: "/tmp/clash-home",
        replicationState: { mode: "cloud-sync" },
      },
    );
    const ready = buildProjectStatus(
      { projectId: "project-synced", source: "explicit" },
      {
        clashRoot: "/tmp/clash-home",
        replicationState: {
          mode: "cloud-sync",
          capabilities: {
            canvas: true,
            assetMetadata: true,
            revisionContent: true,
            projectMetadata: true,
          },
        },
      },
    );

    expect(pending.collaboration).toMatchObject({
      mode: "synced",
      webOpenable: false,
      roomAuthority: "local",
      syncReadiness: {
        status: "pending",
        ready: false,
        missing: [
          "canvas",
          "asset-metadata",
          "revision-content",
          "project-metadata",
        ],
      },
      actions: {
        openInWeb: {
          allowed: false,
          reason: "cloud-sync-not-ready",
          requirements: [
            "canvas",
            "asset-metadata",
            "revision-content",
            "project-metadata",
          ],
        },
        shareProject: {
          allowed: false,
          reason: "cloud-sync-not-ready",
          requirements: [
            "canvas",
            "asset-metadata",
            "revision-content",
            "project-metadata",
          ],
        },
      },
    });
    expect(ready.collaboration).toMatchObject({
      mode: "synced",
      webOpenable: true,
      roomAuthority: "local-with-cloud-mirror",
      syncReadiness: {
        status: "ready",
        ready: true,
        missing: [],
      },
      actions: {
        openInWeb: {
          allowed: true,
          reason: null,
          requirements: [],
        },
        shareProject: {
          allowed: true,
          reason: null,
          requirements: [],
        },
      },
    });
  });

  it("keeps cloud-sync pending until revision content sync is ready", () => {
    const missingRevisionContent = buildProjectStatus(
      { projectId: "project-synced", source: "explicit" },
      {
        clashRoot: "/tmp/clash-home",
        replicationState: {
          mode: "cloud-sync",
          capabilities: {
            canvas: true,
            assetMetadata: true,
          },
        },
      },
    );
    const ready = buildProjectStatus(
      { projectId: "project-synced", source: "explicit" },
      {
        clashRoot: "/tmp/clash-home",
        replicationState: {
          mode: "cloud-sync",
          capabilities: {
            canvas: true,
            assetMetadata: true,
            revisionContent: true,
            projectMetadata: true,
          },
        },
      },
    );

    expect(missingRevisionContent.collaboration).toMatchObject({
      mode: "synced",
      webOpenable: false,
      roomAuthority: "local",
      syncReadiness: {
        status: "pending",
        ready: false,
        missing: ["revision-content", "project-metadata"],
      },
      actions: {
        openInWeb: {
          allowed: false,
          reason: "cloud-sync-not-ready",
          requirements: ["revision-content", "project-metadata"],
        },
        shareProject: {
          allowed: false,
          reason: "cloud-sync-not-ready",
          requirements: ["revision-content", "project-metadata"],
        },
      },
    });
    expect(ready.collaboration).toMatchObject({
      mode: "synced",
      webOpenable: true,
      roomAuthority: "local-with-cloud-mirror",
      syncReadiness: {
        status: "ready",
        ready: true,
        missing: [],
      },
    });
  });

  it("publishes the cloud mirror policy for revision content separately from media assets", () => {
    const status = buildProjectStatus(
      { projectId: "project-synced", source: "explicit" },
      {
        clashRoot: "/tmp/clash-home",
        replicationState: {
          mode: "cloud-sync",
          capabilities: {
            canvas: true,
            assetMetadata: true,
            revisionContent: true,
            projectMetadata: true,
          },
        },
      },
    );

    expect(status.collaboration.syncPolicy).toMatchObject({
      schemaVersion: 1,
      cloudAdmission: "ready-local-with-cloud-mirror",
      mirror: {
        revisionContent: {
          requirement: "revision-content",
          source: "sqlite-index-and-content-addressed-revision-blobs",
          registries: ["text_revisions"],
          contentKinds: ["text-revision-content"],
          mediaAsset: false,
          agentWritable: false,
          conflictPolicy:
            "same-revision-id-same-hash-idempotent-conflict-otherwise",
        },
      },
      excluded: {
        rawAgentTraces: {
          syncDefault: "local-only",
          optInRequiredForSync: true,
        },
        localRuntimeSecrets: {
          syncDefault: "local-only",
          optInRequiredForSync: true,
        },
      },
    });
  });

  it("publishes the room chat and raw agent trace sync boundary", () => {
    const status = buildProjectStatus(
      { projectId: "project-shared", source: "explicit" },
      { clashRoot: "/tmp/clash-home", replicationState: { mode: "shared" } },
    );

    expect(status.collaboration.projectRoom).toEqual(
      expectedProjectRoomPolicy("sequencer"),
    );
    expect(status.collaboration.tracePolicy).toEqual(expectedTracePolicy);
  });
});
