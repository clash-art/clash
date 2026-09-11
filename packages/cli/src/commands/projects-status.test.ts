import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProjectStatus,
  initProject,
  resolveProjectStatus,
} from "./projects";
import type { ResolvedProjectContext } from "../lib/project-context";

function verifiedReplication(projectId: string, mode = "cloud-sync") {
  return { mode, localReplicaId: "host-1", admission: {
    schemaVersion: 1, projectId, localReplicaId: "host-1", userId: "owner", tenantId: "tenant",
    syncBaseUrl: "https://cloud.example.com", status: "ready",
    capabilities: { canvas: true, projectMetadata: true, resources: true },
    admittedAt: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z", lastError: null,
  } };
}

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
};

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
  };
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
};

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

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clash-project-status-"));
}

async function writeProductReplicationConfig(
  homeDir: string,
  config: Record<string, unknown>,
): Promise<void> {
  const clashHome = join(homeDir, ".clash");
  await mkdir(clashHome, { recursive: true });
  const capabilities = config.capabilities as
    Record<string, unknown> | undefined;
  await writeFile(
    join(clashHome, "config.yaml"),
    [
      "version: 1",
      "sync:",
      `  mode: ${String(config.mode ?? "local-only")}`,
      "  remote_loro:",
      `    url: ${JSON.stringify(config.remoteLoroUrl ?? null)}`,
      "  capabilities:",
      `    canvas: ${capabilities?.canvas === true}`,
      `    asset_metadata: ${capabilities?.asset_metadata === true}`,
      `    revision_content: ${capabilities?.revision_content === true}`,
      `    project_metadata: ${capabilities?.project_metadata === true}`,
      "",
    ].join("\n"),
  );
}

test("project status exposes agent-readable project roots and protected local files", () => {
  const homeDir = "/tmp/clash-home";
  const projectId = "project/with spaces";
  const context: ResolvedProjectContext = {
    projectId,
    source: "marker",
    markerPath: "/tmp/workspace/.clash/project.toml",
  };

  const status = buildProjectStatus(context, {
    homeDir,
    marker: {
      schemaVersion: 1,
      projectId,
      store: "managed",
    },
    replicationState: { mode: "local" },
  });

  const projectStore = join(
    homeDir,
    ".clash",
    "projects",
    "project%2Fwith%20spaces",
  );
  const workspaceRoot = "/tmp/workspace";
  const localApiDataDir = join(homeDir, ".clash", "local-api");
  const assetBlobRoot = join(homeDir, ".clash", "assets", "blobs");
  const textRevisionBlobRoot = join(localApiDataDir, "text-revision-blobs");
  const metadataBodyBlobRoot = join(localApiDataDir, "metadata-blobs");
  const loroRoot = join(
    localApiDataDir,
    "projects",
    encodeURIComponent(projectId),
    "loro",
  );

  assert.equal(status.projectId, projectId);
  assert.equal(status.source, "marker");
  assert.equal(status.mode, "local");
  assert.equal(status.syncMode, "local");
  assert.partialDeepStrictEqual(status.collaboration, {
    schemaVersion: 1,
    mode: "local-only",
    rawMode: "local",
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
    syncPolicy: expectedSyncPolicy("disabled-until-enable-sync"),
    localAgentRuntime: {
      requiredForLocalActions: true,
      availability: "owner-machine-online",
    },
    projectRoom: expectedProjectRoomPolicy("disabled"),
    tracePolicy: expectedTracePolicy,
  });
  assert.equal(status.clashHome, join(homeDir, ".clash"));
  assert.equal(status.projectStore, projectStore);
  assert.equal(status.projectWorkspaceRoot, projectStore);
  assert.equal(status.localApiDataDir, localApiDataDir);
  assert.equal(status.localSqlitePath, join(localApiDataDir, "local.sqlite"));
  assert.equal(status.loro.replicaRoot, loroRoot);
  assert.equal(status.loro.snapshotPath, join(loroRoot, "snapshot.bin"));
  assert.equal(status.loro.updatesLogPath, join(loroRoot, "updates.log"));
  assert.equal(status.roots.drafts, join(workspaceRoot, "drafts"));
  assert.equal(status.roots.projections, join(workspaceRoot, "projections"));
  assert.equal(status.roots.timelines, join(workspaceRoot, "timelines"));
  assert.equal(status.roots.sessions, join(workspaceRoot, "sessions"));
  assert.equal(status.roots.assetLinks, join(workspaceRoot, "assets", "links"));
  assert.equal(status.roots.runtime, join(projectStore, "runtime"));
  assert.equal(status.draftsRoot, status.roots.drafts);
  assert.equal(status.projectionsRoot, status.roots.projections);
  assert.equal(status.assetLinksRoot, status.roots.assetLinks);
  assert.equal(status.runtimeRoot, status.roots.runtime);

  assert.deepEqual(status.editablePaths, [
    join(workspaceRoot, "drafts"),
    join(workspaceRoot, "projections"),
    join(workspaceRoot, "timelines"),
    join(workspaceRoot, "sessions"),
    join(workspaceRoot, "assets", "links"),
  ]);
  assert.deepEqual(status.protectedPaths, [
    localApiDataDir,
    join(localApiDataDir, "local.sqlite"),
    join(homeDir, ".clash", "config.yaml"),
    join(homeDir, ".clash", "credentials.json"),
    loroRoot,
    join(loroRoot, "snapshot.bin"),
    join(loroRoot, "updates.log"),
    assetBlobRoot,
    textRevisionBlobRoot,
    metadataBodyBlobRoot,
    status.roots.runtime,
  ]);
  assert.deepEqual(status.storage, {
    schemaVersion: 1,
    context: {
      role: "project-reference",
      projectId,
      source: "marker",
      markerPath: "/tmp/workspace/.clash/project.toml",
    },
    workspace: {
      role: "agent-draft-and-projection-workspace",
      root: workspaceRoot,
      ownsCanonicalSnapshot: false,
      ownsCanonicalMetadata: false,
      editablePaths: status.editablePaths,
      protectedPaths: [],
      viewFiles: {
        texts: {
          kind: "agent-editable-projection-files",
          path: join(workspaceRoot, "projections", "text"),
          defaultFilePattern: "<node-id>.md",
          applyCommand: "clash text apply",
          casRequired: true,
          ownsCanonicalState: false,
        },
        timelines: {
          kind: "agent-editable-view-files",
          path: join(workspaceRoot, "timelines"),
          defaultFilePattern: "<timeline-id>.timeline.yaml",
          pullCommand: "clash timeline pull --timeline <id>",
          applyCommand: "clash timeline apply --timeline <id>",
          casRequired: true,
          ownsCanonicalState: false,
        },
        timelineProjections: {
          kind: "agent-editable-projection-files",
          path: join(workspaceRoot, "projections", "timelines"),
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
      projectId,
      metadata: {
        kind: "sqlite",
        path: join(localApiDataDir, "local.sqlite"),
        agentWritable: false,
        localConfig: {
          role: "user-editable-machine-config",
          format: "yaml",
          path: join(homeDir, ".clash", "config.yaml"),
          sections: ["server", "harnesses", "audio", "sync"],
          syncDefault: "local-only",
          agentWritable: false,
          mutationSurface: "host-api-cli-or-editor",
          sqliteConfigRows: "migration-only",
        },
      },
      projectState: {
        kind: "loro",
        replicaRoot: loroRoot,
        snapshotPath: join(loroRoot, "snapshot.bin"),
        updatesLogPath: join(loroRoot, "updates.log"),
        agentWritable: false,
      },
      mediaAssets: {
        kind: "content-addressed-files",
        path: assetBlobRoot,
        storageKeyPrefix: "local-blobs/",
        immutable: true,
        deduplicatedBy: "sha256",
        agentWritable: false,
        referencedBy: "sqlite-asset-rows-and-project-asset-links",
      },
      contentBlobs: {
        textRevisions: {
          kind: "content-addressed-files",
          path: textRevisionBlobRoot,
          mediaType: "text/markdown",
          immutable: true,
          agentWritable: false,
        },
        assetMetadataBodies: {
          kind: "content-addressed-files",
          path: metadataBodyBlobRoot,
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
          path: join(homeDir, ".clash", "credentials.json"),
          agentWritable: false,
        },
      },
    },
    contentModel: {
      role: "agent-projections-over-host-owned-canonical-state",
      textNodes: {
        liveState: "loro-canvas-text-node-data",
        editableProjection: "storage.workspace.viewFiles.texts",
        projectionPath: join(workspaceRoot, "projections", "text"),
        applyCommand: "clash text apply",
        replaceCommand: "clash text replace",
        restoreCommand: "clash text restore",
        historyCommand: "clash text history",
        contentCommand: "clash text content",
        casRequired: true,
        copyOnWriteWhenReferenced: true,
        revisionRegistry: "text_revisions",
        revisionBlobPath: join(localApiDataDir, "text-revision-blobs"),
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
        projectionPath: join(workspaceRoot, "timelines"),
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
});

test("project status uses collision-resistant project workspace paths", () => {
  const first = buildProjectStatus(
    { projectId: "project/one", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const second = buildProjectStatus(
    { projectId: "project_one", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );

  assert.notEqual(first.projectWorkspaceRoot, second.projectWorkspaceRoot);
  assert.match(first.projectWorkspaceRoot, /project%2Fone|project%252Fone/);
});

test("project pointer marker uses the product-internal local-only default", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();

  const initialized = await initProject({
    cwd,
    projectId: "local_status_project",
  });
  const status = await resolveProjectStatus({ cwd, env: {}, homeDir });

  assert.equal(status.projectId, "local_status_project");
  assert.equal(status.source, "marker");
  assert.equal(status.markerPath, initialized.markerPath);
  assert.equal(status.mode, "local");
  assert.equal(status.syncMode, "local-only");
  assert.equal(status.collaboration.mode, "local-only");
  assert.equal(status.collaboration.webOpenable, false);
  assert.equal(
    status.projectStore,
    join(homeDir, ".clash", "projects", "local_status_project"),
  );
});

test("project marker rejects removed sync fields", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await mkdir(join(cwd, ".clash"), { recursive: true });
  await writeFile(
    join(cwd, ".clash", "project.toml"),
    [
      "schema_version = 1",
      'project_id = "ready_cloud_project"',
      'store = "managed"',
      "",
      "[sync]",
      'mode = "cloud-sync"',
      "",
      "[sync.capabilities]",
      "canvas = true",
      "asset_metadata = true",
      "revision_content = true",
      "",
    ].join("\n"),
    "utf8",
  );

  await assert.rejects(
    resolveProjectStatus({ cwd, env: {}, homeDir }),
    /unsupported TOML section.*\[sync\]/i,
  );
});

test("project status does not infer Project readiness from global product capability flags", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "sqlite_cloud_project" });
  await writeProductReplicationConfig(homeDir, {
    version: 1,
    mode: "cloud-sync",
    remoteLoroUrl: "https://sync.example",
    remoteLoroToken: null,
    capabilities: {
      canvas: true,
      asset_metadata: true,
      revision_content: true,
      project_metadata: true,
    },
    updatedAt: new Date(0).toISOString(),
  });

  const status = await resolveProjectStatus({ cwd, env: {}, homeDir });

  assert.equal(status.collaboration.mode, "synced");
  assert.equal(status.collaboration.webOpenable, false);
  assert.equal(status.collaboration.actions.shareProject.allowed, false);
});

test("project status uses canonical sync readiness supplied by the product", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "missing_revision_content_project" });

  const status = await resolveProjectStatus({
    cwd,
    env: {},
    homeDir,
    replicationState: {
      mode: "cloud-sync",
      capabilities: {
        canvas: true,
        asset_metadata: true,
      },
    },
  });

  assert.equal(status.projectId, "missing_revision_content_project");
  assert.equal(status.collaboration.webOpenable, false);
  assert.equal(status.collaboration.roomAuthority, "local");
  assert.deepEqual(status.collaboration.syncReadiness, {
    status: "pending",
    ready: false,
    required: [
      "canvas",
      "asset-metadata",
      "revision-content",
      "project-metadata",
    ],
    missing: ["canvas", "asset-metadata", "revision-content", "project-metadata"],
  });
  assert.deepEqual(status.collaboration.actions.openInWeb, {
    allowed: false,
    reason: "cloud-sync-not-ready",
    requirements: ["canvas", "asset-metadata", "revision-content", "project-metadata"],
  });
  assert.deepEqual(status.collaboration.actions.shareProject, {
    allowed: false,
    reason: "cloud-sync-not-ready",
    requirements: ["canvas", "asset-metadata", "revision-content", "project-metadata"],
  });
  assert.partialDeepStrictEqual(
    status.collaboration.syncPolicy,
    expectedSyncPolicy("blocked-until-requirements-ready"),
  );
});

test("project status identifies the current marker workspace separately from the canonical store", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  const childCwd = join(cwd, "drafts", "nested");
  await mkdir(childCwd, { recursive: true });
  const initialized = await initProject({
    cwd,
    projectId: "workspace_status_project",
  });

  const status = await resolveProjectStatus({
    cwd: childCwd,
    env: {},
    homeDir,
  });

  assert.deepEqual(status.currentWorkspace, {
    schemaVersion: 1,
    role: "project-reference-and-draft-workspace",
    currentWorkingDirectory: childCwd,
    markerPath: initialized.markerPath,
    markerRoot: cwd,
    markerStore: "managed",
    markerWorkspaceId: initialized.workspaceId,
    projectWorkspaceRoot: join(
      homeDir,
      ".clash",
      "projects",
      "workspace_status_project",
    ),
    locatedInProjectWorkspace: false,
    ownsCanonicalSnapshot: false,
    ownsCanonicalMetadata: false,
    deletionDeletesProjectState: false,
  });
  assert.equal(status.projectStore, status.projectWorkspaceRoot);
  assert.equal(status.storage.workspace.root, cwd);
  assert.equal(status.roots.timelines, join(cwd, "timelines"));
  assert.equal(status.roots.projections, join(cwd, "projections"));
  assert.equal(
    status.storage.canonicalReplica.metadata.path,
    join(homeDir, ".clash", "local-api", "local.sqlite"),
  );
});

test("project status exposes explicit collaboration gates for synced and shared modes", () => {
  const synced = buildProjectStatus(
    { projectId: "synced_project", source: "marker" },
    {
      homeDir: "/tmp/clash-home",
      replicationState: { mode: "cloud-sync" },
    },
  );
  const shared = buildProjectStatus(
    { projectId: "shared_project", source: "marker" },
    {
      homeDir: "/tmp/clash-home",
      replicationState: verifiedReplication("shared_project", "shared"),
    },
  );

  assert.partialDeepStrictEqual(synced.collaboration, {
    schemaVersion: 1,
    mode: "synced",
    rawMode: "cloud-sync",
    webOpenable: false,
    multiUser: false,
    roomAuthority: "local",
    cloudProjectRoom: "disabled",
    syncReadiness: {
      status: "pending",
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
    syncPolicy: expectedSyncPolicy("blocked-until-requirements-ready"),
    localAgentRuntime: {
      requiredForLocalActions: true,
      availability: "owner-machine-online",
    },
    projectRoom: expectedProjectRoomPolicy("disabled"),
    tracePolicy: expectedTracePolicy,
  });
  assert.partialDeepStrictEqual(shared.collaboration, {
    schemaVersion: 1,
    mode: "shared",
    rawMode: "shared",
    webOpenable: true,
    multiUser: true,
    roomAuthority: "cloud-sequencer",
    cloudProjectRoom: "sequencer",
    syncReadiness: {
      status: "ready",
      ready: true,
      required: [
        "canvas",
        "asset-metadata",
        "revision-content",
        "project-metadata",
      ],
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
    syncPolicy: expectedSyncPolicy("cloud-sequencer"),
    localAgentRuntime: {
      requiredForLocalActions: true,
      availability: "owner-machine-online",
    },
    projectRoom: expectedProjectRoomPolicy("sequencer"),
    tracePolicy: expectedTracePolicy,
  });
});

test("explicit project selection does not inherit collaboration from an unrelated marker", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  const initialized = await initProject({ cwd, projectId: "marker_project" });

  const status = await resolveProjectStatus({
    cwd,
    project: "explicit_project",
    env: {},
    homeDir,
  });

  assert.equal(status.projectId, "explicit_project");
  assert.equal(status.source, "explicit");
  assert.equal(status.markerPath, initialized.markerPath);
  assert.equal(status.mode, "local");
  assert.equal(status.syncMode, "local-only");
  assert.equal(
    status.projectStore,
    join(homeDir, ".clash", "projects", "explicit_project"),
  );
});

test("environment project selection uses product-internal collaboration state without a marker", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();

  const status = await resolveProjectStatus({
    cwd,
    env: { CLASH_PROJECT_ID: "env_project" },
    homeDir,
  });

  assert.equal(status.projectId, "env_project");
  assert.equal(status.source, "env");
  assert.equal(status.markerPath, undefined);
  assert.equal(status.mode, "local");
  assert.equal(status.syncMode, "local-only");
  assert.equal(
    status.projectStore,
    join(homeDir, ".clash", "projects", "env_project"),
  );
});

test("project status honors CLASH_HOME for managed roots", async () => {
  const clashRoot = await tempDir();
  const cwd = await tempDir();

  const status = await resolveProjectStatus({
    cwd,
    env: { CLASH_PROJECT_ID: "env_project", CLASH_HOME: clashRoot },
  });

  assert.equal(status.projectStore, join(clashRoot, "projects", "env_project"));
  assert.equal(status.clashHome, clashRoot);
  assert.equal(status.localApiDataDir, join(clashRoot, "local-api"));
  assert.equal(
    status.localSqlitePath,
    join(clashRoot, "local-api", "local.sqlite"),
  );
});
