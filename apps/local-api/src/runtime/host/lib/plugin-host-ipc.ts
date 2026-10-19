import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ExecutablePluginBindingSchema,
  ExecutablePluginCardRegistrationSchema,
  ExecutablePluginFunctionExportSchema,
  ExecutablePluginGeneratorRegistrationSchema,
  ExecutablePluginViewRegistrationSchema,
  ExecutablePluginModelBindingRegistrationSchema,
  ExecutablePluginProviderRegistrationSchema,
  ExecutablePluginInvocationSchema,
  ExecutablePluginResultSchema,
  GeneratorDefinitionSchema,
  type ExecutablePluginBinding,
  type ExecutablePluginCardRegistration,
  type ExecutablePluginFunctionExport,
  type ExecutablePluginGeneratorRegistration,
  type ExecutablePluginViewRegistration,
  type ExecutablePluginModelBindingRegistration,
  type ExecutablePluginProviderRegistration,
  type ExecutablePluginInvocation,
  type ExecutablePluginResult,
  type GeneratorDefinition,
} from "@clash/shared-types";

import { paths } from "./platform.js";

export interface PluginInvocationHost {
  listCards(): ExecutablePluginCardRegistration[];
  listProviders?(): ExecutablePluginProviderRegistration[];
  listModelBindings?(): ExecutablePluginModelBindingRegistration[];
  listGenerators?(): ExecutablePluginGeneratorRegistration[];
  listViews?(): ExecutablePluginViewRegistration[];
  resolveGeneratorDefinition?(
    pluginId: string,
    definitionId: string,
  ): GeneratorDefinition;
  listFunctionExports?(pluginId: string): ExecutablePluginFunctionExport[];
  resolveBinding(
    pluginId: string,
    exportId: string,
    kind: PluginFunctionKind,
  ): ExecutablePluginBinding;
  invoke(
    pluginId: string,
    invocation: unknown,
    options?: { timeoutMs?: number; accountId?: string },
  ): Promise<ExecutablePluginResult>;
}

interface PluginHostRequestBase {
  protocol: "clash.plugin-host/v1";
  requestId: string;
}

type PluginHostRequest = PluginHostRequestBase &
  (
    | {
        operation: "list-cards";
      }
    | {
        operation: "list-providers";
      }
    | {
        operation: "list-model-bindings";
      }
    | {
        operation: "list-generators";
      }
    | {
        operation: "list-views";
      }
    | {
        operation: "list-function-exports";
        pluginId: string;
      }
    | {
        operation: "resolve";
        pluginId: string;
        exportId: string;
        kind: PluginFunctionKind;
      }
    | {
        operation: "resolve-generator";
        pluginId: string;
        definitionId: string;
      }
    | {
        operation: "invoke";
        pluginId: string;
        invocation: ExecutablePluginInvocation;
        timeoutMs?: number;
        accountId?: string;
      }
  );

type PluginHostResponse =
  | {
      protocol: "clash.plugin-host/v1";
      requestId: string;
      status: "ok";
      result: unknown;
    }
  | {
      protocol: "clash.plugin-host/v1";
      requestId: string;
      status: "error";
      error: { code: string; message: string };
    };

/**
 * The largest IPC frame the plugin host will accept.
 *
 * A frame carries control information, not media. References travel as `clash-asset://` handles the
 * plugin resolves through the broker, so the size of a generation does not grow with its inputs.
 *
 * Inlining media here does not scale: a Card may accept a 30 MB reference image and several of them,
 * so the frame would have to be ~100 MB and every byte would be base64-expanded and copied on both
 * sides -- to move a file between two processes on the same machine. Two ordinary generated PNGs
 * (2.26 MB and 2.64 MB encoded) overflowed the previous 4 MB limit and, because the guard answered
 * with `requestId: "unknown"`, the failure surfaced as "mismatched response".
 */
/**
 * Every plugin function kind, mirroring the shared schema.
 *
 * `provider-executor` was absent from the `resolve` check even though the schema has listed it all
 * along, so a generation served by a plugin provider failed with "Invalid plugin function kind" --
 * the protocol rejecting the only kind that does the work.
 */
export const PLUGIN_FUNCTION_KINDS = [
  "action",
  "provider-projector",
  "provider-executor",
] as const;

/**
 * Derived from the runtime list so the two cannot disagree.
 *
 * They were separate declarations of one fact, and they drifted: the array gained
 * `provider-executor` -- the only kind that runs a generation -- while the type kept two members, so
 * the value passed the protocol check and then failed to compile at the call site.
 */
type PluginFunctionKind = (typeof PLUGIN_FUNCTION_KINDS)[number];

// No frame ceiling. The accumulating string has V8's own, which is real and unconfigurable.
// macOS permits at most 103 address bytes for a Unix-domain socket (Linux
// permits 107). Keep a little headroom so the same path is portable and Node
// never silently binds a truncated address that cannot subsequently be chmod'd.
const UNIX_SOCKET_PATH_BUDGET_BYTES = 96;

// Starting two embedded hosts for the same Unix socket must be one atomic
// operation. Without this queue, both callers can observe a stale/missing
// path, then one caller can unlink the socket after the other has started
// listening but before it chmods the path. The resulting ENOENT takes down
// the local daemon and leaves neither caller as a reliable owner.
const socketStartupTails = new Map<string, Promise<void>>();

async function withSocketStartupLock<T>(
  socketPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = socketStartupTails.get(socketPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  socketStartupTails.set(socketPath, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (socketStartupTails.get(socketPath) === current) {
      socketStartupTails.delete(socketPath);
    }
  }
}

export function pluginHostSocketPath(
  env: Record<string, string | undefined> = process.env,
  configDir = paths().configDir,
): string {
  const explicit = env.CLASH_PLUGIN_HOST_SOCKET?.trim();
  if (explicit) return explicit;
  if (process.platform === "win32") {
    const suffix = createHash("sha256")
      .update(configDir)
      .digest("hex")
      .slice(0, 16);
    return `\\\\.\\pipe\\clash-plugin-host-${suffix}`;
  }
  const preferred = join(configDir, "sockets", "plugin-host.sock");
  if (Buffer.byteLength(preferred) <= UNIX_SOCKET_PATH_BUDGET_BYTES)
    return preferred;

  const suffix = createHash("sha256")
    .update(configDir)
    .digest("hex")
    .slice(0, 16);
  const basename = `clash-plugin-host-${suffix}.sock`;
  const temporary = join(tmpdir(), basename);
  return Buffer.byteLength(temporary) <= UNIX_SOCKET_PATH_BUDGET_BYTES
    ? temporary
    : join("/tmp", basename);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function parseRequest(value: unknown): PluginHostRequest {
  if (!value || typeof value !== "object")
    throw new Error("Plugin host request must be an object.");
  const request = value as Record<string, unknown>;
  if (request.protocol !== "clash.plugin-host/v1")
    throw new Error("Unsupported plugin host protocol.");
  const requestId = nonEmptyString(request.requestId, "requestId");
  if (request.operation === "list-function-exports") {
    return {
      protocol: "clash.plugin-host/v1",
      requestId,
      operation: "list-function-exports",
      pluginId: nonEmptyString(request.pluginId, "pluginId"),
    };
  }
  if (
    request.operation === "list-providers" ||
    request.operation === "list-model-bindings" ||
    request.operation === "list-generators" ||
    request.operation === "list-views"
  ) {
    return {
      protocol: "clash.plugin-host/v1",
      requestId,
      operation: request.operation,
    };
  }
  if (request.operation === "list-cards") {
    return {
      protocol: "clash.plugin-host/v1",
      requestId,
      operation: "list-cards",
    };
  }
  const pluginId = nonEmptyString(request.pluginId, "pluginId");
  if (request.operation === "resolve-generator") {
    return {
      protocol: "clash.plugin-host/v1",
      requestId,
      operation: "resolve-generator",
      pluginId,
      definitionId: nonEmptyString(request.definitionId, "definitionId"),
    };
  }
  if (request.operation === "resolve") {
    if (!PLUGIN_FUNCTION_KINDS.includes(request.kind as PluginFunctionKind)) {
      throw new Error(
        `Invalid plugin function kind ${JSON.stringify(request.kind)}; expected one of ${PLUGIN_FUNCTION_KINDS.join(", ")}.`,
      );
    }
    return {
      protocol: "clash.plugin-host/v1",
      requestId,
      operation: "resolve",
      pluginId,
      exportId: nonEmptyString(request.exportId, "exportId"),
      kind: request.kind as PluginFunctionKind,
    };
  }
  if (request.operation === "invoke") {
    const timeoutMs =
      request.timeoutMs === undefined ? undefined : Number(request.timeoutMs);
    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    ) {
      throw new Error("timeoutMs must be positive.");
    }
    const accountId =
      request.accountId === undefined
        ? undefined
        : nonEmptyString(request.accountId, "accountId");
    return {
      protocol: "clash.plugin-host/v1",
      requestId,
      operation: "invoke",
      pluginId,
      invocation: ExecutablePluginInvocationSchema.parse(request.invocation),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(accountId !== undefined ? { accountId } : {}),
    };
  }
  throw new Error("Unknown plugin host operation.");
}

/**
 * Reads `requestId` out of a frame that has not finished arriving.
 *
 * The size guard fires before the frame can be parsed, and answering with `"unknown"` made the
 * client report a mismatched response rather than an oversize request. The id sits near the front of
 * every frame, so a narrow scan recovers it.
 */
export function requestIdFromPartialFrame(partial: string): string {
  const match = /"requestId"\s*:\s*"([^"]+)"/.exec(partial);
  return match?.[1] ?? "unknown";
}

/**
 * Sends one response and closes the socket, tolerating a peer that is already gone.
 *
 * A reply ends the connection, so a second reply on the same socket used to write after end. The
 * rejection escaped an unguarded `.then()` and killed the host process, abandoning whatever
 * generations were queued. An undeliverable response is the client's problem: the host logs it and
 * stays up.
 */
export function writePluginHostResponse(
  socket: Socket,
  response: PluginHostResponse,
): void {
  if (socket.writableEnded || socket.destroyed) return;
  try {
    socket.end(`${JSON.stringify(response)}\n`);
  } catch (error) {
    console.warn(
      `[plugin-host] dropping response ${response.requestId}: ${(error as Error).message}`,
    );
  }
}

async function handleRequest(
  host: PluginInvocationHost,
  input: unknown,
): Promise<PluginHostResponse> {
  let requestId = "unknown";
  try {
    if (input && typeof input === "object" && "requestId" in input) {
      requestId = String((input as { requestId: unknown }).requestId);
    }
    const request = parseRequest(input);
    requestId = request.requestId;
    if (request.operation === "list-providers") {
      return {
        protocol: "clash.plugin-host/v1",
        requestId,
        status: "ok",
        result: ExecutablePluginProviderRegistrationSchema.array().parse(
          host.listProviders?.() ?? [],
        ),
      };
    }
    if (request.operation === "list-function-exports") {
      return {
        protocol: "clash.plugin-host/v1",
        requestId,
        status: "ok",
        result: ExecutablePluginFunctionExportSchema.array().parse(
          host.listFunctionExports?.(request.pluginId) ?? [],
        ),
      };
    }
    if (request.operation === "list-model-bindings") {
      return {
        protocol: "clash.plugin-host/v1",
        requestId,
        status: "ok",
        result: ExecutablePluginModelBindingRegistrationSchema.array().parse(
          host.listModelBindings?.() ?? [],
        ),
      };
    }
    if (request.operation === "list-generators") {
      return {
        protocol: "clash.plugin-host/v1",
        requestId,
        status: "ok",
        result: ExecutablePluginGeneratorRegistrationSchema.array().parse(
          host.listGenerators?.() ?? [],
        ),
      };
    }
    if (request.operation === "list-views") {
      return {
        protocol: "clash.plugin-host/v1",
        requestId,
        status: "ok",
        result: ExecutablePluginViewRegistrationSchema.array().parse(
          host.listViews?.() ?? [],
        ),
      };
    }
    if (request.operation === "list-cards") {
      return {
        protocol: "clash.plugin-host/v1",
        requestId,
        status: "ok",
        result: ExecutablePluginCardRegistrationSchema.array().parse(
          host.listCards(),
        ),
      };
    }
    if (request.operation === "resolve") {
      return {
        protocol: "clash.plugin-host/v1",
        requestId,
        status: "ok",
        result: ExecutablePluginBindingSchema.parse(
          host.resolveBinding(request.pluginId, request.exportId, request.kind),
        ),
      };
    }
    if (request.operation === "resolve-generator") {
      if (!host.resolveGeneratorDefinition) {
        throw new Error("Generator definition resolution is unavailable.");
      }
      return {
        protocol: "clash.plugin-host/v1",
        requestId,
        status: "ok",
        result: GeneratorDefinitionSchema.parse(
          host.resolveGeneratorDefinition(
            request.pluginId,
            request.definitionId,
          ),
        ),
      };
    }
    return {
      protocol: "clash.plugin-host/v1",
      requestId,
      status: "ok",
      result: ExecutablePluginResultSchema.parse(
        await host.invoke(request.pluginId, request.invocation, {
          ...(request.timeoutMs === undefined
            ? {}
            : { timeoutMs: request.timeoutMs }),
          ...(request.accountId === undefined
            ? {}
            : { accountId: request.accountId }),
        }),
      ),
    };
  } catch (error) {
    return {
      protocol: "clash.plugin-host/v1",
      requestId,
      status: "error",
      error: {
        code: "plugin_host_error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export interface PluginHostIpcServer {
  socketPath: string;
  close(): Promise<void>;
}

async function socketIsActive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(active);
    };
    const timer = setTimeout(() => finish(false), 200);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function startPluginHostIpcServer(options: {
  host: PluginInvocationHost;
  socketPath?: string;
}): Promise<PluginHostIpcServer> {
  const socketPath = options.socketPath ?? pluginHostSocketPath();
  return withSocketStartupLock(socketPath, async () => {
    if (process.platform !== "win32") {
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
      if (await socketIsActive(socketPath)) {
        const error = new Error(
          `Clash plugin host is already listening at ${socketPath}.`,
        ) as NodeJS.ErrnoException;
        error.code = "EADDRINUSE";
        throw error;
      }
      await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    const server: Server = createServer((socket) => {
      let buffer = "";
      // One request, one response, one socket: the reply ends the connection, so anything arriving
      // afterwards must not produce a second write.
      let answered = false;
      socket.on("data", (chunk) => {
        if (answered) return;
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = "";
        answered = true;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch (error) {
          writePluginHostResponse(socket, {
            protocol: "clash.plugin-host/v1",
            requestId: "unknown",
            status: "error",
            error: { code: "invalid_json", message: (error as Error).message },
          });
          return;
        }
        void handleRequest(options.host, message)
          .then((response) => writePluginHostResponse(socket, response))
          .catch((error: unknown) => {
            console.warn(
              `[plugin-host] request failed after reply: ${(error as Error).message}`,
            );
          });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") await chmod(socketPath, 0o600);

    return {
      socketPath,
      close: async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        if (process.platform !== "win32") {
          await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      },
    };
  });
}

/**
 * The plugin-host transport could not answer a request: stopped, hung, or speaking
 * something other than the expected protocol. Coded so a project edit can report
 * the affected node's failure instead of a bare message.
 */
export class PluginHostUnavailableError extends Error {
  override readonly name = "PluginHostUnavailableError";
  readonly code = "PLUGIN_HOST_UNAVAILABLE" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class PluginHostClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(options: { socketPath?: string; timeoutMs?: number } = {}) {
    this.socketPath = options.socketPath ?? pluginHostSocketPath();
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async listCards(): Promise<ExecutablePluginCardRegistration[]> {
    return ExecutablePluginCardRegistrationSchema.array().parse(
      await this.request({
        protocol: "clash.plugin-host/v1",
        requestId: randomUUID(),
        operation: "list-cards",
      }),
    );
  }

  /**
   * Providers and model bindings the loaded plugins export.
   *
   * `local-api` has always called both; they existed only inside a committed host bundle under this
   * package's `dist`, so rebuilding from source removed them and the host died on its first model
   * listing. Declared here so the source is the definition.
   */
  async listProviders(): Promise<ExecutablePluginProviderRegistration[]> {
    return ExecutablePluginProviderRegistrationSchema.array().parse(
      await this.request({
        protocol: "clash.plugin-host/v1",
        requestId: randomUUID(),
        operation: "list-providers",
      }),
    );
  }

  async listModelBindings(): Promise<
    ExecutablePluginModelBindingRegistration[]
  > {
    return ExecutablePluginModelBindingRegistrationSchema.array().parse(
      await this.request({
        protocol: "clash.plugin-host/v1",
        requestId: randomUUID(),
        operation: "list-model-bindings",
      }),
    );
  }

  async listGenerators(): Promise<ExecutablePluginGeneratorRegistration[]> {
    return ExecutablePluginGeneratorRegistrationSchema.array().parse(
      await this.request({
        protocol: "clash.plugin-host/v1",
        requestId: randomUUID(),
        operation: "list-generators",
      }),
    );
  }

  async listViews(): Promise<ExecutablePluginViewRegistration[]> {
    return ExecutablePluginViewRegistrationSchema.array().parse(
      await this.request({
        protocol: "clash.plugin-host/v1",
        requestId: randomUUID(),
        operation: "list-views",
      }),
    );
  }

  /**
   * What one plugin's entry points say they can do.
   *
   * Read by the host before it believes an acceptance: a plugin that takes work it cannot be asked
   * about again has spent money nobody can collect. Declaring this method without implementing it
   * made every acceptance fail closed, which is the safe direction but not a working one.
   */
  async listFunctionExports(
    pluginId: string,
  ): Promise<ExecutablePluginFunctionExport[]> {
    return ExecutablePluginFunctionExportSchema.array().parse(
      await this.request({
        protocol: "clash.plugin-host/v1",
        requestId: randomUUID(),
        operation: "list-function-exports",
        pluginId,
      }),
    );
  }

  async resolveBinding(
    pluginId: string,
    exportId: string,
    kind: PluginFunctionKind,
  ): Promise<ExecutablePluginBinding> {
    return ExecutablePluginBindingSchema.parse(
      await this.request({
        protocol: "clash.plugin-host/v1",
        requestId: randomUUID(),
        operation: "resolve",
        pluginId,
        exportId,
        kind,
      }),
    );
  }

  async resolveGeneratorDefinition(
    pluginId: string,
    definitionId: string,
  ): Promise<GeneratorDefinition> {
    return GeneratorDefinitionSchema.parse(
      await this.request({
        protocol: "clash.plugin-host/v1",
        requestId: randomUUID(),
        operation: "resolve-generator",
        pluginId,
        definitionId,
      }),
    );
  }

  async invoke(
    pluginId: string,
    invocation: ExecutablePluginInvocation,
    options: { timeoutMs?: number; accountId?: string } = {},
  ): Promise<ExecutablePluginResult> {
    return ExecutablePluginResultSchema.parse(
      await this.request({
        protocol: "clash.plugin-host/v1",
        requestId: randomUUID(),
        operation: "invoke",
        pluginId,
        invocation: ExecutablePluginInvocationSchema.parse(invocation),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.accountId ? { accountId: options.accountId } : {}),
      }),
    );
  }

  private request(request: PluginHostRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const requestTimeoutMs =
        request.operation === "invoke" && request.timeoutMs
          ? Math.max(this.timeoutMs, request.timeoutMs + 1_000)
          : this.timeoutMs;
      const timer = setTimeout(
        () =>
          finish(
            new PluginHostUnavailableError(
              `Clash plugin host IPC timed out after ${requestTimeoutMs} ms.`,
            ),
          ),
        requestTimeoutMs,
      );
      socket.once("connect", () =>
        socket.write(`${JSON.stringify(request)}\n`),
      );
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(
            buffer.slice(0, newline),
          ) as PluginHostResponse;
          if (
            response.protocol !== "clash.plugin-host/v1" ||
            response.requestId !== request.requestId
          ) {
            throw new PluginHostUnavailableError(
              "Clash plugin host returned a mismatched response.",
            );
          }
          if (response.status === "error") {
            const failure = new Error(response.error.message) as Error & {
              code?: string;
            };
            if (response.error.code) failure.code = response.error.code;
            finish(failure);
          } else finish(undefined, response.result);
        } catch (error) {
          finish(
            error instanceof PluginHostUnavailableError
              ? error
              : new PluginHostUnavailableError(
                  `Clash plugin host returned an invalid response: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                  { cause: error },
                ),
          );
        }
      });
      socket.once("error", (error) =>
        finish(
          new PluginHostUnavailableError(
            `Clash plugin host IPC failed: ${error.message}`,
            { cause: error },
          ),
        ),
      );
      socket.once("close", () => {
        if (!settled)
          finish(
            new PluginHostUnavailableError(
              "Clash plugin host closed without a response.",
            ),
          );
      });
    });
  }
}
