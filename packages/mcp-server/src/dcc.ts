import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type DccInput = {
  app: "blender" | "maya";
  cwd?: string;
  name?: string;
  code?: string;
  assetId?: string;
  file?: string;
  tool?: string;
  toolArguments?: Record<string, unknown>;
};

export interface DccGateway {
  invoke(
    action: string,
    input: DccInput,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

class DccError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const connectionSchema = z.object({
  protocol: z.literal(1),
  app: z.enum(["blender", "maya"]),
  workspace: z.string(),
  port: z.number().int().min(1).max(65535),
  sessionId: z.string().regex(/^[a-f0-9]{32}$/),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

export function createDccGateway(
  options: { discoveryRoot?: string; timeoutMs?: number } = {},
): DccGateway {
  return {
    async invoke(action, { app, cwd, ...params }, signal) {
      const workspace = await realpath(
        resolve(cwd || process.env.CLASH_WORKSPACE_ROOT || process.cwd()),
      );
      const key = createHash("sha256")
        .update(
          process.platform === "win32" ? workspace.toLowerCase() : workspace,
        )
        .digest("hex");
      let record: z.infer<typeof connectionSchema>;
      try {
        record = connectionSchema.parse(
          JSON.parse(
            await readFile(
              join(
                options.discoveryRoot ??
                  join(homedir(), ".clash", "dcc-connections"),
                key,
                `${app}.json`,
              ),
              "utf8",
            ),
          ),
        );
      } catch {
        throw new DccError(
          "DCC_NOT_CONNECTED",
          `Open the Clash plugin in ${app}, choose this working folder and connect agent control. No separate MCP configuration is needed.`,
        );
      }
      if (
        record.app !== app ||
        (await realpath(record.workspace)) !== workspace
      ) {
        throw new DccError(
          "DCC_SCOPE_MISMATCH",
          "The native plugin is connected to a different workspace. Reconnect it to this working folder.",
        );
      }
      const id = randomUUID();
      const timeoutMs = options.timeoutMs ?? 180_000;
      return new Promise((resolveResult, reject) => {
        if (signal?.aborted) {
          reject(new Error("DCC request cancelled before execution."));
          return;
        }
        const socket = connect({ host: "127.0.0.1", port: record.port });
        let sent = false;
        let buffer = Buffer.alloc(0);
        const finish = (error?: Error, value?: Record<string, unknown>) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          socket.removeAllListeners();
          socket.destroy();
          if (error) reject(error);
          else resolveResult(value ?? {});
        };
        const unknownResult = () =>
          new DccError(
            sent ? "DCC_RESULT_UNKNOWN" : "DCC_UNAVAILABLE",
            sent
              ? "DCC_RESULT_UNKNOWN: connection ended before acknowledgement. The operation may have executed; inspect scene and assets before issuing another mutation."
              : "DCC_UNAVAILABLE: reopen the native Clash plugin and reconnect this working folder.",
          );
        const abort = () => finish(unknownResult());
        const timer = setTimeout(abort, timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        socket.on("connect", () => {
          sent = true;
          socket.write(
            JSON.stringify({
              id,
              sessionId: record.sessionId,
              token: record.token,
              action,
              params,
              expiresAt: Date.now() + timeoutMs,
            }) + "\n",
          );
        });
        socket.on("error", () => finish(unknownResult()));
        socket.on("end", () => finish(unknownResult()));
        socket.on("data", (data) => {
          buffer = Buffer.concat([buffer, data]);
          if (buffer.length > 16 * 1024 * 1024) {
            finish(
              new Error(
                "DCC response exceeds the limit; inspect scene before retrying.",
              ),
            );
            return;
          }
          const boundary = buffer.indexOf(10);
          if (boundary < 0) return;
          try {
            const response = JSON.parse(
              buffer.subarray(0, boundary).toString("utf8"),
            );
            if (response.id !== id)
              throw new Error(
                "Native plugin returned a mismatched request identity.",
              );
            if (response.ok !== true)
              throw new DccError(
                response.error?.code ?? "DCC_ERROR",
                response.error?.message ?? "Native operation failed",
              );
            if (
              !response.value ||
              typeof response.value !== "object" ||
              Array.isArray(response.value)
            )
              throw new Error(
                "Native plugin returned an invalid result object.",
              );
            finish(undefined, response.value);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    },
  };
}

export function registerClashDccMcp(
  server: Pick<McpServer, "registerTool">,
  gateway: DccGateway = createDccGateway(),
): void {
  const scope = {
    app: z
      .enum(["blender", "maya"])
      .describe("Native application with the Clash plugin connected"),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Clash project working folder; defaults to the agent workspace",
      ),
  };
  const definitions: Array<{
    action: string;
    title: string;
    description: string;
    schema?: Record<string, z.ZodTypeAny>;
    readOnly?: boolean;
  }> = [
    {
      action: "maya_tools",
      title: "Discover bundled Maya operations",
      description:
        "Read MayaMCP-derived modeling, material, object and scene tool descriptions and JSON input schemas from the connected Maya plugin. Read this before maya_call. Maya only.",
      schema: { app: z.literal("maya") },
      readOnly: true,
    },
    {
      action: "maya_call",
      title: "Run a bundled Maya operation",
      description:
        "Execute one packaged Maya operation discovered through dcc_maya_tools. Pass its exact tool name and arguments matching its inputSchema. May modify scene or files; inspect the scene after errors before retrying. Use Clash Asset operations for material import and publication.",
      schema: {
        app: z.literal("maya"),
        tool: z.string().min(1),
        toolArguments: z.record(z.string(), z.unknown()),
      },
    },
    {
      action: "capabilities",
      title: "Native plugin capabilities",
      description:
        "Read the connected Blender/Maya version and supported control and material workflows.",
      readOnly: true,
    },
    {
      action: "scene",
      title: "Read native scene",
      description:
        "Inspect the live Blender/Maya scene, selection, objects and current file before making changes.",
      readOnly: true,
    },
    {
      action: "object",
      title: "Read native object",
      description:
        "Read one object's transforms, type and material connections.",
      schema: { name: z.string().min(1) },
      readOnly: true,
    },
    {
      action: "screenshot",
      title: "Inspect native viewport",
      description:
        "Capture the current viewport as a PNG image for visual inspection. Requires a visible 3D viewport.",
      readOnly: true,
    },
    {
      action: "execute",
      title: "Execute native Python",
      description:
        "Run Python inside the connected application for modeling, materials, cameras, animation, rendering or other native API work. Full local Python access, not a sandbox. bpy (Blender) or cmds (Maya) is provided. Assign JSON-compatible output to result. Mutations may partially apply on error: inspect the scene before retrying.",
      schema: { code: z.string().min(1).max(100_000) },
    },
    {
      action: "import_asset",
      title: "Import Clash Asset into native scene",
      description:
        "Receive an independent Project Asset copy and import it with the native adapter: Blender GLB/images; Maya image texture. Retains the Clash Asset ID on imported data. Use Clash Assets tools to find the asset first.",
      schema: { assetId: z.string().min(1) },
    },
    {
      action: "publish_file",
      title: "Publish native output to Clash",
      description:
        "Publish a saved material/render file from this working folder as an immutable Clash Project Asset; returns its Asset ID. Host validates the format and bytes. Does not overwrite an existing Asset.",
      schema: {
        file: z
          .string()
          .min(1)
          .describe("File within the connected project working folder"),
      },
    },
    {
      action: "export_selection",
      title: "Publish selected Blender model",
      description:
        "Export selected Blender objects as a self-contained GLB and publish it to Clash, returning the Asset ID and local export path. Blender only; Maya may use execute to export and publish_file for Host-supported media.",
    },
  ];
  for (const definition of definitions) {
    server.registerTool(
      `clash_plugin_dcc_${definition.action}`,
      {
        title: definition.title,
        description: `${definition.description} No separate Blender/Maya MCP setup is required.`,
        inputSchema: { ...scope, ...definition.schema },
        annotations: {
          readOnlyHint: definition.readOnly === true,
          destructiveHint:
            definition.action === "execute" ||
            definition.action === "maya_call",
          openWorldHint: true,
        },
        _meta: { ui: { visibility: ["model"] } },
      },
      async (input, extra) => {
        try {
          const value = await gateway.invoke(
            definition.action,
            input as unknown as DccInput,
            extra.signal,
          );
          if (definition.action === "screenshot") {
            const parsed = z
              .object({
                mimeType: z.literal("image/png"),
                data: z.string().min(1),
              })
              .parse(value);
            return { content: [{ type: "image" as const, ...parsed }] };
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value) }],
            structuredContent: value,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const code =
            error instanceof DccError ? error.code : "DCC_OPERATION_FAILED";
          return {
            isError: true,
            content: [{ type: "text" as const, text: message }],
            structuredContent: {
              error: {
                code,
                message,
                ...(!definition.readOnly && code !== "DCC_NOT_CONNECTED"
                  ? {
                      recovery: {
                        guidance:
                          "Inspect current scene and Project Assets before another mutation; failures may have partially applied.",
                        inspectTool: {
                          name: "clash_plugin",
                          arguments: {
                            operation: "dcc_scene",
                            arguments: {
                              app: input.app,
                              ...(input.cwd ? { cwd: input.cwd } : {}),
                            },
                          },
                        },
                      },
                    }
                  : {}),
              },
            },
          };
        }
      },
    );
  }
}
