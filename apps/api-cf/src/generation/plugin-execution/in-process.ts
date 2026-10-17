import type {
  ExecutorContextOverrides,
  PluginModule,
} from "@clash/action-sdk/browser";
import {
  ExecutablePluginResultSchema,
  type ExecutablePluginResult,
} from "@clash/shared-types/executable-plugin";

import type {
  PluginExecutionPort,
  PluginExecutionRequest,
} from "@clash/shared-runtime/executable-plugin-port";

export interface InProcessPluginExecutionOptions {
  /** First-party modules registered in code; never discovered from user input. */
  modules: ReadonlyMap<string, PluginModule>;
  /** Host services bound for one invocation: credentials, upload, references. */
  context(
    request: PluginExecutionRequest,
  ):
    | ExecutorContextOverrides
    | Promise<ExecutorContextOverrides>;
}

/**
 * Successful submit results keyed by the durable invocation identity.
 *
 * A Worker may lose the isolate between a plugin return and the engine's
 * checkpoint. The journal retries the same invocationId; replaying this
 * result avoids a second upstream submission for the same frozen run. The
 * cache is per-isolate and deliberately does not persist plugin output or
 * credentials; the journal remains the authority across isolates.
 */
const completedSubmits = new Map<string, ExecutablePluginResult>();
const COMPLETED_SUBMITS_LIMIT = 256;

function rememberSubmit(key: string, result: ExecutablePluginResult) {
  completedSubmits.delete(key);
  completedSubmits.set(key, result);
  while (completedSubmits.size > COMPLETED_SUBMITS_LIMIT) {
    const oldest = completedSubmits.keys().next().value;
    if (oldest === undefined) break;
    completedSubmits.delete(oldest);
  }
}

function submitCacheKey(request: PluginExecutionRequest): string {
  return [
    request.invocation.target.pluginId,
    request.invocation.target.exportId,
    request.invocation.invocationId,
  ].join("\u0000");
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(message);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** In-process binding used by the Cloudflare adapter for first-party executors. */
export function createInProcessPluginExecution(
  options: InProcessPluginExecutionOptions,
): PluginExecutionPort {
  return {
    async invoke(request) {
      const invocation = request.invocation;
      if (!invocation.invocationId.trim()) {
        throw new Error("Plugin invocation requires a durable invocation id.");
      }
      const plugin = options.modules.get(invocation.target.pluginId);
      if (!plugin) {
        throw new Error(
          `Executable plugin ${invocation.target.pluginId} is not registered for in-process execution.`,
        );
      }
      if (
        !plugin.contributes.some(
          (entry) =>
            entry.id === invocation.target.exportId &&
            entry.kind === invocation.target.kind,
        )
      ) {
        throw new Error(
          `Executable plugin ${invocation.target.pluginId} does not export ` +
            `${invocation.target.kind} ${invocation.target.exportId}.`,
        );
      }
      if (invocation.operation === "submit") {
        const cached = completedSubmits.get(submitCacheKey(request));
        if (cached !== undefined) return structuredClone(cached);
      }
      const hostContext = await options.context(request);
      const result = await withTimeout(
        plugin.invoke(invocation, hostContext),
        request.timeoutMs,
        `Plugin invocation ${invocation.invocationId} timed out.`,
      );
      const parsed = ExecutablePluginResultSchema.parse(result);
      if (parsed.invocationId !== invocation.invocationId) {
        throw new Error(
          `Executable plugin ${invocation.target.pluginId} answered invocation ` +
            `${parsed.invocationId}, expected ${invocation.invocationId}.`,
        );
      }
      if (
        invocation.operation === "submit" &&
        (parsed.status === "accepted" || parsed.status === "completed")
      ) {
        rememberSubmit(submitCacheKey(request), parsed);
      }
      return parsed;
    },
  };
}
