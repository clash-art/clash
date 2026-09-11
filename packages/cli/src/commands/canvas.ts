import { Command } from "commander";
import { chmodSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import {
  DEFAULT_CANVAS_ID,
  StoryboardViewStateSchema,
  type ProjectHostCommand,
  type ResolvedAsset,
} from "@clash/shared-types";
import { resolveWorkspaceTextInput } from "@clash/shared-runtime";
import type { ProjectAssetHostClient } from "@clash/shared-runtime/project-asset-client";
import { getServerUrl } from "../lib/config";
import { isJsonMode, printJson } from "../lib/output";
import {
  createCliProjectAssetHostClient,
  sendProjectCommand,
} from "../lib/project-host-client";
import { apiJson } from "../lib/api";
import { resolveClashRoot } from "../lib/clash-home";
import { resolveProjectContext, type ResolvedProjectContext } from "../lib/project-context";
import { publicAgentCommandResult } from "../lib/agent-worktree-observation";
import {
  forgetWorktreeObservation,
  recordWorktreeObservation,
  requireWorktreeObservation,
} from "../lib/worktree-observations";
import {
  validateCanvasUpdateDataFields,
} from "../lib/canvas-update-guardrails";
import { requireDestructiveConfirmation } from "../lib/destructive-guardrails";

export interface CanvasPresenceOptions {
  clientType: "cli" | "agent";
  userId?: string;
  userName?: string;
  agentName?: string;
}

export type CanvasActor = {
  actorType: "user" | "agent";
  actorUserId: string;
  actorAgentId?: string;
};

let activeCanvasId = DEFAULT_CANVAS_ID;

export function resolveCanvasCommandCanvasId(options: { canvas?: string } = {}): string {
  return options.canvas?.trim() || process.env.CLASH_CANVAS_ID?.trim() || DEFAULT_CANVAS_ID;
}

export function resolveCanvasPresenceOptions(
  env: Record<string, string | undefined> = process.env,
): CanvasPresenceOptions {
  const userId = env.CLASH_USER_ID?.trim();
  const userName = env.CLASH_USER_NAME?.trim();
  const agentMemberId = env.CLASH_AGENT_MEMBER_ID?.trim();
  const agentName = env.CLASH_AGENT_NAME?.trim() || agentMemberId;
  const base = {
    ...(userId ? { userId } : {}),
    ...(userName ? { userName } : {}),
  };
  if (agentMemberId) {
    return {
      ...base,
      clientType: "agent",
      ...(agentName ? { agentName } : {}),
    };
  }
  return { ...base, clientType: "cli" };
}

/**
 * Resolve the actor that's running this CLI invocation for Phase 0
 * attribution. There are two shapes:
 *
 *   - User-driven (default): resolve the local/remote product user through
 *     /api/v1/me, then stamp `{actorType:'user', actorUserId:<user>}`.
 *   - Agent-driven: the CLI was launched by the local-api host as the
 *     subprocess of an ACP agent. The local-api host stamps
 *     CLASH_AGENT_MEMBER_ID into the env. We stamp `{actorType:'agent',
 *     actorAgentId:<cm>, actorUserId:<owner>}` so the resulting node
 *     attributes back to the human accountable for it.
 *
 * Both lookups go through the same /api/v1/me endpoint — agent-driven
 * just additionally carries the agent member id from the env.
 */
export async function resolveCanvasActor(
  env: Record<string, string | undefined> = process.env,
): Promise<CanvasActor> {
  const configuredUserId = env.CLASH_USER_ID?.trim();
  const configuredAgentId = env.CLASH_AGENT_MEMBER_ID?.trim();
  if (configuredUserId) {
    return configuredAgentId
      ? { actorType: "agent", actorUserId: configuredUserId, actorAgentId: configuredAgentId }
      : { actorType: "user", actorUserId: configuredUserId };
  }
  const me = await apiJson<{ id: string }>("/api/v1/me").catch((e) => {
    throw new Error(`Failed to resolve the current Clash user: ${e instanceof Error ? e.message : String(e)}`);
  });
  const agentMemberId = configuredAgentId;
  if (agentMemberId) {
    return { actorType: "agent", actorUserId: me.id, actorAgentId: agentMemberId };
  }
  return { actorType: "user", actorUserId: me.id };
}

export async function resolveCanvasProjectId(options: {
  project?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
} = {}): Promise<string> {
  return (await resolveCanvasProjectContext(options)).projectId;
}

export async function resolveCanvasProjectContext(options: {
  project?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
} = {}): Promise<ResolvedProjectContext> {
  try {
    return await resolveProjectContext(options);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

function agentClientType(): "cli" | "agent" {
  return resolveCanvasPresenceOptions().clientType;
}

async function recordCanvasObservation(options: {
  context: ResolvedProjectContext;
  entityKind: string;
  entityId: string;
  revision: unknown;
}): Promise<void> {
  // An observation is concurrency evidence, not a permission, so it is recorded
  // for every client. Payload size picks the transport; it never picks the CAS
  // contract.
  if (!options.context.workspaceRoot) {
    throw new Error("Reads require a cwd linked through .clash/project.toml.");
  }
  if (typeof options.revision !== "string" || !options.revision.trim()) {
    throw new Error("Host read did not return an entity version.");
  }
  const revision = options.revision.trim();
  await recordWorktreeObservation({
    workspaceRoot: options.context.workspaceRoot,
    projectId: options.context.projectId,
    entityKind: options.entityKind,
    entityId: options.entityId,
    revision,
  });
}

async function requireCanvasObservation(options: {
  context: ResolvedProjectContext;
  entityKind: string;
  entityId: string;
}): Promise<string | undefined> {
  if (!options.context.workspaceRoot) {
    throw new Error("READ_REQUIRED: Run the command from a cwd linked through .clash/project.toml and read the target first.");
  }
  const observation = await requireWorktreeObservation({
    workspaceRoot: options.context.workspaceRoot,
    projectId: options.context.projectId,
    entityKind: options.entityKind,
    entityId: options.entityId,
  });
  if (!observation.ok) throw new Error(`${observation.code}: ${observation.error}`);
  return observation.revision;
}

async function forgetCanvasObservation(options: {
  context: ResolvedProjectContext;
  entityKind: string;
  entityId: string;
}): Promise<void> {
  if (agentClientType() !== "agent" || !options.context.workspaceRoot) return;
  await forgetWorktreeObservation({
    workspaceRoot: options.context.workspaceRoot,
    projectId: options.context.projectId,
    entityKind: options.entityKind,
    entityId: options.entityId,
  });
}

function publicMutationResult(value: Record<string, unknown>): Record<string, unknown> {
  return publicAgentCommandResult(value);
}

/**
 * Run a command through the local-api project authority.
 */
async function runCommand(projectId: string, cmd: ProjectHostCommand): Promise<any> {
  return sendProjectCommand(projectId, { ...cmd, canvasId: activeCanvasId });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectNodeOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function normalizeNodeIds(nodeIds: unknown): string[] {
  return [...new Set((Array.isArray(nodeIds) ? nodeIds : [])
    .map((nodeId) => String(nodeId ?? "").trim())
    .filter(Boolean))];
}

export async function replaceCanvasAssetNode(options: {
  project?: string;
  nodeId: string;
  assetId: string;
  newNode?: string;
  label?: string;
}): Promise<Record<string, unknown>> {
  const context = await resolveCanvasProjectContext({ project: options.project });
  const projectId = context.projectId;
  const assetId = String(options.assetId ?? "").trim();
  if (!assetId) throw new Error("asset id is required");
  const observedVersion = await requireCanvasObservation({
    context,
    entityKind: "canvas-node",
    entityId: options.nodeId,
  });

  const hostResult = await runCommand(projectId, {
    action: "asset_cow_replace",
    nodeId: options.nodeId,
    assetId,
    newNodeId: options.newNode,
    label: options.label,
    actorClientType: agentClientType(),
    observedVersion,
    ifMatch: observedVersion,
  });
  if (hostResult.error) throw new Error(hostResult.error);
  await recordCanvasObservation({
    context,
    entityKind: "canvas-node",
    entityId: String(hostResult.newNodeId ?? hostResult.nodeId),
    revision: hostResult.readToken ?? hostResult.version,
  });
  return publicMutationResult(hostResult);
}

export const canvasCommand = new Command("canvas")
  .description(`Canvas node operations through the local-api project host

Node types: text, group, image, video, audio, image_gen, video_gen, audio_gen, text_gen

  clash init --project <id>       # one-time workspace setup
  clash canvas list --json        # uses cwd marker automatically`);

// ─── list ─────────────────────────────────────────────────

canvasCommand
  .command("list")
  .description("List canvas nodes")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .option("--type <type>", "Filter by node type")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const projectId = await resolveCanvasProjectId(options);
    const hostResult = await runCommand(projectId, { action: "list", type: options.type });
    if (hostResult.error) { console.error(hostResult.error); process.exit(1); }
    if (isJsonMode(options)) { printJson(hostResult.nodes); }
    else {
        for (const node of hostResult.nodes) {
          console.log(`${node.id}  ${node.type.padEnd(14)}  ${(node.data?.label as string) || ""}`);
        }
        console.log(`\n${hostResult.nodes.length} node(s)`);
    }
  });

canvasCommand
  .command("edges")
  .description("List canvas edges")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const projectId = context.projectId;
    const hostResult = await runCommand(projectId, { action: "edges" });
    if (hostResult.error) { console.error(hostResult.error); process.exit(1); }
    const edges = Array.isArray(hostResult.edges) ? hostResult.edges : [];
    await recordCanvasObservation({
      context,
      entityKind: "canvas-edges",
      entityId: "graph",
      revision: hostResult.readToken ?? hostResult.version,
    });
    if (isJsonMode(options)) { printJson(edges); }
    else {
      for (const edge of edges) {
        console.log(`${edge.id}  ${edge.source} -> ${edge.target}`);
      }
      console.log(`\n${edges.length} edge(s)`);
    }
  });

canvasCommand
  .command("delete-plan")
  .description("Read a graph-aware batch delete plan")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .option("--node <id>", "Node ID to include in the delete batch; repeat for multiple nodes", collectNodeOption, [] as string[])
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const nodeIds = normalizeNodeIds(options.node);
    if (nodeIds.length === 0) {
      console.error("Provide at least one --node <id>");
      process.exit(1);
    }

    const context = await resolveCanvasProjectContext(options);
    const projectId = context.projectId;
    const batchId = nodeIds.join(",");
    const hostResult = await runCommand(projectId, {
      action: "batch_delete_plan",
      nodeIds,
      actorClientType: resolveCanvasPresenceOptions().clientType,
    });
    if (hostResult.error) { console.error(hostResult.error); process.exit(1); }
    await recordCanvasObservation({
      context,
      entityKind: "canvas-node-batch",
      entityId: batchId,
      revision: hostResult.readToken ?? hostResult.version,
    });
    if (isJsonMode(options)) printJson(publicMutationResult(hostResult));
    else {
      console.log(`Batch delete plan: ${hostResult.nodeIds?.join(", ") ?? nodeIds.join(", ")}`);
    }
  });

// ─── get ──────────────────────────────────────────────────

/** Cache dir: $CLASH_HOME/cache/assets, or ~/.clash/cache/assets by default. */
export function assetCacheDir(env: Record<string, string | undefined> = process.env): string {
  return join(resolveClashRoot(env), "cache", "assets");
}

export function resolveAssetDownloadUrl(signedUrl: string, serverUrl = getServerUrl()): string {
  return new URL(signedUrl, `${serverUrl.replace(/\/+$/, "")}/`).toString();
}

function resolvedAssetExtension(asset: ResolvedAsset): string {
  const namedExtension = extname(
    asset.metadata.originalName ?? asset.name ?? "",
  );
  if (/^\.[A-Za-z0-9_-]+$/.test(namedExtension)) return namedExtension;
  const contentType = asset.metadata.contentType?.toLowerCase();
  if (contentType === "image/png") return ".png";
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "image/gif") return ".gif";
  if (contentType === "video/mp4") return ".mp4";
  if (contentType === "video/webm") return ".webm";
  if (contentType === "audio/mpeg") return ".mp3";
  if (contentType === "audio/wav") return ".wav";
  if (contentType === "audio/mp4") return ".m4a";
  if (contentType === "model/gltf-binary") return ".glb";
  if (contentType === "model/gltf+json") return ".gltf";
  return "";
}

/** Download one immutable Project Asset through the Host's ResolvedAsset projection. */
export async function downloadAssetById(
  assetId: string,
  projectId: string,
  options: {
    cacheDir?: string;
    client?: Pick<ProjectAssetHostClient, "get">;
    fetch?: typeof fetch;
  } = {},
): Promise<string | null> {
  try {
    const cacheDir = options.cacheDir ?? assetCacheDir();
    mkdirSync(cacheDir, { recursive: true });

    // ProjectAsset ids are scoped to a Project, so the cache key must be too.
    const safeId = `${projectId}--${assetId}`.replace(/[/\\:]/g, "_");
    for (const name of readdirSync(cacheDir)) {
      if (name === safeId || name.startsWith(`${safeId}.`)) {
        const cachedPath = join(cacheDir, name);
        try { chmodSync(cachedPath, 0o444); } catch {}
        return cachedPath;
      }
    }

    const observed = await (
      options.client ?? createCliProjectAssetHostClient()
    ).get({ projectId, assetId });
    const asset = observed.value;
    if (asset.id !== assetId || asset.status !== "ready" || !asset.url) {
      return null;
    }

    const ext = resolvedAssetExtension(asset);
    const filePath = join(cacheDir, `${safeId}${ext}`);

    const fullUrl = resolveAssetDownloadUrl(asset.url);
    const res = await (options.fetch ?? fetch)(fullUrl);
    if (!res.ok) return null;

    writeFileSync(filePath, Buffer.from(await res.arrayBuffer()), { mode: 0o444 });
    try { chmodSync(filePath, 0o444); } catch {}
    return filePath;
  } catch {
    return null;
  }
}

function printNodeInfo(n: any) {
  console.log(`ID:       ${n.id}`);
  console.log(`Type:     ${n.type}`);
  console.log(`Label:    ${(n.data?.label as string) || "(none)"}`);
  console.log(`Status:   ${(n.data?.status as string) || "(none)"}`);
  console.log(`Position: (${n.position.x}, ${n.position.y})`);
  console.log(`Immutable: ${n.immutable === true ? "yes" : "no"}`);
  if (n.data?.content) console.log(`Content:  ${n.data.content}`);
  if (n.data?.description) console.log(`Desc:     ${n.data.description}`);
}

canvasCommand
  .command("get")
  .description("Get a specific node. For media nodes, downloads the asset to a temp file.")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .requiredOption("--node <id>", "Node ID")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    let node: any = null;
    let observation: string | null = null;
    let immutable = false;

    const context = await resolveCanvasProjectContext(options);
    const projectId = context.projectId;
    const hostResult = await runCommand(projectId, {
      action: "get",
      projectId,
      nodeId: options.node,
      actorClientType: agentClientType(),
    });
    if (hostResult.error) { console.error(hostResult.error); process.exit(1); }
    node = hostResult.node;
    immutable = hostResult.immutable === true;
    observation = typeof hostResult.readToken === "string"
      ? hostResult.readToken
      : typeof hostResult.version === "string"
        ? hostResult.version
        : null;
    if (!observation) throw new Error("Host read did not return an entity version.");
    await recordCanvasObservation({
      context,
      entityKind: "canvas-node",
      entityId: options.node,
      revision: observation,
    });

    // For media nodes, download the Project-scoped immutable projection.
    const assetId = typeof node.data?.assetId === "string" ? node.data.assetId : undefined;
    const isMedia = ["image", "video", "audio"].includes(node.type);
    let assetPath: string | null = null;
    if (isMedia && assetId) {
      assetPath = await downloadAssetById(assetId, projectId);
    }

    if (isJsonMode(options)) {
      printJson({ ...node, immutable: immutable === true, ...(assetPath ? { assetPath } : {}) });
    } else {
      printNodeInfo({ ...node, immutable: immutable === true });
      if (assetPath) {
        console.log(`Asset:    ${assetPath}`);
        console.log(`\nTo view this ${node.type}, open or read the file at the path above.`);
      }
    }
  });

// ─── add ──────────────────────────────────────────────────
//
// `add` deliberately keeps only CLI syntax and local identity resolution here.
// Defaults, model-card parameter coercion, prompt mention parsing, reference
// resolution, and edge creation belong to local-api so every peer client gets
// one product behavior from the typed host command.

canvasCommand
  .command("add")
  .description("Add content, an existing Project Asset, or an action-badge node")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .requiredOption("--type <type>", "Node type: text, group, remotion, image, video, audio, image_gen, video_gen, audio_gen, text_gen, model_gen")
  .requiredOption("--label <label>", "Node label")
  .option("--asset <id>", "Existing active Project Asset ID. Required for type image, video, or audio; projects independently with no lineage edge.")
  .option("--prompt <text>", "Generation prompt for *_gen nodes. May contain `@[Label](node:<id>)` mentions to reference canvas asset nodes; type partitioning is automatic from the referenced asset's kind.")
  .option("--content <content>", "Body content for text / group nodes or single-file Remotion TSX for remotion nodes. Ignored for *_gen nodes — use --prompt there.")
  .option("--content-file <path>", "Workspace-relative UTF-8 file read once as exact content; the path is not persisted. Mutually exclusive with --content.")
  .option("--parent <id>", "Parent group ID")
  .option(
    "--model <id>",
    "Generation Model id from the Host catalog. Creates a native Generator draft with a Canvas placement. Omit to use the default Model for the requested output; cannot be combined with --action.",
  )
  .option(
    "--ref <id...>",
    "Reference an existing canvas asset (image / video / audio). Accepts a canvas node id (we look up its asset) or a bare asset id. Repeatable; the type partitions automatically by asset kind.",
    (val: string, prev: string[]) => [...(prev ?? []), val],
    [] as string[],
  )
  .option(
    "--param <key=value...>",
    "Model or Action parameter (repeatable). Saved in the referenced Generator draft for native cards. Booleans and numbers are coerced; other values stay strings. Example: --param aspect_ratio=16:9 --param seed=42",
    (val: string, prev: Array<[string, string]>) => {
      const eq = val.indexOf("=");
      if (eq < 0) throw new Error(`--param expects key=value, got: ${val}`);
      return [...(prev ?? []), [val.slice(0, eq), val.slice(eq + 1)] as [string, string]];
    },
    [] as Array<[string, string]>,
  )
  .option(
    "--action <id>",
    "Select an installed Action Card. Mapped cards create their declared native Generator draft and Canvas placement; the Host owns contract validation and execution. Cannot be combined with --model. Creation does not run the Action.",
  )
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const projectId = context.projectId;
    const content = await resolveWorkspaceTextInput({
      workspaceRoot: context.workspaceRoot ?? process.cwd(),
      inline: options.content,
      filePath: options.contentFile,
    });
    const presence = resolveCanvasPresenceOptions();
    const params = Object.fromEntries(options.param ?? []) as Record<string, string>;
    const hostResult = await runCommand(projectId, {
      action: "add",
      type: options.type,
      label: options.label,
      content,
      prompt: options.prompt,
      parentId: options.parent,
      modelId: options.model,
      actionId: options.action,
      assetId: options.asset,
      refs: options.ref?.length > 0 ? options.ref : undefined,
      params: Object.keys(params).length > 0 ? params : undefined,
      actorClientType: presence.clientType,
      actorAgentId: process.env.CLASH_AGENT_MEMBER_ID?.trim() || undefined,
    });
    if (hostResult.error) { console.error(hostResult.error); process.exit(1); }
    const refNodeIds = Array.isArray(hostResult.refNodeIds) ? hostResult.refNodeIds as string[] : [];
    if (isJsonMode(options)) printJson(publicMutationResult(hostResult));
    else {
      console.log(`Created node: ${hostResult.node_id} (${hostResult.node?.type ?? options.type})`);
      if (hostResult.asset_id) console.log(`Asset ID:    ${hostResult.asset_id}`);
      if (refNodeIds.length > 0) console.log(`Refs wired:  ${refNodeIds.join(", ")}`);
    }
  });

// ─── execute ──────────────────────────────────────────────

canvasCommand
  .command("execute")
  .description(
    "Execute a node — triggers generation for action-badge nodes or render for video-editor nodes",
  )
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .requiredOption("--node <id>", "Node ID (action-badge or video-editor)")
  .option(
    "--provider <accountId>",
    "Answer with this provider account only. Fails if it cannot serve the model, rather than using another",
  )
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const projectId = await resolveCanvasProjectId(options);
    const printExecuteResult = (kind: string | null, childNodeId: string, childNodeType: string) => {
      if (kind === "render") {
        console.log(`Executed video-editor: ${options.node}`);
        console.log(`Created pending render-video node: ${childNodeId}`);
      } else {
        console.log(`Executed action-badge: ${options.node}`);
        console.log(`Created pending asset: ${childNodeId} (${childNodeType})`);
      }
    };

    const hostResult = await runCommand(projectId, {
      action: "execute",
      nodeId: options.node,
      ...(options.provider ? { providerAccountId: options.provider } : {}),
    });
    if (hostResult.error) { console.error(hostResult.error); process.exit(1); }
    if (isJsonMode(options)) printJson(publicMutationResult(hostResult));
    else printExecuteResult(hostResult.kind, hostResult.childNodeId, hostResult.childNodeType);
  });

/** Read one node through local-api. */
async function readNode(
  projectId: string,
  nodeId: string,
): Promise<{ type: string; data: Record<string, unknown> } | null> {
  const hostResult = await runCommand(projectId, { action: "get", nodeId });
  if (hostResult.error) return null;
  return hostResult.node ?? null;
}

// ─── update ───────────────────────────────────────────────

canvasCommand
  .command("update")
  .description("Update a node's data")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .requiredOption("--node <id>", "Node ID")
  .option("--label <label>", "New label")
  .option("--content <content>", "New content")
  .option("--content-file <path>", "Workspace-relative UTF-8 file read once as exact content; the path is not persisted. Mutually exclusive with --content.")
  .option("--asset-id <id>", "Bind an existing asset (image/video/audio) to this node — its preview will render")
  .option("--view-state-json <json>", "Complete structured plugin View state as JSON")
  .option("--view-state-file <path>", "Workspace-relative JSON file containing complete plugin View state")
  .option(
    "--data <key=value...>",
    "Arbitrary node-data field (repeatable). Example: --data status=completed --data description='hello'",
    (val: string, prev: Array<[string, string]>) => {
      const eq = val.indexOf("=");
      if (eq < 0) throw new Error(`--data expects key=value, got: ${val}`);
      return [...(prev ?? []), [val.slice(0, eq), val.slice(eq + 1)] as [string, string]];
    },
    [] as Array<[string, string]>,
  )
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const projectId = context.projectId;
    const content = await resolveWorkspaceTextInput({
      workspaceRoot: context.workspaceRoot ?? process.cwd(),
      inline: options.content,
      filePath: options.contentFile,
    });
    let observedVersion: string | undefined;
    try {
      observedVersion = await requireCanvasObservation({
        context,
        entityKind: "canvas-node",
        entityId: options.node,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    const extraData: Record<string, unknown> = {};
    if (options.assetId) extraData.assetId = options.assetId;
    for (const [k, v] of (options.data ?? [])) extraData[k] = v;
    if (options.viewStateJson !== undefined && options.viewStateFile !== undefined) {
      console.error("Error: --view-state-json and --view-state-file are mutually exclusive");
      process.exit(1);
    }
    if (options.viewStateJson !== undefined || options.viewStateFile !== undefined) {
      const encoded = options.viewStateFile !== undefined
        ? await resolveWorkspaceTextInput({
            workspaceRoot: context.workspaceRoot ?? process.cwd(),
            filePath: options.viewStateFile,
          })
        : options.viewStateJson;
      try {
        extraData.state = StoryboardViewStateSchema.parse(JSON.parse(encoded ?? ""));
      } catch (error) {
        console.error(`Error: Invalid View state JSON: ${(error as Error).message}`);
        process.exit(1);
      }
    }
    const guard = validateCanvasUpdateDataFields(Object.keys(extraData));
    if (!guard.ok) {
      console.error(`Error: ${guard.error}`);
      process.exit(1);
    }
    if (
      Object.keys(extraData).length === 0 &&
      typeof options.label !== "string" &&
      typeof content !== "string"
    ) {
      console.error("Provide at least one field to update (--label, --content, --content-file, --asset-id, --view-state-file, --data k=v)");
      process.exit(1);
    }

    const hostResult = await runCommand(projectId, {
      action: "update",
      nodeId: options.node,
      label: options.label,
      content,
      data: Object.keys(extraData).length ? extraData : undefined,
      actorClientType: agentClientType(),
      observedVersion,
      ifMatch: observedVersion,
    });
    if (hostResult.error) { console.error(hostResult.error); process.exit(1); }
    await recordCanvasObservation({
      context,
      entityKind: "canvas-node",
      entityId: options.node,
      revision: hostResult.readToken ?? hostResult.version,
    });
    if (isJsonMode(options)) { printJson(publicMutationResult(hostResult)); }
    else console.log(`Updated node: ${options.node}`);
  });

canvasCommand
  .command("move")
  .description("Move a node to an absolute Canvas position")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .requiredOption("--node <id>", "Node ID")
  .requiredOption("--x <number>", "Absolute Canvas x coordinate", Number)
  .requiredOption("--y <number>", "Absolute Canvas y coordinate", Number)
  .option("--json", "Output as JSON")
  .action(async (options) => {
    if (!Number.isFinite(options.x) || !Number.isFinite(options.y)) {
      console.error("Canvas move requires finite x and y coordinates");
      process.exit(1);
    }
    const context = await resolveCanvasProjectContext(options);
    const observedVersion = await requireCanvasObservation({
      context,
      entityKind: "canvas-node",
      entityId: options.node,
    });
    const position = { x: options.x, y: options.y };
    const hostResult = await runCommand(context.projectId, {
      action: "move",
      nodeId: options.node,
      position,
      actorClientType: agentClientType(),
      observedVersion,
      ifMatch: observedVersion,
    });
    if (hostResult.error) { console.error(hostResult.error); process.exit(1); }
    await recordCanvasObservation({
      context,
      entityKind: "canvas-node",
      entityId: options.node,
      revision: hostResult.readToken ?? hostResult.version,
    });
    if (isJsonMode(options)) printJson(publicMutationResult(hostResult));
    else console.log(`Moved node: ${options.node} (${options.x}, ${options.y})`);
  });

// ─── replace asset ────────────────────────────────────────

canvasCommand
  .command("replace-asset")
  .description("Create a copy-on-write media node with a replacement immutable asset")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .requiredOption("--node <id>", "Source image/video/audio node ID")
  .requiredOption("--asset <assetId>", "Replacement immutable asset ID")
  .option("--new-node <id>", "Optional node ID for the copied media node")
  .option("--label <label>", "Optional label for the copied media node")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    try {
      const result = await replaceCanvasAssetNode({
        project: options.project,
        nodeId: options.node,
        assetId: options.asset,
        newNode: options.newNode,
        label: options.label,
      });
      if (isJsonMode(options)) printJson(result);
      else console.log(`Created copy-on-write media node: ${result.newNodeId}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

canvasCommand
  .command("copy")
  .description("Create a mutable copy of a node while preserving existing downstream references")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .requiredOption("--node <id>", "Source node ID")
  .option("--new-node <id>", "Optional node ID for the copy")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const context = await resolveCanvasProjectContext(options);
    const observedVersion = await requireCanvasObservation({
      context,
      entityKind: "canvas-node",
      entityId: options.node,
    });
    const hostResult = await runCommand(context.projectId, {
      action: "copy_node",
      nodeId: options.node,
      newNodeId: options.newNode,
      actorClientType: agentClientType(),
      observedVersion,
      ifMatch: observedVersion,
    });
    if (hostResult.error) {
      console.error(hostResult.error);
      process.exit(1);
    }
    await recordCanvasObservation({
      context,
      entityKind: "canvas-node",
      entityId: String(hostResult.newNodeId ?? hostResult.nodeId),
      revision: hostResult.readToken ?? hostResult.version,
    });
    if (isJsonMode(options)) printJson(publicMutationResult(hostResult));
    else console.log(`Created copy-on-write node: ${hostResult.newNodeId}`);
  });

// ─── delete ───────────────────────────────────────────────

canvasCommand
  .command("delete-batch")
  .description("Delete multiple canvas nodes atomically after reading a graph-aware plan")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .option("--node <id>", "Node ID to delete; repeat for multiple nodes", collectNodeOption, [] as string[])
  .option("--yes", "Confirm deletion without an interactive prompt")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const nodeIds = normalizeNodeIds(options.node);
    if (nodeIds.length === 0) {
      console.error("Provide at least one --node <id>");
      process.exit(1);
    }
    const confirmation = requireDestructiveConfirmation(
      options,
      `canvas node batch ${nodeIds.join(",")}`,
    );
    if (!confirmation.ok) {
      console.error(`Error: ${confirmation.error}`);
      process.exit(1);
    }

    const context = await resolveCanvasProjectContext(options);
    const projectId = context.projectId;
    const batchId = nodeIds.join(",");
    let observedVersion: string | undefined;
    try {
      observedVersion = await requireCanvasObservation({
        context,
        entityKind: "canvas-node-batch",
        entityId: batchId,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    const hostResult = await runCommand(projectId, {
      action: "delete_batch",
      nodeIds,
      actorClientType: agentClientType(),
      observedVersion,
      ifMatch: observedVersion,
    });
    if (hostResult.error) { console.error(hostResult.error); process.exit(1); }
    await forgetCanvasObservation({ context, entityKind: "canvas-node-batch", entityId: batchId });
    for (const nodeId of nodeIds) {
      await forgetCanvasObservation({ context, entityKind: "canvas-node", entityId: nodeId });
    }
    if (isJsonMode(options)) printJson(publicMutationResult(hostResult));
    else {
      console.log(`Deleted node batch: ${nodeIds.join(", ")}`);
    }
  });

canvasCommand
  .command("delete")
  .description("Delete a node")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .requiredOption("--node <id>", "Node ID")
  .option("--yes", "Confirm deletion without an interactive prompt")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const confirmation = requireDestructiveConfirmation(
      options,
      `canvas node ${options.node}`,
    );
    if (!confirmation.ok) {
      console.error(`Error: ${confirmation.error}`);
      process.exit(1);
    }

    const context = await resolveCanvasProjectContext(options);
    const projectId = context.projectId;
    let observedVersion: string | undefined;
    try {
      observedVersion = await requireCanvasObservation({
        context,
        entityKind: "canvas-node",
        entityId: options.node,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    const hostResult = await runCommand(projectId, {
      action: "delete",
      nodeId: options.node,
      actorClientType: agentClientType(),
      observedVersion,
      ifMatch: observedVersion,
    });
    if (hostResult.error) { console.error(hostResult.error); process.exit(1); }
    await forgetCanvasObservation({ context, entityKind: "canvas-node", entityId: options.node });
    if (isJsonMode(options)) { printJson(publicMutationResult(hostResult)); }
    else {
      console.log(`Deleted node: ${options.node}`);
    }
  });

// ─── search ───────────────────────────────────────────────

canvasCommand
  .command("search")
  .description("Search nodes by content")
  .option("--project <id>", "Project ID (defaults to cwd marker or $CLASH_PROJECT_ID)")
  .requiredOption("--query <query>", "Search query")
  .option("--type <types>", "Comma-separated node types to filter")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    const projectId = await resolveCanvasProjectId(options);
    const hostResult = await runCommand(projectId, {
      action: "search", query: options.query, types: options.type?.split(",") ?? null,
    });
    if (hostResult.error) { console.error(hostResult.error); process.exit(1); }
    if (isJsonMode(options)) { printJson(hostResult.nodes); }
    else {
        for (const node of hostResult.nodes) {
          console.log(`${node.id}  ${node.type.padEnd(14)}  ${(node.data?.label as string) || ""}`);
        }
        console.log(`\n${hostResult.nodes.length} result(s)`);
    }
  });

for (const command of canvasCommand.commands) {
  if (!command.options.some((option) => option.long === "--canvas")) {
    command.option("--canvas <id>", "Canvas ID (defaults to main or $CLASH_CANVAS_ID)");
  }
}

canvasCommand.hook("preAction", (_command, actionCommand) => {
  activeCanvasId = resolveCanvasCommandCanvasId(actionCommand.opts());
});
