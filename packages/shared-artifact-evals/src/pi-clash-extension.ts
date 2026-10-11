import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type PiTextContent = { type: "text"; text: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };

export type PiExtensionToolResult = {
  content: Array<PiTextContent | PiImageContent>;
  details: Record<string, unknown>;
};

export type PiExtensionToolDefinition = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<PiExtensionToolResult>;
};

export type PiExtensionApi = {
  registerTool(tool: PiExtensionToolDefinition): void;
  on(event: "session_shutdown", handler: () => Promise<void> | void): void;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Pi Clash extension requires ${name}`);
  }
  return value;
}

function clashMcpEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        (entry[0] === "PATH" || entry[0].startsWith("CLASH_")),
    ),
  );
}

function toolErrorMessage(result: {
  content?: unknown;
  structuredContent?: unknown;
}): string {
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((item): item is { type: "text"; text: string } =>
        Boolean(
          item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string",
        ),
      )
      .map((item) => item.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return result.structuredContent === undefined
    ? "Clash MCP tool call failed"
    : JSON.stringify(result.structuredContent);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function projectStructuredContentForPi(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;

  if (Array.isArray(record.operations)) {
    return {
      ...(record.schemaVersion === undefined
        ? {}
        : { schemaVersion: record.schemaVersion }),
      ...(record.commands === undefined ? {} : { commands: record.commands }),
      ...(record.selectedCommand === undefined
        ? {}
        : { selectedCommand: record.selectedCommand }),
      operations: record.operations.map((operation) => {
        const candidate = asRecord(operation);
        if (!candidate) return operation;
        return Object.fromEntries(
          [
            "name",
            "operation",
            "title",
            "description",
            "readOnly",
            "destructive",
            "inputSchema",
            "recovery",
          ]
            .filter((key) => candidate[key] !== undefined)
            .map((key) => [key, candidate[key]]),
        );
      }),
    };
  }

  if (
    record.operationCatalog !== undefined &&
    record.jsonSchema !== undefined
  ) {
    return Object.fromEntries(
      [
        "schemaVersion",
        "format",
        "description",
        "fieldCatalog",
        "taxonomy",
        "validation",
        "jsonSchema",
        "features",
        "examples",
        "contractFingerprint",
      ]
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, record[key]]),
    );
  }

  return value;
}

function piContent(result: {
  content?: unknown;
  structuredContent?: unknown;
}): Array<PiTextContent | PiImageContent> {
  const content: Array<PiTextContent | PiImageContent> = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const candidate = item as Record<string, unknown>;
      if (candidate.type === "text" && typeof candidate.text === "string") {
        content.push({ type: "text", text: candidate.text });
      } else if (
        candidate.type === "image" &&
        typeof candidate.data === "string" &&
        typeof candidate.mimeType === "string"
      ) {
        content.push({
          type: "image",
          data: candidate.data,
          mimeType: candidate.mimeType,
        });
      } else {
        content.push({ type: "text", text: JSON.stringify(candidate) });
      }
    }
  }
  if (result.structuredContent !== undefined) {
    content.push({
      type: "text",
      text: `Structured result:\n${JSON.stringify(
        projectStructuredContentForPi(result.structuredContent),
      )}`,
    });
  }
  if (content.length > 0) return content;
  return [
    {
      type: "text",
      text:
        result.structuredContent === undefined
          ? "Clash MCP tool completed."
          : JSON.stringify(result.structuredContent),
    },
  ];
}

export default async function piClashExtension(
  pi: PiExtensionApi,
): Promise<void> {
  const runtimePath = requiredEnvironment("CLASH_PI_MCP_RUNTIME_PATH");
  const pluginRoot = requiredEnvironment("CLASH_PI_MCP_PLUGIN_ROOT");
  const transport = new StdioClientTransport({
    // Pi may be a compiled binary, so its own executable is not a Node.
    command: process.env.CLASH_PI_MCP_NODE_PATH?.trim() || process.execPath,
    args: [runtimePath],
    cwd: pluginRoot,
    env: clashMcpEnvironment(),
    stderr: "inherit",
  });
  const client = new Client({
    name: "clash-pi-benchmark-adapter",
    version: "0.1.0",
  });
  await client.connect(transport);

  const listed = await client.listTools();
  for (const tool of listed.tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? `Call the Clash MCP ${tool.name} tool`,
      promptSnippet: tool.description ?? `Call the Clash MCP ${tool.name} tool`,
      parameters: tool.inputSchema,
      async execute(_toolCallId, params, signal) {
        const result = await client.callTool(
          { name: tool.name, arguments: params },
          undefined,
          { signal },
        );
        const resultRecord = result as Record<string, unknown>;
        if (resultRecord.isError === true) {
          throw new Error(toolErrorMessage(resultRecord));
        }
        return {
          content: piContent(resultRecord),
          details: {
            ...(resultRecord.structuredContent === undefined
              ? {}
              : { structuredContent: resultRecord.structuredContent }),
            ...(resultRecord._meta === undefined
              ? {}
              : { meta: resultRecord._meta }),
          },
        };
      },
    });
  }

  let closed = false;
  pi.on("session_shutdown", async () => {
    if (closed) return;
    closed = true;
    await client.close();
  });
}
