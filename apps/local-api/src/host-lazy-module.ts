/** Coded failure of a Host module that is imported on first use instead of at startup. */
export const HOST_LAZY_MODULE_LOAD_FAILED = "HOST_LAZY_MODULE_LOAD_FAILED" as const;

/**
 * A lazily imported Host module could not be loaded.
 *
 * The message carries the code too, so a route that only forwards `error.message` still tells the
 * caller which module failed and why.
 */
export class HostLazyModuleLoadError extends Error {
  override readonly name = "HostLazyModuleLoadError";
  readonly code = HOST_LAZY_MODULE_LOAD_FAILED;

  constructor(
    readonly module: string,
    readonly detail: unknown,
  ) {
    super(
      `${HOST_LAZY_MODULE_LOAD_FAILED}: Host module ${module} could not be loaded: ${detail instanceof Error ? detail.message : String(detail)}`,
    );
  }
}

/**
 * Single-flight loader for a Host module that is not needed before the first request using it.
 *
 * Startup evaluates only what listening, discovery and `/health` need; rarely used dependencies
 * (object storage, image codecs, OTLP exporters) are imported through one of these on first use.
 * Concurrent callers share one import. A failed import is remembered and replayed as the same coded
 * {@link HostLazyModuleLoadError}, so every caller fails visibly instead of hanging or retrying a
 * broken installation.
 */
export function createHostLazyModule<T>(
  module: string,
  load: () => Promise<T>,
): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= Promise.resolve()
      .then(load)
      .catch((cause: unknown) => {
        throw new HostLazyModuleLoadError(module, cause);
      }));
}
