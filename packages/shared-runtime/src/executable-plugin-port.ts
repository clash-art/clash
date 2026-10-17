/**
 * The one port any realm uses to run executable plugin code.
 *
 * Upper layers never pick an adapter. A composition root registers a binding
 * in code; the port resolves that binding and runs exactly one submit or poll
 * step. The journal, retry policy, staging, and publication remain the shared
 * Durable Run Engine's job.
 */
import type { DurableRunRecord } from "./durable-run-engine.js";
import type {
  ExecutablePluginInvocation,
  ExecutablePluginResult,
} from "@clash/shared-types/executable-plugin";

export interface PluginExecutionRequest {
  run: Pick<DurableRunRecord, "actionRunId" | "outputSlot">;
  /** protocol v1; invocationId === durableRunIdempotencyKey(run) on every attempt */
  invocation: ExecutablePluginInvocation;
  /** remaining attempt lease only, never a fresh budget */
  timeoutMs: number;
}

export interface PluginExecutionPort {
  invoke(request: PluginExecutionRequest): Promise<ExecutablePluginResult>;
}

/** Where a plugin runs. Chosen in code at the composition root, never by a caller. */
export type PluginExecutionBinding =
  | {
      kind: "in-process";
      pluginId: string;
      version: string;
      schemaHash: `sha256:${string}`;
      exportId: string;
    }
  | {
      kind: "container";
      pluginId: string;
      version: string;
      schemaHash: `sha256:${string}`;
      exportId: string;
      instance: "render";
    }
  | {
      /** Endpoint and secret are per-user plugin settings resolved per invocation, never bound here. */
      kind: "remote";
      pluginId: string;
      version: string;
      schemaHash: `sha256:${string}`;
      exportId: string;
    };

export interface PluginExecutionRegistry {
  resolve(
    pluginId: string,
    exportId: string,
  ): PluginExecutionBinding | undefined;
}
