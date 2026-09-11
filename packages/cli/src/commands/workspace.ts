import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";

import { Command } from "commander";
import {
  WorkspaceExportPlanSchema,
  WorkspaceImportCommitRequestSchema,
  WorkspaceImportCommitResponseSchema,
  WorkspaceImportFileUploadReceiptSchema,
  WorkspaceImportSessionSchema,
  WorkspaceImportStartSchema,
  type WorkspaceBundleManifest,
  type WorkspaceExportPlan,
  type WorkspaceImportCommitResponse,
  type WorkspaceImportFileUploadReceipt,
  type WorkspaceImportSession,
  type WorkspaceImportStart,
} from "@clash/shared-types";
import {
  materializeVerifiedWorkspaceBundleFile,
  materializeWorkspaceTree,
  planWorkspaceTree,
  projectWorkspaceId,
  verifyWorkspaceBundleDirectory,
  writeWorkspaceBundleManifest,
} from "@clash/shared-runtime";

import {
  readProjectMarker,
  resolveProjectContext,
  writeProjectMarker,
} from "../lib/project-context";
import { resolveCliProjectHostConnection } from "../lib/project-host-client";
import { isJsonMode, printJson } from "../lib/output";

interface WorkspaceExportClient {
  createExport(input: {
    projectId: string;
    sourceWorkspaceId: string;
  }): Promise<unknown>;
  downloadExportFile(input: {
    exportId: string;
    fileId: string;
  }): Promise<Response>;
}

interface WorkspaceImportClient {
  startImport(input: WorkspaceImportStart): Promise<unknown>;
  getImport(input: { importId: string }): Promise<unknown>;
  uploadImportFile(input: {
    importId: string;
    fileId: string;
    body: ReadableStream<Uint8Array>;
    bytes: number;
    sha256: string;
  }): Promise<unknown>;
  commitImport(
    input: { importId: string } & Omit<
      ReturnType<typeof WorkspaceImportCommitRequestSchema.parse>,
      never
    >,
  ): Promise<unknown>;
}

export interface WorkspaceTransferClient
  extends WorkspaceExportClient, WorkspaceImportClient {}

export interface WorkspaceTransferClientOptions {
  endpoint?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export interface ExportWorkspaceInput {
  out: string;
  cwd?: string;
  client: WorkspaceExportClient;
}

export interface ExportWorkspaceResult {
  bundlePath: string;
  bundleDigest: string;
  projectId: string;
  sourceWorkspaceId: string;
  files: number;
  workspaceFiles: number;
}

export interface InspectWorkspaceResult {
  valid: true;
  bundlePath: string;
  bundleDigest: string;
  projectId: string;
  filesVerified: number;
  workspaceFiles: number;
  objectFiles: number;
  payloadBytes: number;
  excluded: Array<{ path: string; reason: string }>;
}

export interface ImportWorkspaceResult {
  targetPath: string;
  projectId: string;
  workspaceId: string;
  markerPath: string;
  bundleDigest: string;
  status: WorkspaceImportCommitResponse["status"];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function responseJson<T>(
  response: Response,
  schema: { parse(value: unknown): T },
): Promise<T> {
  if (!response.ok) {
    throw new Error(
      `Workspace Host request failed (${response.status}): ${await response.text()}`,
    );
  }
  return schema.parse(await response.json());
}

export function createWorkspaceTransferClient(
  options: WorkspaceTransferClientOptions = {},
): WorkspaceTransferClient {
  const discovered =
    options.endpoint === undefined
      ? resolveCliProjectHostConnection()
      : undefined;
  const endpoint = (options.endpoint ?? discovered!.endpoint).replace(
    /\/+$/u,
    "",
  );
  const token = options.token ?? discovered?.token;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const authorization: Record<string, string> = token
    ? { authorization: `Bearer ${token}` }
    : {};
  const jsonHeaders = {
    accept: "application/json",
    "content-type": "application/json",
    ...authorization,
  };
  const url = (path: string) => `${endpoint}${path}`;

  return {
    async createExport(input) {
      const response = await fetchImpl(
        url(
          `/api/v1/projects/${encodeURIComponent(input.projectId)}/workspace-exports`,
        ),
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ sourceWorkspaceId: input.sourceWorkspaceId }),
        },
      );
      return responseJson(response, WorkspaceExportPlanSchema);
    },

    async downloadExportFile(input) {
      return fetchImpl(
        url(
          `/api/v1/workspace-exports/${encodeURIComponent(input.exportId)}` +
            `/files/${encodeURIComponent(input.fileId)}`,
        ),
        { headers: { ...authorization } },
      );
    },

    async startImport(input) {
      const request = WorkspaceImportStartSchema.parse(input);
      const response = await fetchImpl(url("/api/v1/workspace-imports"), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(request),
      });
      return responseJson(response, WorkspaceImportSessionSchema);
    },

    async getImport(input) {
      const response = await fetchImpl(
        url(`/api/v1/workspace-imports/${encodeURIComponent(input.importId)}`),
        { headers: { accept: "application/json", ...authorization } },
      );
      return responseJson(response, WorkspaceImportSessionSchema);
    },

    async uploadImportFile(input) {
      const response = await fetchImpl(
        url(
          `/api/v1/workspace-imports/${encodeURIComponent(input.importId)}` +
            `/files/${encodeURIComponent(input.fileId)}`,
        ),
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(input.bytes),
            ...authorization,
          },
          body: input.body,
          duplex: "half",
        } as RequestInit & { duplex: "half" },
      );
      return responseJson(response, WorkspaceImportFileUploadReceiptSchema);
    },

    async commitImport(input) {
      const { importId, ...candidate } = input;
      const request = WorkspaceImportCommitRequestSchema.parse(candidate);
      const response = await fetchImpl(
        url(`/api/v1/workspace-imports/${encodeURIComponent(importId)}/commit`),
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(request),
        },
      );
      return responseJson(response, WorkspaceImportCommitResponseSchema);
    },
  };
}

async function assertPathAbsent(path: string, label: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info !== undefined) {
    throw new Error(`${label} already exists: ${path}`);
  }
}

async function publishWorkspaceEntryNoReplace(input: {
  sourceRoot: string;
  targetRoot: string;
  relativePath: string;
  completionPath: string;
  syncDirectory: (path: string) => Promise<void>;
}): Promise<void> {
  if (input.relativePath === input.completionPath) return;
  const source = join(input.sourceRoot, ...input.relativePath.split("/"));
  const target = join(input.targetRoot, ...input.relativePath.split("/"));
  const info = await lstat(source);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await mkdir(target, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") {
          throw new Error(
            `Workspace publication target already exists: ${target}`,
          );
        }
        throw error;
      },
    );
    const children = await readdir(source);
    children.sort();
    for (const child of children) {
      await publishWorkspaceEntryNoReplace({
        ...input,
        relativePath: `${input.relativePath}/${child}`,
      });
    }
    await input.syncDirectory(target);
    await rmdir(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY") throw error;
    });
    return;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(
      `Workspace publication source is not a regular file: ${source}`,
    );
  }
  await link(source, target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") {
      throw new Error(`Workspace publication target already exists: ${target}`);
    }
    throw error;
  });
  await unlink(source);
}

/**
 * Persists directory entries where the platform supports directory fsync.
 * Windows and some filesystems reject directory handles/fsync; those explicit
 * unsupported-operation errors degrade to completion-marker ordering only.
 */
export async function syncWorkspaceDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "EINVAL" ||
      code === "ENOTSUP" ||
      code === "EOPNOTSUPP" ||
      code === "EPERM" ||
      code === "EISDIR"
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Claims a new target atomically and publishes the completion marker last.
 * A crash can leave an incomplete claimed directory, but it cannot make that
 * directory valid because the manifest/Project marker is still absent.
 */
export async function publishWorkspaceDirectory(input: {
  stagingRoot: string;
  target: string;
  completionPath: string;
  syncDirectory?: (path: string) => Promise<void>;
}): Promise<void> {
  const sourceRoot = resolve(input.stagingRoot);
  const targetRoot = resolve(input.target);
  const syncDirectory = input.syncDirectory ?? syncWorkspaceDirectory;
  const completionSegments = input.completionPath.split("/");
  if (
    completionSegments.some(
      (segment) => !segment || segment === "." || segment === "..",
    ) ||
    input.completionPath.includes("\\")
  ) {
    throw new Error("Workspace publication completion path is invalid");
  }
  await mkdir(targetRoot, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") {
        throw new Error(
          `Workspace publication target already exists: ${targetRoot}`,
        );
      }
      throw error;
    },
  );

  const entries = await readdir(sourceRoot);
  entries.sort();
  for (const entry of entries) {
    await publishWorkspaceEntryNoReplace({
      sourceRoot,
      targetRoot,
      relativePath: entry,
      completionPath: input.completionPath,
      syncDirectory,
    });
  }
  await syncDirectory(targetRoot);
  await publishWorkspaceEntryNoReplace({
    sourceRoot,
    targetRoot,
    relativePath: input.completionPath,
    completionPath: "",
    syncDirectory,
  });
  let completionDirectory = dirname(join(targetRoot, ...completionSegments));
  while (true) {
    await syncDirectory(completionDirectory);
    if (completionDirectory === targetRoot) break;
    completionDirectory = dirname(completionDirectory);
  }
  await syncDirectory(dirname(targetRoot));
  await rm(sourceRoot, { recursive: true, force: true });
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten === 0) {
      throw new Error("Workspace download made no write progress");
    }
    offset += bytesWritten;
  }
}

async function downloadExportFile(
  stagingRoot: string,
  plan: WorkspaceExportPlan,
  file: WorkspaceExportPlan["files"][number],
  client: WorkspaceExportClient,
): Promise<void> {
  const response = await client.downloadExportFile({
    exportId: plan.exportId,
    fileId: file.fileId,
  });
  if (!response.ok) {
    throw new Error(
      `Workspace export file download failed (${response.status}): ${await response.text()}`,
    );
  }
  const path = join(stagingRoot, ...file.path.split("/"));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value;
        if (chunk.byteLength > file.bytes - bytes) {
          throw new Error(
            `Workspace export file exceeds declared size: ${file.path}`,
          );
        }
        digest.update(chunk);
        await writeAll(handle, chunk);
        bytes += chunk.byteLength;
      }
    }
    if (bytes !== file.bytes) {
      throw new Error(`Workspace export file size mismatch: ${file.path}`);
    }
    const sha256 = digest.digest("hex");
    if (sha256 !== file.sha256) {
      throw new Error(`Workspace export file digest mismatch: ${file.path}`);
    }
    await handle.sync();
    await handle.chmod(file.mode === "0755" ? 0o755 : 0o644);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await chmod(path, file.mode === "0755" ? 0o755 : 0o644);
}

export async function exportWorkspace(
  input: ExportWorkspaceInput,
): Promise<ExportWorkspaceResult> {
  const cwd = resolve(input.cwd ?? process.cwd());
  const target = resolve(input.out);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertPathAbsent(target, "Workspace export target");

  const context = await resolveProjectContext({ cwd });
  const sourceRoot = resolve(context.workspaceRoot ?? cwd);
  const marker = context.markerPath
    ? await readProjectMarker(context.markerPath)
    : undefined;
  const sourceWorkspaceId =
    marker?.workspaceId ??
    projectWorkspaceId("external", context.projectId, sourceRoot);
  const stagingRoot = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.workspace-export`,
  );
  await mkdir(stagingRoot, { mode: 0o700 });
  let published = false;
  try {
    const worktreePlan = await planWorkspaceTree({
      sourceRoot,
      bundleRoot: stagingRoot,
    });
    const hostPlan = WorkspaceExportPlanSchema.parse(
      await input.client.createExport({
        projectId: context.projectId,
        sourceWorkspaceId,
      }),
    );
    if (
      hostPlan.source.projectId !== context.projectId ||
      hostPlan.source.sourceWorkspaceId !== sourceWorkspaceId
    ) {
      throw new Error(
        "Workspace export plan does not match the requested source identity",
      );
    }
    if (hostPlan.files.some((file) => file.role === "workspace")) {
      throw new Error(
        "Host Workspace export plan must not contain worktree files",
      );
    }
    for (const file of hostPlan.files) {
      await downloadExportFile(stagingRoot, hostPlan, file, input.client);
    }
    const worktree = await materializeWorkspaceTree(worktreePlan);
    const files = [
      ...hostPlan.files.map(({ fileId: _fileId, ...file }) => file),
      ...worktree.files,
    ].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const { sourceWorkspaceId: _sourceWorkspaceId, ...portableSource } =
      hostPlan.source;
    const manifest = await writeWorkspaceBundleManifest(stagingRoot, {
      schemaVersion: 1,
      kind: "clash.workspace.bundle",
      source: portableSource,
      content: hostPlan.content,
      semanticRequirements: hostPlan.semanticRequirements,
      files,
      excluded: worktree.excluded,
    });
    await publishWorkspaceDirectory({
      stagingRoot,
      target,
      completionPath: "workspace.json",
    });
    published = true;
    return {
      bundlePath: target,
      bundleDigest: manifest.integrity.bundleDigest,
      projectId: manifest.source.projectId,
      sourceWorkspaceId,
      files: manifest.files.length,
      workspaceFiles: worktree.files.length,
    };
  } catch (error) {
    throw new Error(`Workspace export failed: ${message(error)}`, {
      cause: error,
    });
  } finally {
    if (!published) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

export async function inspectWorkspace(input: {
  bundle: string;
}): Promise<InspectWorkspaceResult> {
  const bundlePath = resolve(input.bundle);
  const verified = await verifyWorkspaceBundleDirectory(bundlePath);
  const { manifest } = verified;
  return {
    valid: true,
    bundlePath,
    bundleDigest: manifest.integrity.bundleDigest,
    projectId: manifest.source.projectId,
    filesVerified: verified.filesVerified,
    workspaceFiles: manifest.files.filter((file) => file.role === "workspace")
      .length,
    objectFiles: manifest.files.filter((file) => file.role === "object").length,
    payloadBytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
    excluded: manifest.excluded.map((entry) => ({ ...entry })),
  };
}

export async function importWorkspace(input: {
  bundle: string;
  into: string;
  client: WorkspaceImportClient;
}): Promise<ImportWorkspaceResult> {
  const bundlePath = resolve(input.bundle);
  const verified = await verifyWorkspaceBundleDirectory(bundlePath);
  const { manifest } = verified;
  const target = resolve(input.into);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertPathAbsent(target, "Workspace import target");

  const stagingRoot = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.workspace-import`,
  );
  const stagingWorkspace = join(stagingRoot, "workspace");
  await mkdir(stagingWorkspace, { recursive: true, mode: 0o700 });
  try {
    for (const file of manifest.files) {
      if (file.role !== "workspace") continue;
      await materializeVerifiedWorkspaceBundleFile({
        bundleRoot: bundlePath,
        destinationRoot: stagingRoot,
        file,
      });
    }

    const idempotencyKey = `workspace-import:${manifest.integrity.bundleDigest}`;
    const start = WorkspaceImportStartSchema.parse({
      schemaVersion: 1,
      kind: "clash.workspace.import-start",
      idempotencyKey,
      bundleDigest: manifest.integrity.bundleDigest,
      manifest,
    });
    let session = WorkspaceImportSessionSchema.parse(
      await input.client.startImport(start),
    );
    assertImportSessionMatchesManifest(session, manifest);

    for (const slot of session.files) {
      if (slot.state === "present") continue;
      const nodeStream = createReadStream(
        join(bundlePath, ...slot.path.split("/")),
      );
      const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
      const receipt = WorkspaceImportFileUploadReceiptSchema.parse(
        await input.client.uploadImportFile({
          importId: session.importId,
          fileId: slot.fileId,
          body,
          bytes: slot.bytes,
          sha256: slot.sha256,
        }),
      );
      assertUploadReceiptMatchesSlot(receipt, session, slot);
    }

    session = WorkspaceImportSessionSchema.parse(
      await input.client.getImport({ importId: session.importId }),
    );
    assertImportSessionMatchesManifest(session, manifest);
    if (session.files.some((slot) => slot.state !== "present")) {
      throw new Error(
        "Workspace import session still has missing Host file slots",
      );
    }

    const commitRequest = WorkspaceImportCommitRequestSchema.parse({
      schemaVersion: 1,
      kind: "clash.workspace.import-commit",
      idempotencyKey,
      bundleDigest: manifest.integrity.bundleDigest,
    });
    const committed = WorkspaceImportCommitResponseSchema.parse(
      await input.client.commitImport({
        importId: session.importId,
        ...commitRequest,
      }),
    );
    assertCommitMatchesManifest(committed, session, manifest);

    const workspaceId = projectWorkspaceId(
      "external",
      manifest.source.projectId,
      target,
    );
    await writeProjectMarker(stagingWorkspace, {
      schemaVersion: 1,
      projectId: manifest.source.projectId,
      workspaceId,
      store: "external",
    });
    await publishWorkspaceDirectory({
      stagingRoot: stagingWorkspace,
      target,
      completionPath: ".clash/project.toml",
    });
    return {
      targetPath: target,
      projectId: manifest.source.projectId,
      workspaceId,
      markerPath: join(target, ".clash", "project.toml"),
      bundleDigest: manifest.integrity.bundleDigest,
      status: committed.status,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertImportSessionMatchesManifest(
  session: WorkspaceImportSession,
  manifest: WorkspaceBundleManifest,
): void {
  const idempotencyKey = `workspace-import:${manifest.integrity.bundleDigest}`;
  if (
    session.idempotencyKey !== idempotencyKey ||
    session.bundleDigest !== manifest.integrity.bundleDigest ||
    !sameJson(session.source, manifest.source) ||
    session.target.projectId !== manifest.source.projectId
  ) {
    throw new Error(
      "Workspace import session does not match the verified bundle identity",
    );
  }
  const expected = manifest.files.filter((file) => file.role !== "workspace");
  if (session.files.length !== expected.length) {
    throw new Error(
      "Workspace import session file slots do not match the verified bundle",
    );
  }
  const expectedByPath = new Map(expected.map((file) => [file.path, file]));
  for (const slot of session.files) {
    const file = expectedByPath.get(slot.path);
    if (
      !file ||
      file.role !== slot.role ||
      file.bytes !== slot.bytes ||
      file.sha256 !== slot.sha256 ||
      file.mode !== slot.mode
    ) {
      throw new Error(
        `Workspace import slot does not match the bundle: ${slot.path}`,
      );
    }
  }
}

function assertUploadReceiptMatchesSlot(
  receipt: WorkspaceImportFileUploadReceipt,
  session: WorkspaceImportSession,
  slot: WorkspaceImportSession["files"][number],
): void {
  if (
    receipt.importId !== session.importId ||
    receipt.fileId !== slot.fileId ||
    receipt.bytes !== slot.bytes ||
    receipt.sha256 !== slot.sha256
  ) {
    throw new Error(
      `Workspace import upload receipt does not match slot: ${slot.path}`,
    );
  }
}

function assertCommitMatchesManifest(
  committed: WorkspaceImportCommitResponse,
  session: WorkspaceImportSession,
  manifest: WorkspaceBundleManifest,
): void {
  if (
    committed.importId !== session.importId ||
    committed.idempotencyKey !== session.idempotencyKey ||
    committed.bundleDigest !== manifest.integrity.bundleDigest ||
    !sameJson(committed.source, manifest.source) ||
    committed.target.projectId !== manifest.source.projectId
  ) {
    throw new Error(
      "Workspace import commit does not match the verified bundle identity",
    );
  }
}

export const workspaceCommand = new Command("workspace").description(
  "Export, inspect, and import portable Clash workspaces",
);

workspaceCommand
  .command("export")
  .description("Export the current Workspace into a new directory bundle")
  .requiredOption("--out <directory>", "New bundle directory")
  .option("--json", "Output as JSON")
  .action(async (options: { out: string; json?: boolean }) => {
    const result = await exportWorkspace({
      out: options.out,
      client: createWorkspaceTransferClient(),
    });
    if (isJsonMode(options)) {
      printJson(result);
      return;
    }
    console.log(`Exported Workspace: ${result.bundlePath}`);
    console.log(`Project: ${result.projectId}`);
    console.log(`Bundle digest: ${result.bundleDigest}`);
    console.log(`Files: ${result.files} (${result.workspaceFiles} worktree)`);
  });

workspaceCommand
  .command("inspect")
  .description("Verify and inspect a Workspace bundle offline")
  .argument("<bundle>", "Workspace bundle directory")
  .option("--json", "Output as JSON")
  .action(async (bundle: string, options: { json?: boolean }) => {
    const result = await inspectWorkspace({ bundle });
    if (isJsonMode(options)) {
      printJson(result);
      return;
    }
    console.log(`Valid Workspace bundle: ${result.bundlePath}`);
    console.log(`Project: ${result.projectId}`);
    console.log(`Bundle digest: ${result.bundleDigest}`);
    console.log(`Files verified: ${result.filesVerified}`);
  });

workspaceCommand
  .command("import")
  .description("Import a Workspace bundle into a new worktree directory")
  .argument("<bundle>", "Workspace bundle directory")
  .requiredOption("--into <directory>", "New worktree directory")
  .option("--json", "Output as JSON")
  .action(async (bundle: string, options: { into: string; json?: boolean }) => {
    const result = await importWorkspace({
      bundle,
      into: options.into,
      client: createWorkspaceTransferClient(),
    });
    if (isJsonMode(options)) {
      printJson(result);
      return;
    }
    console.log(`Imported Workspace: ${result.targetPath}`);
    console.log(`Project: ${result.projectId}`);
    console.log(`Workspace: ${result.workspaceId}`);
    console.log(`Host status: ${result.status}`);
  });
