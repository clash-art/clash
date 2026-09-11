import { projectLocalModelCopy } from "./local-model-copy-projection.js";
/**
 * Project command host — local-api's in-process authority for Canvas, Timeline,
 * Director Stage, and projected text commands used by the CLI.
 */

import { updateLocalCanvasGeneratorNode } from "./local-canvas-generator-update.js";
import { createHmac, randomBytes } from "node:crypto";
import type { LoroDoc } from "loro-crdt";
import Ajv from "ajv";
import {
  agentReadReceiptToken,
  AGENT_NODE_TYPE_MAP,
  Canvas,
  commitProjectMutation,
  createProjectGenerator,
  readProjectGenerator,
  readGeneratorRevision,
  canvasModelPlacementData,
  DEFAULT_CANVAS_ID,
  LoroSyncClient,
  PROJECT_ASSET_RENDER_CANVAS_ID,
  createMediaAssetCowNodeData,
  createDefaultDirectorStageState,
  coerceModelParameterInput,
  CustomActionDefinitionSchema,
  ExecutablePluginBindingSchema,
  extractAssetRefs,
  isMediaNodeType,
  MODEL_CARDS,
  normalizeModelId,
  parsePromptParts,
  pickDefaultModel,
  projectDirectorStageReadToken,
  projectCanvasReadToken,
  projectTimelineReadToken,
  readProjectAsset,
  TIMELINE_DSL_DEFINITION,
  StoryboardViewStateSchema,
  validateTimelineDsl,
  validateAgentObservation,
  validateAgentReadProof,
  type AgentReadReceiptProof,
  canvasBatchDeleteReadToken,
  canvasEdgesReadToken,
  canvasNodeReadToken,
  isCanvasNodeImmutable,
  validateCanvasBatchDelete,
  validateCanvasBatchDeleteReadProof,
  validateCanvasCheckpointPatch,
  validateCanvasDelete,
  validateCanvasContentPatch,
  validateCanvasEdgeAdd,
  validateCanvasMediaAssetPatch,
  validateCanvasReadProof,
  validateCanvasUpdateDataFields,
  type CanvasReadProofEdgeLike,
  type ModelCard,
  type GeneratorDefinition,
  hostMutationRejected,
  hostMutationSucceeded,
  validateHostMutationEnvelope,
} from "@clash/shared-types";
import {
  advanceLocalTimelineGenerator,
  attachLocalTimelineGeneratorToCanvas,
  copyLocalTimelineGeneratorActionToCanvas,
  createLocalTimelineGenerator,
  deleteLocalTimelineGenerator,
  detachLocalTimelineGeneratorFromCanvas,
  listLocalTimelineGenerators,
  listLocalTimelineGeneratorRuns,
  readLocalTimelineGenerator,
} from "./local-timeline-generator-product.js";
import {
  advanceLocalDirectorStageGenerator,
  attachLocalDirectorStageGeneratorToCanvas,
  createLocalDirectorStageGenerator,
  detachLocalDirectorStageGeneratorFromCanvas,
  listLocalDirectorStageGenerators,
  readLocalDirectorStageGenerator,
} from "./local-director-stage-generator-product.js";
import {
  createTextAppliedRevision,
  createTextCowNodeData,
  textHash,
  textReadToken,
  textContentFromNode,
  type TextRevisionActor,
} from "./project-text-projection.js";

const LOCAL_API_READ_RECEIPT_SECRET = randomBytes(32).toString("hex");

function hostCanvasReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`canvas-node:${readToken}`)
    .digest("base64url");
}

function hostCanvasEdgesReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`canvas-edges:${readToken}`)
    .digest("base64url");
}

function hostCanvasBatchDeleteReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`canvas-batch-delete:${readToken}`)
    .digest("base64url");
}

function canvasNodeReceiptReadToken(node: Parameters<typeof canvasNodeReadToken>[0]): string {
  const readToken = canvasNodeReadToken(node);
  return agentReadReceiptToken({
    readToken,
    receipt: hostCanvasReadReceipt(readToken),
  });
}

function canvasBatchDeleteReceiptReadToken(options: Parameters<typeof canvasBatchDeleteReadToken>[0]): string {
  const readToken = canvasBatchDeleteReadToken(options);
  return agentReadReceiptToken({
    readToken,
    receipt: hostCanvasBatchDeleteReadReceipt(readToken),
  });
}

function verifyHostCanvasReadReceipt(proof: AgentReadReceiptProof): boolean {
  return proof.namespace === "node" &&
    proof.receipt === hostCanvasReadReceipt(proof.baseReadToken);
}

function verifyHostCanvasBatchDeleteReadReceipt(proof: AgentReadReceiptProof): boolean {
  return proof.namespace === "canvas-batch-delete" &&
    proof.receipt === hostCanvasBatchDeleteReadReceipt(proof.baseReadToken);
}

function hostProjectCanvasReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`project-canvas:${readToken}`)
    .digest("base64url");
}

function projectCanvasReceiptReadToken(canvas: Parameters<typeof projectCanvasReadToken>[0]): string {
  const readToken = projectCanvasReadToken(canvas);
  return agentReadReceiptToken({
    readToken,
    receipt: hostProjectCanvasReadReceipt(readToken),
  });
}

function verifyHostProjectCanvasReadReceipt(proof: AgentReadReceiptProof): boolean {
  return proof.namespace === "canvas" &&
    proof.receipt === hostProjectCanvasReadReceipt(proof.baseReadToken);
}

function hostProjectTimelineReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`project-timeline:${readToken}`)
    .digest("base64url");
}

function projectTimelineReceiptReadToken(timeline: Parameters<typeof projectTimelineReadToken>[0]): string {
  const readToken = projectTimelineReadToken(timeline);
  return agentReadReceiptToken({
    readToken,
    receipt: hostProjectTimelineReadReceipt(readToken),
  });
}

function verifyHostProjectTimelineReadReceipt(proof: AgentReadReceiptProof): boolean {
  return proof.namespace === "timeline" &&
    proof.receipt === hostProjectTimelineReadReceipt(proof.baseReadToken);
}

function validateHostProjectTimelineRead(options: {
  cmd: Record<string, unknown>;
  currentVersion: string;
  operation: string;
}) {
  return typeof options.cmd.ifMatch === "string"
    ? validateAgentReadProof({
        actorClientType: typeof options.cmd.actorClientType === "string"
          ? options.cmd.actorClientType
          : undefined,
        operation: options.operation,
        currentReadToken: options.currentVersion,
        expectedReadToken: options.cmd.ifMatch,
        requireReceipt: true,
        readReceiptVerifier: verifyHostProjectTimelineReadReceipt,
        readCommandHint: "Run `clash timeline list --json` or `clash timeline pull --timeline <id>` first.",
      })
    : validateAgentObservation({
        actorClientType: typeof options.cmd.actorClientType === "string"
          ? options.cmd.actorClientType
          : undefined,
        operation: options.operation,
        observedVersion: typeof options.cmd.observedVersion === "string"
          ? options.cmd.observedVersion
          : undefined,
        currentVersion: options.currentVersion,
      });
}

function hostProjectDirectorStageReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`project-director-stage:${readToken}`)
    .digest("base64url");
}

function projectDirectorStageReceiptReadToken(
  stage: Parameters<typeof projectDirectorStageReadToken>[0],
): string {
  const readToken = projectDirectorStageReadToken(stage);
  return agentReadReceiptToken({
    readToken,
    receipt: hostProjectDirectorStageReadReceipt(readToken),
  });
}

function verifyHostProjectDirectorStageReadReceipt(proof: AgentReadReceiptProof): boolean {
  return proof.namespace === "director-stage" &&
    proof.receipt === hostProjectDirectorStageReadReceipt(proof.baseReadToken);
}

function validateHostProjectDirectorStageRead(options: {
  cmd: Record<string, unknown>;
  currentVersion: string;
  operation: string;
}) {
  return typeof options.cmd.ifMatch === "string"
    ? validateAgentReadProof({
        actorClientType: typeof options.cmd.actorClientType === "string"
          ? options.cmd.actorClientType
          : undefined,
        operation: options.operation,
        currentReadToken: options.currentVersion,
        expectedReadToken: options.cmd.ifMatch,
        requireReceipt: true,
        readReceiptVerifier: verifyHostProjectDirectorStageReadReceipt,
        readCommandHint: "Run `clash director list --json` or `clash director pull --stage <id>` first.",
      })
    : validateAgentObservation({
        actorClientType: typeof options.cmd.actorClientType === "string"
          ? options.cmd.actorClientType
          : undefined,
        operation: options.operation,
        observedVersion: typeof options.cmd.observedVersion === "string"
          ? options.cmd.observedVersion
          : undefined,
        currentVersion: options.currentVersion,
      });
}

function guardError(guard: { ok: false; error: string; code?: string }): object {
  return {
    error: guard.error,
    ...(guard.code ? { code: guard.code } : {}),
  };
}

function hostTextReadReceipt(readToken: string): string {
  return createHmac("sha256", LOCAL_API_READ_RECEIPT_SECRET)
    .update(`text:${readToken}`)
    .digest("base64url");
}

function textNodeReceiptReadToken(options: {
  projectId: string;
  nodeId: string;
  content: string;
}): string {
  const readToken = textReadToken(options);
  return agentReadReceiptToken({
    readToken,
    receipt: hostTextReadReceipt(readToken),
  });
}

function verifyHostTextReadReceipt(proof: AgentReadReceiptProof): boolean {
  return proof.namespace === "text" &&
    proof.receipt === hostTextReadReceipt(proof.baseReadToken);
}

function listCanvasEdgesWithVersion(client: LoroSyncClient): {
  edges: CanvasReadProofEdgeLike[];
  version: string;
  readToken: string;
} {
  const edges = listCanvasReadProofEdges(client);
  const version = canvasEdgesReadToken(edges);
  return {
    edges,
    version,
    readToken: agentReadReceiptToken({
      readToken: version,
      receipt: hostCanvasEdgesReadReceipt(version),
    }),
  };
}

function listCanvasReadProofEdges(client: LoroSyncClient): CanvasReadProofEdgeLike[] {
  return client.canvas.listEdges().map((edge) => ({ ...edge }));
}

function readCanvasBatchDeletePlan(client: LoroSyncClient, nodeIds: unknown): {
  nodeIds: string[];
  nodes: NonNullable<ReturnType<LoroSyncClient["readNode"]>>[];
  edges: CanvasReadProofEdgeLike[];
  version: string;
  readToken: string;
} | { error: string } {
  if (!Array.isArray(nodeIds)) return { error: "delete batch requires nodeIds" };
  const uniqueNodeIds = [...new Set(nodeIds.map((nodeId) => String(nodeId ?? "").trim()).filter(Boolean))];
  if (uniqueNodeIds.length === 0) return { error: "delete batch requires at least one node id" };
  const nodes: NonNullable<ReturnType<LoroSyncClient["readNode"]>>[] = [];
  const missing: string[] = [];
  for (const nodeId of uniqueNodeIds) {
    const node = client.readNode(nodeId);
    if (!node) missing.push(nodeId);
    else nodes.push(node);
  }
  if (missing.length > 0) return { error: `Node(s) not found: ${missing.join(", ")}` };
  const edges = listCanvasReadProofEdges(client);
  return {
    nodeIds: uniqueNodeIds,
    nodes,
    edges,
    version: canvasBatchDeleteReadToken({ nodes, edges }),
    readToken: canvasBatchDeleteReceiptReadToken({ nodes, edges }),
  };
}

function canvasGuardrailEdgesFromReadProof(
  edges: CanvasReadProofEdgeLike[],
): Array<{ source: string; target: string }> {
  return edges
    .map((edge) => ({
      source: typeof edge.source === "string" ? edge.source : "",
      target: typeof edge.target === "string" ? edge.target : "",
    }))
    .filter((edge) => edge.source && edge.target);
}

function coerceHostParameter(value: string | number | boolean): string | number | boolean {
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
}

function hostModelParams(
  modelCards: readonly ModelCard[],
  modelId: string | undefined,
  params: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
  const normalizedModelId = normalizeModelId(modelId) ?? modelId;
  const card = modelCards.find((candidate) => candidate.id === normalizedModelId);
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([key, raw]) => {
      const value = coerceHostParameter(raw);
      return [key, card ? coerceModelParameterInput(card, key, value) : value];
    }),
  );
}

function resolveCanvasReferenceNodeIds(
  client: LoroSyncClient,
  refs: string[],
): { refNodeIds: string[]; unresolvedReferences: string[] } {
  const nodes = client.listNodes();
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeIdByAssetId = new Map<string, string>();
  for (const node of nodes) {
    const assetId = node.data?.assetId;
    if (typeof assetId === "string" && assetId.trim()) {
      nodeIdByAssetId.set(assetId, node.id);
    }
  }

  const refNodeIds: string[] = [];
  const unresolvedReferences: string[] = [];
  for (const ref of [...new Set(refs.map((value) => value.trim()).filter(Boolean))]) {
    const nodeId = nodeIds.has(ref) ? ref : nodeIdByAssetId.get(ref);
    if (!nodeId) unresolvedReferences.push(ref);
    else if (!refNodeIds.includes(nodeId)) refNodeIds.push(nodeId);
  }
  return { refNodeIds, unresolvedReferences };
}

function generationOutputType(nodeType: string): "image" | "video" | "audio" | "text" | "model" {
  if (nodeType === "video_gen") return "video";
  if (nodeType === "audio_gen") return "audio";
  if (nodeType === "text_gen") return "text";
  if (nodeType === "model_gen") return "model";
  return "image";
}

export type ProjectCommandHostContext = {
  actorUserId?: string;
  effectiveModelCards?: readonly ModelCard[];
  canvasGeneratorDefinitions?: readonly GeneratorDefinition[];
  actionCards?: readonly import("@clash/shared-types").ExecutablePluginCardRegistration[];
  trustedCustomActions?: readonly Record<string, unknown>[];
  /** Host-private pending output identity, preallocated before the Project snapshot commits. */
  generationId?: () => string;
  timelineGeneratorDefinition?: GeneratorDefinition;
  directorStageGeneratorDefinition?: GeneratorDefinition;
};

export function handleProjectCommand(
  projectId: string,
  doc: LoroDoc,
  cmd: Record<string, unknown>,
  context: ProjectCommandHostContext = {},
): object {
  const modelCards = context.effectiveModelCards ?? MODEL_CARDS;
  const clientOptions = {
    serverUrl: "http://127.0.0.1",
    projectId,
    doc,
    modelCards,
  };
  const client = new LoroSyncClient(
    clientOptions as ConstructorParameters<typeof LoroSyncClient>[0],
  );
  return handleCommand(client, { ...cmd, projectId }, {
    ...context,
    effectiveModelCards: modelCards,
  });
}

const READ_ONLY_PROJECT_COMMANDS = new Set([
  "list_canvases",
  "list_timelines",
  "validate_timeline",
  "list_timeline_renders",
  "list_director_stages",
  "capture_director_stage",
  "list",
  "edges",
  "batch_delete_plan",
  "get",
  "search",
  "ping",
]);

export function projectCommandMutates(action: unknown): boolean {
  return typeof action === "string"
    && !READ_ONLY_PROJECT_COMMANDS.has(action);
}

export function handleCommandForTest(
  client: LoroSyncClient,
  cmd: any,
  context: ProjectCommandHostContext = {},
): object {
  return handleCommand(client, cmd, {
    ...context,
    effectiveModelCards: context.effectiveModelCards ?? MODEL_CARDS,
  });
}

function generatorSurfaceNotInstalled(): object {
  return {
    code: "GENERATOR_PROJECTION_SURFACE_NOT_INSTALLED",
    error: "The clash.timeline Generator projection surface is not installed.",
  };
}

function generatorProductError(error: { code: string; message: string }): object {
  return { code: error.code, error: error.message };
}

function handleCommand(
  client: LoroSyncClient,
  cmd: any,
  context: ProjectCommandHostContext,
): object {
  const { action } = cmd;
  const projectWorkspaceAction = action === "list_canvases" ||
    action === "create_canvas" ||
    action === "rename_canvas" ||
    action === "delete_canvas" ||
    action === "list_timeline_renders" ||
    action === "list_timelines" ||
    action === "validate_timeline" ||
    action === "create_timeline" ||
    action === "delete_timeline" ||
    action === "update_timeline_state" ||
    action === "attach_timeline" ||
    action === "detach_timeline" ||
    action === "copy_timeline_action" ||
    action === "request_timeline_render" ||
    action === "list_director_stages" ||
    action === "capture_director_stage" ||
    action === "ping" ||
    action === "create_director_stage" ||
    action === "update_director_stage_state" ||
    action === "attach_director_stage" ||
    action === "detach_director_stage";
  if (!projectWorkspaceAction) {
    try {
      client.selectCanvas(
        typeof cmd.canvasId === "string" && cmd.canvasId.trim()
          ? cmd.canvasId
          : DEFAULT_CANVAS_ID,
      );
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  switch (action) {
    case "list_canvases": {
      const canvases = client.listCanvases();
      return {
        canvases,
        versions: Object.fromEntries(
          canvases.map((canvas) => [canvas.id, projectCanvasReceiptReadToken(canvas)]),
        ),
      };
    }

    case "create_canvas": {
      const result = client.createCanvas({ id: cmd.canvasId, name: cmd.name });
      return result.ok
        ? {
            canvas: result.canvas,
            version: projectCanvasReadToken(result.canvas),
            readToken: projectCanvasReceiptReadToken(result.canvas),
          }
        : { error: result.error };
    }

    case "rename_canvas": {
      const current = client.listCanvases().find((canvas) => canvas.id === cmd.canvasId);
      if (!current) return { error: `Canvas ${cmd.canvasId} not found` };
      const currentVersion = projectCanvasReadToken(current);
      const guard = typeof cmd.ifMatch === "string"
        ? validateAgentReadProof({
            actorClientType: cmd.actorClientType,
            operation: "Canvas rename",
            currentReadToken: currentVersion,
            expectedReadToken: cmd.ifMatch,
            requireReceipt: true,
            readReceiptVerifier: verifyHostProjectCanvasReadReceipt,
            readCommandHint: "Run `clash canvases list --json` first.",
          })
        : validateAgentObservation({
            actorClientType: cmd.actorClientType,
            operation: "renaming the Canvas",
            observedVersion: cmd.observedVersion,
            currentVersion,
          });
      if (!guard.ok) return guardError(guard);
      const result = client.renameCanvas(cmd.canvasId, cmd.name);
      return result.ok
        ? {
            canvas: result.canvas,
            version: projectCanvasReadToken(result.canvas),
            readToken: projectCanvasReceiptReadToken(result.canvas),
          }
        : { error: result.error };
    }

    case "delete_canvas": {
      const current = client.listCanvases().find((canvas) => canvas.id === cmd.canvasId);
      if (!current) return { error: `Canvas ${cmd.canvasId} not found` };
      const currentVersion = projectCanvasReadToken(current);
      const guard = typeof cmd.ifMatch === "string"
        ? validateAgentReadProof({
            actorClientType: cmd.actorClientType,
            operation: "Canvas delete",
            currentReadToken: currentVersion,
            expectedReadToken: cmd.ifMatch,
            requireReceipt: true,
            readReceiptVerifier: verifyHostProjectCanvasReadReceipt,
            readCommandHint: "Run `clash canvases list --json` first.",
          })
        : validateAgentObservation({
            actorClientType: cmd.actorClientType,
            operation: "deleting the Canvas",
            observedVersion: cmd.observedVersion,
            currentVersion,
          });
      if (!guard.ok) return guardError(guard);
      const result = client.deleteCanvas(cmd.canvasId);
      return result.ok
        ? { deleted: true, canvasId: result.canvasId }
        : { error: result.error };
    }

    case "list_timelines": {
      const definition = context.timelineGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const result = listLocalTimelineGenerators(client.doc, definition);
      if (!result.ok) return generatorProductError(result.error);
      return {
        timelines: result.timelines,
        versions: Object.fromEntries(
          result.timelines.map((timeline) => [timeline.id, projectTimelineReceiptReadToken(timeline)]),
        ),
      };
    }

    case "validate_timeline": {
      const validation = validateTimelineDsl(cmd.document);
      return validation.ok
        ? {
            ok: true,
            issues: [],
            contractFingerprint: TIMELINE_DSL_DEFINITION.contractFingerprint,
          }
        : {
            ok: false,
            issues: validation.issues,
            contractFingerprint: TIMELINE_DSL_DEFINITION.contractFingerprint,
          };
    }

    case "list_timeline_renders": {
      const definition = context.timelineGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const status = cmd.status ?? "completed";
      if (status !== "completed" && status !== "all") {
        return { error: "Timeline render status must be 'completed' or 'all'" };
      }
      const listed = listLocalTimelineGeneratorRuns(client.doc, definition, status);
      if (!listed.ok) return generatorProductError(listed.error);
      const renders = listed.runs.map((run) => {
        const projectedStatus = run.status === "succeeded"
          ? "completed"
          : run.status === "failed" ? "failed" : "generating";
        const node = {
          id: run.actionRunId,
          type: "video",
          position: { x: 0, y: 0 },
          parent_id: null,
          data: {
            status: projectedStatus,
            sourceTimelineId: run.timelineId,
            sourceTimelineRevisionId: run.sourceTimelineRevisionId,
            ...(run.outputCommit ? { assetId: run.assetId } : {}),
          },
        };
        const version = canvasNodeReadToken(node);
        return {
          node,
          lineage: {
            sourceTimelineId: run.timelineId,
            sourceTimelineRevisionId: run.sourceTimelineRevisionId,
            renderTarget: null,
            assetId: run.assetId ?? null,
            status: projectedStatus,
          },
          version,
          readToken: canvasNodeReceiptReadToken(node),
        };
      });
      return { canvasId: PROJECT_ASSET_RENDER_CANVAS_ID, status, renders };
    }

    case "request_timeline_render": {
      const definition = context.timelineGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      if (typeof cmd.timelineId !== "string" || !cmd.timelineId.trim()) {
        return { error: "request_timeline_render requires timelineId" };
      }
      const timelineId = cmd.timelineId.trim();
      const read = readLocalTimelineGenerator(client.doc, definition, timelineId);
      if (!read.ok) return generatorProductError(read.error);
      const current = read.timeline;
      const guard = validateHostProjectTimelineRead({
        cmd,
        operation: "Timeline render",
        currentVersion: projectTimelineReadToken(current),
      });
      if (!guard.ok) return guardError(guard);
      const actionRunId = context.generationId?.() ?? crypto.randomUUID();
      const target = current.owner.kind === "canvas-action"
        ? { kind: "canvas", canvasId: current.owner.canvasId, actionNodeId: current.owner.actionNodeId }
        : { kind: "project-assets" };
      return {
        kind: "timeline-generator-action-plan",
        actionRunId,
        generatorId: current.id,
        generatorRevisionId: current.revisionId,
        actionId: definition.projectionSurface!.primaryActionId,
        timelineId: current.id,
        sourceTimelineRevisionId: current.revisionId,
        renderNodeId: actionRunId,
        target,
      };
    }

    case "create_timeline": {
      const definition = context.timelineGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const result = commitProjectMutation(client.doc, (draft) => {
        const created = createLocalTimelineGenerator(draft, definition, {
          id: cmd.timelineId, name: cmd.name, owner: { kind: "project" },
          revisionId: "genesis", state: cmd.state ?? { tracks: [] },
        });
        if (!created.ok || !cmd.placement) return created;
        return attachLocalTimelineGeneratorToCanvas(draft, definition, {
          timelineId: cmd.timelineId,
          canvasId: cmd.placement.canvasId,
          actionNodeId: cmd.placement.actionNodeId,
          position: cmd.placement.position,
        });
      });
      return result.ok
        ? {
            timeline: result.timeline,
            version: projectTimelineReadToken(result.timeline),
            readToken: projectTimelineReceiptReadToken(result.timeline),
          }
        : generatorProductError(result.error);
    }

    case "delete_timeline": {
      const definition = context.timelineGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const read = readLocalTimelineGenerator(client.doc, definition, cmd.timelineId);
      if (!read.ok) return generatorProductError(read.error);
      const current = read.timeline;
      const guard = validateHostProjectTimelineRead({ cmd, operation: "Timeline delete", currentVersion: projectTimelineReadToken(current) });
      if (!guard.ok) return guardError(guard);
      const result = commitProjectMutation(client.doc, (draft) => {
        const owner = current.owner;
        if (owner.kind === "canvas-action") {
          const canvas = new Canvas(draft, () => {}, owner.canvasId);
          const guard = validateCanvasDelete({ nodeId: owner.actionNodeId, edges: canvas.listEdges() });
          if (!guard.ok) return { ok: false as const, error: { code: "IMMUTABLE_NODE", message: guard.error } };
          const node = canvas.readNode(owner.actionNodeId);
          if (node?.data.timelineId === current.id) canvas.deleteNode(owner.actionNodeId);
        }
        return deleteLocalTimelineGenerator(draft, definition, {
          timelineId: current.id, expectedHeadRevisionId: current.revisionId,
          operationId: crypto.randomUUID(),
        });
      });
      return result.ok ? { deleted: true, timelineId: current.id } : generatorProductError(result.error);
    }

    case "update_timeline_state": {
      const definition = context.timelineGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const read = readLocalTimelineGenerator(client.doc, definition, cmd.timelineId);
      if (!read.ok) return generatorProductError(read.error);
      const current = read.timeline;
      const guard = validateHostProjectTimelineRead({
        cmd,
        operation: "Timeline apply",
        currentVersion: projectTimelineReadToken(current),
      });
      if (!guard.ok) return guardError(guard);
      const result = advanceLocalTimelineGenerator(client.doc, definition, {
        ...current,
        state: cmd.state,
      });
      return result.ok
        ? {
            timeline: result.timeline,
            version: projectTimelineReadToken(result.timeline),
            readToken: projectTimelineReceiptReadToken(result.timeline),
          }
        : generatorProductError(result.error);
    }

    case "attach_timeline": {
      const definition = context.timelineGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const read = readLocalTimelineGenerator(client.doc, definition, cmd.timelineId);
      if (!read.ok) return generatorProductError(read.error);
      const current = read.timeline;
      const guard = validateHostProjectTimelineRead({
        cmd,
        operation: "Timeline attach",
        currentVersion: projectTimelineReadToken(current),
      });
      if (!guard.ok) return guardError(guard);
      const result = attachLocalTimelineGeneratorToCanvas(client.doc, definition, {
        timelineId: cmd.timelineId,
        canvasId: cmd.canvasId,
        actionNodeId: typeof cmd.actionNodeId === "string" && cmd.actionNodeId.trim()
          ? cmd.actionNodeId.trim()
          : crypto.randomUUID().slice(0, 8),
        position: cmd.position ?? { x: 0, y: 0 },
      });
      return result.ok
        ? {
            timeline: result.timeline,
            version: projectTimelineReadToken(result.timeline),
            readToken: projectTimelineReceiptReadToken(result.timeline),
          }
        : generatorProductError(result.error);
    }

    case "detach_timeline": {
      const definition = context.timelineGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const read = readLocalTimelineGenerator(client.doc, definition, cmd.timelineId);
      if (!read.ok) return generatorProductError(read.error);
      const current = read.timeline;
      const guard = validateHostProjectTimelineRead({
        cmd,
        operation: "Timeline detach",
        currentVersion: projectTimelineReadToken(current),
      });
      if (!guard.ok) return guardError(guard);
      const result = detachLocalTimelineGeneratorFromCanvas(client.doc, definition, cmd.timelineId);
      return result.ok
        ? {
            timeline: result.timeline,
            version: projectTimelineReadToken(result.timeline),
            readToken: projectTimelineReceiptReadToken(result.timeline),
          }
        : generatorProductError(result.error);
    }

    case "copy_timeline_action": {
      const definition = context.timelineGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const read = readLocalTimelineGenerator(client.doc, definition, cmd.sourceTimelineId);
      if (!read.ok) return generatorProductError(read.error);
      const current = read.timeline;
      const sourceVersion = projectTimelineReadToken(current);
      const guard = validateHostProjectTimelineRead({
        cmd,
        operation: "Timeline Action copy",
        currentVersion: sourceVersion,
      });
      if (!guard.ok) return guardError(guard);
      const result = copyLocalTimelineGeneratorActionToCanvas(client.doc, definition, {
        sourceTimelineId: cmd.sourceTimelineId,
        targetCanvasId: cmd.targetCanvasId,
        newTimelineId: typeof cmd.newTimelineId === "string" && cmd.newTimelineId.trim()
          ? cmd.newTimelineId.trim()
          : `${cmd.sourceTimelineId}-copy-${crypto.randomUUID().slice(0, 8)}`,
        newActionNodeId: typeof cmd.newActionNodeId === "string" && cmd.newActionNodeId.trim()
          ? cmd.newActionNodeId.trim()
          : crypto.randomUUID().slice(0, 8),
        position: cmd.position ?? { x: 0, y: 0 },
      });
      return result.ok
        ? {
            timeline: result.timeline,
            version: projectTimelineReadToken(result.timeline),
            readToken: projectTimelineReceiptReadToken(result.timeline),
            sourceVersion,
          }
        : generatorProductError(result.error);
    }

    case "list_director_stages": {
      const definition = context.directorStageGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const listed = listLocalDirectorStageGenerators(client.doc, definition);
      if (!listed.ok) return generatorProductError(listed.error);
      const stages = listed.stages;
      return {
        stages,
        versions: Object.fromEntries(
          stages.map((stage) => [stage.id, projectDirectorStageReceiptReadToken(stage)]),
        ),
      };
    }

    case "create_director_stage": {
      const definition = context.directorStageGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const result = createLocalDirectorStageGenerator(client.doc, definition, {
        id: cmd.stageId,
        name: cmd.name,
        owner: { kind: "project" },
        revisionId: "",
        state: cmd.state ?? createDefaultDirectorStageState(),
      });
      return result.ok
        ? {
            stage: result.stage,
            version: projectDirectorStageReadToken(result.stage),
            readToken: projectDirectorStageReceiptReadToken(result.stage),
          }
        : { error: result.error };
    }

    case "update_director_stage_state": {
      const definition = context.directorStageGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const read = readLocalDirectorStageGenerator(client.doc, definition, cmd.stageId);
      if (!read.ok) return generatorProductError(read.error);
      const current = read.stage;
      const guard = validateHostProjectDirectorStageRead({
        cmd,
        operation: "Director Stage apply",
        currentVersion: projectDirectorStageReadToken(current),
      });
      if (!guard.ok) return guardError(guard);
      const result = advanceLocalDirectorStageGenerator(client.doc, definition, { ...current, state: cmd.state });
      return result.ok
        ? {
            stage: result.stage,
            version: projectDirectorStageReadToken(result.stage),
            readToken: projectDirectorStageReceiptReadToken(result.stage),
          }
        : { error: result.error };
    }

    case "attach_director_stage": {
      const definition = context.directorStageGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const read = readLocalDirectorStageGenerator(client.doc, definition, cmd.stageId);
      if (!read.ok) return generatorProductError(read.error);
      const current = read.stage;
      const guard = validateHostProjectDirectorStageRead({
        cmd,
        operation: "Director Stage attach",
        currentVersion: projectDirectorStageReadToken(current),
      });
      if (!guard.ok) return guardError(guard);
      const result = attachLocalDirectorStageGeneratorToCanvas(client.doc, definition, {
        stageId: cmd.stageId,
        canvasId: cmd.canvasId,
        actionNodeId: typeof cmd.actionNodeId === "string" && cmd.actionNodeId.trim()
          ? cmd.actionNodeId.trim()
          : crypto.randomUUID().slice(0, 8),
        position: cmd.position ?? { x: 0, y: 0 },
      });
      return result.ok
        ? {
            stage: result.stage,
            version: projectDirectorStageReadToken(result.stage),
            readToken: projectDirectorStageReceiptReadToken(result.stage),
          }
        : { error: result.error };
    }

    case "detach_director_stage": {
      const definition = context.directorStageGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const read = readLocalDirectorStageGenerator(client.doc, definition, cmd.stageId);
      if (!read.ok) return generatorProductError(read.error);
      const current = read.stage;
      const guard = validateHostProjectDirectorStageRead({
        cmd,
        operation: "Director Stage detach",
        currentVersion: projectDirectorStageReadToken(current),
      });
      if (!guard.ok) return guardError(guard);
      const result = detachLocalDirectorStageGeneratorFromCanvas(client.doc, definition, cmd.stageId);
      return result.ok
        ? {
            stage: result.stage,
            version: projectDirectorStageReadToken(result.stage),
            readToken: projectDirectorStageReceiptReadToken(result.stage),
          }
        : { error: result.error };
    }

    case "capture_director_stage": {
      const definition = context.directorStageGeneratorDefinition;
      if (!definition) return generatorSurfaceNotInstalled();
      const read = readLocalDirectorStageGenerator(client.doc, definition, cmd.stageId);
      if (!read.ok) return generatorProductError(read.error);
      const current = read.stage;
      const guard = validateHostProjectDirectorStageRead({
        cmd,
        operation: "Director Stage capture",
        currentVersion: projectDirectorStageReadToken(current),
      });
      if (!guard.ok) return guardError(guard);
      if (!Array.isArray(cmd.frames) || cmd.frames.length === 0) return { code: "INVALID_CAPTURE_FRAMES", error: "Director Stage capture requires frames" };
      const action = definition.actions.find((candidate) => candidate.id === definition.projectionSurface!.primaryActionId);
      if (!action) return { code: "INVALID_CAPTURE_PARAMETERS", error: "Director Stage primary action is not installed" };
      let validateParameters: ReturnType<Ajv["compile"]>;
      try {
        validateParameters = new Ajv({ allErrors: true, strict: true }).compile(action.parametersSchema);
      } catch {
        return { code: "INVALID_CAPTURE_PARAMETERS", error: "Director Stage capture parameter schema is invalid" };
      }
      const labels = new Set<string>();
      const normalized: Array<{ label: string; timeSeconds: number; aspectRatio: string; longEdge: number }> = [];
      for (const raw of cmd.frames) {
        const label = typeof raw?.label === "string" ? raw.label.trim() : "";
        const parameters = { label, timeSeconds: raw?.timeSeconds, aspectRatio: raw?.aspectRatio, longEdge: cmd.longEdge };
        if (!label || labels.has(label)) return { code: "INVALID_CAPTURE_FRAMES", error: "Director capture frame labels must be non-blank and unique after normalization" };
        if (!validateParameters(parameters)) return { code: "INVALID_CAPTURE_PARAMETERS", error: `Invalid Director capture frame ${label}: ${validateParameters.errors?.[0]?.message ?? "invalid parameters"}` };
        labels.add(label);
        normalized.push(parameters as typeof normalized[number]);
      }
      const runs = normalized.map((frame) => {
        const key = `${current.id}:${current.revisionId}:${frame.label}:${frame.timeSeconds}:${frame.aspectRatio}:${frame.longEdge}`;
        const actionRunId = `director-capture:${Buffer.from(key).toString("base64url")}`;
        return {
          actionRunId,
          generatorId: current.id,
          generatorRevisionId: current.revisionId,
          actionId: definition.projectionSurface!.primaryActionId,
          parameters: frame,
        };
      });
      return { kind: "director-stage-capture-plan", stageId: current.id, sourceStageRevisionId: current.revisionId, runs };
    }

    case "list": {
      const nodes = client.listNodes(cmd.type ?? undefined);
      return {
        nodes,
        versions: Object.fromEntries(
          nodes.map((node) => [node.id, canvasNodeReceiptReadToken(node)]),
        ),
      };
    }

    case "edges": {
      return listCanvasEdgesWithVersion(client);
    }

    case "batch_delete_plan": {
      return readCanvasBatchDeletePlan(client, cmd.nodeIds);
    }

    case "get": {
      const node = client.readNode(cmd.nodeId);
      if (!node) return { error: `Node not found: ${cmd.nodeId}` };
      const result: Record<string, unknown> = {
        node,
        immutable: isCanvasNodeImmutable({
          nodeId: cmd.nodeId,
          edges: client.canvas.listEdges(),
        }),
        version: canvasNodeReadToken(node),
        readToken: canvasNodeReceiptReadToken(node),
      };
      if (typeof cmd.projectId === "string" && typeof cmd.nodeId === "string") {
        if (node.type === "text") {
          result.textReadToken = textNodeReceiptReadToken({
            projectId: cmd.projectId,
            nodeId: cmd.nodeId,
            content: textContentFromNode({ type: node.type, data: node.data as Record<string, unknown> }),
          });
        }
      }
      return result;
    }

    case "add": {
      const nodeId = crypto.randomUUID().slice(0, 8);
      const requestedNodeType = String(cmd.type);
      const mapping = AGENT_NODE_TYPE_MAP[
        requestedNodeType as keyof typeof AGENT_NODE_TYPE_MAP
      ];
      if (!mapping) return { error: `Unsupported Canvas node type: ${requestedNodeType}` };
      const outputKind = requestedNodeType.endsWith("_gen")
        ? generationOutputType(requestedNodeType)
        : undefined;
      const isGenerationNode = outputKind !== undefined;
      const isProjectAssetNode = requestedNodeType === "image"
        || requestedNodeType === "video"
        || requestedNodeType === "audio";
      const data: Record<string, unknown> = { label: cmd.label };

      if (typeof cmd.parentId === "string") {
        const parent = client.readNode(cmd.parentId);
        if (!parent || parent.type !== "group") {
          return { error: `Parent group not found: ${cmd.parentId}` };
        }
      }
      if (!isGenerationNode && (
        cmd.prompt !== undefined || cmd.modelId !== undefined || cmd.actionId !== undefined
        || cmd.refs !== undefined || cmd.params !== undefined
      )) {
        return { error: `Generation fields are not valid for Canvas node type ${requestedNodeType}` };
      }
      if (!isProjectAssetNode && cmd.assetId !== undefined) {
        return { error: `assetId is only valid when projecting an image, video, or audio Project Asset` };
      }
      if (isProjectAssetNode) {
        const assetId = typeof cmd.assetId === "string" ? cmd.assetId.trim() : "";
        if (!assetId) {
          return {
            code: "PROJECT_ASSET_REQUIRED",
            error: `Canvas node type ${requestedNodeType} requires an existing Project Asset ID`,
          };
        }
        const asset = readProjectAsset(client.doc, assetId);
        if (!asset) {
          return {
            code: "PROJECT_ASSET_NOT_FOUND",
            error: `Project Asset not found: ${assetId}`,
          };
        }
        if (asset.lifecycle.state !== "active") {
          return {
            code: "PROJECT_ASSET_NOT_ACTIVE",
            error: `Project Asset ${assetId} is ${asset.lifecycle.state}, not active`,
          };
        }
        if (asset.kind !== requestedNodeType) {
          return {
            code: "PROJECT_ASSET_KIND_MISMATCH",
            error: `Project Asset ${assetId} has kind ${asset.kind}, expected ${requestedNodeType}`,
          };
        }
        data.assetId = asset.id;
        data.status = "completed";
      }
      if (cmd.actionId !== undefined && cmd.modelId !== undefined) {
        return { error: "Canvas add accepts either actionId or modelId, not both" };
      }

      if (context.actorUserId) {
        data.actorType = cmd.actorClientType === "agent" || typeof cmd.actorAgentId === "string"
          ? "agent"
          : "user";
        data.actorUserId = context.actorUserId;
        if (typeof cmd.actorAgentId === "string") data.actorAgentId = cmd.actorAgentId;
      }

      const promptReferenceIds = typeof cmd.prompt === "string"
        ? extractAssetRefs(parsePromptParts(cmd.prompt)).map((reference) => reference.nodeId)
        : [];
      const references = resolveCanvasReferenceNodeIds(client, [
        ...(Array.isArray(cmd.refs) ? cmd.refs : []),
        ...promptReferenceIds,
      ]);
      if (references.unresolvedReferences.length > 0) {
        return {
          code: "UNRESOLVED_REFERENCE",
          error: `Canvas reference(s) not found: ${references.unresolvedReferences.join(", ")}`,
          unresolvedReferences: references.unresolvedReferences,
        };
      }

      let trustedActionToRegister: Record<string, unknown> | undefined;

      if (isGenerationNode) {
        const prompt = typeof cmd.prompt === "string" ? cmd.prompt : undefined;
        if (prompt !== undefined) {
          data.prompt = prompt;
          data.content = prompt;
        }
        if (typeof cmd.actionId === "string" && cmd.actionId.trim()) {
          const actionId = cmd.actionId.trim();
          const installedDefinition = client.canvas.getCustomAction(actionId) as Record<string, unknown> | null;
          const trustedDefinition = context.trustedCustomActions?.find(
            (candidate) => candidate.id === actionId,
          );
          const definition = trustedDefinition ?? installedDefinition ?? null;
          if (!definition) {
            return { code: "UNKNOWN_CUSTOM_ACTION", error: `Custom action not installed: ${actionId}` };
          }
          if (trustedDefinition) trustedActionToRegister = trustedDefinition;
          data.actionType = `custom:${actionId}`;
          data.customActionId = actionId;
          data.customActionParams = hostModelParams(
            context.effectiveModelCards ?? MODEL_CARDS,
            undefined,
            cmd.params,
          );
          data.outputType = definition?.outputType === "image" || definition?.outputType === "video"
            || definition?.outputType === "audio" || definition?.outputType === "text"
            || definition?.outputType === "model"
            ? definition.outputType
            : generationOutputType(requestedNodeType);
          const pluginBinding = ExecutablePluginBindingSchema.safeParse(definition?.pluginBinding);
          if (pluginBinding.success) data.pluginBinding = pluginBinding.data;
        } else {
          const modelCards = context.effectiveModelCards ?? MODEL_CARDS;
          const requestedModelId = typeof cmd.modelId === "string" ? cmd.modelId.trim() : "";
          const normalizedModelId = normalizeModelId(requestedModelId) ?? requestedModelId;
          const modelCard = requestedModelId
            ? modelCards.find((candidate) => candidate.id === normalizedModelId)
            : pickDefaultModel({ outputKind: outputKind!, cards: modelCards });
          if (!modelCard) {
            return {
              code: "MODEL_NOT_AVAILABLE",
              error: requestedModelId
                ? `Model is not available in the local host catalog: ${requestedModelId}`
                : `No default ${outputKind} model is available in the local host catalog`,
            };
          }
          if ("actionType" in mapping) data.actionType = mapping.actionType;
          data.modelId = modelCard.id;
          data.modelParams = hostModelParams(modelCards, modelCard.id, cmd.params);
        }
      } else {
        if (typeof cmd.content === "string") data.content = cmd.content;
      }

      if (isGenerationNode && references.refNodeIds.length > 0) {
        data.referenceImageOrder = references.refNodeIds;
      }

      if (trustedActionToRegister) {
        client.doc.getMap("customActions").set(String(trustedActionToRegister.id), trustedActionToRegister);
        client.doc.commit({ origin: "local-api:add-trusted-custom-action" });
      }

      let result: {
        node_id: string | null;
        error: string | null;
        proposal: Record<string, unknown> | null;
        asset_id: string | null;
      };
      if (references.refNodeIds.length > 0) {
        const [firstSourceId, ...remainingSourceIds] = references.refNodeIds;
        client.canvas.createLinkedNode({
          nodeId,
          nodeType: mapping.rfType,
          data,
          parentId: cmd.parentId ?? null,
          sourceNodeId: firstSourceId,
          edgeId: `ref-${firstSourceId}-${nodeId}`,
          edgeType: "reference",
        });
        for (const sourceId of remainingSourceIds) {
          client.canvas.insertEdge(`ref-${sourceId}-${nodeId}`, sourceId, nodeId, "reference");
        }
        result = { node_id: nodeId, error: null, proposal: null, asset_id: null };
      } else {
        result = client.createNode(
          nodeId,
          requestedNodeType,
          data,
          null,
          cmd.parentId ?? null,
        );
      }
      if (result.error || !result.node_id) return result;
      const node = client.readNode(result.node_id);
      const version = node ? canvasNodeReadToken(node) : undefined;
      const readToken = node ? canvasNodeReceiptReadToken(node) : undefined;
      return {
        ...result,
        node,
        refNodeIds: isGenerationNode ? references.refNodeIds : [],
        ...(version ? { version } : {}),
        ...(readToken ? { readToken } : {}),
      };
    }

    case "update": {
      const updates: Record<string, unknown> = { ...(cmd.data ?? {}) };
      const guard = validateCanvasUpdateDataFields(Object.keys(updates));
      if (!guard.ok) return { error: guard.error };
      if (typeof cmd.label === "string") updates.label = cmd.label;
      if (typeof cmd.content === "string") updates.content = cmd.content;
      if (Object.keys(updates).length === 0) {
        return { error: "Provide at least one field to update (--label, --content, --asset-id, --data k=v)" };
      }
      const node = client.readNode(cmd.nodeId);
      if (!node) return { error: `Node not found: ${cmd.nodeId}` };
      if (node.type === "plugin-view") {
        const unsupported = Object.keys(updates).filter(
          (field) => field !== "label" && field !== "state",
        );
        if (unsupported.length > 0) {
          return {
            error: `Plugin View updates accept only label and structured state; got ${unsupported.join(", ")}`,
          };
        }
        if (Object.prototype.hasOwnProperty.call(updates, "state")) {
          const state = StoryboardViewStateSchema.safeParse(updates.state);
          if (!state.success) {
            return { code: "INVALID_VIEW_STATE", error: state.error.message };
          }
          updates.state = state.data;
        }
      } else if (Object.prototype.hasOwnProperty.call(updates, "state")) {
        return { error: "Structured View state can only be applied to a plugin-view node" };
      }
      const currentReadToken = canvasNodeReadToken(node);
      const observedVersion = typeof cmd.observedVersion === "string" ? cmd.observedVersion : undefined;
      const readProof = typeof cmd.ifMatch === "string"
        ? validateCanvasReadProof({
            operation: "update",
            actorClientType: cmd.actorClientType,
            node,
            expectedReadToken: cmd.ifMatch,
            requireReceipt: true,
            readReceiptVerifier: verifyHostCanvasReadReceipt,
          })
        : validateAgentObservation({
            actorClientType: cmd.actorClientType,
            operation: "canvas update",
            observedVersion,
            currentVersion: currentReadToken,
          });
      const hostMutation = validateHostMutationEnvelope({
        operation: "canvas_update",
        entity: { kind: "canvas-node", id: cmd.nodeId },
        expectedHash: observedVersion,
        currentHash: observedVersion ? currentReadToken : undefined,
        expectedReadToken: typeof cmd.ifMatch === "string" ? cmd.ifMatch : undefined,
        currentReadToken: typeof cmd.ifMatch === "string" ? currentReadToken : undefined,
        guard: readProof,
      });
      if (!hostMutation.ok) return { error: hostMutation.error, mutation: hostMutation.mutation };
      const edges = client.canvas.listEdges();
      if (isCanvasNodeImmutable({ nodeId: cmd.nodeId, edges })) {
        const error = "IMMUTABLE_NODE";
        return {
          code: error,
          error,
          entity: { kind: "canvas-node", id: cmd.nodeId },
          mutation: hostMutationRejected(hostMutation.envelope, error),
        };
      }
      if (typeof updates.content === "string") {
        const contentGuard = validateCanvasContentPatch({
          nodeId: cmd.nodeId,
          node: { type: node.type },
          nodes: client.listNodes(),
          edges,
          hasContentPatch: true,
        });
        if (!contentGuard.ok) return { error: contentGuard.error, mutation: hostMutationRejected(hostMutation.envelope, contentGuard.error) };
      }
      const mediaGuard = validateCanvasMediaAssetPatch({
        nodeId: cmd.nodeId,
        node: { type: node.type, data: node.data as Record<string, unknown> },
        edges,
        hasAssetIdPatch: Object.prototype.hasOwnProperty.call(updates, "assetId"),
        nextAssetId: updates.assetId,
      });
      if (!mediaGuard.ok) return { error: mediaGuard.error, mutation: hostMutationRejected(hostMutation.envelope, mediaGuard.error) };
      const checkpointGuard = validateCanvasCheckpointPatch({
        nodeId: cmd.nodeId,
        node: { type: node.type, data: node.data as Record<string, unknown> },
        nodes: client.listNodes(),
        edges,
        fields: Object.keys(updates),
      });
      if (!checkpointGuard.ok) return { error: checkpointGuard.error, mutation: hostMutationRejected(hostMutation.envelope, checkpointGuard.error) };
      try {
        if (!updateLocalCanvasGeneratorNode(client.doc, cmd.nodeId, node.canvas_id, updates, context.canvasGeneratorDefinitions, context.actionCards)) {
          const ok = client.updateNode(cmd.nodeId, updates);
          if (!ok) return { error: `Node not found: ${cmd.nodeId}` };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: message, mutation: hostMutationRejected(hostMutation.envelope, message) };
      }
      const updatedNode = client.readNode(cmd.nodeId);
      const version = updatedNode ? canvasNodeReadToken(updatedNode) : undefined;
      const afterReadToken = updatedNode ? canvasNodeReceiptReadToken(updatedNode) : undefined;
      return {
        updated: true,
        nodeId: cmd.nodeId,
        ...(version ? { version } : {}),
        ...(afterReadToken ? { readToken: afterReadToken } : {}),
        mutation: hostMutationSucceeded(hostMutation.envelope, {
          resultEntityId: cmd.nodeId,
          afterHash: observedVersion ? version : undefined,
          afterReadToken,
        }),
      };
    }

    case "move": {
      const x = Number(cmd.position?.x);
      const y = Number(cmd.position?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { error: "Canvas move requires finite x and y coordinates" };
      }
      const node = client.readNode(cmd.nodeId);
      if (!node) return { error: `Node not found: ${cmd.nodeId}` };
      const currentReadToken = canvasNodeReadToken(node);
      const observedVersion = typeof cmd.observedVersion === "string" ? cmd.observedVersion : undefined;
      const readProof = typeof cmd.ifMatch === "string"
        ? validateCanvasReadProof({
            operation: "update",
            actorClientType: cmd.actorClientType,
            node,
            expectedReadToken: cmd.ifMatch,
            requireReceipt: true,
            readReceiptVerifier: verifyHostCanvasReadReceipt,
          })
        : validateAgentObservation({
            actorClientType: cmd.actorClientType,
            operation: "canvas move",
            observedVersion,
            currentVersion: currentReadToken,
          });
      const hostMutation = validateHostMutationEnvelope({
        operation: "canvas_move",
        entity: { kind: "canvas-node", id: cmd.nodeId },
        expectedHash: observedVersion,
        currentHash: observedVersion ? currentReadToken : undefined,
        expectedReadToken: typeof cmd.ifMatch === "string" ? cmd.ifMatch : undefined,
        currentReadToken: typeof cmd.ifMatch === "string" ? currentReadToken : undefined,
        guard: readProof,
      });
      if (!hostMutation.ok) return { error: hostMutation.error, mutation: hostMutation.mutation };
      if (isCanvasNodeImmutable({ nodeId: cmd.nodeId, edges: client.canvas.listEdges() })) {
        const error = "IMMUTABLE_NODE";
        return { code: error, error, entity: { kind: "canvas-node", id: cmd.nodeId },
          mutation: hostMutationRejected(hostMutation.envelope, error) };
      }
      const moved = client.canvas.moveNode(cmd.nodeId, { x, y });
      if (!moved) {
        const error = `Node not found: ${cmd.nodeId}`;
        return { error, mutation: hostMutationRejected(hostMutation.envelope, error) };
      }
      const updatedNode = client.readNode(cmd.nodeId);
      const version = updatedNode ? canvasNodeReadToken(updatedNode) : undefined;
      const afterReadToken = updatedNode ? canvasNodeReceiptReadToken(updatedNode) : undefined;
      return {
        moved: true,
        nodeId: cmd.nodeId,
        position: { x, y },
        ...(version ? { version } : {}),
        ...(afterReadToken ? { readToken: afterReadToken } : {}),
        mutation: hostMutationSucceeded(hostMutation.envelope, {
          resultEntityId: cmd.nodeId,
          afterHash: observedVersion ? version : undefined,
          afterReadToken,
        }),
      };
    }

    case "copy_node": {
      const node = client.readNode(cmd.nodeId);
      if (!node) return { error: `Node not found: ${cmd.nodeId}` };
      const currentReadToken = canvasNodeReadToken(node);
      const observedVersion = typeof cmd.observedVersion === "string" ? cmd.observedVersion : undefined;
      const readProof = typeof cmd.ifMatch === "string"
        ? validateCanvasReadProof({
            operation: "update",
            actorClientType: cmd.actorClientType,
            node,
            expectedReadToken: cmd.ifMatch,
            requireReceipt: true,
            readReceiptVerifier: verifyHostCanvasReadReceipt,
          })
        : validateAgentObservation({
            actorClientType: cmd.actorClientType,
            operation: "canvas copy",
            observedVersion,
            currentVersion: currentReadToken,
          });
      const hostMutation = validateHostMutationEnvelope({
        operation: "canvas_copy_node",
        entity: { kind: "canvas-node", id: cmd.nodeId },
        expectedHash: observedVersion,
        currentHash: observedVersion ? currentReadToken : undefined,
        expectedReadToken: typeof cmd.ifMatch === "string" ? cmd.ifMatch : undefined,
        currentReadToken: typeof cmd.ifMatch === "string" ? currentReadToken : undefined,
        guard: readProof,
      });
      if (!hostMutation.ok) return { error: hostMutation.error, mutation: hostMutation.mutation };

      const newNodeId = typeof cmd.newNodeId === "string" && cmd.newNodeId.trim()
        ? cmd.newNodeId.trim()
        : crypto.randomUUID().slice(0, 8);
      const data: Record<string, unknown> = {
        ...(node.data as Record<string, unknown>),
        copyOnWrite: true,
        sourceNodeId: cmd.nodeId,
      };
      for (const runtimeField of ["error", "hasRun", "pendingTask", "pendingTaskAt", "progress", "status", "taskId"]) {
        delete data[runtimeField];
      }

      try {
        const placement = {
          nodeId: newNodeId, nodeType: node.type, data,
          parentId: node.parent_id ?? null, sourceNodeId: cmd.nodeId,
          edgeId: `${cmd.nodeId}-${newNodeId}`, edgeType: "copy-on-write",
        };
        if (node.type === "action-badge" && typeof node.data.generatorId === "string") {
          // Copy the immutable authored revision, never its projected fields or
          // Generator pointer. The new draft and placement publish together.
          commitProjectMutation(client.doc, (draft) => {
            const source = readProjectGenerator(draft, node.data.generatorId as string);
            const revision = source && readGeneratorRevision(draft, { generatorId: source.id, generatorRevisionId: source.headRevisionId });
            if (!revision) throw new Error("Source Generator is unavailable. Read again.");
            const generatorId = crypto.randomUUID();
            const generatorRevisionId = crypto.randomUUID();
            const created = createProjectGenerator(draft, {
              head: { id: generatorId, headRevisionId: generatorRevisionId },
              revision: { id: generatorRevisionId, generatorId,
                definitionRef: revision.definitionRef, state: revision.state,
                persistentInputRefs: revision.persistentInputRefs,
                forkedFrom: { generatorId: revision.generatorId, generatorRevisionId: revision.id },
              },
            });
            if (!created.ok) throw new Error(created.error.message);
            if (draft.getMap("nodes").get(newNodeId) !== undefined) throw new Error(`Node already exists: ${newNodeId}`);
            new Canvas(draft, () => {}, node.canvas_id).createLinkedNode({
              ...placement, data: { ...canvasModelPlacementData(data), generatorId },
            });
            projectLocalModelCopy(draft, node.canvas_id, cmd.nodeId, newNodeId, {
              ...revision, generatorId, id: generatorRevisionId,
              forkedFrom: { generatorId: revision.generatorId, generatorRevisionId: revision.id },
            });
            return { ok: true };
          });
        } else {
          if (client.doc.getMap("nodes").get(newNodeId) !== undefined) throw new Error(`Node already exists: ${newNodeId}`);
          client.canvas.createLinkedNode(placement);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: message, mutation: hostMutationRejected(hostMutation.envelope, message) };
      }

      const copiedNode = client.readNode(newNodeId);
      if (!copiedNode) {
        const error = `Copied node not found after creation: ${newNodeId}`;
        return { error, mutation: hostMutationRejected(hostMutation.envelope, error) };
      }
      const version = canvasNodeReadToken(copiedNode);
      const afterReadToken = canvasNodeReceiptReadToken(copiedNode);
      return {
        copied: true,
        copyOnWrite: true,
        sourceNodeId: cmd.nodeId,
        newNodeId,
        nodeId: newNodeId,
        node: copiedNode,
        immutable: false,
        lineageEdge: { source: cmd.nodeId, target: newNodeId, type: "copy-on-write" },
        version,
        readToken: afterReadToken,
        mutation: hostMutationSucceeded(hostMutation.envelope, {
          resultEntityId: newNodeId,
          afterHash: observedVersion ? version : undefined,
          afterReadToken,
        }),
      };
    }

    case "text_cas_update": {
      const node = client.readNode(cmd.nodeId);
      if (!node) return { error: `Node not found: ${cmd.nodeId}` };
      if (typeof cmd.content !== "string") {
        return { error: "text_cas_update requires string content" };
      }
      const currentContent = textContentFromNode({
        type: node.type,
        data: node.data as Record<string, unknown>,
      });
      const beforeHash = textHash(currentContent);
      const beforeReadToken = textReadToken({
        projectId: cmd.projectId,
        nodeId: cmd.nodeId,
        contentHash: beforeHash,
      });
      const expectedReadToken = typeof cmd.ifMatch === "string"
        ? cmd.ifMatch
        : typeof cmd.observedVersion === "string"
          ? cmd.observedVersion
          : undefined;
      const readProof = validateAgentReadProof({
        actorClientType: cmd.actorClientType,
        operation: "text apply",
        currentReadToken: beforeReadToken,
        expectedReadToken,
        requireReceipt: true,
        readReceiptVerifier: verifyHostTextReadReceipt,
        readCommandHint: "Run `clash text pull --json` first, then retry.",
      });
      const hostMutation = validateHostMutationEnvelope({
        operation: "text_cas_update",
        entity: { kind: "text", id: cmd.nodeId },
        currentHash: beforeHash,
        expectedReadToken,
        currentReadToken: beforeReadToken,
        guard: readProof,
      });
      if (!hostMutation.ok) return { error: hostMutation.error, mutation: hostMutation.mutation };
      if (isCanvasNodeImmutable({ nodeId: cmd.nodeId, edges: client.canvas.listEdges() })) {
        const error = "IMMUTABLE_NODE";
        return {
          code: error,
          error,
          entity: { kind: "text", id: cmd.nodeId },
          mutation: hostMutationRejected(hostMutation.envelope, error),
        };
      }
      const ok = client.updateNode(cmd.nodeId, { content: cmd.content });
      if (!ok) return { error: `Node not found: ${cmd.nodeId}` };
      const afterHash = textHash(cmd.content);
      const afterReadToken = textNodeReceiptReadToken({
        projectId: cmd.projectId,
        nodeId: cmd.nodeId,
        content: cmd.content,
      });
      const textRevision = typeof cmd.cwd === "string" && typeof cmd.filePath === "string"
        ? createTextAppliedRevision({
            projectId: cmd.projectId,
            nodeId: cmd.nodeId,
            cwd: cmd.cwd,
            filePath: cmd.filePath,
            content: cmd.content,
            parentRevisionId: typeof cmd.parentRevisionId === "string" ? cmd.parentRevisionId : undefined,
            actor: readTextRevisionActor(cmd.actor),
          })
        : undefined;
      return {
        updated: true,
        nodeId: cmd.nodeId,
        textRevision,
        version: textReadToken({
          projectId: cmd.projectId,
          nodeId: cmd.nodeId,
          content: cmd.content,
        }),
        readToken: afterReadToken,
        mutation: hostMutationSucceeded(hostMutation.envelope, {
          resultEntityId: cmd.nodeId,
          afterHash,
          afterReadToken,
        }),
      };
    }

    case "text_cow_replace": {
      const node = client.readNode(cmd.nodeId);
      if (!node) return { error: `Node not found: ${cmd.nodeId}` };
      if (node.type !== "text") return { error: `Node ${cmd.nodeId} has type "${node.type}", expected "text"` };
      if (typeof cmd.content !== "string") {
        return { error: "text_cow_replace requires string content" };
      }
      const currentContent = textContentFromNode({
        type: node.type,
        data: node.data as Record<string, unknown>,
      });
      const beforeHash = textHash(currentContent);
      const beforeReadToken = textReadToken({
        projectId: cmd.projectId,
        nodeId: cmd.nodeId,
        contentHash: beforeHash,
      });
      const expectedReadToken = typeof cmd.ifMatch === "string"
        ? cmd.ifMatch
        : typeof cmd.observedVersion === "string"
          ? cmd.observedVersion
          : undefined;
      const readProof = validateAgentReadProof({
        actorClientType: cmd.actorClientType,
        operation: "text replace",
        currentReadToken: beforeReadToken,
        expectedReadToken,
        requireReceipt: true,
        readReceiptVerifier: verifyHostTextReadReceipt,
        readCommandHint: "Run `clash text pull --json` first, then retry.",
      });
      const hostMutation = validateHostMutationEnvelope({
        operation: "text_cow_replace",
        entity: { kind: "text", id: cmd.nodeId },
        currentHash: beforeHash,
        expectedReadToken,
        currentReadToken: beforeReadToken,
        guard: readProof,
      });
      if (!hostMutation.ok) return { error: hostMutation.error, mutation: hostMutation.mutation };
      const newNodeId = typeof cmd.newNodeId === "string" && cmd.newNodeId.length > 0
        ? cmd.newNodeId
        : crypto.randomUUID().slice(0, 8);
      const textRevision = typeof cmd.cwd === "string" && typeof cmd.filePath === "string"
        ? createTextAppliedRevision({
            projectId: cmd.projectId,
            nodeId: newNodeId,
            cwd: cmd.cwd,
            filePath: cmd.filePath,
            content: cmd.content,
            parentRevisionId: typeof cmd.parentRevisionId === "string" ? cmd.parentRevisionId : undefined,
            actor: readTextRevisionActor(cmd.actor),
          })
        : undefined;
      const data = createTextCowNodeData({
        sourceNodeId: cmd.nodeId,
        sourceLabel: typeof node.data?.label === "string" ? node.data.label : undefined,
        sourceContent: currentContent,
        content: cmd.content,
        label: typeof cmd.label === "string" ? cmd.label : undefined,
        filePath: typeof cmd.filePath === "string" ? cmd.filePath : undefined,
        textRevision,
      });
      try {
        client.canvas.createLinkedNode({
          nodeId: newNodeId,
          nodeType: "text",
          data,
          parentId: node.parent_id ?? null,
          sourceNodeId: cmd.nodeId,
          edgeId: `${cmd.nodeId}-${newNodeId}`,
          edgeType: "copy-on-write",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: message, mutation: hostMutationRejected(hostMutation.envelope, message) };
      }
      const afterHash = textHash(cmd.content);
      const afterReadToken = textNodeReceiptReadToken({
        projectId: cmd.projectId,
        nodeId: newNodeId,
        content: cmd.content,
      });
      return {
        replaced: true,
        copyOnWrite: true,
        sourceNodeId: cmd.nodeId,
        newNodeId,
        nodeId: newNodeId,
        sourceContentHash: beforeHash,
        contentHash: afterHash,
        textRevision,
        lineageEdge: { source: cmd.nodeId, target: newNodeId, type: "copy-on-write" },
        version: textReadToken({
          projectId: cmd.projectId,
          nodeId: newNodeId,
          content: cmd.content,
        }),
        readToken: afterReadToken,
        mutation: hostMutationSucceeded(hostMutation.envelope, {
          resultEntityId: newNodeId,
          afterHash,
          afterReadToken,
        }),
      };
    }

    case "delete": {
      const node = client.readNode(cmd.nodeId);
      if (!node) return { error: `Node not found: ${cmd.nodeId}` };
      const currentReadToken = canvasNodeReadToken(node);
      const observedVersion = typeof cmd.observedVersion === "string" ? cmd.observedVersion : undefined;
      const readProof = typeof cmd.ifMatch === "string"
        ? validateCanvasReadProof({
            operation: "delete",
            actorClientType: cmd.actorClientType,
            node,
            expectedReadToken: cmd.ifMatch,
            requireReceipt: true,
            readReceiptVerifier: verifyHostCanvasReadReceipt,
          })
        : validateAgentObservation({
            actorClientType: cmd.actorClientType,
            operation: "canvas delete",
            observedVersion,
            currentVersion: currentReadToken,
          });
      const hostMutation = validateHostMutationEnvelope({
        operation: "canvas_delete",
        entity: { kind: "canvas-node", id: cmd.nodeId },
        expectedHash: observedVersion,
        currentHash: observedVersion ? currentReadToken : undefined,
        expectedReadToken: typeof cmd.ifMatch === "string" ? cmd.ifMatch : undefined,
        currentReadToken: typeof cmd.ifMatch === "string" ? currentReadToken : undefined,
        guard: readProof,
      });
      if (!hostMutation.ok) return { error: hostMutation.error, mutation: hostMutation.mutation };
      const edges = client.canvas.listEdges();
      const deleteGuard = validateCanvasDelete({
        nodeId: cmd.nodeId,
        edges,
      });
      if (!deleteGuard.ok) return { error: deleteGuard.error, mutation: hostMutationRejected(hostMutation.envelope, deleteGuard.error) };
      const ok = client.deleteNode(cmd.nodeId);
      if (!ok) return { error: `Node not found: ${cmd.nodeId}` };
      return {
        deleted: true,
        nodeId: cmd.nodeId,
        mutation: hostMutationSucceeded(hostMutation.envelope, {
          resultEntityId: cmd.nodeId,
        }),
      };
    }

    case "delete_batch": {
      const plan = readCanvasBatchDeletePlan(client, cmd.nodeIds);
      if ("error" in plan) return { error: plan.error };
      const batchId = plan.nodeIds.join(",");
      const currentReadToken = canvasBatchDeleteReadToken({
        nodes: plan.nodes,
        edges: plan.edges,
      });
      const observedVersion = typeof cmd.observedVersion === "string" ? cmd.observedVersion : undefined;
      const readProof = typeof cmd.ifMatch === "string"
        ? validateCanvasBatchDeleteReadProof({
            actorClientType: cmd.actorClientType,
            nodes: plan.nodes,
            edges: plan.edges,
            expectedReadToken: cmd.ifMatch,
            requireReceipt: true,
            readReceiptVerifier: verifyHostCanvasBatchDeleteReadReceipt,
          })
        : validateAgentObservation({
            actorClientType: cmd.actorClientType,
            operation: "canvas batch delete",
            observedVersion,
            currentVersion: currentReadToken,
          });
      const hostMutation = validateHostMutationEnvelope({
        operation: "canvas_batch_delete",
        entity: { kind: "canvas-node-batch", id: batchId },
        expectedHash: observedVersion,
        currentHash: observedVersion ? currentReadToken : undefined,
        expectedReadToken: typeof cmd.ifMatch === "string" ? cmd.ifMatch : undefined,
        currentReadToken: typeof cmd.ifMatch === "string" ? currentReadToken : undefined,
        guard: readProof,
      });
      if (!hostMutation.ok) return { error: hostMutation.error, mutation: hostMutation.mutation };
      const guardrailEdges = canvasGuardrailEdgesFromReadProof(plan.edges);
      const deleteGuard = validateCanvasBatchDelete({
        nodeIds: plan.nodeIds,
        edges: guardrailEdges,
      });
      if (!deleteGuard.ok) return { error: deleteGuard.error, mutation: hostMutationRejected(hostMutation.envelope, deleteGuard.error) };
      const result = client.deleteNodes(plan.nodeIds);
      if (result.deletedNodeIds.length === 0) return { error: `Node(s) not found: ${plan.nodeIds.join(", ")}` };
      return {
        deleted: true,
        nodeIds: plan.nodeIds,
        deletedNodeIds: result.deletedNodeIds,
        deletedEdgeIds: result.deletedEdgeIds,
        mutation: hostMutationSucceeded(hostMutation.envelope, {
          resultEntityId: batchId,
        }),
      };
    }

    case "asset_cow_replace": {
      const node = client.readNode(cmd.nodeId);
      if (!node) return { error: `Node not found: ${cmd.nodeId}` };
      if (!isMediaNodeType(node.type)) {
        return { error: `Node ${cmd.nodeId} has type "${node.type}", expected image, video, or audio` };
      }
      if (typeof cmd.assetId !== "string" || cmd.assetId.trim().length === 0) {
        return { error: "asset_cow_replace requires assetId" };
      }
      const currentReadToken = canvasNodeReadToken(node);
      const observedVersion = typeof cmd.observedVersion === "string" ? cmd.observedVersion : undefined;
      const readProof = typeof cmd.ifMatch === "string"
        ? validateCanvasReadProof({
            operation: "update",
            actorClientType: cmd.actorClientType,
            node,
            expectedReadToken: cmd.ifMatch,
            requireReceipt: true,
            readReceiptVerifier: verifyHostCanvasReadReceipt,
          })
        : validateAgentObservation({
            actorClientType: cmd.actorClientType,
            operation: "canvas copy",
            observedVersion,
            currentVersion: currentReadToken,
          });
      const hostMutation = validateHostMutationEnvelope({
        operation: "asset_cow_replace",
        entity: { kind: "media-node", id: cmd.nodeId },
        expectedHash: observedVersion,
        currentHash: observedVersion ? currentReadToken : undefined,
        expectedReadToken: typeof cmd.ifMatch === "string" ? cmd.ifMatch : undefined,
        currentReadToken: typeof cmd.ifMatch === "string" ? currentReadToken : undefined,
        guard: readProof,
      });
      if (!hostMutation.ok) return { error: hostMutation.error, mutation: hostMutation.mutation };
      if (!isCanvasNodeImmutable({
        nodeId: cmd.nodeId,
        edges: client.canvas.listEdges(),
      })) {
        const code = "NODE_NOT_IMMUTABLE";
        const error = "Copy-on-write replacement is only valid for an immutable media node with downstream references; add an independent Project Asset to the Canvas instead";
        return {
          code,
          error,
          mutation: hostMutationRejected(hostMutation.envelope, error),
        };
      }
      const newNodeId = typeof cmd.newNodeId === "string" && cmd.newNodeId.length > 0
        ? cmd.newNodeId
        : crypto.randomUUID().slice(0, 8);
      const sourceAssetId = typeof node.data?.assetId === "string" ? node.data.assetId : undefined;
      const data = createMediaAssetCowNodeData({
        sourceNodeId: cmd.nodeId,
        sourceLabel: typeof node.data?.label === "string" ? node.data.label : undefined,
        sourceAssetId,
        assetId: cmd.assetId.trim(),
        label: typeof cmd.label === "string" ? cmd.label : undefined,
      });
      try {
        const placement = {
          nodeId: newNodeId, nodeType: node.type, data,
          parentId: node.parent_id ?? null, sourceNodeId: cmd.nodeId,
          edgeId: `${cmd.nodeId}-${newNodeId}`, edgeType: "copy-on-write",
        };
        if (node.type === "action-badge" && typeof node.data.generatorId === "string") {
          // Copy the immutable authored revision, never its projected fields or
          // Generator pointer. The new draft and placement publish together.
          commitProjectMutation(client.doc, (draft) => {
            const source = readProjectGenerator(draft, node.data.generatorId as string);
            const revision = source && readGeneratorRevision(draft, { generatorId: source.id, generatorRevisionId: source.headRevisionId });
            if (!revision) throw new Error("Source Generator is unavailable. Read again.");
            const generatorId = crypto.randomUUID();
            const generatorRevisionId = crypto.randomUUID();
            const created = createProjectGenerator(draft, {
              head: { id: generatorId, headRevisionId: generatorRevisionId },
              revision: { id: generatorRevisionId, generatorId,
                definitionRef: revision.definitionRef, state: revision.state,
                persistentInputRefs: revision.persistentInputRefs,
                forkedFrom: { generatorId: revision.generatorId, generatorRevisionId: revision.id },
              },
            });
            if (!created.ok) throw new Error(created.error.message);
            if (draft.getMap("nodes").get(newNodeId) !== undefined) throw new Error(`Node already exists: ${newNodeId}`);
            new Canvas(draft, () => {}, node.canvas_id).createLinkedNode({
              ...placement, data: { ...canvasModelPlacementData(data), generatorId },
            });
            return { ok: true };
          });
        } else {
          if (client.doc.getMap("nodes").get(newNodeId) !== undefined) throw new Error(`Node already exists: ${newNodeId}`);
          client.canvas.createLinkedNode(placement);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: message, mutation: hostMutationRejected(hostMutation.envelope, message) };
      }
      const newNode = client.readNode(newNodeId);
      const version = newNode ? canvasNodeReadToken(newNode) : undefined;
      const afterReadToken = newNode ? canvasNodeReceiptReadToken(newNode) : undefined;
      return {
        replaced: true,
        copyOnWrite: true,
        sourceNodeId: cmd.nodeId,
        newNodeId,
        nodeId: newNodeId,
        sourceAssetId,
        assetId: cmd.assetId.trim(),
        lineageEdge: { source: cmd.nodeId, target: newNodeId, type: "copy-on-write" },
        ...(version ? { version } : {}),
        ...(afterReadToken ? { readToken: afterReadToken } : {}),
        mutation: hostMutationSucceeded(hostMutation.envelope, {
          resultEntityId: newNodeId,
          afterHash: observedVersion ? version : undefined,
          afterReadToken,
        }),
      };
    }

    case "search": {
      const types = cmd.types ?? null;
      const nodes = client.searchNodes(cmd.query, types);
      return { nodes };
    }

    case "execute": {
      const node = client.readNode(cmd.nodeId);
      if (!node) return { error: `Node not found: ${cmd.nodeId}` };
      const currentReadToken = canvasNodeReadToken(node);
      const guard = typeof cmd.ifMatch === "string"
        ? validateCanvasReadProof({
            operation: "update",
            actorClientType: cmd.actorClientType,
            node,
            expectedReadToken: cmd.ifMatch,
            requireReceipt: true,
            readReceiptVerifier: verifyHostCanvasReadReceipt,
          })
        : validateAgentObservation({
            actorClientType: cmd.actorClientType,
            operation: "canvas execute",
            observedVersion: typeof cmd.observedVersion === "string" ? cmd.observedVersion : undefined,
            currentVersion: currentReadToken,
          });
      if (!guard.ok) return guardError(guard);
      const nodeData = node.data as Record<string, unknown>;
      const customActionId =
        typeof nodeData.customActionId === "string"
          ? nodeData.customActionId
          : typeof nodeData.actionType === "string" &&
              nodeData.actionType.startsWith("custom:")
            ? nodeData.actionType.slice("custom:".length)
            : undefined;
      let globalCustomAction:
        | ReturnType<typeof CustomActionDefinitionSchema.parse>
        | undefined;
      if (customActionId && typeof nodeData.generatorId === "string") {
        const trusted = CustomActionDefinitionSchema.safeParse(context.trustedCustomActions?.find(candidate => candidate.id === customActionId));
        if (!trusted.success || !trusted.data.generator) return { code: "UNKNOWN_CUSTOM_ACTION", error: `Native Action Card is unavailable: ${customActionId}` };
        // Canvas validates this explicit Host contract against the pinned Revision.
        // Its replica customActions map is not executable authority.
        globalCustomAction = trusted.data;
      } else if (customActionId && !client.canvas.getCustomAction(customActionId)) {
        const trusted = CustomActionDefinitionSchema.safeParse(
          context.trustedCustomActions?.find(
            (candidate) => candidate.id === customActionId,
          ),
        );
        const nodeBinding = ExecutablePluginBindingSchema.safeParse(
          nodeData.pluginBinding,
        );
        const trustedBinding = trusted.success
          ? ExecutablePluginBindingSchema.safeParse(
              trusted.data.pluginBinding,
            )
          : null;
        const exactBinding =
          nodeBinding.success &&
          trustedBinding?.success &&
          nodeBinding.data.pluginId === trustedBinding.data.pluginId &&
          nodeBinding.data.version === trustedBinding.data.version &&
          nodeBinding.data.exportId === trustedBinding.data.exportId &&
          nodeBinding.data.schemaHash === trustedBinding.data.schemaHash;
        if (!trusted.success || !exactBinding) {
          return {
            code: "UNKNOWN_CUSTOM_ACTION",
            error: `Custom action not installed: ${customActionId}`,
          };
        }
        globalCustomAction = trusted.data;
      }
      const r = client.canvas.execute(
        cmd.nodeId,
        context.generationId ?? (() => crypto.randomUUID().slice(0, 8)),
        undefined,
        globalCustomAction,
      );
      if (r.error) return { error: r.error };
      // Echo `kind` so the CLI can pick the right log line. Both
      // pipelines also fill `childNodeId` so the agent can poll the
      // resulting asset/render node for status.
      return { executed: true, kind: r.kind, childNodeId: r.childNodeId, childNodeType: r.childNodeType };
    }

    case "ensure_edge": {
      // Add a default edge from source → target IF no edge between that
      // exact pair already exists. Idempotent so callers don't have to
      // track which edges they've already wired. Used by `clash canvas
      // timeline push` to reflect timeline items' sourceNodeId
      // references as visible canvas edges. Goes through client.canvas
      // so the LoroSyncClient's subscribeLocalUpdates loop broadcasts
      // the change to the project room.
      const source: string = cmd.source;
      const target: string = cmd.target;
      for (const e of client.canvas.listEdges()) {
        if (e.source === source && e.target === target) return { existed: true };
      }
      const guard = validateCanvasEdgeAdd({
        edge: { source, target },
        nodes: client.listNodes(),
        edges: client.canvas.listEdges(),
      });
      if (!guard.ok) return { error: guard.error };
      const edgeId = `e-${source}-${target}-${crypto.randomUUID().slice(0, 4)}`;
      client.canvas.insertEdge(edgeId, source, target, "default");
      return { existed: false, edgeId };
    }

    case "ping": {
      return { pong: true };
    }

    default:
      return { error: `Unknown action: ${action}` };
  }
}

function readTextRevisionActor(value: unknown): TextRevisionActor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const actor = value as Partial<TextRevisionActor>;
  if (
    (actor.actorType !== "user" && actor.actorType !== "agent") ||
    typeof actor.actorUserId !== "string"
  ) {
    return undefined;
  }
  return {
    actorType: actor.actorType,
    actorUserId: actor.actorUserId,
    ...(typeof actor.actorAgentId === "string" ? { actorAgentId: actor.actorAgentId } : {}),
  };
}
