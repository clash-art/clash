import { z } from "zod/v3";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import {
  createActionClient,
  type ActionInvocation,
} from "@clash/shared-runtime/action-client";
import {
  createAssetEvidenceClient,
  type RecordMediaOperationInput,
  type RecordMediaObservationInput,
} from "@clash/shared-runtime/asset-evidence-client";
import { createAssetSearchClient } from "@clash/shared-runtime/asset-search-client";
import { agentDocumentRequest } from "@clash/shared-runtime/document-client";
import { resolveProjectHostContext } from "@clash/shared-runtime/project-host-client";
import type { GeneratorRequest } from "@clash/shared-runtime/generator-client";
import type { ClashMcpServer } from "./server.js";
import { describeClashTool } from "./tool-guidance.js";
import { registerContentTools } from "./content-tools.js";

/** Task-oriented operations share the exact orchestration used by the CLI. */
export function registerActionTools(
  server: ClashMcpServer,
  options: { request: GeneratorRequest },
): void {
  registerContentTools(server, options);
  const actions = createActionClient(options.request);
  const evidence = createAssetEvidenceClient(agentDocumentRequest(options.request));
  const search = createAssetSearchClient(options.request);
  const scope = {
    projectId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  };
  const waitMs = z.number().min(0).max(60_000).optional();
  const register = (
    name: string,
    title: string,
    useWhen: string,
    effect: string,
    readOnly: boolean,
    schema: Record<string, unknown>,
    call: (project: string, args: Record<string, unknown>) => Promise<unknown>,
  ) => {
    server.registerTool(
      name,
      {
        title,
        description: describeClashTool({
          useWhen,
          effect,
          returns:
            "usable output references, evidence or a resumable Run with its actual status",
          next: "use returned references directly; continue an unfinished Run with action_wait instead of resubmitting",
        }),
        inputSchema: { ...scope, ...schema } as ZodRawShapeCompat,
        annotations: { readOnlyHint: readOnly, destructiveHint: false },
      },
      async (args) => {
        const input = args as Record<string, unknown>;
        const context = await resolveProjectHostContext({
          cwd: input.cwd as string | undefined,
          projectId: input.projectId as string | undefined,
        });
        const value = await call(context.projectId, input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredContent: { result: value },
        };
      },
    );
  };
  register(
    "clash_generators_actions_list",
    "Find project Actions",
    "a crop, rotation, trim, frame, analysis or project custom operation is needed",
    "lists the installed Actions available to this project with their actual input and parameter contracts",
    true,
    { query: z.string().optional() },
    (project, args) =>
      actions.list(project, { query: args.query as string | undefined }),
  );
  register(
    "clash_generators_action_invoke",
    "Run a project Action",
    "an installed Action should process media without manually creating Generator or Run objects",
    "freezes source references and parameters, creates a visible native operation, submits it, and waits up to waitMs; model Actions may incur provider charges",
    false,
    {
      action: z.string().min(1),
      assetId: z.string().min(1).optional(),
      inputs: z.record(z.unknown()).optional(),
      parameters: z.record(z.unknown()).optional(),
      state: z.record(z.unknown()).optional(),
      requestId: z.string().min(1).optional(),
      canvasId: z.string().min(1).optional(),
      label: z.string().optional(),
      providerAccountId: z.string().optional().describe(
        "Provider account for direct model execution; media analysis uses Settings routing and rejects this override",
      ),
      waitMs,
    },
    (project, args) =>
      actions.invoke(project, args as unknown as ActionInvocation),
  );
  register(
    "clash_generators_action_wait",
    "Wait for an existing Action",
    "previous work is pending, running or has an uncertain response",
    "reads the same Run and resolves committed outputs without invoking it again",
    true,
    { actionRunId: z.string().min(1), waitMs },
    (project, args) =>
      actions.wait(project, args.actionRunId as string, {
        waitMs: args.waitMs as number | undefined,
      }),
  );
  register(
    "clash_assets_search",
    "Search media evidence",
    "media should be found by content rather than filename",
    "searches exact attached analysis revisions in this project and returns matching text and available source times",
    true,
    { query: z.string().optional(), assetId: z.string().optional() },
    (project, args) =>
      search.search(project, {
        query: args.query as string | undefined,
        assetId: args.assetId as string | undefined,
      }),
  );
  register(
    "clash_assets_record_operation",
    "Record external media work",
    "one-off external processing has already produced imported output Assets",
    "records immutable source/output relationships and inert command detail; never executes the command or claims a native processing Run",
    false,
    {
      title: z.string().min(1),
      detail: z.string().min(1),
      sources: z.array(z.string().min(1)).min(1),
      outputs: z.array(z.string().min(1)).min(1),
      recordId: z.string().optional(),
    },
    (project, args) =>
      evidence.recordTrace(
        project,
        args as unknown as RecordMediaOperationInput,
      ),
  );
  register(
    "clash_assets_record_observation",
    "Attach external media analysis",
    "external analysis or an agent observation should be retained with its source Asset",
    "stores actor-attributed observations through the Document authority and attaches the exact revision to the source Asset",
    false,
    {
      assetId: z.string().min(1),
      body: z.object({
        summary: z.string().min(1),
        tool: z.string().optional(),
        model: z.string().optional(),
        observations: z
          .array(
            z.object({
              text: z.string().min(1),
              startMs: z.number().int().nonnegative().optional(),
              endMs: z.number().int().positive().optional(),
            }),
          )
          .optional(),
      }),
      recordId: z.string().optional(),
    },
    (project, args) =>
      evidence.recordObservation(
        project,
        args as unknown as RecordMediaObservationInput,
      ),
  );
}
