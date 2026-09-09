import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  RegisteredTool,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getParseErrorMessage,
  normalizeObjectSchema,
  safeParseAsync,
  type AnySchema,
  type ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
  ToolExecution,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CLASH_MCP_COMMAND_IDS,
  buildClashMcpCommandMenu,
  classifyClashMcpTool,
  getClashMcpCommand,
  type ClashMcpCommandId,
} from "@clash/shared-runtime";
import { z } from "zod";

import { McpSchemaCompatibilityTransport } from "./compatibility-transport.js";
import { describeClashTool } from "./tool-guidance.js";
import { projectClashMcpWireJsonSchema } from "./wire-schema.js";

export const CLASH_ROOT_TOOL_NAME = "clash";
export const CLASH_PLUGIN_TOOL_NAME = "clash_plugin";
export const CLASH_ASSETS_TOOL_NAME = "clash_assets";
export const CLASH_CANVAS_TOOL_NAME = "clash_canvas";
export const CLASH_GENERATORS_TOOL_NAME = "clash_generators";
export const CLASH_COMPOSITION_TOOL_NAME = "clash_composition";

const MAX_ASSET_CONTRACT_BATCH_SIZE = 8;

export const LEGACY_CLASH_GROUP_TOOL_NAMES = {
  director: "clash_director",
  timeline: "clash_timeline",
} as const;

type LegacyClashGroupCommandId = keyof typeof LEGACY_CLASH_GROUP_TOOL_NAMES;
type ClashCompositionKind = "timeline" | "director-stage";

export const CLASH_MCP_INSTRUCTIONS = [
  "Clash discloses product operations progressively.",
  `Use the root ${CLASH_ROOT_TOOL_NAME} tool for command navigation, ${CLASH_PLUGIN_TOOL_NAME} for executable plugin lifecycle, ${CLASH_ASSETS_TOOL_NAME} for Project and personal Global Assets, ${CLASH_CANVAS_TOOL_NAME} for Canvas nodes, and ${CLASH_COMPOSITION_TOOL_NAME} for Timeline or Director Stage composition.`,
  `${CLASH_GENERATORS_TOOL_NAME} dispatches live registered Project Generators, their Revisions, and their Action Runs.`,
  "Timeline is temporal composition; Director Stage is spatial composition.",
  "Call clash_assets without operation for its lightweight index, then pass contracts for the small set of live Asset contracts needed together; contract remains available for one. Other dispatchers reveal live contracts when operation is omitted.",
  "Composition disclosure and short operations require kind=timeline or kind=director-stage; a complete clash_* leaf name remains accepted for compatibility.",
  "The advertised tool list stays fixed and does not require a tools/list refresh.",
  "Within a selected command, tool descriptions, schemas, structured results, and recovery guidance are the operational source of truth.",
].join(" ");

type RegisteredClashTool = {
  name: string;
  removed: boolean;
  handle: RegisteredTool;
};

type ToolDefinition = Record<string, unknown> & { name: string };

type ClashToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type ClashOperationView = {
  name: string;
  operation: string;
  title: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  recovery: {
    guidance: string;
    retryOperationPath: "structuredContent.error.retryTool";
    staleMergePath: "structuredContent.error.recovery";
  };
  metadata?: Record<string, unknown>;
};

type ClashOperationIndexEntry = Pick<
  ClashOperationView,
  "name" | "operation" | "title" | "readOnly" | "destructive"
>;

function modelVisible(meta: Record<string, unknown> | undefined): boolean {
  const ui = meta?.ui;
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) return true;
  const visibility = (ui as Record<string, unknown>).visibility;
  return !Array.isArray(visibility) || visibility.includes("model");
}

function annotationsOf(handle: RegisteredTool): ToolAnnotations {
  return handle.annotations ?? {};
}

function inputJsonSchemaOf(handle: RegisteredTool): Record<string, unknown> {
  const input = normalizeObjectSchema(handle.inputSchema);
  const jsonSchema = input
    ? toJsonSchemaCompat(input, { strictUnions: true, pipeStrategy: "input" })
    : { type: "object", properties: {} };
  return projectClashMcpWireJsonSchema(jsonSchema) as Record<string, unknown>;
}

function outputJsonSchemaOf(
  handle: RegisteredTool,
): Record<string, unknown> | undefined {
  const output = normalizeObjectSchema(handle.outputSchema);
  if (!output) return undefined;
  return projectClashMcpWireJsonSchema(
    toJsonSchemaCompat(output, {
      strictUnions: true,
      pipeStrategy: "output",
    }),
  ) as Record<string, unknown>;
}

function nextGuidance(description: string | undefined): string {
  return (
    description?.match(/(?:^|\s)Next:\s*(.+)$/u)?.[1]?.trim() ??
    "Inspect structuredContent.error and follow any retryTool or recovery fields before retrying."
  );
}

function clashMetadata(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const entries = Object.entries(meta).filter(([key]) =>
    key.startsWith("clash/"),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** One server implementation shared by every Clash MCP transport and plugin. */
export class ClashMcpServer extends McpServer {
  readonly #registeredClashTools = new Set<RegisteredClashTool>();

  constructor(
    serverInfo: ConstructorParameters<typeof McpServer>[0],
    options: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {},
  ) {
    const additionalInstructions = options.instructions?.trim();
    super(serverInfo, {
      ...options,
      instructions: additionalInstructions
        ? `${CLASH_MCP_INSTRUCTIONS}\n\n${additionalInstructions}`
        : CLASH_MCP_INSTRUCTIONS,
    });

    super.registerTool(
      CLASH_ROOT_TOOL_NAME,
      {
        title: "Clash",
        description: describeClashTool({
          useWhen:
            "you need the compact Clash command menu or the stable dispatcher for a product command",
          effect:
            "returns command counts and navigation without expanding leaf operations into the advertised tool list",
          returns:
            "the command menu and selected Plugin, Assets, Canvas, or composition dispatcher",
          next: "call clash_plugin for executable plugin lifecycle, clash_assets for Project or personal Global Assets, clash_canvas for Canvas, or clash_composition with kind for Timeline or Director Stage; complete leaf execution remains compatibility-only",
        }),
        inputSchema: {
          command: z
            .enum(CLASH_MCP_COMMAND_IDS)
            .optional()
            .describe(
              "Root command to reveal; omit to show the root menu and fold leaf operations away",
            ),
          operation: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Complete registered clash_* leaf name for compatibility; use a dispatcher for command-local short names",
            ),
          arguments: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Arguments validated against the selected operation's live input schema",
            ),
        },
        _meta: { ui: { visibility: ["model"] } },
      },
      async ({ command, operation, arguments: operationArguments }, extra) => {
        const selectedCommand = command as ClashMcpCommandId | undefined;
        if (operation) {
          if (!operation.startsWith("clash_")) {
            throw new Error(
              "Clash root compatibility execution requires a complete clash_* leaf name.",
            );
          }
          return this.#dispatchOperation({
            operation,
            arguments: operationArguments ?? {},
            selectedCommand,
            extra,
          });
        }
        const view = this.#rootView(selectedCommand);
        const selected = selectedCommand
          ? view.commands.find(({ id }) => id === selectedCommand)
          : undefined;
        const operationCount = selected?.availableOperations ?? 0;
        if (selectedCommand && operationCount === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `The ${selectedCommand} command has no operations in this Clash host.`,
              },
            ],
            structuredContent: view,
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: selectedCommand
                ? `Use ${view.selectedDispatcher}${view.selectedKind ? ` with kind=${view.selectedKind}` : ""} for ${selectedCommand}.`
                : `Clash offers ${view.commands.filter(({ availableOperations }) => availableOperations > 0).length} available commands.`,
            },
          ],
          structuredContent: view,
        };
      },
    );

    const pluginDefinition = getClashMcpCommand("plugin");
    super.registerTool(
      CLASH_PLUGIN_TOOL_NAME,
      {
        title: pluginDefinition.title,
        description: describeClashTool({
          useWhen:
            "the Agent needs plugin lifecycle operations or connected Blender/Maya control and Clash material exchange",
          effect:
            "returns live plugin contracts including dcc_* native application operations when operation is omitted, or validates and executes one plugin operation exactly once",
          returns:
            "typed plugin lifecycle contracts or the selected operation's exact result",
          next: "choose the smallest matching operation, then call clash_plugin with operation and arguments",
        }),
        inputSchema: {
          operation: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Omit this field entirely to reveal live contracts; otherwise pass a command-local Plugin operation or complete clash_plugin_* leaf name",
            ),
          arguments: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Arguments validated against the selected operation's live input schema",
            ),
        },
        _meta: { ui: { visibility: ["model"] } },
      },
      async ({ operation, arguments: operationArguments }, extra) => {
        if (operation) {
          return this.#dispatchOperation({
            operation,
            arguments: operationArguments ?? {},
            selectedCommand: "plugin",
            extra,
          });
        }
        return this.#commandResult("plugin");
      },
    );

    const assetsDefinition = getClashMcpCommand("assets");
    super.registerTool(
      CLASH_ASSETS_TOOL_NAME,
      {
        title: assetsDefinition.title,
        description: describeClashTool({
          useWhen:
            "you need to inspect, import, admit, publish, trash, or restore Project and personal Global Assets",
          effect:
            "returns a lightweight Asset operation index, reveals a requested bounded set of live contracts, or validates and executes one Asset leaf exactly once",
          returns:
            "an operation index, the requested typed Project or Global Asset contracts, or the selected leaf operation's exact result",
          next: "choose the smallest matching operations, request their contracts together, then call clash_assets with operation and arguments for each execution",
        }),
        inputSchema: {
          operation: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Pass a command-local Assets operation or complete clash_assets_* leaf name to execute it; omit to inspect the lightweight index or requested contracts",
            ),
          contract: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Command-local Assets operation or complete clash_assets_* leaf name whose full live contract should be returned without execution",
            ),
          contracts: z
            .array(z.string().min(1))
            .min(1)
            .max(
              MAX_ASSET_CONTRACT_BATCH_SIZE,
              `Asset contract batches accept at most ${MAX_ASSET_CONTRACT_BATCH_SIZE} operations`,
            )
            .optional()
            .describe(
              "Distinct ordered Assets operations whose full live contracts should be returned together without execution",
            ),
          arguments: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Arguments validated against the selected operation's live input schema",
            ),
        },
        _meta: { ui: { visibility: ["model"] } },
      },
      async (
        { operation, contract, contracts, arguments: operationArguments },
        extra,
      ) => {
        if (
          [operation, contract, contracts].filter(
            (value) => value !== undefined,
          ).length > 1
        ) {
          throw new Error(
            "Clash Assets accepts one disclosure mode or operation execution, not a combination.",
          );
        }
        if (contracts) return this.#contractBatchResult("assets", contracts);
        if (contract) return this.#contractResult("assets", contract);
        if (operation) {
          return this.#dispatchOperation({
            operation,
            arguments: operationArguments ?? {},
            selectedCommand: "assets",
            extra,
          });
        }
        return this.#commandResult("assets", { lightweight: true });
      },
    );

    const canvasDefinition = getClashMcpCommand("canvas");
    super.registerTool(
      CLASH_CANVAS_TOOL_NAME,
      {
        title: canvasDefinition.title,
        description: describeClashTool({
          useWhen: "you need to inspect or execute Canvas node operations",
          effect:
            "returns live Canvas contracts when operation is omitted, or validates and executes one Canvas leaf exactly once",
          returns:
            "typed Canvas operation contracts or the selected leaf operation's exact result",
          next: "choose the smallest matching operation, then call clash_canvas with operation and arguments",
        }),
        inputSchema: {
          operation: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Omit this field entirely to reveal live contracts; never send an empty string, list_operations, or contracts. Otherwise pass a command-local Canvas operation or complete clash_canvas_* leaf name",
            ),
          arguments: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Arguments validated against the selected operation's live input schema",
            ),
        },
        _meta: { ui: { visibility: ["model"] } },
      },
      async ({ operation, arguments: operationArguments }, extra) => {
        if (operation) {
          return this.#dispatchOperation({
            operation,
            arguments: operationArguments ?? {},
            selectedCommand: "canvas",
            extra,
          });
        }
        return this.#commandResult("canvas");
      },
    );

    const generatorsDefinition = getClashMcpCommand("generators");
    super.registerTool(
      CLASH_GENERATORS_TOOL_NAME,
      {
        title: generatorsDefinition.title,
        description: describeClashTool({
          useWhen:
            "the user asks to generate or edit image, video, or audio media for the current Clash Project, or you need to discover, inspect, or run a registered Project Generator",
          effect:
            "returns live Generators contracts when operation is omitted, or validates and executes one registered Generators leaf exactly once",
          returns:
            "typed Generators operation contracts or the selected leaf operation's exact result",
          next: "choose the smallest matching operation, submit and poll the Action Run, then read its output commit; never claim complete, finished, or successful project media without that persisted readback",
        }),
        inputSchema: {
          operation: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Omit this field entirely to reveal live contracts; never send an empty string, list_operations, or contracts. Otherwise pass a command-local Generators operation or complete clash_generators_* leaf name",
            ),
          arguments: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Arguments validated against the selected operation's live input schema",
            ),
        },
        _meta: { ui: { visibility: ["model"] } },
      },
      async ({ operation, arguments: operationArguments }, extra) => {
        if (operation) {
          return this.#dispatchOperation({
            operation,
            arguments: operationArguments ?? {},
            selectedCommand: "generators",
            extra,
          });
        }
        return this.#commandResult("generators");
      },
    );

    super.registerTool(
      CLASH_COMPOSITION_TOOL_NAME,
      {
        title: "Composition",
        description: describeClashTool({
          useWhen:
            "you need Timeline temporal composition or Director Stage spatial composition operations",
          effect:
            "returns live contracts for one composition kind, or validates and executes one matching composition leaf exactly once",
          returns:
            "typed Timeline or Director Stage contracts, or the selected leaf operation's exact result",
          next: "set kind to timeline or director-stage, choose the smallest matching operation, then pass operation and arguments",
        }),
        inputSchema: {
          kind: z
            .enum(["timeline", "director-stage"])
            .optional()
            .describe(
              "Required for contract disclosure and command-local short operations; complete leaf names may infer it",
            ),
          operation: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Omit this field entirely to reveal live contracts for the selected kind; never send an empty string, list_operations, or contracts. Otherwise pass a command-local operation or complete clash_timeline_* or clash_director_* leaf name",
            ),
          arguments: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Arguments validated against the selected operation's live input schema",
            ),
        },
        _meta: { ui: { visibility: ["model"] } },
      },
      async ({ kind, operation, arguments: operationArguments }, extra) => {
        const selectedCommand =
          kind === "timeline"
            ? "timeline"
            : kind === "director-stage"
              ? "director"
              : undefined;
        if (operation) {
          if (!selectedCommand && !operation.startsWith("clash_")) {
            throw new Error(
              `Clash composition short operation ${operation} requires kind.`,
            );
          }
          return this.#dispatchOperation({
            operation,
            arguments: operationArguments ?? {},
            selectedCommand,
            allowedCommands: ["timeline", "director"],
            extra,
          });
        }
        if (!selectedCommand) {
          throw new Error(
            "Clash composition disclosure requires kind=timeline or kind=director-stage.",
          );
        }
        return this.#commandResult(selectedCommand);
      },
    );

    for (const command of Object.keys(
      LEGACY_CLASH_GROUP_TOOL_NAMES,
    ) as LegacyClashGroupCommandId[]) {
      const commandDefinition = getClashMcpCommand(command);
      const toolName = LEGACY_CLASH_GROUP_TOOL_NAMES[command];
      super.registerTool(
        toolName,
        {
          title: commandDefinition.title,
          description: describeClashTool({
            useWhen: `you need to inspect or execute ${commandDefinition.title} operations`,
            effect: `returns live ${command} contracts when operation is omitted, or validates arguments and executes the selected registered ${command} leaf exactly once`,
            returns:
              "typed operation contracts or the selected leaf operation's exact result",
            next: "choose the smallest matching operation, then call this command tool with operation and arguments",
          }),
          inputSchema: {
            operation: z
              .string()
              .min(1)
              .optional()
              .describe(
                `Exact ${command} operation name returned by this command tool`,
              ),
            arguments: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                "Arguments validated against the selected operation's live input schema",
              ),
          },
          _meta: { ui: { visibility: ["model"] } },
        },
        async ({ operation, arguments: operationArguments }, extra) => {
          if (operation) {
            return this.#dispatchOperation({
              operation,
              arguments: operationArguments ?? {},
              selectedCommand: command,
              extra,
            });
          }
          return this.#commandResult(command);
        },
      );
    }
  }

  override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      execution?: ToolExecution;
      _meta?: Record<string, unknown>;
    },
    callback: ToolCallback<InputArgs>,
  ): RegisteredTool {
    if (
      name === CLASH_ROOT_TOOL_NAME ||
      name === CLASH_PLUGIN_TOOL_NAME ||
      name === CLASH_ASSETS_TOOL_NAME ||
      name === CLASH_CANVAS_TOOL_NAME ||
      name === CLASH_GENERATORS_TOOL_NAME ||
      name === CLASH_COMPOSITION_TOOL_NAME ||
      Object.values(LEGACY_CLASH_GROUP_TOOL_NAMES).includes(
        name as (typeof LEGACY_CLASH_GROUP_TOOL_NAMES)[LegacyClashGroupCommandId],
      )
    ) {
      throw new Error(`${name} is provided by ClashMcpServer`);
    }
    const handle = super.registerTool(name, config, callback);
    const registered: RegisteredClashTool = { name, removed: false, handle };
    this.#registeredClashTools.add(registered);
    const update = handle.update.bind(handle);
    handle.update = ((updates: { name?: string | null }) => {
      update(updates as never);
      if (updates.name === null) registered.removed = true;
      if (typeof updates.name === "string") registered.name = updates.name;
    }) as RegisteredTool["update"];
    return handle;
  }

  #liveModelTools(): RegisteredClashTool[] {
    return [...this.#registeredClashTools]
      .filter(
        ({ removed, handle }) =>
          !removed && handle.enabled && modelVisible(handle._meta),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  #commandView(selectedCommand?: ClashMcpCommandId): {
    schemaVersion: 1;
    commands: Array<{
      id: ClashMcpCommandId;
      title: string;
      useWhen: string;
      availableOperations: number;
    }>;
    selectedCommand?: ClashMcpCommandId;
    operations?: ClashOperationView[];
  } {
    const operations = this.#liveModelTools().map(
      ({ name, handle }): ClashOperationView => {
        const metadata = clashMetadata(handle._meta);
        const outputSchema = outputJsonSchemaOf(handle);
        return {
          name,
          operation: this.#commandLocalOperation(name),
          title: handle.title ?? name,
          description: handle.description ?? "",
          readOnly: annotationsOf(handle).readOnlyHint === true,
          destructive: annotationsOf(handle).destructiveHint === true,
          inputSchema: inputJsonSchemaOf(handle),
          ...(outputSchema ? { outputSchema } : {}),
          recovery: {
            guidance: nextGuidance(handle.description),
            retryOperationPath: "structuredContent.error.retryTool",
            staleMergePath: "structuredContent.error.recovery",
          },
          ...(metadata ? { metadata } : {}),
        };
      },
    );
    return buildClashMcpCommandMenu({
      operations,
      ...(selectedCommand ? { selectedCommand } : {}),
      belongsToCommand: (operation, command) =>
        classifyClashMcpTool(operation.name) === command.id,
    });
  }

  #commandResult(
    command: ClashMcpCommandId,
    options: { lightweight?: boolean } = {},
  ): CallToolResult {
    const view = this.#commandView(command);
    const operationCount = view.operations?.length ?? 0;
    if (operationCount === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `The ${command} command has no operations in this Clash host.`,
          },
        ],
        structuredContent: view,
        isError: true,
      };
    }
    const operations: ClashOperationView[] | ClashOperationIndexEntry[] =
      options.lightweight
        ? (view.operations ?? []).map(
            ({ name, operation, title, readOnly, destructive }) => ({
              name,
              operation,
              title,
              readOnly,
              destructive,
            }),
          )
        : (view.operations ?? []);
    return {
      content: [
        {
          type: "text" as const,
          text: options.lightweight
            ? `Found ${operationCount} ${command} operation${operationCount === 1 ? "" : "s"}. Request only the needed full contracts together with contracts=["<operation>", ...] before execution; contract="<operation>" remains available for one.`
            : `Revealed ${operationCount} ${command} operation${operationCount === 1 ? "" : "s"}.`,
        },
      ],
      structuredContent: { ...view, operations },
    };
  }

  #contractResult(
    command: ClashMcpCommandId,
    requestedOperation: string,
  ): CallToolResult {
    const operationName = this.#resolveOperationName(
      requestedOperation,
      command,
    );
    const contract = this.#commandView(command).operations?.find(
      ({ name }) => name === operationName,
    );
    if (!contract) {
      throw new Error(
        `Clash ${command} operation ${requestedOperation} has no live contract in this host.`,
      );
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Revealed the live contract for ${contract.name}.`,
        },
      ],
      structuredContent: {
        schemaVersion: 1,
        selectedCommand: command,
        contract,
      },
    };
  }

  #contractBatchResult(
    command: ClashMcpCommandId,
    requestedOperations: string[],
  ): CallToolResult {
    const liveContracts = this.#commandView(command).operations ?? [];
    const operationNames = requestedOperations.map((requestedOperation) =>
      this.#resolveOperationName(requestedOperation, command),
    );
    if (new Set(operationNames).size !== operationNames.length) {
      throw new Error(
        `Clash ${command} contract batches require distinct operations.`,
      );
    }
    const contracts = operationNames.map((operationName, index) => {
      const contract = liveContracts.find(({ name }) => name === operationName);
      if (!contract) {
        throw new Error(
          `Clash ${command} operation ${requestedOperations[index]} has no live contract in this host.`,
        );
      }
      return contract;
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Revealed ${contracts.length} live ${command} contracts.`,
        },
      ],
      structuredContent: {
        schemaVersion: 1,
        selectedCommand: command,
        contracts,
      },
    };
  }

  #rootView(selectedCommand?: ClashMcpCommandId): {
    schemaVersion: 1;
    commands: Array<{
      id: ClashMcpCommandId;
      title: string;
      useWhen: string;
      availableOperations: number;
      dispatcher?: string;
      kind?: ClashCompositionKind;
    }>;
    selectedCommand?: ClashMcpCommandId;
    selectedDispatcher?: string;
    selectedKind?: ClashCompositionKind;
  } {
    const menu = this.#commandView();
    const commands: Array<{
      id: ClashMcpCommandId;
      title: string;
      useWhen: string;
      availableOperations: number;
      dispatcher?: string;
      kind?: ClashCompositionKind;
    }> = menu.commands.map((command) => {
      if (command.id === "workspace") {
        return {
          ...command,
          ...(command.availableOperations > 0
            ? { dispatcher: "clash_workspace_init" }
            : {}),
        };
      }
      if (command.id === "assets") {
        return { ...command, dispatcher: CLASH_ASSETS_TOOL_NAME };
      }
      if (command.id === "plugin") {
        return { ...command, dispatcher: CLASH_PLUGIN_TOOL_NAME };
      }
      if (command.id === "canvas") {
        return { ...command, dispatcher: CLASH_CANVAS_TOOL_NAME };
      }
      if (command.id === "generators") {
        return { ...command, dispatcher: CLASH_GENERATORS_TOOL_NAME };
      }
      const kind: ClashCompositionKind =
        command.id === "timeline" ? "timeline" : "director-stage";
      return { ...command, dispatcher: CLASH_COMPOSITION_TOOL_NAME, kind };
    });
    if (!selectedCommand) return { ...menu, commands };
    const selected = commands.find(({ id }) => id === selectedCommand);
    return {
      ...menu,
      commands,
      selectedCommand,
      ...(selected?.dispatcher
        ? { selectedDispatcher: selected.dispatcher }
        : {}),
      ...(selected?.kind ? { selectedKind: selected.kind } : {}),
    };
  }

  #commandLocalOperation(name: string): string {
    const family = classifyClashMcpTool(name);
    const prefixes =
      family === "workspace"
        ? ["clash_workspace_", "clash_studio_"]
        : family === "other"
          ? []
          : [`clash_${family}_`];
    const prefix = prefixes.find((candidate) => name.startsWith(candidate));
    return prefix ? name.slice(prefix.length) : name;
  }

  #resolveOperationName(
    operation: string,
    selectedCommand?: ClashMcpCommandId,
  ): string {
    if (operation.startsWith("clash_")) return operation;
    if (!selectedCommand) {
      throw new Error(
        `Clash short operation ${operation} requires an explicit command.`,
      );
    }
    const matches = this.#liveModelTools().filter(
      ({ name }) =>
        classifyClashMcpTool(name) === selectedCommand &&
        this.#commandLocalOperation(name) === operation,
    );
    if (matches.length === 0) {
      throw new Error(
        `Clash ${selectedCommand} operation ${operation} is not registered, enabled, and model-visible in this host.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Clash ${selectedCommand} operation ${operation} is ambiguous; use a complete clash_* leaf name.`,
      );
    }
    return matches[0]!.name;
  }

  async #dispatchOperation(input: {
    operation: string;
    arguments: Record<string, unknown>;
    selectedCommand?: ClashMcpCommandId;
    allowedCommands?: readonly ClashMcpCommandId[];
    extra: ClashToolExtra;
  }): Promise<CallToolResult> {
    const operationName = this.#resolveOperationName(
      input.operation,
      input.selectedCommand,
    );
    const registered = this.#liveModelTools().find(
      ({ name }) => name === operationName,
    );
    if (!registered) {
      throw new Error(
        `Clash operation ${operationName} is not registered, enabled, and model-visible in this host.`,
      );
    }
    const family = classifyClashMcpTool(registered.name);
    if (family === "other") {
      throw new Error(
        `Clash operation ${registered.name} is not part of a root command.`,
      );
    }
    if (input.allowedCommands && !input.allowedCommands.includes(family)) {
      throw new Error(
        `Clash operation ${registered.name} is not available through this dispatcher.`,
      );
    }
    if (input.selectedCommand && family !== input.selectedCommand) {
      throw new Error(
        `Clash operation ${registered.name} belongs to ${family}, not ${input.selectedCommand}.`,
      );
    }

    const { handle } = registered;
    const normalizedInput = normalizeObjectSchema(handle.inputSchema);
    const schemaToParse = normalizedInput ?? handle.inputSchema;
    let parsedArguments: unknown = undefined;
    if (schemaToParse) {
      const parsed = await safeParseAsync(schemaToParse, input.arguments);
      if (!parsed.success) {
        throw new Error(
          `Invalid arguments for Clash operation ${registered.name}: ${getParseErrorMessage(parsed.error)}`,
        );
      }
      parsedArguments = parsed.data;
    }

    if (typeof handle.handler !== "function") {
      throw new Error(
        `Task-based Clash operation ${registered.name} cannot use root dispatch.`,
      );
    }
    const result = handle.inputSchema
      ? await (
          handle.handler as (
            args: unknown,
            extra: ClashToolExtra,
          ) => CallToolResult | Promise<CallToolResult>
        )(parsedArguments, input.extra)
      : await (
          handle.handler as (
            extra: ClashToolExtra,
          ) => CallToolResult | Promise<CallToolResult>
        )(input.extra);

    if (handle.outputSchema && !result.isError) {
      if (!result.structuredContent) {
        throw new Error(
          `Clash operation ${registered.name} has an output schema but returned no structured content.`,
        );
      }
      const normalizedOutput = normalizeObjectSchema(handle.outputSchema);
      const schema = normalizedOutput ?? handle.outputSchema;
      const parsed = await safeParseAsync(schema, result.structuredContent);
      if (!parsed.success) {
        throw new Error(
          `Invalid structured content from Clash operation ${registered.name}: ${getParseErrorMessage(parsed.error)}`,
        );
      }
    }
    return result;
  }

  #visibleTools(
    tools: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    return tools.filter((tool): tool is ToolDefinition => {
      if (typeof tool.name !== "string") return false;
      if (
        Object.values(LEGACY_CLASH_GROUP_TOOL_NAMES).includes(
          tool.name as (typeof LEGACY_CLASH_GROUP_TOOL_NAMES)[LegacyClashGroupCommandId],
        )
      )
        return false;
      if (
        tool.name === CLASH_ROOT_TOOL_NAME ||
        tool.name === CLASH_PLUGIN_TOOL_NAME ||
        tool.name === CLASH_ASSETS_TOOL_NAME ||
        tool.name === CLASH_CANVAS_TOOL_NAME ||
        tool.name === CLASH_GENERATORS_TOOL_NAME ||
        tool.name === CLASH_COMPOSITION_TOOL_NAME ||
        tool.name === "clash_workspace_init"
      )
        return true;
      return classifyClashMcpTool(tool.name) === "other";
    });
  }

  override async connect(transport: Transport): Promise<void> {
    await super.connect(
      new McpSchemaCompatibilityTransport(transport, {
        filterTools: (tools) => this.#visibleTools(tools),
      }),
    );
  }
}
