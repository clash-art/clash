import { PluginRuntimeUnavailableError } from "./plugin-runtime-unavailable.js";

/**
 * Single-flight gate around the Host's plugin runtime.
 *
 * The post-listen warm-up and every lazy route share one start. A failure is remembered, reported
 * once with a coded error, and replayed to later callers instead of retrying a half-started Host.
 */
export function createPluginRuntimeGate(options: {
  start(): Promise<void>;
  onReady?(ms: number): void;
  onUnavailable(error: PluginRuntimeUnavailableError, cause: unknown): void;
}): {
  ensure(): Promise<void>;
  warm(): void;
  pending(): Promise<void> | null;
} {
  let ready: Promise<void> | null = null;
  let unavailable: PluginRuntimeUnavailableError | null = null;

  const ensure = (): Promise<void> => {
    if (unavailable) return Promise.reject(unavailable);
    return (ready ??= options.start().catch((cause) => {
      const error = new PluginRuntimeUnavailableError(cause);
      unavailable = error;
      options.onUnavailable(error, cause);
      throw error;
    }));
  };

  const warm = (): void => {
    const startedAt = Date.now();
    void ensure().then(
      () => options.onReady?.(Date.now() - startedAt),
      () => {
        // The gate already reported the coded failure once.
      },
    );
  };

  return { ensure, warm, pending: () => ready };
}
