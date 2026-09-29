import {
  createExecutorContext,
  executableFailureFromThrown,
  type PluginModule,
} from "@clash/action-sdk";
import {
  ExecutablePluginBrokerRequestSchema,
  ExecutablePluginInvocationSchema,
  ExecutablePluginManifestSchema,
  ExecutablePluginResultSchema,
  type ExecutablePluginManifest,
  type ExecutablePluginResult,
} from "@clash/shared-types";

import type { PluginBroker } from "./plugin-stdio-runner.js";

export interface PluginExecutionOptions {
  timeoutMs?: number;
  accountId?: string;
}

/** Transport-neutral shape used by the Host after it has selected an installed plugin. */
export interface PluginExecutionEndpoint {
  invoke(
    invocation: unknown,
    options?: PluginExecutionOptions,
  ): Promise<ExecutablePluginResult>;
  close(): void;
}

export interface ModulePluginEndpointOptions {
  manifest: unknown;
  schemaHash: `sha256:${string}`;
  module: PluginModule;
  broker: PluginBroker;
}

interface PendingModuleInvocation {
  token: symbol;
  timer: NodeJS.Timeout;
  reject(error: Error): void;
}

/** Executes one trusted, already-loaded PluginModule inside the Local Host process. */
export class ModulePluginEndpoint implements PluginExecutionEndpoint {
  readonly manifest: ExecutablePluginManifest;
  private readonly schemaHash: `sha256:${string}`;
  private readonly module: PluginModule;
  private readonly broker: PluginBroker;
  private readonly pending = new Map<string, PendingModuleInvocation>();
  private requestSequence = 0;
  private closed = false;

  constructor(options: ModulePluginEndpointOptions) {
    this.manifest = ExecutablePluginManifestSchema.parse(options.manifest);
    this.schemaHash = options.schemaHash;
    this.module = options.module;
    this.broker = options.broker;
  }

  async invoke(
    input: unknown,
    options: PluginExecutionOptions = {},
  ): Promise<ExecutablePluginResult> {
    if (this.closed) {
      throw new Error(`Plugin ${this.manifest.id} endpoint is closed.`);
    }
    const invocation = ExecutablePluginInvocationSchema.parse(input);
    if (
      invocation.target.pluginId !== this.manifest.id ||
      invocation.target.version !== this.manifest.version
    ) {
      throw new Error(
        `Invocation target ${invocation.target.pluginId}@${invocation.target.version} does not match ` +
          `${this.manifest.id}@${this.manifest.version}.`,
      );
    }
    if (invocation.target.schemaHash !== this.schemaHash) {
      throw new Error(
        `Plugin ${this.manifest.id} schema hash does not match the pinned invocation.`,
      );
    }
    const exported = this.manifest.contributes.functions.find(
      (entry) =>
        entry.id === invocation.target.exportId &&
        entry.kind === invocation.target.kind,
    );
    if (!exported) {
      throw new Error(
        `Plugin ${this.manifest.id} does not export ${invocation.target.kind} ${invocation.target.exportId}.`,
      );
    }
    if (this.pending.has(invocation.invocationId)) {
      throw new Error(
        `Invocation ${invocation.invocationId} is already running.`,
      );
    }
    const timeoutMs = options.timeoutMs ?? 120_000;
    const deadlineAt = Date.now() + timeoutMs;

    return await new Promise<ExecutablePluginResult>((resolve, reject) => {
      const token = Symbol(invocation.invocationId);
      const takePending = (): boolean => {
        const current = this.pending.get(invocation.invocationId);
        if (current?.token !== token) return false;
        clearTimeout(current.timer);
        this.pending.delete(invocation.invocationId);
        return true;
      };
      const settleIfActive = (settle: () => void): void => {
        if (!takePending()) return;
        void this.releaseInvocation(invocation.invocationId).then(settle);
      };
      const rejectIfActive = (error: Error): void => {
        settleIfActive(() => reject(error));
      };
      const timer = setTimeout(() => {
        rejectIfActive(
          new Error(`Plugin invocation ${invocation.invocationId} timed out.`),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(invocation.invocationId, {
        token,
        timer,
        reject: rejectIfActive,
      });

      void this.executeModule(
        invocation,
        options,
        deadlineAt,
        () => this.pending.get(invocation.invocationId)?.token === token,
      ).then((result) => {
        settleIfActive(() => resolve(result));
      }, rejectIfActive);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const active of [...this.pending.values()]) {
      active.reject(new Error(`Plugin ${this.manifest.id} endpoint closed.`));
    }
  }

  private async executeModule(
    invocation: ReturnType<typeof ExecutablePluginInvocationSchema.parse>,
    options: PluginExecutionOptions,
    deadlineAt: number,
    isActive: () => boolean,
  ): Promise<ExecutablePluginResult> {
    const context = createExecutorContext({}, async (operation) => {
      if (!isActive()) {
        throw new Error(
          `Plugin invocation ${invocation.invocationId} is no longer active.`,
        );
      }
      const request = ExecutablePluginBrokerRequestSchema.parse({
        protocol: "clash.plugin.broker-request/v1",
        requestId: `module-${++this.requestSequence}`,
        invocationId: invocation.invocationId,
        operation,
      });
      return await this.broker(request, {
        manifest: this.manifest,
        invocation,
        deadlineAt,
        ...(options.accountId ? { accountId: options.accountId } : {}),
      });
    });
    let rawResult: unknown;
    try {
      rawResult = await this.module.invoke(invocation, context);
    } catch (error) {
      rawResult = {
        protocol: "clash.plugin.result/v1",
        invocationId: invocation.invocationId,
        status: "failed",
        error: executableFailureFromThrown(error, invocation.operation),
      };
    }
    let result: ExecutablePluginResult;
    try {
      result = ExecutablePluginResultSchema.parse(rawResult);
    } catch (error) {
      throw new Error(
        `Plugin ${this.manifest.id} emitted an invalid result for ${invocation.invocationId}: ${(error as Error).message}`,
      );
    }
    if (result.invocationId !== invocation.invocationId) {
      throw new Error(
        `Plugin ${this.manifest.id} returned result ${result.invocationId} for active ${invocation.invocationId}.`,
      );
    }
    return result;
  }

  private async releaseInvocation(invocationId: string): Promise<void> {
    try {
      await this.broker.releaseInvocation?.(invocationId);
    } catch {
      // The result, plugin failure, timeout, or close is the primary outcome. A cleanup failure
      // cannot replace it; the concrete broker keeps its own release operation idempotent.
    }
  }
}

export function createModulePluginEndpoint(
  options: ModulePluginEndpointOptions,
): ModulePluginEndpoint {
  return new ModulePluginEndpoint(options);
}
