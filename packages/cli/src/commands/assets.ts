import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  copyFileSync,
  statSync,
  readFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import { Command } from "commander";
import type {
  ActionAssetBinding,
  AssetKind,
  ResolvedAsset,
} from "@clash/shared-types";
import {
  createProjectAssetHostClient,
  resolveAssetImportFileType,
  type PersonalGlobalAssetHostClient,
  type ProjectAssetHostClient,
} from "@clash/shared-runtime/project-asset-client";
import { downloadAssetById, replaceCanvasAssetNode } from "./canvas";
import { requireDestructiveConfirmation } from "../lib/destructive-guardrails";
import { isJsonMode, printJson } from "../lib/output";
import { assetMetadataCommand } from "./asset-metadata";
import { createAssetDocumentsCommand } from "./asset-documents";
import { resolveProjectStatus } from "./projects";
import {
  forgetAgentObservation,
  isAgentInvocation,
  publicAgentCommandResult,
  recordAgentObservation,
  requireAgentObservation,
} from "../lib/agent-worktree-observation";
import { resolveProjectContext } from "../lib/project-context";
import {
  createCliPersonalGlobalAssetHostClient,
  createCliProjectAssetHostClient,
} from "../lib/project-host-client";

export type AssetLinkMethod = "symlink" | "copy";

export interface AssetLinkResult {
  projectId: string;
  assetId: string;
  sourcePath: string;
  linkPath: string;
  method: AssetLinkMethod;
}

export interface AssetImportResult {
  projectId: string;
  assetId: string;
  kind: AssetKind;
  sourcePath: string;
  linkPath?: string;
  linkMethod?: AssetLinkMethod;
  registered: true;
  registration: ResolvedAsset;
}

export interface AssetFileReplaceResult {
  importedAssetId: string;
  replaced: true;
  replaceResult: Record<string, unknown>;
}

export interface AssetReferencesResult {
  projectAssetId: string;
  references: ActionAssetBinding[];
}

export type AssetRecordResult = ResolvedAsset;

const projectImportIds = new WeakMap<object, string>();
const globalImportIds = new WeakMap<object, string>();
const globalTrashIds = new WeakMap<object, string>();
type ProjectImportSnapshot = {
  sourcePath: string;
  status: Awaited<ReturnType<typeof resolveProjectStatus>>;
  kind: AssetKind;
  request: Parameters<ProjectAssetHostClient["importFile"]>[0];
};
type GlobalImportSnapshot = {
  request: Parameters<PersonalGlobalAssetHostClient["importFile"]>[0];
};
// One options object is one in-process CLI command. A new object intentionally
// creates a new Asset even when it names the same file; no cross-process or
// content-wide deduplication is implied.
const projectImports = new WeakMap<object, ProjectImportSnapshot>();
const globalImports = new WeakMap<object, GlobalImportSnapshot>();

function stableCliImportId(
  command: object,
  requested: string | undefined,
  ids: WeakMap<object, string>,
  prefix: "asset" | "global" | "delete",
): string {
  const existing = ids.get(command);
  if (existing) return existing;
  const normalized = requested?.trim();
  if (requested !== undefined && !normalized) {
    throw new Error(
      prefix === "delete"
        ? "delete operation id is required"
        : `${prefix} asset id is required`,
    );
  }
  const id = normalized ?? `${prefix}:${randomUUID()}`;
  ids.set(command, id);
  return id;
}

/**
 * Allocate the public import identity at the Commander boundary. The Host and
 * SDK only consume this value; they must never invent it after bytes are sent.
 */
export function preassignImportAssetId(
  requested: string | undefined,
  prefix: "asset" | "global",
): string {
  const normalized = requested?.trim();
  if (requested !== undefined && !normalized) {
    throw new Error(`${prefix} asset id is required`);
  }
  return normalized ?? `${prefix}:${randomUUID()}`;
}

export function resolveAssetLinkName(
  assetId: string,
  sourcePath: string,
  requestedName?: string,
): string {
  const raw = requestedName?.trim() || basename(sourcePath) || assetId;
  if (!raw || raw === "." || raw === ".." || /[/\\]/.test(raw)) {
    throw new Error("asset link name must be a single file name");
  }
  return raw.replace(/:/g, "_");
}

function createAssetLink(options: {
  assetId: string;
  sourcePath: string;
  assetLinksRoot: string;
  name?: string;
  createSymlink?: (target: string, path: string) => void;
}): { linkPath: string; method: AssetLinkMethod } {
  const linkName = resolveAssetLinkName(
    options.assetId,
    options.sourcePath,
    options.name,
  );
  const linkPath = join(options.assetLinksRoot, linkName);

  mkdirSync(options.assetLinksRoot, { recursive: true });
  if (existsSync(linkPath)) {
    const existing = lstatSync(linkPath);
    if (existing.isDirectory() && !existing.isSymbolicLink()) {
      throw new Error(`asset link path is a directory: ${linkPath}`);
    }
    throw new Error(
      `asset link already exists: ${linkPath}. Choose a different --name or remove the old link explicitly.`,
    );
  }

  let method: AssetLinkMethod = "symlink";
  try {
    (options.createSymlink ?? symlinkSync)(options.sourcePath, linkPath);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (!["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP"].includes(code))
      throw error;
    copyFileSync(options.sourcePath, linkPath);
    chmodSync(linkPath, 0o444);
    method = "copy";
  }

  return { linkPath, method };
}

export async function linkAssetIntoProject(options: {
  assetId: string;
  project?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  name?: string;
  download?: (assetId: string, projectId: string) => Promise<string | null>;
  createSymlink?: (target: string, path: string) => void;
}): Promise<AssetLinkResult> {
  const assetId = options.assetId.trim();
  if (!assetId) throw new Error("asset id is required");
  const status = await resolveProjectStatus({
    project: options.project,
    cwd: options.cwd,
    env: options.env,
    homeDir: options.homeDir,
  });
  const sourcePath = await (options.download ?? downloadAssetById)(
    assetId,
    status.projectId,
  );
  if (!sourcePath) throw new Error(`Unable to resolve asset ${assetId}`);
  const { linkPath, method } = createAssetLink({
    assetId,
    sourcePath,
    assetLinksRoot: status.assetLinksRoot,
    name: options.name,
    createSymlink: options.createSymlink,
  });

  return {
    projectId: status.projectId,
    assetId,
    sourcePath,
    linkPath,
    method,
  };
}

export async function importAssetFile(options: {
  filePath: string;
  projectAssetId?: string;
  project?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  kind?: string;
  name?: string;
  link?: boolean;
  client?: ProjectAssetHostClient;
  download?: (assetId: string, projectId: string) => Promise<string | null>;
  createSymlink?: (target: string, path: string) => void;
}): Promise<AssetImportResult> {
  let snapshot = projectImports.get(options);
  if (!snapshot) {
    const sourcePath = resolve(options.filePath);
    const info = statSync(sourcePath);
    if (!info.isFile())
      throw new Error(`asset import source is not a file: ${sourcePath}`);

    const status = await resolveProjectStatus({
      project: options.project,
      cwd: options.cwd,
      env: options.env,
      homeDir: options.homeDir,
    });
    const requestedKind = normalizeAssetKind(options.kind);
    if (options.kind !== undefined && !requestedKind) {
      throw new Error(
        "asset kind must be image, video, audio, or model to import through the Host",
      );
    }
    const fileType = resolveAssetImportFileType(
      sourcePath,
      requestedKind ?? undefined,
    );
    snapshot = {
      sourcePath,
      status,
      kind: fileType.kind,
      request: {
        projectId: status.projectId,
        bytes: new Uint8Array(readFileSync(sourcePath)),
        fileName: basename(sourcePath),
        contentType: fileType.contentType,
        kind: fileType.kind,
        projectAssetId: stableCliImportId(
          options,
          options.projectAssetId,
          projectImportIds,
          "asset",
        ),
      },
    };
    projectImports.set(options, snapshot);
  }
  const imported = await (
    options.client ?? createCliProjectAssetHostClient()
  ).importFile(snapshot.request);
  const assetId = imported.value.id;

  const result: AssetImportResult = {
    projectId: snapshot.status.projectId,
    assetId,
    kind: snapshot.kind,
    sourcePath: snapshot.sourcePath,
    registered: true,
    registration: imported.value,
  };

  if (options.link !== false) {
    const projectionPath = await (options.download ?? downloadAssetById)(
      assetId,
      snapshot.status.projectId,
    );
    if (!projectionPath) {
      throw new Error(`Unable to resolve imported Project Asset ${assetId}`);
    }
    const extension = extname(snapshot.sourcePath);
    const defaultName = `${assetId}${extension}`;
    const link = createAssetLink({
      assetId,
      sourcePath: projectionPath,
      assetLinksRoot: snapshot.status.assetLinksRoot,
      name: options.name ?? defaultName,
      createSymlink: options.createSymlink,
    });
    result.linkPath = link.linkPath;
    result.linkMethod = link.method;
  }

  return result;
}

type ProjectAssetObservationRecorder = (
  receipt: string,
) => void | Promise<void>;

function projectAssetClient(options: {
  client?: ProjectAssetHostClient;
  request?: (path: string, init?: RequestInit) => Promise<Response>;
}): ProjectAssetHostClient {
  if (options.client) return options.client;
  if (!options.request) return createCliProjectAssetHostClient();
  return createProjectAssetHostClient({
    endpoint: "http://clash-cli.test",
    env: {},
    fetch: (input, init) => {
      const url = new URL(String(input));
      return options.request!(`${url.pathname}${url.search}`, init);
    },
  });
}

export async function listProjectAssetRecords(options: {
  projectId: string;
  request?: (path: string, init?: RequestInit) => Promise<Response>;
  client?: ProjectAssetHostClient;
}): Promise<ResolvedAsset[]> {
  return (
    await projectAssetClient(options).list({ projectId: options.projectId })
  ).value;
}

export async function fetchProjectAssetReferences(options: {
  assetId: string;
  projectId: string;
  request?: (path: string, init?: RequestInit) => Promise<Response>;
  client?: ProjectAssetHostClient;
  onObservation?: ProjectAssetObservationRecorder;
}): Promise<AssetReferencesResult> {
  const observed = await projectAssetClient(options).references({
    projectId: options.projectId,
    assetId: options.assetId,
  });
  await options.onObservation?.(observed.receipt);
  return {
    projectAssetId: options.assetId,
    references: observed.value,
  };
}

export async function fetchProjectAssetRecord(options: {
  assetId: string;
  projectId: string;
  request?: (path: string, init?: RequestInit) => Promise<Response>;
  client?: ProjectAssetHostClient;
  onObservation?: ProjectAssetObservationRecorder;
}): Promise<AssetRecordResult> {
  const observed = await projectAssetClient(options).get({
    projectId: options.projectId,
    assetId: options.assetId,
  });
  await options.onObservation?.(observed.receipt);
  return observed.value;
}

/** Compatibility for Timeline readback; still resolves through the current Project endpoint. */
export async function fetchAssetRecord(options: {
  assetId: string;
  projectId?: string;
  request?: (path: string, init?: RequestInit) => Promise<Response>;
  client?: ProjectAssetHostClient;
}): Promise<AssetRecordResult> {
  return fetchProjectAssetRecord({
    assetId: options.assetId,
    projectId: options.projectId ?? (await resolveAssetProjectId()),
    ...(options.request ? { request: options.request } : {}),
    ...(options.client ? { client: options.client } : {}),
  });
}

export async function trashProjectAsset(options: {
  assetId: string;
  projectId: string;
  request?: (path: string, init?: RequestInit) => Promise<Response>;
  client?: ProjectAssetHostClient;
  actorClientType?: string;
  observedVersion?: string;
  onObservation?: ProjectAssetObservationRecorder;
}): Promise<ResolvedAsset> {
  // A CLI process may exit after the Host committed but before it received the
  // response. The same implicit observation therefore derives the same logical
  // delete operation on a later invocation; a fresh post-Restore observation
  // derives a new operation without exposing this identity to the user.
  const deleteOperationId = `delete:sha256:${createHash("sha256")
    .update(options.projectId)
    .update("\0")
    .update(options.assetId)
    .update("\0")
    .update(options.observedVersion ?? "")
    .digest("hex")}`;
  const observed = await projectAssetClient(options).trash({
    projectId: options.projectId,
    assetId: options.assetId,
    deleteOperationId,
    ...(options.actorClientType
      ? { actorClientType: options.actorClientType }
      : {}),
    ...(options.observedVersion ? { receipt: options.observedVersion } : {}),
  });
  await options.onObservation?.(observed.receipt);
  return observed.value;
}

export async function restoreProjectAsset(options: {
  assetId: string;
  projectId: string;
  request?: (path: string, init?: RequestInit) => Promise<Response>;
  client?: ProjectAssetHostClient;
  actorClientType?: string;
  observedVersion?: string;
  onObservation?: ProjectAssetObservationRecorder;
}): Promise<ResolvedAsset> {
  const observed = await projectAssetClient(options).restore({
    projectId: options.projectId,
    assetId: options.assetId,
    ...(options.actorClientType
      ? { actorClientType: options.actorClientType }
      : {}),
    ...(options.observedVersion ? { receipt: options.observedVersion } : {}),
  });
  await options.onObservation?.(observed.receipt);
  return observed.value;
}

export async function listPersonalGlobalAssetRecords(
  options: {
    client?: PersonalGlobalAssetHostClient;
  } = {},
): Promise<ResolvedAsset[]> {
  return (options.client ?? createCliPersonalGlobalAssetHostClient()).list();
}

export async function fetchPersonalGlobalAssetRecord(options: {
  globalAssetId: string;
  client?: PersonalGlobalAssetHostClient;
  onObservation?: (
    deleteOperationId: string | undefined,
  ) => void | Promise<void>;
}): Promise<ResolvedAsset> {
  const result = await (
    options.client ?? createCliPersonalGlobalAssetHostClient()
  ).get({
    globalAssetId: options.globalAssetId,
  });
  await options.onObservation?.(
    result.lifecycle.state === "trashed"
      ? result.lifecycle.deleteOperationId
      : undefined,
  );
  return result;
}

export async function importPersonalGlobalAssetFile(options: {
  filePath: string;
  globalAssetId?: string;
  kind?: string;
  client?: PersonalGlobalAssetHostClient;
}): Promise<ResolvedAsset> {
  let snapshot = globalImports.get(options);
  if (!snapshot) {
    const sourcePath = resolve(options.filePath);
    const info = statSync(sourcePath);
    if (!info.isFile()) {
      throw new Error(
        `Global Asset import source is not a file: ${sourcePath}`,
      );
    }
    const requestedKind = normalizeAssetKind(options.kind);
    if (options.kind !== undefined && !requestedKind) {
      throw new Error(
        "Global Asset kind must be image, video, audio, or model",
      );
    }
    const fileType = resolveAssetImportFileType(
      sourcePath,
      requestedKind ?? undefined,
    );
    snapshot = {
      request: {
        bytes: new Uint8Array(readFileSync(sourcePath)),
        fileName: basename(sourcePath),
        contentType: fileType.contentType,
        kind: fileType.kind,
        globalAssetId: stableCliImportId(
          options,
          options.globalAssetId,
          globalImportIds,
          "global",
        ),
      },
    };
    globalImports.set(options, snapshot);
  }
  return (
    options.client ?? createCliPersonalGlobalAssetHostClient()
  ).importFile(snapshot.request);
}

export async function admitPersonalGlobalAsset(options: {
  projectId: string;
  globalAssetId: string;
  client?: ProjectAssetHostClient;
}): Promise<ResolvedAsset> {
  return (
    await (options.client ?? createCliProjectAssetHostClient()).admit({
      projectId: options.projectId,
      globalAssetId: options.globalAssetId,
    })
  ).value;
}

export async function publishProjectAssetToPersonalGlobal(options: {
  projectId: string;
  projectAssetId: string;
  client?: PersonalGlobalAssetHostClient;
}): Promise<ResolvedAsset> {
  return (options.client ?? createCliPersonalGlobalAssetHostClient()).publish({
    projectId: options.projectId,
    projectAssetId: options.projectAssetId,
  });
}

export async function trashPersonalGlobalAsset(options: {
  globalAssetId: string;
  deleteOperationId?: string;
  client?: PersonalGlobalAssetHostClient;
  onObservation?: (deleteOperationId: string) => void | Promise<void>;
}): Promise<ResolvedAsset> {
  const deleteOperationId = stableCliImportId(
    options,
    options.deleteOperationId,
    globalTrashIds,
    "delete",
  );
  const result = await (
    options.client ?? createCliPersonalGlobalAssetHostClient()
  ).trash({
    globalAssetId: options.globalAssetId,
    deleteOperationId,
  });
  if (result.lifecycle.state !== "trashed") {
    throw new Error(`Host did not trash Global Asset ${options.globalAssetId}`);
  }
  await options.onObservation?.(result.lifecycle.deleteOperationId);
  return result;
}

export async function restorePersonalGlobalAsset(options: {
  globalAssetId: string;
  observedDeleteOperationId?: string;
  client?: PersonalGlobalAssetHostClient;
  onObservation?: (deleteOperationId: string) => void | Promise<void>;
}): Promise<ResolvedAsset> {
  const client = options.client ?? createCliPersonalGlobalAssetHostClient();
  let deleteOperationId = options.observedDeleteOperationId?.trim();
  if (!deleteOperationId) {
    const observed = await client.get({ globalAssetId: options.globalAssetId });
    if (observed.lifecycle.state !== "trashed") {
      throw new Error(
        `Global Asset ${options.globalAssetId} must be trashed before restore`,
      );
    }
    deleteOperationId = observed.lifecycle.deleteOperationId;
  }
  const result = await client.restore({
    globalAssetId: options.globalAssetId,
    deleteOperationId,
  });
  await options.onObservation?.(deleteOperationId);
  return result;
}

export async function replaceAssetFile(options: {
  filePath: string;
  nodeId: string;
  project?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  kind?: string;
  ifMatch?: string;
  newNode?: string;
  label?: string;
  link?: boolean;
  importFile?: (options: {
    filePath: string;
    project?: string;
    cwd?: string;
    env?: Record<string, string | undefined>;
    homeDir?: string;
    kind?: string;
    link?: boolean;
  }) => Promise<AssetImportResult>;
  replaceAsset?: (options: {
    project?: string;
    nodeId: string;
    assetId: string;
    ifMatch?: string;
    newNode?: string;
    label?: string;
  }) => Promise<Record<string, unknown>>;
}): Promise<AssetFileReplaceResult> {
  const imported = await (options.importFile ?? importAssetFile)({
    filePath: options.filePath,
    project: options.project,
    cwd: options.cwd,
    env: options.env,
    homeDir: options.homeDir,
    kind: options.kind,
    link: options.link ?? true,
  });
  const replaceResult = await (options.replaceAsset ?? replaceCanvasAssetNode)({
    project: options.project,
    nodeId: options.nodeId,
    assetId: imported.assetId,
    ifMatch: options.ifMatch,
    newNode: options.newNode,
    label: options.label,
  });
  return {
    importedAssetId: imported.assetId,
    replaced: true,
    replaceResult,
  };
}

function normalizeAssetKind(kind: string | undefined): AssetKind | null {
  const normalized = kind?.trim().toLowerCase();
  return normalized === "image" ||
    normalized === "video" ||
    normalized === "audio" ||
    normalized === "model"
    ? normalized
    : null;
}

export const assetsCommand = new Command("assets")
  .alias("asset")
  .description("Inspect and transfer Project and personal Global Assets");

function publicAssetResult<T extends object>(result: T): Omit<T, "readToken"> {
  return publicAgentCommandResult(
    result as T & Record<string, unknown>,
  ) as Omit<T, "readToken">;
}

async function resolveAssetProjectId(project?: string): Promise<string> {
  return (await resolveProjectContext({ project })).projectId;
}

function projectAssetObservation(projectId: string, assetId: string) {
  return {
    entityKind: "project-asset",
    entityId: assetId,
    project: projectId,
  } as const;
}

function personalGlobalAssetObservation(globalAssetId: string) {
  return {
    entityKind: "global-asset",
    entityId: globalAssetId,
  } as const;
}

async function recordPersonalGlobalAssetObservation(
  globalAssetId: string,
  deleteOperationId: string | undefined,
): Promise<void> {
  if (deleteOperationId) {
    await recordAgentObservation({
      ...personalGlobalAssetObservation(globalAssetId),
      revision: deleteOperationId,
    });
    return;
  }
  await forgetAgentObservation(personalGlobalAssetObservation(globalAssetId));
}

async function recordProjectAssetObservation(
  projectId: string,
  assetId: string,
  receipt: string,
): Promise<void> {
  await recordAgentObservation({
    ...projectAssetObservation(projectId, assetId),
    revision: receipt,
  });
}

assetsCommand
  .command("list")
  .description("List Project Assets resolved by the current Host")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--json", "Output result as JSON")
  .action(async (options: { project?: string; json?: boolean }) => {
    try {
      const projectId = await resolveAssetProjectId(options.project);
      const assets = await listProjectAssetRecords({ projectId });
      if (isJsonMode(options)) {
        printJson({ assets });
      } else if (assets.length === 0) {
        console.log("No Project Assets");
      } else {
        for (const asset of assets) {
          console.log(`${asset.id} ${asset.kind} ${asset.status}`);
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

assetsCommand
  .command("get")
  .description("Read a Project Asset resolved by the current Host")
  .requiredOption("--asset <id>", "Asset ID")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--json", "Output result as JSON")
  .action(
    async (options: { asset: string; project?: string; json?: boolean }) => {
      try {
        const projectId = await resolveAssetProjectId(options.project);
        const result = await fetchProjectAssetRecord({
          projectId,
          assetId: options.asset,
          onObservation: (receipt) =>
            recordProjectAssetObservation(projectId, options.asset, receipt),
        });
        if (isJsonMode(options)) {
          printJson(publicAssetResult(result));
        } else {
          console.log(`${result.id} ${result.kind} ${result.status}`);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    },
  );

assetsCommand
  .command("link")
  .description("Create an agent-readable project link for an immutable asset")
  .requiredOption("--asset <id>", "Asset ID")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--name <file>", "Link file name under assets/links")
  .option("--json", "Output as JSON")
  .action(
    async (options: {
      asset: string;
      project?: string;
      name?: string;
      json?: boolean;
    }) => {
      try {
        const result = await linkAssetIntoProject({
          assetId: options.asset,
          project: options.project,
          name: options.name,
        });
        if (isJsonMode(options)) {
          printJson(publicAssetResult(result));
        } else {
          console.log(
            `linked ${result.assetId} -> ${result.linkPath} (${result.method})`,
          );
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    },
  );

assetsCommand
  .command("import")
  .description(
    "Import a local file into the immutable content-addressed asset store",
  )
  .requiredOption("--file <path>", "Local file to import")
  .option("--kind <kind>", "Asset kind: image, video, audio, or model")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option(
    "--asset-id <id>",
    "Preassigned Project Asset ID; reuse it to replay an import with an unknown result",
  )
  .option("--name <file>", "Link file name under assets/links")
  .option("--no-link", "Do not create a project assets/links entry")
  .option("--json", "Output result as JSON")
  .action(
    async (options: {
      file: string;
      kind?: string;
      project?: string;
      assetId?: string;
      name?: string;
      link?: boolean;
      json?: boolean;
    }) => {
      let projectAssetId = options.assetId?.trim();
      try {
        projectAssetId = preassignImportAssetId(options.assetId, "asset");
        const result = await importAssetFile({
          filePath: options.file,
          kind: options.kind,
          project: options.project,
          projectAssetId,
          name: options.name,
          link: options.link,
        });
        if (isJsonMode(options)) {
          printJson(publicAssetResult(result));
        } else {
          const link = result.linkPath ? `, link ${result.linkPath}` : "";
          console.log(`imported Project Asset ${result.assetId}${link}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryHint = projectAssetId
          ? ` Retry an unknown result with --asset-id ${projectAssetId}.`
          : "";
        console.error(`${message}${retryHint}`);
        process.exit(1);
      }
    },
  );

assetsCommand
  .command("replace")
  .description(
    "Import a local file and create a copy-on-write replacement media node",
  )
  .requiredOption(
    "--file <path>",
    "Local file to import as the replacement asset",
  )
  .requiredOption("--node <id>", "Source image/video/audio node ID")
  .option("--kind <kind>", "Asset kind, such as image, video, or audio")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--new-node <id>", "Optional node ID for the copied media node")
  .option("--label <label>", "Optional label for the copied media node")
  .option(
    "--no-link",
    "Do not create a project assets/links entry for the imported asset",
  )
  .option("--json", "Output result as JSON")
  .action(
    async (options: {
      file: string;
      node: string;
      kind?: string;
      project?: string;
      newNode?: string;
      label?: string;
      link?: boolean;
      json?: boolean;
    }) => {
      try {
        const result = await replaceAssetFile({
          filePath: options.file,
          nodeId: options.node,
          project: options.project,
          kind: options.kind,
          newNode: options.newNode,
          label: options.label,
          link: options.link,
        });
        if (isJsonMode(options)) {
          printJson(publicAssetResult(result));
        } else {
          const newNodeId =
            typeof result.replaceResult.newNodeId === "string"
              ? result.replaceResult.newNodeId
              : "(unknown)";
          console.log(
            `Imported ${result.importedAssetId} and created copy-on-write media node: ${newNodeId}`,
          );
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    },
  );

assetsCommand
  .command("refs")
  .description("Show authoritative Action Asset bindings for a Project Asset")
  .requiredOption("--asset <id>", "Asset ID")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--json", "Output result as JSON")
  .action(
    async (options: { asset: string; project?: string; json?: boolean }) => {
      try {
        const projectId = await resolveAssetProjectId(options.project);
        const result = await fetchProjectAssetReferences({
          assetId: options.asset,
          projectId,
          onObservation: (receipt) =>
            recordProjectAssetObservation(projectId, options.asset, receipt),
        });
        if (isJsonMode(options)) {
          printJson(publicAssetResult(result));
        } else if (result.references.length === 0) {
          console.log(`No Action Asset bindings for ${result.projectAssetId}`);
        } else {
          for (const ref of result.references) {
            console.log(
              `${ref.direction} ${ref.slot} ${ref.owner.kind}:${ref.owner.actionId}${ref.role ? ` ${ref.role}` : ""}`,
            );
          }
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    },
  );

assetsCommand
  .command("admit")
  .description("Admit a personal Global Asset into the selected Project")
  .requiredOption("--global-asset <id>", "Global Asset ID")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--json", "Output result as JSON")
  .action(
    async (options: {
      globalAsset: string;
      project?: string;
      json?: boolean;
    }) => {
      try {
        const projectId = await resolveAssetProjectId(options.project);
        const result = await admitPersonalGlobalAsset({
          projectId,
          globalAssetId: options.globalAsset,
        });
        if (isJsonMode(options)) {
          printJson(publicAssetResult(result));
        } else {
          console.log(
            `admitted Global Asset ${options.globalAsset} as Project Asset ${result.id}`,
          );
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    },
  );

assetsCommand
  .command("publish")
  .description("Publish a Project Asset to the personal Global library")
  .requiredOption("--asset <id>", "Project Asset ID")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--json", "Output result as JSON")
  .action(
    async (options: { asset: string; project?: string; json?: boolean }) => {
      try {
        const projectId = await resolveAssetProjectId(options.project);
        const result = await publishProjectAssetToPersonalGlobal({
          projectId,
          projectAssetId: options.asset,
        });
        if (isJsonMode(options)) {
          printJson(publicAssetResult(result));
        } else {
          console.log(
            `published Project Asset ${options.asset} as Global Asset ${result.id}`,
          );
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    },
  );

assetsCommand
  .command("delete")
  .description("Move an unreferenced Project Asset to the recovery window")
  .requiredOption("--asset <id>", "Asset ID")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--yes", "Confirm deletion")
  .option("--json", "Output result as JSON")
  .action(
    async (options: {
      asset: string;
      project?: string;
      yes?: boolean;
      json?: boolean;
    }) => {
      try {
        const projectId = await resolveAssetProjectId(options.project);
        const confirmation = requireDestructiveConfirmation(
          options,
          `${projectId}:${options.asset}`,
        );
        if (!confirmation.ok) throw new Error(confirmation.error);
        const observedVersion = await requireAgentObservation(
          projectAssetObservation(projectId, options.asset),
        );
        const result = await trashProjectAsset({
          assetId: options.asset,
          projectId,
          actorClientType: isAgentInvocation() ? "agent" : undefined,
          observedVersion,
          onObservation: (receipt) =>
            recordProjectAssetObservation(projectId, options.asset, receipt),
        });
        if (isJsonMode(options)) {
          printJson(publicAssetResult(result));
        } else {
          console.log(`trashed Project Asset ${result.id}`);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    },
  );

assetsCommand
  .command("restore")
  .description("Restore a trashed Project Asset during its recovery window")
  .requiredOption("--asset <id>", "Asset ID")
  .option(
    "--project <id>",
    "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)",
  )
  .option("--json", "Output result as JSON")
  .action(
    async (options: { asset: string; project?: string; json?: boolean }) => {
      try {
        const projectId = await resolveAssetProjectId(options.project);
        const observedVersion = await requireAgentObservation(
          projectAssetObservation(projectId, options.asset),
        );
        const result = await restoreProjectAsset({
          assetId: options.asset,
          projectId,
          actorClientType: isAgentInvocation() ? "agent" : undefined,
          observedVersion,
          onObservation: (receipt) =>
            recordProjectAssetObservation(projectId, options.asset, receipt),
        });
        if (isJsonMode(options)) {
          printJson(publicAssetResult(result));
        } else {
          console.log(`restored Project Asset ${result.id}`);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    },
  );

const personalGlobalAssetsCommand = new Command("global").description(
  "Inspect and import personal Global Assets",
);

personalGlobalAssetsCommand
  .command("list")
  .description("List personal Global Assets resolved by the current Host")
  .option("--json", "Output result as JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const assets = await listPersonalGlobalAssetRecords();
      if (isJsonMode(options)) {
        printJson({ assets });
      } else if (assets.length === 0) {
        console.log("No personal Global Assets");
      } else {
        for (const asset of assets) {
          console.log(`${asset.id} ${asset.kind} ${asset.status}`);
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

personalGlobalAssetsCommand
  .command("get")
  .description("Read one personal Global Asset resolved by the current Host")
  .requiredOption("--asset <id>", "Global Asset ID")
  .option("--json", "Output result as JSON")
  .action(async (options: { asset: string; json?: boolean }) => {
    try {
      const result = await fetchPersonalGlobalAssetRecord({
        globalAssetId: options.asset,
        onObservation: (deleteOperationId) =>
          recordPersonalGlobalAssetObservation(
            options.asset,
            deleteOperationId,
          ),
      });
      if (isJsonMode(options)) {
        printJson(publicAssetResult(result));
      } else {
        console.log(`${result.id} ${result.kind} ${result.status}`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

personalGlobalAssetsCommand
  .command("import")
  .description("Import a local file into the personal Global Asset library")
  .requiredOption("--file <path>", "Local file to import")
  .option("--kind <kind>", "Asset kind: image, video, audio, or model")
  .option(
    "--asset-id <id>",
    "Preassigned Global Asset ID; reuse it to replay an import with an unknown result",
  )
  .option("--json", "Output result as JSON")
  .action(
    async (options: {
      file: string;
      kind?: string;
      assetId?: string;
      json?: boolean;
    }) => {
      let globalAssetId = options.assetId?.trim();
      try {
        globalAssetId = preassignImportAssetId(options.assetId, "global");
        const result = await importPersonalGlobalAssetFile({
          filePath: options.file,
          kind: options.kind,
          globalAssetId,
        });
        if (isJsonMode(options)) {
          printJson(publicAssetResult(result));
        } else {
          console.log(`imported Global Asset ${result.id}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryHint = globalAssetId
          ? ` Retry an unknown result with --asset-id ${globalAssetId}.`
          : "";
        console.error(`${message}${retryHint}`);
        process.exit(1);
      }
    },
  );

personalGlobalAssetsCommand
  .command("delete")
  .description("Move a personal Global Asset to the recovery window")
  .requiredOption("--asset <id>", "Global Asset ID")
  .option("--yes", "Confirm deletion")
  .option("--json", "Output result as JSON")
  .action(async (options: { asset: string; yes?: boolean; json?: boolean }) => {
    try {
      const confirmation = requireDestructiveConfirmation(
        options,
        `personal:${options.asset}`,
      );
      if (!confirmation.ok) throw new Error(confirmation.error);
      const result = await trashPersonalGlobalAsset({
        globalAssetId: options.asset,
        onObservation: (deleteOperationId) =>
          recordPersonalGlobalAssetObservation(
            options.asset,
            deleteOperationId,
          ),
      });
      if (isJsonMode(options)) {
        printJson(publicAssetResult(result));
      } else {
        console.log(`trashed Global Asset ${result.id}`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

personalGlobalAssetsCommand
  .command("restore")
  .description("Restore a trashed personal Global Asset")
  .requiredOption("--asset <id>", "Global Asset ID")
  .option("--json", "Output result as JSON")
  .action(async (options: { asset: string; json?: boolean }) => {
    try {
      const observedDeleteOperationId = await requireAgentObservation(
        personalGlobalAssetObservation(options.asset),
      );
      const result = await restorePersonalGlobalAsset({
        globalAssetId: options.asset,
        observedDeleteOperationId,
        onObservation: (deleteOperationId) =>
          recordPersonalGlobalAssetObservation(
            options.asset,
            deleteOperationId,
          ),
      });
      if (isJsonMode(options)) {
        printJson(publicAssetResult(result));
      } else {
        console.log(`restored Global Asset ${result.id}`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

assetsCommand.addCommand(personalGlobalAssetsCommand);
assetsCommand.addCommand(assetMetadataCommand);
assetsCommand.addCommand(createAssetDocumentsCommand());
