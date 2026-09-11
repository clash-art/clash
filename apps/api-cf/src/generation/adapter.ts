import type { DurableProviderStep } from "@clash/shared-runtime/durable-run-engine";
import type { ExecutablePluginJsonValue } from "@clash/shared-types/executable-plugin";
import type { GenerationContext } from "./context";

/** One provider submit or one status request. Waiting belongs to DurableRunEngine.
 * A completed media result must already identify a durable broker receipt. */
export interface GenerationAdapter {
  readonly name: string;
  submit(ctx: GenerationContext): Promise<DurableProviderStep>;
  poll?(
    ctx: GenerationContext,
    token: ExecutablePluginJsonValue,
  ): Promise<DurableProviderStep>;
}
