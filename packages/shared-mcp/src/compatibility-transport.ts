import type {
  JSONRPCMessage,
  MessageExtraInfo,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

import { projectClashMcpWireJsonSchema } from "./wire-schema.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toolsListRequestId(message: JSONRPCMessage): RequestId | undefined {
  if (!isRecord(message)) return undefined;
  const record = message as unknown as Record<string, unknown>;
  return record.method === "tools/list" &&
    (typeof record.id === "string" || typeof record.id === "number")
    ? record.id
    : undefined;
}

function responseId(message: JSONRPCMessage): RequestId | undefined {
  if (!isRecord(message)) return undefined;
  return ("result" in message || "error" in message) &&
    (typeof message.id === "string" || typeof message.id === "number")
    ? message.id
    : undefined;
}

function toolCallRequest(
  message: JSONRPCMessage,
):
  | { id: RequestId; name: string; arguments: Record<string, unknown> }
  | undefined {
  if (!isRecord(message)) return undefined;
  const record = message as unknown as Record<string, unknown>;
  if (
    record.method !== "tools/call" ||
    (typeof record.id !== "string" && typeof record.id !== "number") ||
    !isRecord(record.params) ||
    typeof record.params.name !== "string"
  ) {
    return undefined;
  }
  return {
    id: record.id,
    name: record.params.name,
    arguments: isRecord(record.params.arguments) ? record.params.arguments : {},
  };
}

/** Returns corrective text for a tools/call that must not reach a handler. */
export type ClashMcpToolCallGuard = (call: {
  name: string;
  arguments: Record<string, unknown>;
}) => string | undefined;

export type ClashMcpToolListFilter = (
  tools: Array<Record<string, unknown>>,
) => Array<Record<string, unknown>>;

function projectToolsListResponse(
  message: JSONRPCMessage,
  filterTools?: ClashMcpToolListFilter,
): JSONRPCMessage {
  const record = message as unknown as Record<string, unknown>;
  if (!isRecord(message) || !isRecord(record.result)) {
    throw new Error("tools/list response did not contain an object result");
  }
  const result = record.result;
  if (!Array.isArray(result.tools)) {
    throw new Error("tools/list response did not contain a tools array");
  }
  const projectedTools = (result.tools as unknown[]).map((value, index) => {
    if (!isRecord(value) || typeof value.name !== "string") {
      throw new Error(`tools/list entry ${index} is not a named tool`);
    }
    const tool = { ...value };
    if (value.inputSchema !== undefined) {
      tool.inputSchema = projectClashMcpWireJsonSchema(
        value.inputSchema,
        `${value.name} input schema`,
      );
    }
    if (value.outputSchema !== undefined) {
      tool.outputSchema = projectClashMcpWireJsonSchema(
        value.outputSchema,
        `${value.name} output schema`,
      );
    }
    return tool;
  });
  const tools = filterTools ? filterTools(projectedTools) : projectedTools;
  return {
    ...message,
    result: { ...result, tools },
  } as JSONRPCMessage;
}

function internalErrorResponse(
  message: JSONRPCMessage,
  error: unknown,
): JSONRPCMessage {
  const id = responseId(message);
  if (id === undefined) return message;
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message: `Clash MCP tools/list schema projection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    },
  };
}

/**
 * Transport decorator that applies compatibility to tools/list egress and
 * answers a misaddressed tools/call with corrective guidance before dispatch.
 */
export class McpSchemaCompatibilityTransport implements Transport {
  readonly #transport: Transport;
  readonly #filterTools?: ClashMcpToolListFilter;
  readonly #guardToolCall?: ClashMcpToolCallGuard;
  readonly #pendingToolsListIds = new Set<RequestId>();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  constructor(
    transport: Transport,
    options: {
      filterTools?: ClashMcpToolListFilter;
      guardToolCall?: ClashMcpToolCallGuard;
    } = {},
  ) {
    this.#transport = transport;
    this.#filterTools = options.filterTools;
    this.#guardToolCall = options.guardToolCall;
  }

  get sessionId(): string | undefined {
    return this.#transport.sessionId;
  }

  set sessionId(value: string | undefined) {
    this.#transport.sessionId = value;
  }

  setProtocolVersion(version: string): void {
    this.#transport.setProtocolVersion?.(version);
  }

  async start(): Promise<void> {
    const existingClose = this.#transport.onclose;
    const existingError = this.#transport.onerror;
    const existingMessage = this.#transport.onmessage;
    this.#transport.onclose = () => {
      this.#pendingToolsListIds.clear();
      existingClose?.();
      this.onclose?.();
    };
    this.#transport.onerror = (error) => {
      existingError?.(error);
      this.onerror?.(error);
    };
    this.#transport.onmessage = <T extends JSONRPCMessage>(
      message: T,
      extra?: MessageExtraInfo,
    ) => {
      existingMessage?.(message, extra);
      const call = toolCallRequest(message);
      const guidance = call && this.#guardToolCall?.(call);
      if (call && guidance) {
        void this.#transport
          .send({
            jsonrpc: "2.0",
            id: call.id,
            result: {
              content: [{ type: "text", text: guidance }],
              isError: true,
            },
          })
          .catch((error) => this.onerror?.(error as Error));
        return;
      }
      const id = toolsListRequestId(message);
      if (id !== undefined) this.#pendingToolsListIds.add(id);
      this.onmessage?.(message, extra);
    };
    await this.#transport.start();
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    const id = responseId(message);
    if (id === undefined || !this.#pendingToolsListIds.delete(id)) {
      await this.#transport.send(message, options);
      return;
    }
    let projected = message;
    if ("result" in message) {
      try {
        projected = projectToolsListResponse(message, this.#filterTools);
      } catch (error) {
        projected = internalErrorResponse(message, error);
      }
    }
    await this.#transport.send(projected, options);
  }

  async close(): Promise<void> {
    this.#pendingToolsListIds.clear();
    await this.#transport.close();
  }
}
