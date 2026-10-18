/**
 * A Host process that could not start its plugin runtime.
 *
 * The error is coded so every route that needs executable plugins can fail visibly with HTTP 503
 * instead of a bare internal error, while Project opens that need no plugins keep working.
 */
export class PluginRuntimeUnavailableError extends Error {
  override readonly name = "PluginRuntimeUnavailableError";
  readonly code = "PLUGIN_RUNTIME_UNAVAILABLE" as const;

  constructor(cause: unknown) {
    super(
      `Plugin runtime is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.detail = cause;
  }

  readonly detail: unknown;
}
