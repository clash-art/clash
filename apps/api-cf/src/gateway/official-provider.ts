/**
 * The "Clash official" provider row (#351; guide: apps/docs/guide/gateway-admin.md):
 * the live published catalog as `/model-providers` and `/models/catalog` list
 * it, read through the same D1 routes port the data plane routes with, so the
 * row never shows a model routing would refuse (a draft, a DeepSeek
 * Pro/Reasoner card, a card no enabled official account serves).
 */
import type { D1Database } from "@cloudflare/workers-types";
import {
  OFFICIAL_MODEL_PROVIDER_LABEL,
  buildOfficialModelProvider,
  toGatewayError,
  type GatewayClock,
  type GatewayIdentity,
  type GatewayLogger,
} from "@clash/gateway-core";
import { OFFICIAL_MODEL_PROVIDER_ID, type OfficialModelProvider } from "@clash/shared-types";

import { monotonicClock, toMs } from "./d1-common";
import { createD1GatewayRoutesPort, UNPUBLISHED_CATALOG_VERSION } from "./d1-routes";
import { workersLogger } from "./workers-logger";

/** The platform's own view: official scope, no tenant (the catalog is platform-wide). */
export const OFFICIAL_IDENTITY: GatewayIdentity = { tenantId: "", userId: "", budgetIds: [], credentialScope: "official" };

/**
 * The row, `null` while no catalog version is published, or `unavailable`
 * with the coded reason when it cannot be read: never an empty catalog
 * standing in for a failure.
 */
export async function readOfficialModelProvider(
  db: D1Database,
  deps: { clock: GatewayClock; logger: GatewayLogger } = { clock: monotonicClock(), logger: workersLogger() },
): Promise<OfficialModelProvider | null> {
  try {
    const routes = createD1GatewayRoutesPort(db, deps);
    const [catalog, accounts] = await Promise.all([
      routes.catalog(OFFICIAL_IDENTITY),
      routes.providers(OFFICIAL_IDENTITY, "official"),
    ]);
    if (catalog.version === UNPUBLISHED_CATALOG_VERSION) return null;
    const published = await db
      .prepare(`SELECT MAX(published_at) AS published_at FROM gateway_model WHERE catalog_version = ?`)
      .bind(catalog.version)
      .first<{ published_at: number | null }>();
    const publishedAt =
      typeof published?.published_at === "number" ? new Date(toMs(published.published_at)).toISOString() : null;
    return buildOfficialModelProvider({ catalog, accounts, publishedAt });
  } catch (error) {
    const coded = toGatewayError(error);
    deps.logger.warn("gateway.official_provider_unavailable", { code: coded.code });
    return {
      id: OFFICIAL_MODEL_PROVIDER_ID,
      label: OFFICIAL_MODEL_PROVIDER_LABEL,
      managed: true,
      status: "unavailable",
      code: coded.code,
    };
  }
}
