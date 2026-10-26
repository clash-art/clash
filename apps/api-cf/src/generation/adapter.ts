import type { DurableProviderStep } from "@clash/shared-runtime/durable-run-engine";
import type { ExecutablePluginJsonValue } from "@clash/shared-types/executable-plugin";
import type { GenerationContext } from "./context";
import type { GenerationParams } from "./params";

/** One provider submit or one status request. Waiting belongs to DurableRunEngine.
 * A completed media result must already identify a durable broker receipt. */
export interface GenerationAdapter {
  readonly name: string;
  /**
   * True when the adapter records the provider's own usage lifecycle events
   * for this run (Pika); the hosted lifecycle then writes no usage row of its
   * own for a run on the user's provider account (generation/media-usage.ts).
   */
  recordsProviderUsage?(params: GenerationParams): boolean;
  submit(ctx: GenerationContext): Promise<DurableProviderStep>;
  poll?(
    ctx: GenerationContext,
    token: ExecutablePluginJsonValue,
  ): Promise<DurableProviderStep>;
}
