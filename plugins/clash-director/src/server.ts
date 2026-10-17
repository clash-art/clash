import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  ClashMcpServer,
  describeClashTool,
  parseClashRecoveryError,
  type ClashStaleRecovery,
} from "@clash/shared-mcp";
import {
  DirectorStageCameraSchema,
  DirectorStageObjectSchema,
  DirectorStageAuthoringStateSchema,
  directorStageJsonSchema,
} from "@clash/shared-types";
import {
  createDirectorAdapter,
  directorWorkspaceCwd,
  type DirectorAdapter,
} from "./adapter.js";
import {
  DIRECTOR_PLUGIN_TOOL_NAMES,
  type DirectorPluginToolName,
  type DirectorToolInput,
} from "./contract.js";
import {
  createDirectorAppHtml,
  DIRECTOR_APP_MIME_TYPE,
  DIRECTOR_APP_RESOURCE_URI,
} from "./app.js";

export { DIRECTOR_PLUGIN_TOOL_NAMES } from "./contract.js";

const scope = {
  cwd: z.string().min(1).optional().describe("Absolute workspace path containing .clash/project.toml"),
  projectId: z.string().min(1).optional().describe("Optional Project ID override"),
};
const stageScope = { ...scope, stageId: z.string().min(1) };
const record = z.record(z.string(), z.unknown());

function compactAuthoritativeSchema(
  schema: z.ZodType,
  contract: "state" | "object" | "camera",
): z.ZodType<Record<string, unknown>> {
  const label = `Director Stage ${contract}`;
  return z.object({}).catchall(z.unknown()).superRefine((value, context) => {
    const parsed = schema.safeParse(value);
    if (parsed.success) return;
    const issue = parsed.error.issues[0];
    context.addIssue({
      code: "custom",
      path: issue?.path ?? [],
      message: issue?.message ?? `Invalid ${label}`,
    });
  }).describe(
    `${label} complete object. Call clash_director_schema with contract=${contract} for the authoritative JSON Schema.`,
  );
}

const directorState = compactAuthoritativeSchema(
  DirectorStageAuthoringStateSchema,
  "state",
);
const directorObject = compactAuthoritativeSchema(DirectorStageObjectSchema, "object");
const directorCamera = compactAuthoritativeSchema(DirectorStageCameraSchema, "camera");
const directorKeyframe = z.object({
  durationSeconds: z.number().finite().positive(),
  fps: z.number().int().positive(),
  trackId: z.string().min(1),
  targetId: z.string().min(1),
  property: z.enum([
    "position",
    "rotation",
    "scale",
    "fov",
    "focalLengthMm",
    "focusDistanceM",
    "fStop",
  ]),
  id: z.string().min(1),
  time: z.number().finite().nonnegative(),
  value: z.union([
    z.number().finite(),
    z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  ]),
  interpolation: z.enum(["hold", "linear", "bezier"]).optional(),
});

const definitions: Record<DirectorPluginToolName, {
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations?: Record<string, boolean>;
}> = {
  clash_director_open: {
    title: "Open Clash Director",
    description: describeClashTool({
      useWhen: "the user needs the interactive Director Stage surface",
      effect: "opens the selected Stage without mutating it",
      returns: "the workspace, available Stages, and selected Stage",
      next: "inspect or edit the selected Stage in the app",
    }),
    inputSchema: { ...scope, stageId: z.string().min(1).optional() },
    annotations: { readOnlyHint: true },
  },
  clash_director_schema: {
    title: "Read Director Stage Schema",
    description: describeClashTool({
      useWhen: "a complete state, object, or camera contract is needed before authoring",
      effect: "reads the authoritative Director contract without touching project state",
      returns: "the requested JSON Schema and contract version",
      next: "author against that schema, then use the most specific mutation tool",
    }),
    inputSchema: { contract: z.enum(["state", "object", "camera"]).default("state") },
    annotations: { readOnlyHint: true },
  },
  clash_director_list: {
    title: "List Director Stages",
    description: describeClashTool({
      useWhen: "the target Stage id is unknown or ownership must be inspected",
      effect: "reads the Project's Director Stage index",
      returns: "Stage entities with ids, ownership, revisions, and state",
      next: "select one Stage and read it before changing it",
    }),
    inputSchema: scope,
    annotations: { readOnlyHint: true },
  },
  clash_director_get: {
    title: "Read Director Stage",
    description: describeClashTool({
      useWhen: "the current full Stage state or revision is needed",
      effect: "reads one persisted Director Stage",
      returns: "the Stage entity and its complete authoritative state",
      next: "plan a focused mutation from the returned revision",
    }),
    inputSchema: stageScope,
    annotations: { readOnlyHint: true },
  },
  clash_director_capture: {
    title: "Capture Director frames",
    description: describeClashTool({
      useWhen: "the editable Stage must be proven with exact-time product-rendered PNG evidence",
      effect: "uses the daemon-owned DirectorViewport WebGL renderer and verifies the persisted Stage revision before and after capture",
      returns: "absolute PNG paths, hashes, active cameras, immutable Project Asset identities, the renderer identity, and a durable capture receipt",
      next: "reuse the returned Project Asset identities in downstream Timeline items; capture does not mutate the Stage, so do not write its Action output back into Stage shots, re-import the PNGs, or substitute screenshots",
    }),
    inputSchema: {
      ...stageScope,
      times: z.array(z.number().finite().nonnegative()).min(1).max(12),
      labels: z.array(z.string().min(1)).min(1).max(12).optional(),
      outputDir: z.string().min(1).optional(),
      aspectRatio: z.enum(["16:9", "9:16", "4:3", "3:4", "1:1"]).optional(),
      longEdge: z.number().int().min(256).max(4096).default(1920),
    },
  },
  clash_director_create: {
    title: "Create Director Stage",
    description: describeClashTool({
      useWhen: "the Project needs a new standalone Director Stage",
      effect: "creates an empty persisted Stage with the requested id and name",
      returns: "the created Stage and revision metadata",
      next: "read it, then establish scene, subjects, and cameras",
    }),
    inputSchema: { ...stageScope, name: z.string().min(1) },
  },
  clash_director_save: {
    title: "Save Director Stage",
    description: describeClashTool({
      useWhen: "a complete Stage state must be atomically replaced",
      effect: "authoritatively validates and applies the full persisted projection",
      returns: "apply status and the resulting revision metadata",
      next: "read the Stage back and review the persisted result; on stale recovery, merge the preserved edit into the automatically pulled latest projection and retry",
    }),
    inputSchema: {
      ...stageScope,
      baseRevisionId: z.string().min(1).describe("Revision returned by clash_director_get"),
      state: directorState,
    },
  },
  clash_director_attach: {
    title: "Attach Director Stage",
    description: describeClashTool({
      useWhen: "a standalone Stage should become owned by a Canvas Action",
      effect: "attaches the Stage to the specified Canvas and Action node",
      returns: "the updated ownership result",
      next: "read the Stage and Canvas owner back",
    }),
    inputSchema: { ...stageScope, canvasId: z.string().min(1), nodeId: z.string().min(1).optional() },
  },
  clash_director_detach: {
    title: "Detach Director Stage",
    description: describeClashTool({
      useWhen: "a Canvas-owned Stage should return to Project ownership",
      effect: "detaches the Stage from its Canvas Action",
      returns: "the updated standalone Stage",
      next: "read the Stage to verify ownership",
    }),
    inputSchema: stageScope,
  },
  clash_director_object_add: {
    title: "Add 3D object",
    description: describeClashTool({
      useWhen: "a complete new subject, prop, set element, vehicle, light, crowd, or model is ready",
      effect: "validates the full object and adds it to the persisted Stage state",
      returns: "the Stage apply result",
      next: "read back blocking, silhouette, visibility, and relationships",
    }),
    inputSchema: { ...stageScope, object: directorObject },
  },
  clash_director_object_update: {
    title: "Update 3D object",
    description: describeClashTool({
      useWhen: "an existing object's blocking or supported properties need refinement",
      effect: "applies the patch through the authoritative full-state command model",
      returns: "the Stage apply result",
      next: "read back the object and judge staging continuity",
    }),
    inputSchema: { ...stageScope, objectId: z.string().min(1), patch: record },
  },
  clash_director_object_remove: {
    title: "Remove 3D object",
    description: describeClashTool({
      useWhen: "an existing object and its dependent references should be removed",
      effect: "removes the object and safely reconciles targets, attachments, and animation",
      returns: "the Stage apply result",
      next: "read back the Stage for broken composition or coverage",
    }),
    inputSchema: { ...stageScope, objectId: z.string().min(1) },
  },
  clash_director_object_group: {
    title: "Group 3D objects",
    description: describeClashTool({
      useWhen: "several existing objects should share a logical Stage group",
      effect: "assigns the requested group id to every selected object",
      returns: "the Stage apply result",
      next: "read back membership and spatial hierarchy",
    }),
    inputSchema: { ...stageScope, groupId: z.string().min(1), objectIds: z.array(z.string().min(1)).min(1) },
  },
  clash_director_object_ungroup: {
    title: "Ungroup 3D objects",
    description: describeClashTool({
      useWhen: "a Stage group should be dissolved",
      effect: "removes that group assignment from its member objects",
      returns: "the Stage apply result",
      next: "read back the affected objects",
    }),
    inputSchema: { ...stageScope, groupId: z.string().min(1) },
  },
  clash_director_camera_add: {
    title: "Add camera",
    description: describeClashTool({
      useWhen: "a motivated new coverage angle is fully specified",
      effect: "validates and adds the complete camera to the Stage",
      returns: "the Stage apply result",
      next: "read back framing, eyelines, targets, and lens choices",
    }),
    inputSchema: { ...stageScope, camera: directorCamera },
  },
  clash_director_camera_update: {
    title: "Update camera",
    description: describeClashTool({
      useWhen: "an existing camera's pose, lens, or target needs refinement",
      effect: "applies the camera patch through the authoritative full-state command model",
      returns: "the Stage apply result",
      next: "read back the shot's framing and continuity",
    }),
    inputSchema: { ...stageScope, cameraId: z.string().min(1), patch: record },
  },
  clash_director_camera_remove: {
    title: "Remove camera",
    description: describeClashTool({
      useWhen: "an unused camera should be removed from coverage",
      effect: "removes the camera if no captured or sequenced shot depends on it",
      returns: "the Stage apply result or a dependency error",
      next: "resolve any returned dependency, or read back coverage",
    }),
    inputSchema: { ...stageScope, cameraId: z.string().min(1) },
  },
  clash_director_scene_update: {
    title: "Update 3D scene",
    description: describeClashTool({
      useWhen: "the Stage environment, calibration, or grid needs refinement",
      effect: "merges the scene patch into the authoritative full Stage state",
      returns: "the Stage apply result",
      next: "read back environment scale, horizon, and subject grounding",
    }),
    inputSchema: { ...stageScope, scene: record },
  },
  clash_director_keyframe_upsert: {
    title: "Upsert keyframe",
    description: describeClashTool({
      useWhen: "an object or camera property needs a timed pose",
      effect: "inserts or replaces one validated keyframe and orders its track",
      returns: "the Stage apply result",
      next: "read back timing and judge anticipation, action, and settle",
    }),
    inputSchema: { ...stageScope, keyframe: directorKeyframe },
  },
  clash_director_keyframe_remove: {
    title: "Remove keyframe",
    description: describeClashTool({
      useWhen: "a timed pose should be removed from an animation track",
      effect: "removes the keyframe and prunes the track when it becomes empty",
      returns: "the Stage apply result",
      next: "read back motion timing and continuity",
    }),
    inputSchema: { ...stageScope, keyframe: record },
  },
  clash_director_action_upsert: {
    title: "Upsert action clip",
    description: describeClashTool({
      useWhen: "a character or rigged model needs a timed action performance",
      effect: "validates and inserts or replaces the action clip on the full Stage state",
      returns: "the Stage apply result",
      next: "read back performance timing, overlap, and story-beat alignment",
    }),
    inputSchema: { ...stageScope, action: record },
  },
  clash_director_action_remove: {
    title: "Remove action clip",
    description: describeClashTool({
      useWhen: "a timed character action should be removed",
      effect: "removes the requested action clip from the Stage animation",
      returns: "the Stage apply result",
      next: "read back the performance and repair any resulting gap",
    }),
    inputSchema: { ...stageScope, actionId: z.string().min(1) },
  },
};

function structured(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { items: value };
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return { value };
}

async function invoke(
  name: DirectorPluginToolName,
  input: DirectorToolInput,
  adapter: DirectorAdapter,
): Promise<unknown> {
  switch (name) {
    case "clash_director_schema": {
      const contract = input.contract ?? "state";
      return {
        schemaVersion: 1,
        contract,
        source: "@clash/shared-types",
        jsonSchema: directorStageJsonSchema(contract),
      };
    }
    case "clash_director_open": {
      const stages = await adapter.list(input);
      const selected = input.stageId
        ? stages.find((stage) => stage.id === input.stageId)
        : stages[0];
      if (input.stageId && !selected) throw new Error(`Director Stage ${input.stageId} not found`);
      return { cwd: directorWorkspaceCwd(input), stages, selected };
    }
    case "clash_director_list": return adapter.list(input);
    case "clash_director_get": return { stage: await adapter.get(input) };
    case "clash_director_capture": return adapter.capture(input);
    case "clash_director_create": return adapter.create(input);
    case "clash_director_save": return adapter.save(input);
    case "clash_director_attach": return adapter.attach(input);
    case "clash_director_detach": return adapter.detach(input);
    default: return adapter.mutate(name, input);
  }
}

function summary(name: DirectorPluginToolName, value: unknown): string {
  if (name === "clash_director_schema") {
    return `Returned the authoritative Director ${(value as { contract?: string }).contract ?? "state"} schema.`;
  }
  if (name === "clash_director_open") {
    const count = Array.isArray((value as { stages?: unknown[] })?.stages)
      ? (value as { stages: unknown[] }).stages.length
      : 0;
    return `Opened Clash Director with ${count} Stage${count === 1 ? "" : "s"}.`;
  }
  if (name === "clash_director_save") return "Director Stage projection validated and applied.";
  if (name === "clash_director_capture") return "Captured exact-time PNGs through the Director product renderer with Stage revision readback.";
  return JSON.stringify(value);
}

export type DirectorToolErrorPayload = {
  code: string;
  message: string;
  recovery?: ClashStaleRecovery;
};

export function directorToolErrorPayload(error: unknown): DirectorToolErrorPayload {
  const parsed = parseClashRecoveryError(error instanceof Error ? error.message : String(error));
  const code = parsed.message.match(/^([A-Z][A-Z0-9_]+):/)?.[1]
    ?? (/not found/i.test(parsed.message) ? "DIRECTOR_STAGE_NOT_FOUND" : "DIRECTOR_OPERATION_FAILED");
  return {
    code,
    message: parsed.message,
    ...(parsed.recovery ? { recovery: parsed.recovery } : {}),
  };
}

export function registerDirectorPluginMcp(
  server: Pick<McpServer, "registerTool" | "registerResource">,
  adapter: DirectorAdapter,
  bundledAppJavascript: string,
  options: { appSurfaces?: boolean } = {},
): void {
  const appSurfaces = options.appSurfaces ?? false;
  for (const name of DIRECTOR_PLUGIN_TOOL_NAMES) {
    if (!appSurfaces && name === "clash_director_open") continue;
    const definition = definitions[name];
    registerAppTool(server, name, {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: definition.annotations,
      _meta: {
        ui: {
          ...(name === "clash_director_open"
            ? { resourceUri: DIRECTOR_APP_RESOURCE_URI }
            : {}),
          visibility: ["model", "app"],
        },
      },
    }, async (input) => {
      try {
        const value = await invoke(name, input as DirectorToolInput, adapter);
        return {
          content: [{ type: "text" as const, text: summary(name, value) }],
          structuredContent: structured(value),
        };
      } catch (error) {
        const structuredError = directorToolErrorPayload(error);
        return {
          content: [{ type: "text" as const, text: structuredError.message }],
          structuredContent: { error: structuredError },
          isError: true,
        };
      }
    });
  }

  if (appSurfaces) registerAppResource(server, "Clash Director", DIRECTOR_APP_RESOURCE_URI, {
    description: "Interactive Director Stage editor backed by Clash read-proof and projection apply behavior",
  }, async () => ({
    contents: [{
      uri: DIRECTOR_APP_RESOURCE_URI,
      mimeType: DIRECTOR_APP_MIME_TYPE,
      text: createDirectorAppHtml(bundledAppJavascript),
      _meta: { ui: { csp: {} } },
    }],
  }));
}

export function createDirectorPluginServer(options: {
  adapter?: DirectorAdapter;
  bundledAppJavascript?: string;
} = {}): McpServer {
  const server = new ClashMcpServer({ name: "clash-director", version: "0.1.0" });
  const javascript = options.bundledAppJavascript ?? readFileSync(new URL("./app-client.js", import.meta.url), "utf8");
  registerDirectorPluginMcp(server, options.adapter ?? createDirectorAdapter(), javascript);
  return server;
}

export async function serveDirectorPluginStdio(options: { adapter?: DirectorAdapter } = {}): Promise<void> {
  await createDirectorPluginServer(options).connect(new StdioServerTransport());
}
