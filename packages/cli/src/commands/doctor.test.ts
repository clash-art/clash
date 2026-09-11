import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareSecondaryCanvasRecovery,
  doctorCommand,
  inspectStorageContract,
  listSecondaryCanvasRecoveries,
  restoreSecondaryCanvasRecovery,
  runStorageDoctor,
} from "./doctor";
import { buildProjectStatus, initProject } from "./projects";

const require = createRequire(import.meta.url);

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clash-storage-doctor-"));
}

function openSqlite(path: string) {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        get(...params: unknown[]): Record<string, unknown> | undefined;
      };
      close(): void;
    };
  };
  return new DatabaseSync(path);
}

function createAssetReferenceIndexSchema(sqlite: ReturnType<typeof openSqlite>): void {
  sqlite.exec(`
    CREATE TABLE asset_node_refs (
      asset_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      field_path TEXT NOT NULL,
      reference_role TEXT NOT NULL DEFAULT 'asset',
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, node_id, field_path, asset_id)
    );
    CREATE INDEX asset_node_refs_asset_idx ON asset_node_refs(asset_id, project_id);
    CREATE INDEX asset_node_refs_project_idx ON asset_node_refs(project_id, node_id);
  `);
}

function createRevisionIndexSchema(sqlite: ReturnType<typeof openSqlite>): void {
  sqlite.exec(`
    CREATE TABLE text_revisions (
      revision_id TEXT PRIMARY KEY NOT NULL,
      text_id TEXT NOT NULL,
      parent_revision_id TEXT,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      hash_algorithm TEXT NOT NULL,
      source_file_path TEXT NOT NULL,
      source_file_hash TEXT NOT NULL,
      actor_json TEXT
    );
    CREATE INDEX text_revisions_project_node_idx ON text_revisions(project_id, node_id, created_at DESC);
    CREATE INDEX text_revisions_text_idx ON text_revisions(text_id, created_at DESC);

  `);
}

function recreateProviderAuthTablesWithLegacyPrimaryKeys(sqlite: ReturnType<typeof openSqlite>): void {
  sqlite.exec(`
    DROP TABLE IF EXISTS provider_accounts;
    DROP TABLE IF EXISTS provider_oauth;

    CREATE TABLE provider_accounts (
      user_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      id TEXT,
      provider_id TEXT NOT NULL,
      upstream_id TEXT,
      region TEXT,
      label TEXT,
      enabled INTEGER NOT NULL,
      priority REAL,
      weight REAL,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (user_id, provider_id)
    );

    CREATE TABLE provider_oauth (
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      token_type TEXT,
      verification_uri TEXT,
      user_code TEXT,
      device_code TEXT,
      interval_seconds INTEGER,
      account_label TEXT,
      expires_at TEXT,
      error TEXT,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (user_id, provider_id)
    );
  `);
}

function textRevisionBlobPath(homeDir: string, content: string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return join(homeDir, ".clash", "local-api", "text-revision-blobs", hash.slice(0, 2), `${hash}.md`);
}

async function writeWritableFile(filePath: string, content: string): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, content, { encoding: "utf8", mode: 0o644 });
  await chmod(filePath, 0o644);
}

function checkById(report: Awaited<ReturnType<typeof runStorageDoctor>>, id: string) {
  const check = report.checks.find((item) => item.id === id);
  assert.ok(check, `missing doctor check: ${id}`);
  return check;
}

test("storage doctor reports marker project with non-fatal missing-store warnings", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });

  assert.equal(report.ok, true);
  assert.equal(report.projectId, "doctor_project");
  assert.equal(checkById(report, "project-context").level, "ok");
  assert.equal(checkById(report, "project-marker").level, "ok");
  assert.equal(checkById(report, "editable-protected-separation").level, "ok");
  assert.equal(checkById(report, "cwd-protected").level, "ok");
  assert.equal(checkById(report, "project-workspace").level, "ok");
  assert.equal(checkById(report, "editable-drafts-root").level, "warning");
  assert.equal(checkById(report, "editable-projections-root").level, "warning");
  assert.equal(checkById(report, "editable-timelines-root").level, "warning");
  assert.equal(checkById(report, "editable-sessions-root").level, "warning");
  assert.equal(checkById(report, "editable-asset-links-root").level, "warning");
  assert.equal(checkById(report, "protected-runtime-root").level, "warning");
  assert.equal(checkById(report, "loro-replica").level, "warning");
  assert.equal(checkById(report, "local-sqlite").level, "warning");
});

test("storage doctor reports v1 project workspace roots when they exist", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const projectRoot = cwd;
  await Promise.all([
    mkdir(join(projectRoot, "drafts"), { recursive: true }),
    mkdir(join(projectRoot, "projections", "text"), { recursive: true }),
    mkdir(join(projectRoot, "projections", "timelines"), { recursive: true }),
    mkdir(join(projectRoot, "timelines"), { recursive: true }),
    mkdir(join(projectRoot, "sessions"), { recursive: true }),
    mkdir(join(projectRoot, "assets", "links"), { recursive: true }),
    mkdir(join(homeDir, ".clash", "projects", "doctor_project", "runtime"), { recursive: true }),
  ]);

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });

  assert.equal(report.ok, true);
  assert.equal(checkById(report, "project-workspace").level, "ok");
  assert.equal(checkById(report, "editable-drafts-root").level, "ok");
  assert.equal(checkById(report, "editable-projections-root").level, "ok");
  assert.equal(checkById(report, "editable-timelines-root").level, "ok");
  assert.equal(checkById(report, "editable-sessions-root").level, "ok");
  assert.equal(checkById(report, "editable-asset-links-root").level, "ok");
  assert.equal(checkById(report, "protected-runtime-root").level, "ok");
});

test("storage doctor fails on broken project asset links", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const projectRoot = cwd;
  const assetLinksRoot = join(projectRoot, "assets", "links");
  await Promise.all([
    mkdir(join(projectRoot, "drafts"), { recursive: true }),
    mkdir(join(projectRoot, "projections"), { recursive: true }),
    mkdir(join(projectRoot, "timelines"), { recursive: true }),
    mkdir(join(projectRoot, "sessions"), { recursive: true }),
    mkdir(assetLinksRoot, { recursive: true }),
    mkdir(join(homeDir, ".clash", "projects", "doctor_project", "runtime"), { recursive: true }),
  ]);
  await symlink(
    join(homeDir, ".clash", "assets", "missing.png"),
    join(assetLinksRoot, "missing.png"),
  );

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });

  assert.equal(report.ok, false);
  const linksCheck = checkById(report, "asset-link-integrity");
  assert.equal(linksCheck.level, "error");
  assert.match(linksCheck.message, /broken symlink/);
  assert.match(linksCheck.message, /missing\.png/);
});

test("storage doctor fails when cwd is inside protected Clash storage", async () => {
  const homeDir = await tempDir();
  const protectedCwd = join(homeDir, ".clash", "local-api");
  await mkdir(protectedCwd, { recursive: true });

  const report = await runStorageDoctor({
    cwd: protectedCwd,
    project: "doctor_project",
    env: {},
    homeDir,
  });

  assert.equal(report.ok, false);
  const cwdCheck = checkById(report, "cwd-protected");
  assert.equal(cwdCheck.level, "error");
  assert.equal(cwdCheck.path, protectedCwd);
});

test("storage doctor fails when cwd owns a second canvas replica", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  await mkdir(join(cwd, "loro"), { recursive: true });
  await writeFile(join(cwd, "loro", "snapshot.bin"), "draft snapshot", "utf8");
  await writeFile(join(cwd, "loro", "updates.log"), "draft updates", "utf8");

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });

  assert.equal(report.ok, false);
  const replicaCheck = checkById(report, "secondary-canvas-replica");
  assert.equal(replicaCheck.level, "error");
  assert.match(replicaCheck.message, /second canvas replica/i);
  assert.match(replicaCheck.message, /snapshot\.bin/);
  assert.equal(replicaCheck.path, join(cwd, "loro", "snapshot.bin"));
});

test("storage doctor accepts canonical local-api Loro replica files", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  const projectId = "doctor_project";
  await initProject({ cwd, projectId });
  const canonicalReplicaRoot = join(
    homeDir,
    ".clash",
    "local-api",
    "projects",
    encodeURIComponent(projectId),
    "loro",
  );
  await mkdir(canonicalReplicaRoot, { recursive: true });
  await writeFile(join(canonicalReplicaRoot, "snapshot.bin"), "canonical snapshot", "utf8");
  await writeFile(join(canonicalReplicaRoot, "updates.log"), "canonical updates", "utf8");

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });

  assert.equal(report.ok, true);
  assert.equal(checkById(report, "secondary-canvas-replica").level, "ok");
  assert.equal(checkById(report, "loro-replica").level, "ok");
});

test("storage doctor repair quarantines cwd secondary canvas replica files", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const snapshotPath = join(cwd, "loro", "snapshot.bin");
  const updatesPath = join(cwd, "loro", "updates.log");
  await mkdir(join(cwd, "loro"), { recursive: true });
  await writeFile(snapshotPath, "draft snapshot", "utf8");
  await writeFile(updatesPath, "draft updates", "utf8");

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });

  assert.equal(repaired.ok, true);
  assert.equal(checkById(repaired, "secondary-canvas-replica").level, "ok");
  const quarantined = repaired.repairs?.filter((repair) => repair.id === "secondary-canvas-replica-quarantine") ?? [];
  assert.equal(quarantined.length, 2);
  assert.ok(quarantined.every((repair) => repair.path?.includes(join("runtime", "recovery", "secondary-canvas-replicas"))));
  await assert.rejects(readFile(snapshotPath, "utf8"), /ENOENT/);
  await assert.rejects(readFile(updatesPath, "utf8"), /ENOENT/);
  assert.equal(await readFile(quarantined.find((repair) => repair.path?.endsWith("snapshot.bin"))?.path ?? "", "utf8"), "draft snapshot");
  assert.equal(await readFile(quarantined.find((repair) => repair.path?.endsWith("updates.log"))?.path ?? "", "utf8"), "draft updates");

  const manifestPath = join(quarantined[0].path ? join(quarantined[0].path, "..", "..") : "", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    schemaVersion: number;
    projectId: string;
    canonicalReplica: { snapshotPath: string; updatesLogPath: string };
    files: Array<{ sourcePath: string; destinationPath: string; kind: string }>;
  };
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.projectId, "doctor_project");
  assert.match(manifest.canonicalReplica.snapshotPath, /local-api\/projects\/doctor_project\/loro\/snapshot\.bin$/);
  assert.deepEqual(
    manifest.files.map((file) => ({
      sourcePath: file.sourcePath,
      kind: file.kind,
      basename: file.destinationPath.endsWith("snapshot.bin") ? "snapshot.bin" : "updates.log",
    })).sort((a, b) => a.basename.localeCompare(b.basename)),
    [
      { sourcePath: snapshotPath, kind: "snapshot", basename: "snapshot.bin" },
      { sourcePath: updatesPath, kind: "updates-log", basename: "updates.log" },
    ].sort((a, b) => a.basename.localeCompare(b.basename)),
  );

  const verified = await runStorageDoctor({ cwd, env: {}, homeDir });
  assert.equal(verified.ok, true);
  assert.equal(checkById(verified, "secondary-canvas-replica").level, "ok");
  const recovery = checkById(verified, "secondary-canvas-recovery");
  assert.equal(recovery.level, "warning");
  assert.equal(recovery.path, manifestPath);
  assert.match(recovery.message, /1 quarantined canvas replica recovery set/);
});

test("secondary canvas recovery compare reports canonical and quarantined file hashes without importing", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir },
  );
  await mkdir(status.loro.replicaRoot, { recursive: true });
  await writeFile(status.loro.snapshotPath, "canonical snapshot", "utf8");
  await writeFile(status.loro.updatesLogPath, "canonical updates", "utf8");
  const snapshotPath = join(cwd, "loro", "snapshot.bin");
  const updatesPath = join(cwd, "loro", "updates.log");
  await mkdir(join(cwd, "loro"), { recursive: true });
  await writeFile(snapshotPath, "draft snapshot", "utf8");
  await writeFile(updatesPath, "draft updates", "utf8");

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });
  const quarantined = repaired.repairs?.filter((repair) => repair.id === "secondary-canvas-replica-quarantine") ?? [];
  const manifestPath = join(quarantined[0].path ? join(quarantined[0].path, "..", "..") : "", "manifest.json");

  const compared = await compareSecondaryCanvasRecovery({ manifestPath, cwd, env: {}, homeDir });

  assert.equal(compared.schemaVersion, 1);
  assert.equal(compared.status, "compared");
  assert.equal(compared.projectId, "doctor_project");
  assert.equal(compared.safeToImportAutomatically, false);
  assert.equal(compared.files.length, 2);
  const snapshot = compared.files.find((file) => file.kind === "snapshot");
  assert.ok(snapshot);
  assert.equal(snapshot.sourcePath, snapshotPath);
  assert.equal(snapshot.canonical.path, status.loro.snapshotPath);
  assert.equal(snapshot.quarantined.exists, true);
  assert.equal(snapshot.canonical.exists, true);
  assert.equal(snapshot.quarantined.size, "draft snapshot".length);
  assert.equal(snapshot.canonical.size, "canonical snapshot".length);
  assert.notEqual(snapshot.quarantined.sha256, snapshot.canonical.sha256);
  assert.equal(snapshot.sameBytes, false);
  assert.match(compared.readToken, /^secondary-canvas-recovery:/);
});

test("secondary canvas recovery reports cloud-sync as local replica recovery only", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const replicationState = { mode: "cloud-sync" };
  const snapshotPath = join(cwd, "loro", "snapshot.bin");
  await mkdir(join(cwd, "loro"), { recursive: true });
  await writeFile(snapshotPath, "draft snapshot", "utf8");

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, replicationState, repair: true });
  const quarantined = repaired.repairs?.filter((repair) => repair.id === "secondary-canvas-replica-quarantine") ?? [];
  const manifestPath = join(quarantined[0].path ? join(quarantined[0].path, "..", "..") : "", "manifest.json");
  const compared = await compareSecondaryCanvasRecovery({ manifestPath, cwd, env: {}, homeDir, replicationState });
  const inventory = await listSecondaryCanvasRecoveries({ cwd, env: {}, homeDir, replicationState });

  const expectedPolicy = {
    scope: "local-canonical-replica",
    collaborationMode: "synced",
    rawSyncMode: "cloud-sync",
    roomAuthority: "local",
    cloudProjectRoom: "disabled",
    syncReadinessStatus: "pending",
    localRestoreAllowed: true,
    cloudStateIncluded: false,
    cloudStateMutated: false,
    requiresCloudConflictReview: true,
    reason: "cloud-sync-local-replica-review-required",
  };
  assert.deepEqual(compared.recoveryPolicy, expectedPolicy);
  assert.deepEqual(inventory.recoveryPolicy, expectedPolicy);
  assert.equal(compared.safeToImportAutomatically, false);
  assert.equal(inventory.safeToImportAutomatically, false);
});

test("secondary canvas recovery restore copies quarantined bytes into canonical replica only with compare read token", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  const replicationState = { mode: "local-only" };
  await initProject({ cwd, projectId: "doctor_project" });
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir },
  );
  await mkdir(status.loro.replicaRoot, { recursive: true });
  await writeFile(status.loro.snapshotPath, "canonical snapshot", "utf8");
  await writeFile(status.loro.updatesLogPath, "canonical updates", "utf8");
  const snapshotPath = join(cwd, "loro", "snapshot.bin");
  const updatesPath = join(cwd, "loro", "updates.log");
  await mkdir(join(cwd, "loro"), { recursive: true });
  await writeFile(snapshotPath, "draft snapshot", "utf8");
  await writeFile(updatesPath, "draft updates", "utf8");

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, replicationState, repair: true });
  const quarantined = repaired.repairs?.filter((repair) => repair.id === "secondary-canvas-replica-quarantine") ?? [];
  const manifestPath = join(quarantined[0].path ? join(quarantined[0].path, "..", "..") : "", "manifest.json");
  const compared = await compareSecondaryCanvasRecovery({ manifestPath, cwd, env: {}, homeDir, replicationState });

  const restored = await restoreSecondaryCanvasRecovery({
    manifestPath,
    cwd,
    env: {},
    homeDir,
    replicationState,
    expectedReadToken: compared.readToken,
    confirm: true,
  });

  assert.equal(restored.schemaVersion, 1);
  assert.equal(restored.status, "restored");
  assert.equal(restored.projectId, "doctor_project");
  assert.equal(restored.expectedReadToken, compared.readToken);
  assert.equal(restored.safeToImportAutomatically, false);
  assert.equal(await readFile(status.loro.snapshotPath, "utf8"), "draft snapshot");
  assert.equal(await readFile(status.loro.updatesLogPath, "utf8"), "draft updates");
  const restoredSnapshot = restored.files.find((file) => file.kind === "snapshot");
  const restoredUpdates = restored.files.find((file) => file.kind === "updates-log");
  assert.ok(restoredSnapshot?.backupPath);
  assert.ok(restoredUpdates?.backupPath);
  assert.equal(await readFile(restoredSnapshot.backupPath, "utf8"), "canonical snapshot");
  assert.equal(await readFile(restoredUpdates.backupPath, "utf8"), "canonical updates");
  assert.notEqual(restored.beforeReadToken, restored.afterReadToken);
  const receiptPath = restored.receiptPath;
  assert.match(receiptPath, /restore-receipt\.json$/);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, "restored");
  assert.equal(receipt.projectId, "doctor_project");
  assert.equal(receipt.expectedReadToken, compared.readToken);
  assert.equal(receipt.beforeReadToken, restored.beforeReadToken);
  assert.equal(receipt.afterReadToken, restored.afterReadToken);
  assert.deepEqual(
    receipt.files.map((file: { kind: string; canonicalAfter: { sha256?: string } }) => [
      file.kind,
      typeof file.canonicalAfter?.sha256,
    ]).sort(),
    [
      ["snapshot", "string"],
      ["updates-log", "string"],
    ].sort(),
  );
});

test("secondary canvas recovery restore rejects shared projects owned by the cloud sequencer", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const replicationState = { mode: "shared" };
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir, replicationState },
  );
  await mkdir(status.loro.replicaRoot, { recursive: true });
  await writeFile(status.loro.snapshotPath, "canonical snapshot", "utf8");
  const snapshotPath = join(cwd, "loro", "snapshot.bin");
  await mkdir(join(cwd, "loro"), { recursive: true });
  await writeFile(snapshotPath, "draft snapshot", "utf8");

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, replicationState, repair: true });
  const quarantined = repaired.repairs?.filter((repair) => repair.id === "secondary-canvas-replica-quarantine") ?? [];
  const manifestPath = join(quarantined[0].path ? join(quarantined[0].path, "..", "..") : "", "manifest.json");
  const compared = await compareSecondaryCanvasRecovery({ manifestPath, cwd, env: {}, homeDir, replicationState });

  assert.deepEqual(compared.recoveryPolicy, {
    scope: "local-canonical-replica",
    collaborationMode: "shared",
    rawSyncMode: "shared",
    roomAuthority: "cloud-sequencer",
    cloudProjectRoom: "sequencer",
    syncReadinessStatus: "pending",
    localRestoreAllowed: false,
    cloudStateIncluded: false,
    cloudStateMutated: false,
    requiresCloudConflictReview: true,
    reason: "shared-cloud-sequencer-restore-blocked",
  });
  await assert.rejects(
    restoreSecondaryCanvasRecovery({
      manifestPath,
      cwd,
      env: {},
      homeDir,
      replicationState,
      expectedReadToken: compared.readToken,
      confirm: true,
    }),
    /cloud sequencer/,
  );
  assert.equal(await readFile(status.loro.snapshotPath, "utf8"), "canonical snapshot");
});

test("secondary canvas recovery restore rejects stale compare read tokens before overwriting canonical bytes", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir },
  );
  await mkdir(status.loro.replicaRoot, { recursive: true });
  await writeFile(status.loro.snapshotPath, "canonical snapshot", "utf8");
  const snapshotPath = join(cwd, "loro", "snapshot.bin");
  await mkdir(join(cwd, "loro"), { recursive: true });
  await writeFile(snapshotPath, "draft snapshot", "utf8");

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });
  const quarantined = repaired.repairs?.filter((repair) => repair.id === "secondary-canvas-replica-quarantine") ?? [];
  const manifestPath = join(quarantined[0].path ? join(quarantined[0].path, "..", "..") : "", "manifest.json");
  const compared = await compareSecondaryCanvasRecovery({ manifestPath, cwd, env: {}, homeDir });
  await writeFile(status.loro.snapshotPath, "newer canonical snapshot", "utf8");

  await assert.rejects(
    restoreSecondaryCanvasRecovery({
      manifestPath,
      cwd,
      env: {},
      homeDir,
      expectedReadToken: compared.readToken,
      confirm: true,
    }),
    /read token is stale/,
  );
  assert.equal(await readFile(status.loro.snapshotPath, "utf8"), "newer canonical snapshot");
});

test("secondary canvas recovery compare rejects manifests outside the current project recovery root", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const externalManifest = join(await tempDir(), "manifest.json");
  await writeFile(
    externalManifest,
    JSON.stringify({
      schemaVersion: 1,
      projectId: "doctor_project",
      createdAt: new Date().toISOString(),
      canonicalReplica: {
        replicaRoot: join(homeDir, ".clash", "local-api", "projects", "doctor_project", "loro"),
        snapshotPath: join(homeDir, ".clash", "local-api", "projects", "doctor_project", "loro", "snapshot.bin"),
        updatesLogPath: join(homeDir, ".clash", "local-api", "projects", "doctor_project", "loro", "updates.log"),
      },
      files: [],
    }),
    "utf8",
  );

  await assert.rejects(
    compareSecondaryCanvasRecovery({ manifestPath: externalManifest, cwd, env: {}, homeDir }),
    /outside current project recovery root/,
  );
});

test("secondary canvas recovery compare rejects manifest destination paths outside its recovery set", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir },
  );
  const recoverySetRoot = join(status.roots.runtime, "recovery", "secondary-canvas-replicas", "manual");
  const leakedFile = join(await tempDir(), "outside-snapshot.bin");
  await mkdir(recoverySetRoot, { recursive: true });
  await writeFile(leakedFile, "outside bytes", "utf8");
  const manifestPath = join(recoverySetRoot, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      projectId: "doctor_project",
      createdAt: new Date().toISOString(),
      canonicalReplica: {
        replicaRoot: status.loro.replicaRoot,
        snapshotPath: status.loro.snapshotPath,
        updatesLogPath: status.loro.updatesLogPath,
      },
      files: [
        {
          kind: "snapshot",
          sourcePath: join(cwd, "loro", "snapshot.bin"),
          destinationPath: leakedFile,
        },
      ],
    }),
    "utf8",
  );

  await assert.rejects(
    compareSecondaryCanvasRecovery({ manifestPath, cwd, env: {}, homeDir }),
    /outside recovery set root/,
  );
});

test("secondary canvas recovery compare rejects symlinked manifests", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir },
  );
  const recoverySetRoot = join(status.roots.runtime, "recovery", "secondary-canvas-replicas", "manual");
  const externalManifest = join(await tempDir(), "external-manifest.json");
  await mkdir(recoverySetRoot, { recursive: true });
  await writeFile(
    externalManifest,
    JSON.stringify({
      schemaVersion: 1,
      projectId: "doctor_project",
      createdAt: new Date().toISOString(),
      canonicalReplica: {
        replicaRoot: status.loro.replicaRoot,
        snapshotPath: status.loro.snapshotPath,
        updatesLogPath: status.loro.updatesLogPath,
      },
      files: [],
    }),
    "utf8",
  );
  const manifestPath = join(recoverySetRoot, "manifest.json");
  await symlink(externalManifest, manifestPath);

  await assert.rejects(
    compareSecondaryCanvasRecovery({ manifestPath, cwd, env: {}, homeDir }),
    /must be a regular file/,
  );
});

test("secondary canvas recovery compare rejects manifests reached through symlinked recovery set directories", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir },
  );
  const recoveryRoot = join(status.roots.runtime, "recovery", "secondary-canvas-replicas");
  const externalSetRoot = await tempDir();
  await mkdir(recoveryRoot, { recursive: true });
  await writeFile(
    join(externalSetRoot, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      projectId: "doctor_project",
      createdAt: new Date().toISOString(),
      canonicalReplica: {
        replicaRoot: status.loro.replicaRoot,
        snapshotPath: status.loro.snapshotPath,
        updatesLogPath: status.loro.updatesLogPath,
      },
      files: [],
    }),
    "utf8",
  );
  const linkedSetRoot = join(recoveryRoot, "linked-set");
  await symlink(externalSetRoot, linkedSetRoot);

  await assert.rejects(
    compareSecondaryCanvasRecovery({ manifestPath: join(linkedSetRoot, "manifest.json"), cwd, env: {}, homeDir }),
    /outside current project recovery root/,
  );
});

test("secondary canvas recovery compare rejects symlinked quarantined files", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir },
  );
  const recoverySetRoot = join(status.roots.runtime, "recovery", "secondary-canvas-replicas", "manual");
  const leakedFile = join(await tempDir(), "outside-snapshot.bin");
  const linkedDestination = join(recoverySetRoot, "snapshot.bin");
  await mkdir(recoverySetRoot, { recursive: true });
  await mkdir(status.loro.replicaRoot, { recursive: true });
  await writeFile(status.loro.snapshotPath, "canonical snapshot", "utf8");
  await writeFile(leakedFile, "outside bytes", "utf8");
  await symlink(leakedFile, linkedDestination);
  const manifestPath = join(recoverySetRoot, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      projectId: "doctor_project",
      createdAt: new Date().toISOString(),
      canonicalReplica: {
        replicaRoot: status.loro.replicaRoot,
        snapshotPath: status.loro.snapshotPath,
        updatesLogPath: status.loro.updatesLogPath,
      },
      files: [
        {
          kind: "snapshot",
          sourcePath: join(cwd, "loro", "snapshot.bin"),
          destinationPath: linkedDestination,
        },
      ],
    }),
    "utf8",
  );

  await assert.rejects(
    compareSecondaryCanvasRecovery({ manifestPath, cwd, env: {}, homeDir }),
    /must be a regular file/,
  );
});

test("secondary canvas recovery compare rejects quarantined files reached through symlinked directories", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir },
  );
  const recoverySetRoot = join(status.roots.runtime, "recovery", "secondary-canvas-replicas", "manual");
  const externalDir = await tempDir();
  const linkedDir = join(recoverySetRoot, "linked-dir");
  const linkedDestination = join(linkedDir, "snapshot.bin");
  await mkdir(recoverySetRoot, { recursive: true });
  await mkdir(status.loro.replicaRoot, { recursive: true });
  await writeFile(status.loro.snapshotPath, "canonical snapshot", "utf8");
  await writeFile(join(externalDir, "snapshot.bin"), "outside bytes", "utf8");
  await symlink(externalDir, linkedDir);
  const manifestPath = join(recoverySetRoot, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      projectId: "doctor_project",
      createdAt: new Date().toISOString(),
      canonicalReplica: {
        replicaRoot: status.loro.replicaRoot,
        snapshotPath: status.loro.snapshotPath,
        updatesLogPath: status.loro.updatesLogPath,
      },
      files: [
        {
          kind: "snapshot",
          sourcePath: join(cwd, "loro", "snapshot.bin"),
          destinationPath: linkedDestination,
        },
      ],
    }),
    "utf8",
  );

  await assert.rejects(
    compareSecondaryCanvasRecovery({ manifestPath, cwd, env: {}, homeDir }),
    /outside recovery set root/,
  );
});

test("secondary canvas recovery list reports quarantined manifests for review", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const snapshotPath = join(cwd, "loro", "snapshot.bin");
  const updatesPath = join(cwd, "loro", "updates.log");
  await mkdir(join(cwd, "loro"), { recursive: true });
  await writeFile(snapshotPath, "draft snapshot", "utf8");
  await writeFile(updatesPath, "draft updates", "utf8");

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });
  const quarantined = repaired.repairs?.filter((repair) => repair.id === "secondary-canvas-replica-quarantine") ?? [];
  const manifestPath = join(quarantined[0].path ? join(quarantined[0].path, "..", "..") : "", "manifest.json");
  const module = await import("./doctor");
  assert.equal(typeof module.listSecondaryCanvasRecoveries, "function");

  const inventory = await module.listSecondaryCanvasRecoveries({ cwd, env: {}, homeDir });

  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.status, "listed");
  assert.equal(inventory.projectId, "doctor_project");
  assert.equal(inventory.invalidEntries.length, 0);
  assert.equal(inventory.sets.length, 1);
  assert.equal(inventory.sets[0].manifestPath, manifestPath);
  assert.equal(inventory.sets[0].fileCount, 2);
  assert.deepEqual(
    inventory.sets[0].files.map((file: { kind: string; sourcePath: string }) => ({
      kind: file.kind,
      sourcePath: file.sourcePath,
    })).sort((a, b) => a.kind.localeCompare(b.kind)),
    [
      { kind: "snapshot", sourcePath: snapshotPath },
      { kind: "updates-log", sourcePath: updatesPath },
    ].sort((a, b) => a.kind.localeCompare(b.kind)),
  );
});

test("secondary canvas recovery list reports prior restore receipts for review", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  const replicationState = { mode: "local-only" };
  await initProject({ cwd, projectId: "doctor_project" });
  const snapshotPath = join(cwd, "loro", "snapshot.bin");
  const updatesPath = join(cwd, "loro", "updates.log");
  await mkdir(join(cwd, "loro"), { recursive: true });
  await writeFile(snapshotPath, "draft snapshot", "utf8");
  await writeFile(updatesPath, "draft updates", "utf8");

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, replicationState, repair: true });
  const quarantined = repaired.repairs?.filter((repair) => repair.id === "secondary-canvas-replica-quarantine") ?? [];
  const manifestPath = join(quarantined[0].path ? join(quarantined[0].path, "..", "..") : "", "manifest.json");
  const compared = await compareSecondaryCanvasRecovery({ manifestPath, cwd, env: {}, homeDir, replicationState });
  const restored = await restoreSecondaryCanvasRecovery({
    manifestPath,
    cwd,
    env: {},
    homeDir,
    replicationState,
    expectedReadToken: compared.readToken,
    confirm: true,
  });

  const inventory = await listSecondaryCanvasRecoveries({ cwd, env: {}, homeDir, replicationState });

  assert.equal(inventory.invalidEntries.length, 0);
  assert.equal(inventory.sets.length, 1);
  assert.equal(inventory.sets[0].manifestPath, manifestPath);
  const receipts = inventory.sets[0].restoreReceipts;
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].receiptPath, restored.receiptPath);
  assert.equal(receipts[0].status, "restored");
  assert.equal(receipts[0].projectId, "doctor_project");
  assert.equal(receipts[0].expectedReadToken, compared.readToken);
  assert.equal(receipts[0].beforeReadToken, restored.beforeReadToken);
  assert.equal(receipts[0].afterReadToken, restored.afterReadToken);
  assert.equal(receipts[0].fileCount, 2);
});

test("secondary canvas recovery list reports symlinked restore receipt roots as invalid inventory", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir },
  );
  const recoverySetRoot = join(status.roots.runtime, "recovery", "secondary-canvas-replicas", "manual");
  const manifestPath = join(recoverySetRoot, "manifest.json");
  await mkdir(recoverySetRoot, { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      projectId: "doctor_project",
      createdAt: new Date().toISOString(),
      canonicalReplica: {
        replicaRoot: status.loro.replicaRoot,
        snapshotPath: status.loro.snapshotPath,
        updatesLogPath: status.loro.updatesLogPath,
      },
      files: [],
    }),
    "utf8",
  );
  const externalReceiptRoot = await tempDir();
  const receiptRoot = join(recoverySetRoot, "canonical-before-restore");
  await symlink(externalReceiptRoot, receiptRoot);

  const inventory = await listSecondaryCanvasRecoveries({ cwd, env: {}, homeDir });

  assert.equal(inventory.sets.length, 1);
  assert.equal(inventory.sets[0].restoreReceipts.length, 0);
  assert.ok(
    inventory.invalidEntries.some((entry) =>
      entry.path === receiptRoot &&
      /outside recovery set root/.test(entry.error)
    ),
  );
});

test("secondary canvas recovery list reports symlinked manifests as invalid inventory", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir },
  );
  const recoverySetRoot = join(status.roots.runtime, "recovery", "secondary-canvas-replicas", "manual");
  const externalManifest = join(await tempDir(), "manifest.json");
  await mkdir(recoverySetRoot, { recursive: true });
  await writeFile(
    externalManifest,
    JSON.stringify({
      schemaVersion: 1,
      projectId: "doctor_project",
      createdAt: new Date().toISOString(),
      canonicalReplica: {
        replicaRoot: status.loro.replicaRoot,
        snapshotPath: status.loro.snapshotPath,
        updatesLogPath: status.loro.updatesLogPath,
      },
      files: [],
    }),
    "utf8",
  );
  const manifestPath = join(recoverySetRoot, "manifest.json");
  await symlink(externalManifest, manifestPath);

  const inventory = await listSecondaryCanvasRecoveries({ cwd, env: {}, homeDir });

  assert.equal(inventory.sets.length, 0);
  assert.equal(inventory.invalidEntries.length, 1);
  assert.equal(inventory.invalidEntries[0].path, manifestPath);
  assert.match(inventory.invalidEntries[0].error, /regular file/);
});

test("secondary canvas recovery list reports out-of-set destinations as invalid inventory", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir },
  );
  const recoverySetRoot = join(status.roots.runtime, "recovery", "secondary-canvas-replicas", "manual");
  const leakedFile = join(await tempDir(), "outside-snapshot.bin");
  await mkdir(recoverySetRoot, { recursive: true });
  await writeFile(leakedFile, "outside bytes", "utf8");
  const manifestPath = join(recoverySetRoot, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      projectId: "doctor_project",
      createdAt: new Date().toISOString(),
      canonicalReplica: {
        replicaRoot: status.loro.replicaRoot,
        snapshotPath: status.loro.snapshotPath,
        updatesLogPath: status.loro.updatesLogPath,
      },
      files: [
        {
          kind: "snapshot",
          sourcePath: join(cwd, "loro", "snapshot.bin"),
          destinationPath: leakedFile,
        },
      ],
    }),
    "utf8",
  );

  const inventory = await listSecondaryCanvasRecoveries({ cwd, env: {}, homeDir });

  assert.equal(inventory.sets.length, 0);
  assert.equal(inventory.invalidEntries.length, 1);
  assert.equal(inventory.invalidEntries[0].path, manifestPath);
  assert.match(inventory.invalidEntries[0].error, /outside recovery set root/);
});

test("storage doctor reports invalid recovery manifests instead of blessing symlinked inventory", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "marker", markerPath: join(cwd, ".clash", "project.toml") },
    { homeDir },
  );
  const recoverySetRoot = join(status.roots.runtime, "recovery", "secondary-canvas-replicas", "manual");
  const externalManifest = join(await tempDir(), "manifest.json");
  await mkdir(recoverySetRoot, { recursive: true });
  await writeFile(
    externalManifest,
    JSON.stringify({
      schemaVersion: 1,
      projectId: "doctor_project",
      createdAt: new Date().toISOString(),
      canonicalReplica: {
        replicaRoot: status.loro.replicaRoot,
        snapshotPath: status.loro.snapshotPath,
        updatesLogPath: status.loro.updatesLogPath,
      },
      files: [],
    }),
    "utf8",
  );
  const manifestPath = join(recoverySetRoot, "manifest.json");
  await symlink(externalManifest, manifestPath);

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });
  const recoveryCheck = checkById(report, "secondary-canvas-recovery");

  assert.equal(recoveryCheck?.level, "warning");
  assert.equal(recoveryCheck?.path, manifestPath);
  assert.match(recoveryCheck?.message ?? "", /invalid manifest entries/);
});

test("storage doctor validates the project status storage role contract", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );

  const checks = inspectStorageContract(status);

  assert.deepEqual(checks, [
    {
      id: "storage-role-contract",
      level: "ok",
      message: "Project storage contract separates agent workspace from protected canonical replica and local secrets.",
    },
  ]);
});

test("storage doctor fails when storage roles make canonical state agent-writable", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const corrupted = {
    ...status,
    storage: {
      ...status.storage,
      workspace: {
        ...status.storage.workspace,
        ownsCanonicalSnapshot: true,
        editablePaths: [
          ...status.storage.workspace.editablePaths,
          status.loro.snapshotPath,
        ],
      },
      canonicalReplica: {
        ...status.storage.canonicalReplica,
        metadata: {
          ...status.storage.canonicalReplica.metadata,
          agentWritable: true,
        },
      },
    },
  };

  const checks = inspectStorageContract(corrupted as any);

  const contract = checkById({ checks } as Awaited<ReturnType<typeof runStorageDoctor>>, "storage-role-contract");
  assert.equal(contract.level, "error");
  assert.match(contract.message, /owns canonical snapshot/);
  assert.match(contract.message, /canonical metadata is agent-writable/);
  assert.match(contract.message, /editable workspace includes canonical canvas path/);
});

test("storage doctor fails when revision content blobs are editable by agents", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const corrupted = {
    ...status,
    storage: {
      ...status.storage,
      canonicalReplica: {
        ...status.storage.canonicalReplica,
        contentBlobs: {
          ...status.storage.canonicalReplica.contentBlobs,
          textRevisions: {
            ...status.storage.canonicalReplica.contentBlobs.textRevisions,
            path: status.roots.projections,
            agentWritable: true,
          },
        },
      },
    },
  };

  const checks = inspectStorageContract(corrupted as any);

  const contract = checkById({ checks } as Awaited<ReturnType<typeof runStorageDoctor>>, "storage-role-contract");
  assert.equal(contract.level, "error");
  assert.match(contract.message, /text revision content blobs are agent-writable/);
  assert.match(contract.message, /canonical path is not protected/);
  assert.match(contract.message, /editable workspace includes canonical content path/);
});

test("storage doctor fails when canonical media asset blobs are editable by agents", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const corrupted = {
    ...status,
    storage: {
      ...status.storage,
      workspace: {
        ...status.storage.workspace,
        editablePaths: [
          ...status.storage.workspace.editablePaths,
          status.storage.canonicalReplica.mediaAssets.path,
        ],
      },
      canonicalReplica: {
        ...status.storage.canonicalReplica,
        mediaAssets: {
          ...status.storage.canonicalReplica.mediaAssets,
          agentWritable: true,
        },
      },
    },
  };

  const checks = inspectStorageContract(corrupted as any);

  const contract = checkById({ checks } as Awaited<ReturnType<typeof runStorageDoctor>>, "storage-role-contract");
  assert.equal(contract.level, "error");
  assert.match(contract.message, /canonical media asset blobs are agent-writable/);
  assert.match(contract.message, /editable workspace includes canonical media asset path/);
});

test("storage doctor fails when local secret files are agent-writable or unprotected", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const corrupted = {
    ...status,
    protectedPaths: status.protectedPaths.filter(
      (path) => path !== status.storage.localSecrets.files.hostCredentials.path,
    ),
    storage: {
      ...status.storage,
      localSecrets: {
        ...status.storage.localSecrets,
        agentWritable: true,
        files: {
          ...status.storage.localSecrets.files,
          hostCredentials: {
            ...status.storage.localSecrets.files.hostCredentials,
            agentWritable: true,
          },
        },
      },
    },
  };

  const checks = inspectStorageContract(corrupted as any);

  const contract = checkById({ checks } as Awaited<ReturnType<typeof runStorageDoctor>>, "storage-role-contract");
  assert.equal(contract.level, "error");
  assert.match(contract.message, /local secrets are agent-writable/);
  assert.match(contract.message, /local host credentials secret path is not protected/);
  assert.match(contract.message, /local host credentials secret is agent-writable/);
});

test("storage doctor fails when machine-local config is not modeled as protected YAML", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const corrupted = {
    ...status,
    storage: {
      ...status.storage,
      canonicalReplica: {
        ...status.storage.canonicalReplica,
        metadata: {
          ...status.storage.canonicalReplica.metadata,
          localConfig: {
            ...status.storage.canonicalReplica.metadata.localConfig,
            format: "json",
            path: "/tmp/clash-home/config.json",
            agentWritable: true,
            mutationSurface: "direct-file-edit",
            sqliteConfigRows: "active",
          },
        },
      },
    },
  };

  const checks = inspectStorageContract(corrupted as any);

  const contract = checkById({ checks } as Awaited<ReturnType<typeof runStorageDoctor>>, "storage-role-contract");
  assert.equal(contract.level, "error");
  assert.match(contract.message, /machine-local config format is wrong/);
  assert.match(contract.message, /machine-local config path is wrong/);
  assert.match(contract.message, /machine-local config is agent-writable/);
  assert.match(contract.message, /machine-local config mutation surface is wrong/);
  assert.match(contract.message, /machine-local SQLite config rows are not migration-only/);
});

test("storage doctor rejects media-backed text revisions and non-Loro Timeline history", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const corrupted = {
    ...status,
    storage: {
      ...status.storage,
      contentModel: {
        ...status.storage.contentModel,
        textNodes: {
          ...status.storage.contentModel.textNodes,
          revisionBlobPath: status.storage.canonicalReplica.mediaAssets.path,
          mediaAsset: true,
          agentWritableCanonicalState: true,
        },
        timelines: {
          ...status.storage.contentModel.timelines,
          projectionPath: status.loro.replicaRoot,
          revisionAuthority: "sqlite-revision-index",
          revisionRegistry: "timeline_revisions",
          contentRegistry: { table: "timeline_revisions" },
          mediaAsset: true,
        },
      },
    },
  };

  const checks = inspectStorageContract(corrupted as any);

  const contract = checkById({ checks } as Awaited<ReturnType<typeof runStorageDoctor>>, "storage-role-contract");
  assert.equal(contract.level, "error");
  assert.match(contract.message, /text content model revision blob path is wrong/);
  assert.match(contract.message, /text content model incorrectly uses media assets/);
  assert.match(contract.message, /text content model marks canonical state agent-writable/);
  assert.match(contract.message, /timeline content model projection path is wrong/);
  assert.match(contract.message, /timeline content model exposes removed revisionRegistry/);
  assert.match(contract.message, /timeline content model exposes removed contentRegistry/);
  assert.match(contract.message, /timeline content model exposes removed mediaAsset/);
  assert.match(contract.message, /timeline content model revision authority is wrong/);
});

test("storage doctor fails when text revision or Timeline entity commands drift from the CLI contract", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const corrupted = {
    ...status,
    storage: {
      ...status.storage,
      contentModel: {
        ...status.storage.contentModel,
        textNodes: {
          ...status.storage.contentModel.textNodes,
          restoreCommand: "clash text apply",
          historyCommand: "clash assets list",
          contentCommand: "clash asset get",
        },
        timelines: {
          ...status.storage.contentModel.timelines,
          pullCommand: "clash timeline pull --node <id>",
          publicCommands: ["clash timeline history"],
        },
      },
    },
  };

  const checks = inspectStorageContract(corrupted as any);

  const contract = checkById({ checks } as Awaited<ReturnType<typeof runStorageDoctor>>, "storage-role-contract");
  assert.equal(contract.level, "error");
  assert.match(contract.message, /text content model restore command is wrong/);
  assert.match(contract.message, /text content model history command is wrong/);
  assert.match(contract.message, /text content model content command is wrong/);
  assert.match(contract.message, /timeline content model pull command is wrong/);
  assert.match(contract.message, /timeline content model public commands are wrong/);
});

test("storage doctor fails when workspace editable paths omit a declared agent root", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const corrupted = {
    ...status,
    storage: {
      ...status.storage,
      workspace: {
        ...status.storage.workspace,
        editablePaths: status.storage.workspace.editablePaths.filter(
          (path) => path !== status.roots.timelines,
        ),
      },
    },
  };

  const checks = inspectStorageContract(corrupted as any);

  const contract = checkById({ checks } as Awaited<ReturnType<typeof runStorageDoctor>>, "storage-role-contract");
  assert.equal(contract.level, "error");
  assert.match(contract.message, /workspace editable paths missing declared agent path/);
  assert.match(contract.message, /timelines/);
});

test("storage doctor fails when workspace paths expose non-workspace locations to agents", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const externalDraftRoot = "/tmp/external-drafts";
  const corrupted = {
    ...status,
    storage: {
      ...status.storage,
      workspace: {
        ...status.storage.workspace,
        editablePaths: [
          ...status.storage.workspace.editablePaths,
          externalDraftRoot,
        ],
        protectedPaths: [
          ...status.storage.workspace.protectedPaths,
          status.localApiDataDir,
        ],
      },
    },
  };

  const checks = inspectStorageContract(corrupted as any);

  const contract = checkById({ checks } as Awaited<ReturnType<typeof runStorageDoctor>>, "storage-role-contract");
  assert.equal(contract.level, "error");
  assert.match(contract.message, /workspace editable paths include undeclared agent path/);
  assert.match(contract.message, /workspace editable path is outside project workspace/);
  assert.match(contract.message, /workspace protected path is outside project workspace/);
});

test("storage doctor fails when text view files point at canonical revision content", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const corrupted = {
    ...status,
    storage: {
      ...status.storage,
      workspace: {
        ...status.storage.workspace,
        viewFiles: {
          ...status.storage.workspace.viewFiles,
          texts: {
            ...status.storage.workspace.viewFiles.texts,
            path: status.storage.canonicalReplica.contentBlobs.textRevisions.path,
          },
        },
      },
    },
  };

  const checks = inspectStorageContract(corrupted as any);

  const contract = checkById({ checks } as Awaited<ReturnType<typeof runStorageDoctor>>, "storage-role-contract");
  assert.equal(contract.level, "error");
  assert.match(contract.message, /text view files path does not match projections\/text/);
  assert.match(contract.message, /text view files point at protected canonical state/);
});

test("storage doctor fails when timeline view files point at canonical state", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const corrupted = {
    ...status,
    storage: {
      ...status.storage,
      workspace: {
        ...status.storage.workspace,
        viewFiles: {
          ...status.storage.workspace.viewFiles,
          timelines: {
            ...status.storage.workspace.viewFiles.timelines,
            path: status.loro.replicaRoot,
          },
          timelineProjections: {
            ...status.storage.workspace.viewFiles.timelineProjections,
            path: status.loro.snapshotPath,
          },
        },
      },
    },
  };

  const checks = inspectStorageContract(corrupted as any);

  const contract = checkById({ checks } as Awaited<ReturnType<typeof runStorageDoctor>>, "storage-role-contract");
  assert.equal(contract.level, "error");
  assert.match(contract.message, /timeline view files path does not match timelines/);
  assert.match(contract.message, /timeline projection files path does not match projections\/timelines/);
  assert.match(contract.message, /timeline view files point at protected canonical state/);
  assert.match(contract.message, /timeline projection files point at protected canonical state/);
});

test("storage doctor fails when text content model points at the media asset table", () => {
  const status = buildProjectStatus(
    { projectId: "doctor_project", source: "explicit" },
    { homeDir: "/tmp/clash-home" },
  );
  const corrupted = {
    ...status,
    storage: {
      ...status.storage,
      contentModel: {
        ...status.storage.contentModel,
        textNodes: {
          ...status.storage.contentModel.textNodes,
          contentRegistry: {
            kind: "sqlite-non-media-revision-registry",
            table: "assets",
            blobStore: "storage.canonicalReplica.mediaAssets",
            mediaAssetTable: true,
          },
        },
      },
    },
  };

  const checks = inspectStorageContract(corrupted as any);

  const contract = checkById({ checks } as Awaited<ReturnType<typeof runStorageDoctor>>, "storage-role-contract");
  assert.equal(contract.level, "error");
  assert.match(contract.message, /text content model registry table is wrong/);
  assert.match(contract.message, /text content model incorrectly uses media asset table/);
  assert.match(contract.message, /text content model registry blob store is wrong/);
});

test("storage doctor fails when text revision content blobs are writable or hash-mismatched", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const blobPath = join(
    homeDir,
    ".clash",
    "local-api",
    "text-revision-blobs",
    "12",
    "1234567890abcdef.md",
  );
  await mkdir(join(blobPath, ".."), { recursive: true });
  await writeFile(blobPath, "tampered text body", { encoding: "utf8", mode: 0o644 });

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });

  assert.equal(report.ok, false);
  const check = checkById(report, "text-revision-blob-integrity");
  assert.equal(check.level, "error");
  assert.equal(check.path, blobPath);
  assert.match(check.message, /hash mismatch/);
  assert.match(check.message, /writable/);
});

test("storage doctor warns when local SQLite lacks the asset reference index schema", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const localApiDir = join(homeDir, ".clash", "local-api");
  await mkdir(localApiDir, { recursive: true });
  const sqlite = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    sqlite.exec(`
      CREATE TABLE assets (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE asset_refs (
        asset_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        imported_at INTEGER NOT NULL,
        PRIMARY KEY (asset_id, project_id)
      );
    `);
  } finally {
    sqlite.close();
  }

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });

  assert.equal(report.ok, true);
  const schemaCheck = checkById(report, "local-sqlite-schema");
  assert.equal(schemaCheck.level, "warning");
  assert.match(schemaCheck.message, /asset_node_refs/);
});

test("storage doctor warns when local SQLite lacks the text revision index schema", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const localApiDir = join(homeDir, ".clash", "local-api");
  await mkdir(localApiDir, { recursive: true });
  const sqlite = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    createAssetReferenceIndexSchema(sqlite);
  } finally {
    sqlite.close();
  }

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });

  assert.equal(report.ok, true);
  const schemaCheck = checkById(report, "local-sqlite-schema");
  assert.equal(schemaCheck.level, "warning");
  assert.match(schemaCheck.message, /text_revisions/);
});

test("storage doctor warns when local SQLite lacks core metadata tables", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const localApiDir = join(homeDir, ".clash", "local-api");
  await mkdir(localApiDir, { recursive: true });
  const sqlite = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    createAssetReferenceIndexSchema(sqlite);
    createRevisionIndexSchema(sqlite);
  } finally {
    sqlite.close();
  }

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });

  assert.equal(report.ok, true);
  const schemaCheck = checkById(report, "local-sqlite-schema");
  assert.equal(schemaCheck.level, "warning");
  assert.match(schemaCheck.message, /project/);
  assert.match(schemaCheck.message, /local_config/);
  assert.match(schemaCheck.message, /runtime_session/);
  assert.match(schemaCheck.message, /mutation_audit/);
});

test("storage doctor warns when local SQLite lacks provider auth tables", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });
  const localApiDir = join(homeDir, ".clash", "local-api");
  const sqlite = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    sqlite.exec(`
      DROP TABLE IF EXISTS provider_accounts;
      DROP TABLE IF EXISTS provider_account_credentials;
      DROP TABLE IF EXISTS provider_account_supported_models;
      DROP TABLE IF EXISTS provider_account_model_priorities;
      DROP TABLE IF EXISTS provider_oauth;
    `);
  } finally {
    sqlite.close();
  }

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });

  assert.equal(report.ok, true);
  const schemaCheck = checkById(report, "local-sqlite-schema");
  assert.equal(schemaCheck.level, "warning");
  assert.match(schemaCheck.message, /provider_accounts/);
  assert.match(schemaCheck.message, /provider_oauth/);
});

test("storage doctor warns when provider auth primary keys cannot support multi-account rows", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });
  const localApiDir = join(homeDir, ".clash", "local-api");
  const sqlite = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    recreateProviderAuthTablesWithLegacyPrimaryKeys(sqlite);
  } finally {
    sqlite.close();
  }

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });

  assert.equal(report.ok, true);
  const schemaCheck = checkById(report, "local-sqlite-schema");
  assert.equal(schemaCheck.level, "warning");
  assert.match(schemaCheck.message, /provider_accounts primary key/);
  assert.match(schemaCheck.message, /provider_oauth primary key/);
});

test("storage doctor repair creates workspace roots and fixes local SQLite asset reference schema", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const localApiDir = join(homeDir, ".clash", "local-api");
  await mkdir(localApiDir, { recursive: true });
  const sqlite = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    sqlite.exec(`
      CREATE TABLE assets (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE asset_refs (
        asset_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        imported_at INTEGER NOT NULL,
        PRIMARY KEY (asset_id, project_id)
      );
    `);
  } finally {
    sqlite.close();
  }

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });

  assert.equal(repaired.ok, true);
  assert.equal(repaired.repaired, true);
  assert.ok(repaired.repairs?.some((repair) => repair.id === "editable-drafts-root"));
  assert.ok(repaired.repairs?.some((repair) => repair.id === "local-sqlite-schema"));
  assert.equal(checkById(repaired, "project-workspace").level, "ok");
  assert.equal(checkById(repaired, "editable-drafts-root").level, "ok");
  assert.equal(checkById(repaired, "editable-projections-root").level, "ok");
  assert.equal(checkById(repaired, "editable-timelines-root").level, "ok");
  assert.equal(checkById(repaired, "editable-sessions-root").level, "ok");
  assert.equal(checkById(repaired, "editable-asset-links-root").level, "ok");
  assert.equal(checkById(repaired, "protected-runtime-root").level, "ok");
  assert.equal(checkById(repaired, "local-sqlite").level, "ok");
  assert.equal(checkById(repaired, "local-sqlite-schema").level, "ok");
  const sqliteAfterRepair = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    assert.equal(
      sqliteAfterRepair.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'text_revisions'").get()?.name,
      "text_revisions",
    );
    assert.equal(
      sqliteAfterRepair.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'text_revisions_project_node_idx'").get()?.name,
      "text_revisions_project_node_idx",
    );
  } finally {
    sqliteAfterRepair.close();
  }

  const verified = await runStorageDoctor({ cwd, env: {}, homeDir });
  assert.equal(checkById(verified, "local-sqlite-schema").level, "ok");
});

test("storage doctor repair creates core local SQLite metadata tables", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const localApiDir = join(homeDir, ".clash", "local-api");
  await mkdir(localApiDir, { recursive: true });
  const sqlite = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    createAssetReferenceIndexSchema(sqlite);
    createRevisionIndexSchema(sqlite);
  } finally {
    sqlite.close();
  }

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });

  assert.equal(repaired.ok, true);
  assert.equal(checkById(repaired, "local-sqlite-schema").level, "ok");
  const sqliteAfterRepair = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    for (const table of [
      "local_migration",
      "project",
      "project_preview_asset",
      "local_config",
      "assets",
      "asset_refs",
      "runtime_session",
      "agent_member",
      "chat_message",
      "mutation_audit",
    ]) {
      assert.equal(
        sqliteAfterRepair.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.name,
        table,
      );
    }
    for (const index of [
      "project_owner_idx",
      "assets_user_idx",
      "assets_task_idx",
      "assets_project_idx",
      "asset_refs_project_idx",
      "runtime_session_project_idx",
      "agent_member_user_idx",
      "chat_message_session_idx",
      "mutation_audit_created_idx",
      "mutation_audit_operation_idx",
      "mutation_audit_entity_idx",
    ]) {
      assert.equal(
        sqliteAfterRepair.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)?.name,
        index,
      );
    }
  } finally {
    sqliteAfterRepair.close();
  }
});

test("storage doctor repair creates provider auth SQLite tables", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });
  const localApiDir = join(homeDir, ".clash", "local-api");
  const sqlite = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    sqlite.exec(`
      DROP TABLE IF EXISTS provider_accounts;
      DROP TABLE IF EXISTS provider_account_credentials;
      DROP TABLE IF EXISTS provider_account_supported_models;
      DROP TABLE IF EXISTS provider_account_model_priorities;
      DROP TABLE IF EXISTS provider_oauth;
    `);
  } finally {
    sqlite.close();
  }

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });

  assert.equal(repaired.ok, true);
  assert.equal(checkById(repaired, "local-sqlite-schema").level, "ok");
  const sqliteAfterRepair = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    for (const table of [
      "provider_accounts",
      "provider_account_credentials",
      "provider_account_supported_models",
      "provider_account_model_priorities",
      "provider_oauth",
    ]) {
      assert.equal(
        sqliteAfterRepair.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.name,
        table,
      );
    }
  } finally {
    sqliteAfterRepair.close();
  }
});

test("storage doctor repair fixes provider auth primary keys for multi-account rows", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });
  const localApiDir = join(homeDir, ".clash", "local-api");
  const sqlite = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    recreateProviderAuthTablesWithLegacyPrimaryKeys(sqlite);
  } finally {
    sqlite.close();
  }

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });

  assert.equal(repaired.ok, true);
  assert.equal(checkById(repaired, "local-sqlite-schema").level, "ok");
  const sqliteAfterRepair = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    sqliteAfterRepair.exec(`
      INSERT INTO provider_accounts (user_id, account_key, provider_id, enabled)
      VALUES ('local-user', 'replicate-primary', 'replicate', 1);
      INSERT INTO provider_accounts (user_id, account_key, provider_id, enabled)
      VALUES ('local-user', 'replicate-secondary', 'replicate', 1);
      INSERT INTO provider_oauth (user_id, provider_id, account_id, status)
      VALUES ('local-user', 'example-oauth', 'example-primary', 'authorized');
      INSERT INTO provider_oauth (user_id, provider_id, account_id, status)
      VALUES ('local-user', 'example-oauth', 'example-secondary', 'pending');
    `);
    assert.equal(
      sqliteAfterRepair.prepare("SELECT COUNT(*) AS count FROM provider_accounts WHERE provider_id = 'replicate'").get()?.count,
      2,
    );
    assert.equal(
      sqliteAfterRepair.prepare("SELECT COUNT(*) AS count FROM provider_oauth WHERE provider_id = 'example-oauth'").get()?.count,
      2,
    );
  } finally {
    sqliteAfterRepair.close();
  }
});

test("storage doctor repair upgrades partial core local SQLite metadata tables", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const localApiDir = join(homeDir, ".clash", "local-api");
  await mkdir(localApiDir, { recursive: true });
  const sqlite = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    sqlite.exec(`
      CREATE TABLE local_migration (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE project (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE project_preview_asset (project_id TEXT NOT NULL);
      CREATE TABLE assets (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE asset_refs (
        asset_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        PRIMARY KEY (asset_id, project_id)
      );
      CREATE TABLE runtime_session (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE agent_member (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE chat_message (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        PRIMARY KEY (session_id, id)
      );
      CREATE TABLE mutation_audit (id TEXT PRIMARY KEY NOT NULL);
    `);
    createAssetReferenceIndexSchema(sqlite);
    createRevisionIndexSchema(sqlite);
  } finally {
    sqlite.close();
  }

  const repaired = await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });
  const verified = await runStorageDoctor({ cwd, env: {}, homeDir });

  assert.equal(repaired.ok, true);
  assert.equal(checkById(repaired, "local-sqlite-schema").level, "ok");
  assert.equal(checkById(verified, "local-sqlite-schema").level, "ok");
});

test("storage doctor accepts the local SQLite core metadata, provider auth, and projection schema", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "doctor_project" });
  const localApiDir = join(homeDir, ".clash", "local-api");
  await mkdir(localApiDir, { recursive: true });
  const sqlite = openSqlite(join(localApiDir, "local.sqlite"));
  try {
    createAssetReferenceIndexSchema(sqlite);
    createRevisionIndexSchema(sqlite);
  } finally {
    sqlite.close();
  }
  await runStorageDoctor({ cwd, env: {}, homeDir, repair: true });

  const report = await runStorageDoctor({ cwd, env: {}, homeDir });

  const schemaCheck = checkById(report, "local-sqlite-schema");
  assert.equal(schemaCheck.level, "ok");
  assert.match(schemaCheck.message, /supports core metadata/);
  assert.match(schemaCheck.message, /provider auth/);
});

test("doctor command is registered with storage subcommand", async () => {
  assert.equal(doctorCommand.name(), "doctor");
  assert.deepEqual(doctorCommand.commands.map((command) => command.name()), ["storage", "storage-recovery"]);
  assert.deepEqual(
    doctorCommand.commands.find((command) => command.name() === "storage-recovery")?.commands.map((command) => command.name()),
    ["list", "compare", "restore"],
  );

  const programSource = await readFile(new URL("../program.ts", import.meta.url), "utf8");
  assert.match(programSource, /import \{ doctorCommand \} from "\.\/commands\/doctor"/);
  assert.match(programSource, /program\.addCommand\(doctorCommand\)/);
});
