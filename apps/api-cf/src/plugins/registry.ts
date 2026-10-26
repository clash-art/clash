/**
 * Module-level plugin registry.
 *
 * Plugins are composed once at app construction (apps/api-cf/src/app.ts)
 * and stored here. Call sites — including Workflow bodies that run in
 * the same isolate but outside the Hono request lifecycle — reach the
 * composed plugin via getPlugins().
 */
import type {
  GenerationHookCtx,
  GenerationResult,
  Plugin,
  ResolvedKey,
  UserContext,
} from "./types";
import type { Hono } from "hono";
import type { Env } from "../config";

const NOOP: Plugin = { name: "noop" };

let composed: Plugin = NOOP;

/** Compose a list of plugins into a single Plugin where:
 *  - lifecycle hooks run all matching impls in registration order
 *  - resolveKey / resolveUser take the FIRST non-null result
 *  - routes.register is invoked for every plugin
 *  - billing is the first plugin's declared purchase mode
 */
export function composePlugins(plugins: Plugin[]): Plugin {
  if (plugins.length === 0) return NOOP;
  if (plugins.length === 1) return plugins[0];

  const name = `composed(${plugins.map((p) => p.name).join(",")})`;

  const authResolveUsers = plugins.flatMap((p) => (p.auth?.resolveUser ? [p.auth.resolveUser] : []));
  const genResolveKeys = plugins.flatMap((p) => (p.generation?.resolveKey ? [p.generation.resolveKey] : []));
  const beforeGenerationStarts = plugins.flatMap((p) => (p.generation?.beforeGenerationStart ? [p.generation.beforeGenerationStart] : []));
  const beforeGens = plugins.flatMap((p) => (p.generation?.beforeGenerate ? [p.generation.beforeGenerate] : []));
  const afterGens = plugins.flatMap((p) => (p.generation?.afterGenerate ? [p.generation.afterGenerate] : []));
  const onFailures = plugins.flatMap((p) => (p.generation?.onFailure ? [p.generation.onFailure] : []));
  const beforeUploads = plugins.flatMap((p) => (p.assets?.beforeUpload ? [p.assets.beforeUpload] : []));
  // One provider owns purchases: the first plugin declaring a mode wins
  // (fail closed — any "provider" plugin closes the free path).
  const billing = plugins.find((p) => p.billing)?.billing;
  const routesRegisters = plugins.flatMap((p) => (p.routes?.register ? [p.routes.register] : []));

  return {
    name,
    auth: authResolveUsers.length
      ? {
          resolveUser: async (req: Request, env: Env): Promise<UserContext | null> => {
            for (const fn of authResolveUsers) {
              const got = await fn(req, env);
              if (got) return got;
            }
            return null;
          },
        }
      : undefined,
    generation: {
      resolveKey: genResolveKeys.length
        ? async (provider: string, ctx: GenerationHookCtx): Promise<ResolvedKey | null> => {
            for (const fn of genResolveKeys) {
              const got = await fn(provider, ctx);
              if (got) return got;
            }
            return null;
          }
        : undefined,
      beforeGenerationStart: beforeGenerationStarts.length
        ? async (ctx: GenerationHookCtx): Promise<void> => {
            for (const fn of beforeGenerationStarts) await fn(ctx);
          }
        : undefined,
      beforeGenerate: beforeGens.length
        ? async (ctx: GenerationHookCtx): Promise<void> => {
            for (const fn of beforeGens) await fn(ctx);
          }
        : undefined,
      afterGenerate: afterGens.length
        ? async (ctx: GenerationHookCtx, result: GenerationResult): Promise<void> => {
            for (const fn of afterGens) await fn(ctx, result);
          }
        : undefined,
      onFailure: onFailures.length
        ? async (ctx: GenerationHookCtx, err: unknown): Promise<void> => {
            for (const fn of onFailures) {
              try {
                await fn(ctx, err);
              } catch {
                // Failure-path hooks must never mask the original error.
              }
            }
          }
        : undefined,
    },
    assets: beforeUploads.length
      ? {
          beforeUpload: async (input) => {
            for (const fn of beforeUploads) await fn(input);
          },
        }
      : undefined,
    billing,
    routes: routesRegisters.length
      ? {
          register: (app: Hono<{ Bindings: Env }>) => {
            for (const fn of routesRegisters) fn(app);
          },
        }
      : undefined,
  };
}

/** Install the composed plugin. Called once by createApp(). */
export function setPlugins(plugins: Plugin[]): void {
  composed = composePlugins(plugins);
}

/**
 * "free" (self-host, no billing plugin: core grants credits directly) or
 * "provider" (a payments plugin sells them). Fails closed: any declared
 * `billing` config, whatever its mode, closes the free path.
 */
export function billingPurchaseMode(plugin: Plugin = composed): "free" | "provider" {
  return plugin.billing ? "provider" : "free";
}

/** Read the currently-installed composed plugin. */
export function getPlugins(): Plugin {
  return composed;
}
