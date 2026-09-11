import { z } from "zod";

const id = z.string().trim().min(1);
const actorClientType = z.enum(["browser", "cli", "mcp", "agent"]).optional();
const observed = {
  actorClientType,
  observedVersion: id.optional(),
  ifMatch: id.optional(),
};
const position = z.object({ x: z.number().finite(), y: z.number().finite() });
const primitiveParameter = z.union([z.string(), z.number().finite(), z.boolean()]);
const command = <T extends string>(action: T, shape: z.ZodRawShape = {}) =>
  z.object({ action: z.literal(action), ...shape }).passthrough();
const addCommand = z.object({
  action: z.literal("add"),
  canvasId: id.optional(),
  type: z.enum([
    "text",
    "group",
    "remotion",
    "image",
    "video",
    "audio",
    "image_gen",
    "video_gen",
    "audio_gen",
    "text_gen",
    "model_gen",
  ]),
  label: id,
  content: z.string().optional(),
  prompt: z.string().optional(),
  parentId: id.optional(),
  modelId: id.optional(),
  actionId: id.optional(),
  assetId: id.optional(),
  refs: z.array(id).optional(),
  params: z.record(id, primitiveParameter).optional(),
  actorClientType,
  actorAgentId: id.optional(),
}).strict();

export const ProjectHostCommandSchema = z.discriminatedUnion("action", [
  command("list_canvases"),
  command("create_canvas", { canvasId: id, name: id }),
  command("rename_canvas", { canvasId: id, name: id, ...observed }),
  command("delete_canvas", { canvasId: id, ...observed }),
  command("list_timelines"),
  command("validate_timeline", { document: z.unknown() }),
  command("list_timeline_renders", {
    status: z.enum(["completed", "all"]).optional(),
  }),
  command("create_timeline", {
    timelineId: id,
    name: id,
    state: z.unknown().optional(),
    placement: z.object({ canvasId: id, actionNodeId: id, position: position.optional() }).optional(),
  }),
  command("delete_timeline", { timelineId: id, ...observed }),
  command("update_timeline_state", {
    timelineId: id,
    state: z.unknown(),
    ...observed,
  }),
  command("attach_timeline", {
    timelineId: id,
    canvasId: id,
    actionNodeId: id.optional(),
    position: position.optional(),
    ...observed,
  }),
  command("detach_timeline", { timelineId: id, ...observed }),
  command("copy_timeline_action", {
    sourceTimelineId: id,
    targetCanvasId: id,
    newTimelineId: id.optional(),
    newActionNodeId: id.optional(),
    position: position.optional(),
    ...observed,
  }),
  command("request_timeline_render", {
    timelineId: id,
    actorAgentId: id.optional(),
    ...observed,
  }),
  command("list_director_stages"),
  command("create_director_stage", {
    stageId: id,
    name: id,
    state: z.unknown().optional(),
  }),
  command("update_director_stage_state", {
    stageId: id,
    state: z.unknown(),
    ...observed,
  }),
  command("attach_director_stage", {
    stageId: id,
    canvasId: id,
    actionNodeId: id.optional(),
    position: position.optional(),
    ...observed,
  }),
  command("detach_director_stage", { stageId: id, ...observed }),
  command("capture_director_stage", {
    stageId: id,
    frames: z.array(z.object({
      label: id,
      timeSeconds: z.number().finite().nonnegative(),
      aspectRatio: z.enum(["16:9", "9:16", "4:3", "3:4", "1:1"]),
    }).strict()).min(1).max(12),
    longEdge: z.number().int().min(256).max(4096),
    ...observed,
  }),
  command("list", { canvasId: id.optional(), type: id.optional() }),
  command("edges", { canvasId: id.optional() }),
  command("batch_delete_plan", {
    canvasId: id.optional(),
    nodeIds: z.array(id).min(1),
  }),
  command("get", { canvasId: id.optional(), nodeId: id }),
  addCommand,
  command("update", {
    canvasId: id.optional(),
    nodeId: id,
    label: z.string().optional(),
    content: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    ...observed,
  }),
  command("move", {
    canvasId: id.optional(),
    nodeId: id,
    position,
    ...observed,
  }),
  command("copy_node", {
    canvasId: id.optional(),
    nodeId: id,
    newNodeId: id.optional(),
    ...observed,
  }),
  command("text_cas_update", {
    canvasId: id.optional(),
    projectId: id.optional(),
    nodeId: id,
    content: z.string(),
    cwd: id.optional(),
    filePath: id.optional(),
    parentRevisionId: id.optional(),
    actor: z.unknown().optional(),
    ...observed,
  }),
  command("text_cow_replace", {
    canvasId: id.optional(),
    projectId: id.optional(),
    nodeId: id,
    content: z.string(),
    cwd: id.optional(),
    filePath: id.optional(),
    parentRevisionId: id.optional(),
    label: z.string().optional(),
    newNodeId: id.optional(),
    actor: z.unknown().optional(),
    ...observed,
  }),
  command("delete", { canvasId: id.optional(), nodeId: id, ...observed }),
  command("delete_batch", {
    canvasId: id.optional(),
    nodeIds: z.array(id).min(1),
    ...observed,
  }),
  command("asset_cow_replace", {
    canvasId: id.optional(),
    nodeId: id,
    assetId: id,
    newNodeId: id.optional(),
    label: z.string().optional(),
    ...observed,
  }),
  command("search", {
    canvasId: id.optional(),
    query: z.string(),
    types: z.array(id).nullable().optional(),
  }),
  command("execute", {
    canvasId: id.optional(),
    nodeId: id,
    providerAccountId: id.optional(),
    ...observed,
  }),
  command("ensure_edge", { canvasId: id.optional(), source: id, target: id }),
  command("ping"),
]);

export type ProjectHostCommand = z.infer<typeof ProjectHostCommandSchema>;
