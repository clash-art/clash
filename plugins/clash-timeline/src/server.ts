import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import {
  ClashMcpServer,
  describeClashTool,
  parseClashRecoveryError,
  type ClashStaleRecovery,
  type ClashToolGuidance,
} from "@clash/shared-mcp";
import { createTimelineAdapter, type TimelineAdapter } from "./adapter.js";
import {
  TIMELINE_PLUGIN_SURFACE_BINDINGS,
  TIMELINE_PLUGIN_TOOL_NAMES,
  type TimelinePluginToolName,
  type TimelineToolInput,
} from "./contract.js";
import {
  createTimelineAppHtml,
  TIMELINE_APP_MIME_TYPE,
  TIMELINE_APP_RESOURCE_URI,
} from "./app.js";
import { timelineOperationMetadata } from "./timeline-contract-adapter.js";
import { timelineMcpExecutor } from "./timeline-mcp-executors.js";

const TIMELINE_TOOL_GUIDANCE = {
  "timeline.open": {
    useWhen:
      "a human needs the interactive Timeline surface for review or manual adjustment",
    effect:
      "opens the Timeline app with the selected or first Timeline without mutating product state",
    returns:
      "the resolved workspace, available Timelines, and current selection",
    next: "review the selection, then use the specific read or mutation capability that matches the intended change",
  },
  "timeline.schema": {
    useWhen:
      "authoring a Timeline document or recovering from a Timeline DSL validation error",
    effect:
      "reads compact authoring discovery by default, or the complete authoritative Timeline DSL contract with view full, without mutating product state",
    returns:
      "schema identity, authored fields, reference semantics, stable rules, and an executable example; full view also includes the machine-readable JSON Schema",
    next: "build a complete state that satisfies the contract, then create or save it; submission validates automatically",
  },
  "timeline.validate": {
    useWhen:
      "diagnosing a complete Timeline draft only when no create or save write is intended",
    effect:
      "runs the same structure and semantic validation as create and save without changing the Timeline",
    returns:
      "validation success or stable issues with paths and rule identifiers",
    next: "if a write is intended, skip this diagnostic and call create or save directly; invalid writes return the same issues without changing product state",
  },
  "timeline.list": {
    useWhen:
      "discovering Timeline identifiers or choosing among existing Timelines",
    effect: "reads Timeline summaries without changing product state",
    returns: "identity, revision, ownership, dimensions and item counts; full true includes complete states",
    next: "read the chosen Timeline before planning or applying an edit",
  },
  "timeline.get": {
    useWhen:
      "editing an existing Timeline or recovering from a stale or read-required response",
    effect:
      "reads the full persisted Timeline and records the observation needed for a safe later write",
    returns:
      "complete state, current revision, ownership, contract identity, and validation results",
    next: "preserve unrelated fields and submit a complete replacement against the returned revision",
  },
  "timeline.create": {
    useWhen:
      "a genuinely new Timeline is required rather than a revision of an existing one",
    effect:
      "automatically validates the optional complete typed state; invalid state leaves Project state unchanged, while valid state creates the Timeline. Track categories must already follow effect, text, visual, primary, audio order; supplied tracks are never automatically sorted",
    returns: "the persisted Timeline entity and its current state",
    next: "use role subtitle only for structured captions whose text items include cues, wordRefs, and sourceToOutputMap; for a plain title, omit role. Read back the new Timeline before making another revision or attaching it to Canvas",
  },
  "timeline.save": {
    useWhen:
      "a complete typed Timeline state is ready after reading the current revision",
    effect:
      "automatically validates; invalid state leaves the Timeline revision unchanged, while valid state atomically replaces the entire Timeline state under baseRevisionId; it never applies a partial patch",
    returns:
      "whether the replacement was applied and the resulting revision identifier",
    next: "read back the persisted Timeline; on a stale response, use the automatically pulled latest projection and structured paths to merge, then resubmit",
  },
  "timeline.attach": {
    useWhen:
      "an existing Timeline should become the editable composition owned by a Canvas action",
    effect:
      "attaches the Timeline to the requested Canvas location and action ownership",
    returns: "the persisted Timeline with its updated ownership",
    next: "read the Timeline and inspect the owning Canvas action before making dependent changes",
  },
  "timeline.detach": {
    useWhen:
      "a Timeline should be made standalone without deleting its editable state",
    effect: "removes the Canvas ownership link while preserving the Timeline",
    returns: "the persisted standalone Timeline",
    next: "read back the Timeline and update any workflow that depended on its former owner",
  },
  "timeline.copy": {
    useWhen:
      "a Canvas needs an independent copy while the source Timeline and its references remain unchanged",
    effect:
      "creates a copy and attaches the new Timeline to the target Canvas location",
    returns:
      "the persisted copy with independent identity, state, revision, and ownership",
    next: "read the copy before editing it and leave source references on the original until explicitly rewired",
  },
  "timeline.render": {
    useWhen:
      "a persisted editable Timeline must become real playable media through the Clash product renderer",
    effect:
      "submits the current persisted Timeline revision to the daemon-owned Remotion renderer, resolving every runtime: remotion item from the latest TSX on its stable Canvas sourceNodeId, and waits by default",
    returns:
      "a render node receipt, source revision, completion status, and immutable Asset readback including its download URL",
    next: "only claim completion when status is completed; link or download the returned Asset for review, and inspect error when failed",
  },
} as const satisfies Record<string, ClashToolGuidance>;

function timelineToolDescription(operationId: string): string {
  const guidance =
    TIMELINE_TOOL_GUIDANCE[operationId as keyof typeof TIMELINE_TOOL_GUIDANCE];
  if (!guidance)
    throw new Error(`Missing Timeline MCP guidance for ${operationId}`);
  return describeClashTool(guidance);
}

function structured(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { items: value };
  if (value && typeof value === "object")
    return value as Record<string, unknown>;
  return { value };
}

export type TimelineToolErrorPayload = {
  code: string;
  message: string;
  retryTool?: TimelinePluginToolName;
  recovery?: ClashStaleRecovery;
  issues?: Array<{
    ruleId: string;
    path: Array<string | number>;
    message: string;
  }>;
};

export function timelineToolErrorPayload(
  error: unknown,
): TimelineToolErrorPayload {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const parsedRecovery = parseClashRecoveryError(rawMessage);
  const message = parsedRecovery.message;
  const explicitCode = message.match(/^([A-Z][A-Z0-9_]+):/)?.[1];
  const code =
    explicitCode ??
    (/baseRevisionId is required|read .* before saving/i.test(message)
      ? "READ_REQUIRED"
      : /not found/i.test(message)
        ? "TIMELINE_NOT_FOUND"
        : /validation|Timeline item|\berror:/i.test(message)
          ? "TIMELINE_DSL_INVALID"
          : "TIMELINE_OPERATION_FAILED");
  const retryTool: TimelinePluginToolName | undefined =
    !parsedRecovery.recovery &&
    (code === "STALE_TIMELINE" ||
      code === "STALE_READ" ||
      code === "READ_REQUIRED")
      ? "clash_timeline_get"
      : code === "TIMELINE_DSL_INVALID"
        ? "clash_timeline_schema"
        : code === "TIMELINE_NOT_FOUND"
          ? "clash_timeline_list"
          : undefined;
  const issues =
    error &&
    typeof error === "object" &&
    Array.isArray((error as { issues?: unknown }).issues)
      ? (error as TimelineToolErrorPayload).issues
      : undefined;
  return {
    code,
    message,
    ...(retryTool ? { retryTool } : {}),
    ...(parsedRecovery.recovery ? { recovery: parsedRecovery.recovery } : {}),
    ...(issues ? { issues } : {}),
  };
}

export function registerTimelinePluginMcp(
  server: Pick<McpServer, "registerTool" | "registerResource">,
  adapter: TimelineAdapter,
  bundledAppJavascript: string,
  options: { appSurfaces?: boolean } = {},
): void {
  const appSurfaces = options.appSurfaces ?? false;
  for (const name of TIMELINE_PLUGIN_TOOL_NAMES) {
    if (!appSurfaces && name === "clash_timeline_open") continue;
    const binding = TIMELINE_PLUGIN_SURFACE_BINDINGS[name];
    const executor = timelineMcpExecutor(binding.operationId);
    const operation = timelineOperationMetadata(name)!;
    registerAppTool(
      server,
      name,
      {
        title: executor.title,
        description: timelineToolDescription(binding.operationId),
        inputSchema: executor.inputSchema,
        outputSchema: executor.outputSchema,
        annotations: { readOnlyHint: operation.readOnly },
        _meta: {
          "clash/timelineOperation": operation,
          ui: {
            ...(name === "clash_timeline_open"
              ? { resourceUri: TIMELINE_APP_RESOURCE_URI }
              : {}),
            visibility: ["model", "app"],
          },
        },
      },
      async (input: unknown) => {
        try {
          const value = await executor.execute(
            input as TimelineToolInput,
            adapter,
          );
          return {
            content: [{ type: "text" as const, text: executor.summary(value) }],
            structuredContent: structured(value),
          };
        } catch (error) {
          const structuredError = timelineToolErrorPayload(error);
          return {
            content: [{ type: "text" as const, text: structuredError.message }],
            structuredContent: { error: structuredError },
            isError: true,
          };
        }
      },
    );
  }

  if (appSurfaces)
    registerAppResource(
      server,
      "Clash Timeline",
      TIMELINE_APP_RESOURCE_URI,
      {
        description:
          "Interactive Timeline editor backed by Clash read-proof and apply behavior",
      },
      async () => ({
        contents: [
          {
            uri: TIMELINE_APP_RESOURCE_URI,
            mimeType: TIMELINE_APP_MIME_TYPE,
            text: createTimelineAppHtml(bundledAppJavascript),
            _meta: { ui: { csp: {} } },
          },
        ],
      }),
    );
}

export function createTimelinePluginServer(
  options: {
    adapter?: TimelineAdapter;
    bundledAppJavascript?: string;
  } = {},
): McpServer {
  const server = new ClashMcpServer({
    name: "clash-timeline",
    version: "0.1.0",
  });
  const bundledAppJavascript =
    options.bundledAppJavascript ??
    readFileSync(new URL("./app-client.js", import.meta.url), "utf8");
  registerTimelinePluginMcp(
    server,
    options.adapter ?? createTimelineAdapter(),
    bundledAppJavascript,
  );
  return server;
}

export async function serveTimelinePluginStdio(
  options: {
    adapter?: TimelineAdapter;
  } = {},
): Promise<void> {
  const server = createTimelinePluginServer(options);
  await server.connect(new StdioServerTransport());
}
