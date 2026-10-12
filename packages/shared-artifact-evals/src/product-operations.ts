import { createHash } from "node:crypto";

import type { ProductOperationObservation } from "./types";

const DISCOVERY_FLAGS = new Set(["--help", "-h", "--version", "-V"]);
const MAX_REPORTED_CLI_ARGUMENT_BYTES = 512;

const MCP_TOOL_BY_CLI_COMMAND: Record<string, string> = {
  "assets delete": "clash_assets_trash",
  "assets get": "clash_assets_get",
  "assets import": "clash_assets_import_file",
  "assets list": "clash_assets_list",
  "assets restore": "clash_assets_restore",
  "canvas add": "clash_canvas_add",
  "canvas get": "clash_canvas_get",
  "canvas update": "clash_canvas_update",
  "director apply": "clash_director_save",
  "director capture": "clash_director_capture",
  "director create": "clash_director_create",
  "director pull": "clash_director_get",
  "timeline apply": "clash_timeline_save",
  "timeline create": "clash_timeline_create",
  "timeline pull": "clash_timeline_get",
  "timeline render": "clash_timeline_render",
  "timeline validate": "clash_timeline_validate",
};

const DIRECTOR_FOCUSED_COMMANDS = new Set([
  "action",
  "camera",
  "keyframe",
  "object",
  "scene",
]);

export function formatCliInvocation(argv: string[]): string {
  return argv
    .map((argument) => {
      const bytes = Buffer.byteLength(argument);
      if (bytes <= MAX_REPORTED_CLI_ARGUMENT_BYTES) return argument;
      const sha256 = createHash("sha256").update(argument).digest("hex");
      return `<arg:${bytes}B sha256:${sha256}>`;
    })
    .join(" ");
}

/**
 * Resolve the MCP leaf whose implementation crossed the runner-owned CLI
 * proxy. The transport origin comes from the sealed proxy trace; argv only
 * selects the already-registered Clash leaf and never establishes success.
 */
export function mcpToolForCliInvocation(argv: string[]): string | undefined {
  if (argv.some((argument) => DISCOVERY_FLAGS.has(argument))) return undefined;
  const command = `${argv[0] ?? ""} ${argv[1] ?? ""}`.trim();
  const direct = MCP_TOOL_BY_CLI_COMMAND[command];
  if (direct) return direct;
  if (
    argv[0] === "director" &&
    DIRECTOR_FOCUSED_COMMANDS.has(argv[1] ?? "") &&
    /^[a-z][a-z0-9-]*$/u.test(argv[2] ?? "")
  ) {
    return `clash_director_${argv[1]}_${argv[2]!.replaceAll("-", "_")}`;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Codex may keep the MCP tool list fixed for a turn. Clash therefore supports
 * dispatching a revealed leaf operation through the stable root `clash` tool.
 * Attribute a successful dispatch to the leaf so trajectory gates stay
 * transport-neutral; plain root menu/discovery calls remain `clash`.
 */
export function effectiveMcpToolName(input: {
  tool?: unknown;
  arguments?: unknown;
}): string | undefined {
  if (typeof input.tool !== "string") return undefined;
  const args = asRecord(input.arguments);
  const operation = args?.operation;
  if (typeof operation !== "string") return input.tool;

  const completeLeaf =
    /^clash_(workspace|canvas|director|timeline|assets)_[a-z0-9_]+$/u.exec(
      operation,
    );
  const legacyDispatcher =
    /^clash_(workspace|canvas|director|timeline|assets)$/u.exec(
      input.tool,
    )?.[1];
  const compositionKind =
    args?.kind === "timeline"
      ? "timeline"
      : args?.kind === "director-stage"
        ? "director"
        : undefined;
  const rootCommand =
    typeof args?.command === "string" && /^[a-z0-9-]+$/u.test(args.command)
      ? args.command.replaceAll("-", "_")
      : undefined;

  if (input.tool === "clash") {
    if (!completeLeaf) return input.tool;
    return rootCommand && completeLeaf[1] !== rootCommand
      ? input.tool
      : operation;
  }

  if (input.tool === "clash_composition") {
    if (completeLeaf) {
      if (completeLeaf[1] !== "timeline" && completeLeaf[1] !== "director") {
        return input.tool;
      }
      return compositionKind && completeLeaf[1] !== compositionKind
        ? input.tool
        : operation;
    }
    return compositionKind && /^[a-z][a-z0-9_]*$/u.test(operation)
      ? `clash_${compositionKind}_${operation}`
      : input.tool;
  }

  if (!legacyDispatcher) return input.tool;
  if (completeLeaf) {
    return completeLeaf[1] === legacyDispatcher ? operation : input.tool;
  }
  return /^[a-z][a-z0-9_]*$/u.test(operation)
    ? `clash_${legacyDispatcher}_${operation}`
    : input.tool;
}

export const PRODUCT_OPERATION_IDS = [
  "asset.get",
  "asset.import",
  "asset.list",
  "asset.restore",
  "asset.trash",
  "canvas.add",
  "canvas.get",
  "canvas.update",
  "director.capture",
  "director.create",
  "director.get",
  "director.mutate",
  "timeline.create",
  "timeline.get",
  "timeline.render",
  "timeline.save",
  "timeline.validate",
] as const;

export type ProductOperationId = (typeof PRODUCT_OPERATION_IDS)[number];

export type AssetEntityOperationId =
  "asset.import" | "asset.get" | "asset.trash" | "asset.restore";

export type TrustedAssetOperationEvidence = {
  operation: AssetEntityOperationId;
  transport: "mcp" | "cli";
  invocation: string;
  projectAssetId: string;
  sourcePath?: string;
};

export type SuccessfulAssetMcpCall = {
  tool: string;
  arguments?: unknown;
  result?: unknown;
  /** Runner-sealed start time; orders evidence across transports. */
  startedAt?: string;
};

export type SuccessfulAssetCliCall = {
  argv: string[];
  /** Identity the runner read from a successful import's own output. */
  importedProjectAssetId?: string;
  startedAt?: string;
};

const ASSET_ENTITY_OPERATION_BY_MCP_TOOL: Record<
  string,
  AssetEntityOperationId
> = {
  clash_assets_import_file: "asset.import",
  clash_assets_get: "asset.get",
  clash_assets_trash: "asset.trash",
  clash_assets_restore: "asset.restore",
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function leafMcpArguments(
  call: SuccessfulAssetMcpCall,
): Record<string, unknown> {
  const outer = asRecord(call.arguments) ?? {};
  return asRecord(outer.arguments) ?? outer;
}

function structuredMcpResult(
  value: unknown,
): Record<string, unknown> | undefined {
  const result = asRecord(value);
  if (!result) return undefined;
  return (
    asRecord(result.structured_content) ??
    asRecord(result.structuredContent) ??
    result
  );
}

function cliOption(argv: string[], name: string): string | undefined {
  const exactIndex = argv.indexOf(name);
  if (exactIndex >= 0) return nonEmptyString(argv[exactIndex + 1]);
  const prefix = `${name}=`;
  const joined = argv.find((argument) => argument.startsWith(prefix));
  return joined ? nonEmptyString(joined.slice(prefix.length)) : undefined;
}

function mcpAssetOperationEvidence(
  call: SuccessfulAssetMcpCall,
): TrustedAssetOperationEvidence | undefined {
  const effectiveTool = effectiveMcpToolName(call);
  if (!effectiveTool) return undefined;
  const operation = ASSET_ENTITY_OPERATION_BY_MCP_TOOL[effectiveTool];
  if (!operation) return undefined;
  const args = leafMcpArguments(call);
  const requestedId = nonEmptyString(
    operation === "asset.import" ? args.projectAssetId : args.assetId,
  );
  const resultId = nonEmptyString(structuredMcpResult(call.result)?.id);
  if (requestedId && resultId && requestedId !== resultId) return undefined;
  const projectAssetId = resultId ?? requestedId;
  if (!projectAssetId) return undefined;
  const sourcePath =
    operation === "asset.import" ? nonEmptyString(args.filePath) : undefined;
  if (operation === "asset.import" && !sourcePath) return undefined;
  return {
    operation,
    transport: "mcp",
    invocation: effectiveTool,
    projectAssetId,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

/**
 * Read the Project Asset identity a successful `assets import` reported. The
 * runner calls this on the stdout it captured itself, so a minted id reaches
 * the sealed trace without the Agent restating it.
 */
export function importedProjectAssetIdFromCliOutput(
  argv: string[],
  stdout: string,
): string | undefined {
  const canonicalArgv =
    argv[0] === "asset" ? ["assets", ...argv.slice(1)] : argv;
  if (
    canonicalArgv[0] !== "assets" ||
    canonicalArgv[1] !== "import" ||
    canonicalArgv.some((argument) => DISCOVERY_FLAGS.has(argument))
  ) {
    return undefined;
  }
  const json = stdout.trim().startsWith("{") ? asRecord(stdout) : undefined;
  if (json) return nonEmptyString(json.assetId);
  return nonEmptyString(
    /^imported Project Asset (\S+?)(?:, link .*)?$/mu.exec(stdout)?.[1],
  );
}

function cliAssetOperationEvidence(
  call: SuccessfulAssetCliCall,
): TrustedAssetOperationEvidence | undefined {
  const { argv } = call;
  const canonicalArgv =
    argv[0] === "asset" ? ["assets", ...argv.slice(1)] : argv;
  if (
    canonicalArgv[0] !== "assets" ||
    canonicalArgv.some((argument) => DISCOVERY_FLAGS.has(argument))
  ) {
    return undefined;
  }
  const command = canonicalArgv[1];
  const operation: AssetEntityOperationId | undefined =
    command === "import"
      ? "asset.import"
      : command === "get"
        ? "asset.get"
        : command === "delete"
          ? "asset.trash"
          : command === "restore"
            ? "asset.restore"
            : undefined;
  if (!operation) return undefined;
  const requestedId = cliOption(
    canonicalArgv,
    operation === "asset.import" ? "--asset-id" : "--asset",
  );
  const resultId =
    operation === "asset.import"
      ? nonEmptyString(call.importedProjectAssetId)
      : undefined;
  if (requestedId && resultId && requestedId !== resultId) return undefined;
  const projectAssetId = resultId ?? requestedId;
  if (!projectAssetId) return undefined;
  const sourcePath =
    operation === "asset.import"
      ? cliOption(canonicalArgv, "--file")
      : undefined;
  if (operation === "asset.import" && !sourcePath) return undefined;
  return {
    operation,
    transport: "cli",
    invocation: formatCliInvocation(argv),
    projectAssetId,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

/**
 * Retain entity identity only from successful product calls, in the order the
 * runner saw them start. A structured MCP result or the runner-captured CLI
 * import output may strengthen the requested identity and can never
 * contradict it; an import whose identity neither side names is not evidence.
 */
export function extractTrustedAssetOperationEvidence(input: {
  successfulMcpCalls: SuccessfulAssetMcpCall[];
  successfulCliCalls: SuccessfulAssetCliCall[];
}): TrustedAssetOperationEvidence[] {
  const startedMs = (startedAt: string | undefined): number => {
    const parsed = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  return [
    ...input.successfulMcpCalls.map((call) => ({
      startedMs: startedMs(call.startedAt),
      evidence: mcpAssetOperationEvidence(call),
    })),
    ...input.successfulCliCalls.map((call) => ({
      startedMs: startedMs(call.startedAt),
      evidence: cliAssetOperationEvidence(call),
    })),
  ]
    .sort((left, right) =>
      left.startedMs === right.startedMs ? 0 : left.startedMs - right.startedMs,
    )
    .flatMap(({ evidence }) => (evidence ? [evidence] : []));
}

type ProductOperationRule = {
  mcpTools?: readonly string[];
  mcpPrefixes?: readonly string[];
  cliPrefixes: readonly (readonly string[])[];
};

const PRODUCT_OPERATION_RULES: Record<
  ProductOperationId,
  ProductOperationRule
> = {
  "asset.get": {
    mcpTools: ["clash_assets_get"],
    cliPrefixes: [["assets", "get"]],
  },
  "asset.import": {
    mcpTools: ["clash_assets_import_file"],
    cliPrefixes: [["assets", "import"]],
  },
  "asset.list": {
    mcpTools: ["clash_assets_list"],
    cliPrefixes: [["assets", "list"]],
  },
  "asset.restore": {
    mcpTools: ["clash_assets_restore"],
    cliPrefixes: [["assets", "restore"]],
  },
  "asset.trash": {
    mcpTools: ["clash_assets_trash"],
    cliPrefixes: [["assets", "delete"]],
  },
  "canvas.add": {
    mcpTools: ["clash_canvas_add"],
    cliPrefixes: [["canvas", "add"]],
  },
  "canvas.get": {
    mcpTools: ["clash_canvas_get"],
    cliPrefixes: [["canvas", "get"]],
  },
  "canvas.update": {
    mcpTools: ["clash_canvas_update"],
    cliPrefixes: [["canvas", "update"]],
  },
  "director.capture": {
    mcpTools: ["clash_director_capture"],
    cliPrefixes: [["director", "capture"]],
  },
  "director.create": {
    mcpTools: ["clash_director_create"],
    cliPrefixes: [["director", "create"]],
  },
  "director.get": {
    mcpTools: ["clash_director_get"],
    cliPrefixes: [["director", "pull"]],
  },
  "director.mutate": {
    mcpTools: ["clash_director_save"],
    mcpPrefixes: [
      "clash_director_object_",
      "clash_director_camera_",
      "clash_director_scene_",
      "clash_director_keyframe_",
      "clash_director_action_",
    ],
    cliPrefixes: [
      ["director", "apply"],
      ["director", "object"],
      ["director", "camera"],
      ["director", "scene"],
      ["director", "keyframe"],
      ["director", "action"],
    ],
  },
  "timeline.create": {
    mcpTools: ["clash_timeline_create"],
    cliPrefixes: [["timeline", "create"]],
  },
  "timeline.get": {
    mcpTools: ["clash_timeline_get"],
    cliPrefixes: [["timeline", "pull"]],
  },
  "timeline.render": {
    mcpTools: ["clash_timeline_render"],
    cliPrefixes: [["timeline", "render"]],
  },
  "timeline.save": {
    mcpTools: ["clash_timeline_save"],
    cliPrefixes: [["timeline", "apply"]],
  },
  "timeline.validate": {
    mcpTools: ["clash_timeline_validate"],
    cliPrefixes: [["timeline", "validate"]],
  },
};

function startsWithArgv(argv: string[], prefix: readonly string[]): boolean {
  return prefix.every((argument, index) => argv[index] === argument);
}

function matchingMcpTool(
  rule: ProductOperationRule,
  successfulMcpTools: string[],
): string | undefined {
  return successfulMcpTools.find(
    (tool) =>
      rule.mcpTools?.includes(tool) ||
      rule.mcpPrefixes?.some((prefix) => tool.startsWith(prefix)),
  );
}

function matchingCliArgv(
  rule: ProductOperationRule,
  successfulCliArgv: string[][],
): string[] | undefined {
  return successfulCliArgv.find((argv) => {
    const canonicalArgv =
      argv[0] === "asset" ? ["assets", ...argv.slice(1)] : argv;
    return (
      !canonicalArgv.some((argument) => DISCOVERY_FLAGS.has(argument)) &&
      rule.cliPrefixes.some((prefix) => startsWithArgv(canonicalArgv, prefix))
    );
  });
}

export function matchRequiredProductOperations(input: {
  requiredProductOperations: string[];
  successfulMcpTools: string[];
  successfulCliArgv: string[][];
}): {
  observedProductOperations: ProductOperationObservation[];
  missingProductOperations: string[];
} {
  const observedProductOperations: ProductOperationObservation[] = [];
  const observed = new Set<string>();

  for (const operation of input.requiredProductOperations) {
    const rule = PRODUCT_OPERATION_RULES[operation as ProductOperationId];
    if (!rule) throw new Error(`Unknown Clash product operation: ${operation}`);

    const mcpTool = matchingMcpTool(rule, input.successfulMcpTools);
    if (mcpTool) {
      observed.add(operation);
      observedProductOperations.push({
        operation,
        transport: "mcp",
        invocation: mcpTool,
      });
    }

    const cliArgv = matchingCliArgv(rule, input.successfulCliArgv);
    if (cliArgv) {
      observed.add(operation);
      observedProductOperations.push({
        operation,
        transport: "cli",
        invocation: formatCliInvocation(cliArgv),
      });
    }
  }

  return {
    observedProductOperations,
    missingProductOperations: input.requiredProductOperations.filter(
      (operation) => !observed.has(operation),
    ),
  };
}

export function matchForbiddenProductOperations(input: {
  forbiddenProductOperations: string[];
  invokedMcpTools: string[];
  invokedCliArgv: string[][];
}): ProductOperationObservation[] {
  return matchRequiredProductOperations({
    requiredProductOperations: input.forbiddenProductOperations,
    successfulMcpTools: input.invokedMcpTools,
    successfulCliArgv: input.invokedCliArgv,
  }).observedProductOperations;
}
