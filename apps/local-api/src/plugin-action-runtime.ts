import {
  ExecutablePluginResultSchema,
  type ExecutablePluginInvocation,
  type ExecutablePluginResult,
} from "@clash/shared-types";
import {
  executablePluginActionInvocation,
  type ExecutablePluginActionInvoker,
} from "@clash/shared-runtime/executable-run";

export type {
  ExecutablePluginActionInvoker,
  ExecutablePluginActionRequest,
} from "@clash/shared-runtime/executable-run";

export interface ExecutablePluginActionClient {
  invoke(
    pluginId: string,
    invocation: ExecutablePluginInvocation,
    options?: { timeoutMs?: number },
  ): Promise<ExecutablePluginResult>;
}

export function createExecutablePluginActionInvoker(options: {
  client: ExecutablePluginActionClient;
  timeoutMs?: number;
}): ExecutablePluginActionInvoker {
  return async (request) => {
    const invocation = executablePluginActionInvocation(request);
    return ExecutablePluginResultSchema.parse(
      await options.client.invoke(invocation.target.pluginId, invocation, {
        timeoutMs: request.timeoutMs ?? options.timeoutMs ?? 1_800_000,
      }),
    );
  };
}
