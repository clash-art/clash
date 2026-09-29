export {
  TIMELINE_PLUGIN_SURFACE_BINDINGS,
  TIMELINE_PLUGIN_TOOL_NAMES,
} from "./timeline-contract-adapter.js";
export type {
  TimelinePluginSurfaceToolName as TimelinePluginToolName,
} from "./timeline-contract-adapter.js";
import type {
  TimelinePluginSurfaceToolName as TimelinePluginToolName,
} from "./timeline-contract-adapter.js";

export type TimelineEntity = {
  id: string;
  name: string;
  revisionId?: string;
  owner?: {
    kind?: string;
    canvasId?: string;
    actionNodeId?: string;
  };
  state: unknown;
};

export type TimelineToolInput = {
  cwd?: string;
  projectId?: string;
  standalone?: boolean;
  full?: boolean;
  id?: string;
  timelineId?: string;
  sourceTimelineId?: string;
  baseRevisionId?: string;
  name?: string;
  canvasId?: string;
  targetCanvasId?: string;
  nodeId?: string;
  actionNodeId?: string;
  newTimelineId?: string;
  newNodeId?: string;
  newActionNodeId?: string;
  position?: { x: number; y: number };
  wait?: boolean;
  timeoutMs?: number;
  document?: string | Record<string, unknown>;
  format?: "yaml" | "json" | "object";
  view?: "authoring" | "full";
  state?: Record<string, unknown>;
};

function required(input: TimelineToolInput, key: keyof TimelineToolInput): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${String(key)} is required`);
  }
  return value.trim();
}

function appendProject(args: string[], input: TimelineToolInput): void {
  if (input.projectId?.trim()) args.push("--project", input.projectId.trim());
  args.push("--json");
}

function appendPosition(args: string[], input: TimelineToolInput): void {
  if (!input.position) return;
  args.push("--x", String(input.position.x), "--y", String(input.position.y));
}

export function buildTimelineCliArgs(
  name: string,
  input: TimelineToolInput,
): string[] {
  const args = ["timeline"];
  switch (name) {
    case "clash_timeline_schema":
      return [
        "timeline",
        "schema",
        "--view",
        input.view ?? "authoring",
        "--json",
      ];
    case "clash_timeline_list":
      args.push("list");
      if (input.standalone) args.push("--standalone");
      if (input.full) args.push("--full");
      break;
    case "clash_timeline_create":
      args.push(
        "create",
        "--id",
        required(input, "timelineId"),
        "--name",
        required(input, "name"),
      );
      break;
    case "clash_timeline_attach":
      args.push(
        "attach",
        "--timeline",
        required(input, "timelineId"),
        "--canvas",
        required(input, "canvasId"),
      );
      if (input.nodeId?.trim()) args.push("--node", input.nodeId.trim());
      appendPosition(args, input);
      break;
    case "clash_timeline_detach":
      args.push("detach", "--timeline", required(input, "timelineId"));
      break;
    case "clash_timeline_copy":
      args.push(
        "copy",
        "--timeline",
        required(input, "timelineId"),
        "--canvas",
        required(input, "canvasId"),
      );
      if (input.newTimelineId?.trim()) {
        args.push("--new-timeline", input.newTimelineId.trim());
      }
      if (input.newNodeId?.trim()) args.push("--new-node", input.newNodeId.trim());
      appendPosition(args, input);
      break;
    case "clash_timeline_render":
      args.push("render", "--timeline", required(input, "timelineId"));
      if (input.wait === false) args.push("--no-wait");
      if (input.timeoutMs !== undefined) {
        args.push("--timeout-ms", String(input.timeoutMs));
      }
      break;
    default:
      throw new Error(`Timeline operation ${name} is not exposed`);
  }
  appendProject(args, input);
  return args;
}
