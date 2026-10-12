import type { Hono } from "hono";
import {
  hostMutationRejected,
  hostMutationSucceeded,
  type HostMutationEnvelope,
  type HostMutationRecord,
} from "@clash/shared-types";

/**
 * Generic GET/PATCH routes for a Host-local config document.
 *
 * Each config (telemetry, …) implements `LocalConfigResource`: how to read a
 * versioned snapshot and how to apply an update. The request flow is fixed
 * here: read proof → update → audit → post-update hook → refreshed snapshot.
 * Read receipts and audit records are Host authority, so app.ts implements
 * `LocalConfigAuthority` once and every config shares it.
 */

/** Invalid input to a local config update; mapped to its HTTP status. */
export class LocalConfigError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 422 = 400,
  ) {
    super(message);
    this.name = "LocalConfigError";
  }
}

/** One version of a config document: the client view plus its version. */
export interface LocalConfigSnapshot<View extends object = object> {
  view: View;
  updatedAt: string;
}

export interface LocalConfigResource<View extends object> {
  /** Route segment and audit entity id: `/api/v1/local/<id>`. */
  readonly id: string;
  read(): Promise<LocalConfigSnapshot<View>>;
  /** Apply a PATCH body; throw `LocalConfigError` for invalid input. */
  update(body: Record<string, unknown>): Promise<void>;
  /** Runs after a committed update, e.g. to hot-reload a running service. */
  afterUpdate?(): Promise<void>;
}

export type LocalConfigGuard =
  | {
      /** The caller sent a valid read proof; return a fresh receipt. */
      kind: "guarded";
      envelope: HostMutationEnvelope;
      actorClientType?: string;
    }
  | {
      /** The caller sent no read proof (e.g. the Settings GUI). */
      kind: "unguarded";
      envelope: HostMutationEnvelope;
      actorClientType?: string;
    }
  | { kind: "rejected"; error: string; mutation: HostMutationRecord };

export interface LocalConfigMutationRequest {
  id: string;
  operation: string;
  snapshot: LocalConfigSnapshot;
  header(name: string): string | undefined;
  body: Record<string, unknown>;
}

export interface LocalConfigAuthority {
  /** Receipt-bearing read token for a snapshot. */
  readToken(id: string, snapshot: LocalConfigSnapshot): string;
  /** Check an agent's read-before-write proof against the current snapshot. */
  guardMutation(request: LocalConfigMutationRequest): LocalConfigGuard;
  audit(
    mutation: HostMutationRecord,
    actorClientType: string | undefined,
    reason: string,
  ): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function mountLocalConfigRoutes<View extends object>(
  app: Hono,
  resource: LocalConfigResource<View>,
  authority: LocalConfigAuthority,
): void {
  const path = `/api/v1/local/${resource.id}`;
  const operation = `local_${resource.id}_config_update`;
  const reason = `local ${resource.id} config update`;
  const present = (snapshot: LocalConfigSnapshot<View>) => ({
    ...snapshot.view,
    readToken: authority.readToken(resource.id, snapshot),
  });

  app.get(path, async (c) => c.json(present(await resource.read())));

  app.patch(path, async (c) => {
    const parsed: unknown = await c.req.json().catch(() => ({}));
    const body = isRecord(parsed) ? parsed : {};
    const guard = authority.guardMutation({
      id: resource.id,
      operation,
      snapshot: await resource.read(),
      header: (name) => c.req.header(name),
      body,
    });
    if (guard.kind === "rejected") {
      return c.json({ error: guard.error, mutation: guard.mutation }, 409);
    }
    try {
      await resource.update(body);
    } catch (error) {
      if (!(error instanceof LocalConfigError)) throw error;
      return c.json(
        {
          error: error.message,
          mutation: hostMutationRejected(guard.envelope, error.message),
        },
        error.status,
      );
    }
    const snapshot = await resource.read();
    const mutation = hostMutationSucceeded(guard.envelope, {
      resultEntityId: resource.id,
      ...(guard.kind === "guarded"
        ? { afterReadToken: authority.readToken(resource.id, snapshot) }
        : {}),
    });
    await authority.audit(mutation, guard.actorClientType, reason);
    // The update is committed and audited; a failing hook is reported in the
    // Host log rather than turning a saved change into an error response.
    await resource.afterUpdate?.().catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "local_config.after_update_failed",
          config: resource.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    return c.json({ ...present(snapshot), mutation });
  });
}
