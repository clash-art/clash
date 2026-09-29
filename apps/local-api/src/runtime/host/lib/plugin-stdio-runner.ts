import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  ExecutablePluginBrokerRequestSchema,
  ExecutablePluginBrokerResponseSchema,
  ExecutablePluginInvocationSchema,
  ExecutablePluginManifestSchema,
  ExecutablePluginResultSchema,
  type ExecutablePluginBrokerRequest,
  type ExecutablePluginInvocation,
  type ExecutablePluginJsonValue,
  type ExecutablePluginManifest,
  type ExecutablePluginResult,
} from "@clash/shared-types";

export interface PluginBroker {
  (
    request: ExecutablePluginBrokerRequest,
    context: {
      manifest: ExecutablePluginManifest;
      invocation: ExecutablePluginInvocation;
      /**
       * Which provider account the host selected for this invocation.
       *
       * Part of the context, never part of the request. A plugin asking the store for a key gets this
       * account's value because the host already decided which account it is -- there is no field on
       * the wire for a plugin to name a different one. One process may serve several accounts, so the
       * binding lives with the pending invocation rather than with the process.
       */
      accountId?: string;
      /** Host-owned absolute attempt deadline; plugins cannot extend it through broker input. */
      deadlineAt?: number;
    },
  ): Promise<ExecutablePluginJsonValue>;
  /** Host-only terminal hook. It never crosses the plugin wire. */
  releaseInvocation?(invocationId: string): Promise<void> | void;
  /** Process-owner shutdown hook. Individual endpoints must not call it. */
  close?(): Promise<void> | void;
}

export interface PluginStdioSessionOptions {
  manifest: unknown;
  stdin: Writable;
  stdout: Readable;
  broker: PluginBroker;
}

interface PendingInvocation {
  invocation: ExecutablePluginInvocation;
  accountId?: string;
  deadlineAt: number;
  resolve: (result: ExecutablePluginResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class PluginStdioSession {
  readonly manifest: ExecutablePluginManifest;
  private readonly stdin: Writable;
  private readonly broker: PluginBroker;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<string, PendingInvocation>();
  private closed = false;

  constructor(options: PluginStdioSessionOptions) {
    this.manifest = ExecutablePluginManifestSchema.parse(options.manifest);
    if (
      this.manifest.runtime.kind !== "local" ||
      this.manifest.runtime.transport !== "stdio"
    ) {
      throw new Error(
        `Plugin ${this.manifest.id} is not a local stdio plugin.`,
      );
    }
    this.stdin = options.stdin;
    this.broker = options.broker;
    this.lines = createInterface({
      input: options.stdout,
      crlfDelay: Infinity,
    });
    this.lines.on("line", (line) => {
      void this.onLine(line);
    });
    this.lines.on("close", () => {
      this.failAll(
        new Error(`Plugin ${this.manifest.id} closed its stdio channel.`),
      );
    });
  }

  invoke(
    input: unknown,
    options: { timeoutMs?: number; accountId?: string } = {},
  ): Promise<ExecutablePluginResult> {
    if (this.closed)
      return Promise.reject(
        new Error(`Plugin ${this.manifest.id} session is closed.`),
      );
    const invocation = ExecutablePluginInvocationSchema.parse(input);
    if (
      invocation.target.pluginId !== this.manifest.id ||
      invocation.target.version !== this.manifest.version
    ) {
      return Promise.reject(
        new Error(
          `Invocation target ${invocation.target.pluginId}@${invocation.target.version} does not match ` +
            `${this.manifest.id}@${this.manifest.version}.`,
        ),
      );
    }
    const exported = this.manifest.contributes.functions.find(
      (entry) =>
        entry.id === invocation.target.exportId &&
        entry.kind === invocation.target.kind,
    );
    if (!exported) {
      return Promise.reject(
        new Error(
          `Plugin ${this.manifest.id} does not export ${invocation.target.kind} ${invocation.target.exportId}.`,
        ),
      );
    }
    if (this.pending.has(invocation.invocationId)) {
      return Promise.reject(
        new Error(`Invocation ${invocation.invocationId} is already running.`),
      );
    }

    const timeoutMs = options.timeoutMs ?? 120_000;
    const deadlineAt = Date.now() + timeoutMs;
    return new Promise<ExecutablePluginResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.finishInvocation(invocation.invocationId, pending, () => {
          reject(
            new Error(
              `Plugin invocation ${invocation.invocationId} timed out.`,
            ),
          );
        });
      }, timeoutMs);
      const pending: PendingInvocation = {
        invocation,
        deadlineAt,
        ...(options.accountId ? { accountId: options.accountId } : {}),
        resolve,
        reject,
        timer,
      };
      this.pending.set(invocation.invocationId, pending);
      this.write(invocation);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.failAll(new Error(`Plugin ${this.manifest.id} session closed.`));
  }

  private async onLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.failAll(
        new Error(`Plugin ${this.manifest.id} emitted invalid JSON on stdout.`),
      );
      return;
    }
    if (!message || typeof message !== "object") return;
    const protocol = (message as { protocol?: unknown }).protocol;
    if (protocol === "clash.plugin.result/v1") {
      await this.acceptResult(message);
      return;
    }
    if (protocol === "clash.plugin.broker-request/v1") {
      await this.acceptBrokerRequest(message);
    }
  }

  private async acceptResult(message: unknown): Promise<void> {
    const invocationId = (message as { invocationId?: unknown })?.invocationId;
    if (typeof invocationId !== "string") return;
    const pending = this.pending.get(invocationId);
    if (!pending) return;
    let result: ExecutablePluginResult;
    try {
      result = ExecutablePluginResultSchema.parse(message);
    } catch (error) {
      await this.finishInvocation(invocationId, pending, () => {
        pending.reject(
          new Error(
            `Plugin ${this.manifest.id} emitted an invalid result for ${invocationId}: ${(error as Error).message}`,
          ),
        );
      });
      return;
    }
    await this.finishInvocation(invocationId, pending, () => {
      pending.resolve(result);
    });
  }

  private async acceptBrokerRequest(message: unknown): Promise<void> {
    let request: ExecutablePluginBrokerRequest;
    try {
      request = ExecutablePluginBrokerRequestSchema.parse(message);
    } catch (error) {
      this.failAll(
        new Error(
          `Plugin ${this.manifest.id} emitted an invalid broker request: ${(error as Error).message}`,
        ),
      );
      return;
    }
    const pending = this.pending.get(request.invocationId);
    if (!pending) {
      this.writeBrokerError(
        request.requestId,
        "unknown_invocation",
        "Invocation is not active.",
      );
      return;
    }
    try {
      const result = await this.broker(request, {
        manifest: this.manifest,
        invocation: pending.invocation,
        deadlineAt: pending.deadlineAt,
        ...(pending.accountId ? { accountId: pending.accountId } : {}),
      });
      this.write(
        ExecutablePluginBrokerResponseSchema.parse({
          protocol: "clash.plugin.broker-response/v1",
          requestId: request.requestId,
          status: "ok",
          result,
        }),
      );
    } catch (error) {
      this.writeBrokerError(
        request.requestId,
        "broker_error",
        (error as Error).message,
      );
    }
  }

  private writeBrokerError(
    requestId: string,
    code: string,
    message: string,
  ): void {
    this.write(
      ExecutablePluginBrokerResponseSchema.parse({
        protocol: "clash.plugin.broker-response/v1",
        requestId,
        status: "error",
        error: { code, message },
      }),
    );
  }

  private write(message: ExecutablePluginInvocation | object): void {
    this.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: Error): void {
    const active = [...this.pending.entries()];
    this.pending.clear();
    for (const [invocationId, pending] of active) {
      clearTimeout(pending.timer);
      void this.releaseInvocation(invocationId).then(() => {
        pending.reject(error);
      });
    }
  }

  private async finishInvocation(
    invocationId: string,
    pending: PendingInvocation,
    settle: () => void,
  ): Promise<void> {
    if (this.pending.get(invocationId) !== pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(invocationId);
    await this.releaseInvocation(invocationId);
    settle();
  }

  private async releaseInvocation(invocationId: string): Promise<void> {
    try {
      await this.broker.releaseInvocation?.(invocationId);
    } catch {
      // Cleanup is best-effort at the endpoint boundary and must not replace the plugin result,
      // protocol error, timeout, or close error that ended the invocation.
    }
  }
}
