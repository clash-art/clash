/**
 * Lazy Better Auth loader (#142). better-auth + kysely + its plugins cost
 * ~20 ms of Worker startup CPU and ~1.7 MB of evaluated JS. Most requests
 * never need them: session reads go through the one-query verifier
 * (session-fast.ts), API tokens and Durable Object traffic never touch them.
 * The bundler keeps `../auth` in the bundle but defers its evaluation to the
 * first call.
 */
import type { AuthBindings } from "../auth";

export type { AuthBindings };

let authModule: Promise<typeof import("../auth")> | undefined;

export function loadAuth(): Promise<typeof import("../auth")> {
  authModule ??= import("../auth");
  authModule.catch(() => {
    authModule = undefined;
  });
  return authModule;
}
