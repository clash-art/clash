/**
 * Node wiring for the shared voice-input contract. The HTTP routes, catalog
 * selection and Provider transcription live in shared-runtime; this module
 * supplies PostgreSQL read models and usage audit.
 */
import type { Hono } from "hono";
import type { PostgresQueryPort } from "@clash/shared-runtime/project-authorization-postgres";
import {
  createHostedVoiceInputPorts,
  type VoiceInputPorts,
} from "@clash/shared-runtime/cloud-project-host/voice-input";
import { createVoiceInputRoutes as createSharedVoiceInputRoutes } from "@clash/shared-runtime/voice-input-routes";
import {
  appendNodeProviderUsageEvent,
  getNodeProviderCredentials,
  loadNodeVoiceInputCatalog,
} from "./provider-settings.ts";

export interface NodeVoiceInputOptions {
  db?: PostgresQueryPort;
  /** ACTION_SECRET_KEY; decrypts provider credential envelopes. */
  secretKey?: string;
  /** Tests inject user-scoped ports. */
  createPorts?: (userId: string) => VoiceInputPorts;
}

export function createNodeVoiceInputRoutes(
  options: NodeVoiceInputOptions,
): Hono<{ Variables: { userId: string } }> {
  const createPorts =
    options.createPorts ??
    ((userId: string) => {
      const db = options.db;
      if (!db) throw new Error("Node voice input requires a database.");
      return createHostedVoiceInputPorts(userId, {
        catalog: {
          list: (id) => loadNodeVoiceInputCatalog(db, id),
        },
        credentials: {
          resolve: ({ userId: actor, route }) =>
            getNodeProviderCredentials(db, options.secretKey, actor, {
              accountId: route.accountId,
              providerId: route.providerId ?? route.upstreamId,
              upstreamId: route.upstreamId,
              region: route.region,
              modelCode: route.modelCode,
              requiredCredentials: route.requiredCredentials,
            }),
        },
        usage: {
          append: (event) => appendNodeProviderUsageEvent(db, event),
        },
      });
    });

  return createSharedVoiceInputRoutes<{ Variables: { userId: string } }>({
    userId: (c) => c.get("userId") ?? null,
    createPorts: (_c, userId) => createPorts(userId),
  });
}
