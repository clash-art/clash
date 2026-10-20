/**
 * Routes port over D1: the published catalog (`gateway_model.card_json`), the
 * official upstream accounts (`gateway_upstream_account`) and the price book
 * (`gateway_price`). Routing itself stays in gateway-core/shared-types; this
 * port only reads configured data, so no model list is compiled in here.
 */
import type { D1Database } from "@cloudflare/workers-types";
import {
  GatewayError,
  isGatewayPriceUnit,
  type GatewayCatalog,
  type GatewayClock,
  type GatewayLogger,
  type GatewayModelCard,
  type GatewayPrice,
  type GatewayPriceRate,
  type GatewayRoutesPort,
} from "@clash/gateway-core";
import { ModelCardSchema, type ProviderAccountAvailability } from "@clash/shared-types";
import { parseConfiguredCredentials } from "@clash/shared-runtime/provider-credentials";

import {
  numberRecord,
  parseJson,
  publishedCatalogVersionSql,
  stringList,
  toSeconds,
} from "./d1-common";

/** Catalog version answered when nothing is published yet: every model is then unknown. */
export const UNPUBLISHED_CATALOG_VERSION = "unpublished";

interface UpstreamAccountRow {
  id: string;
  provider_id: string;
  upstream_id: string;
  api_shape: string | null;
  region: string;
  label: string | null;
  priority: number | null;
  weight: number | null;
  supported_model_ids_json: string | null;
  model_priorities_json: string | null;
  configured_credentials: string | null;
}

interface PriceRow {
  price_version: string;
  upstream_id: string;
  unit: string;
  amount_micro: number;
  per: number;
}

export function createD1GatewayRoutesPort(
  db: D1Database,
  deps: { clock: GatewayClock; logger: GatewayLogger },
): GatewayRoutesPort {
  return {
    async catalog(): Promise<GatewayCatalog> {
      const { results } = await db
        .prepare(
          `SELECT catalog_version, model_code, kind, card_json FROM gateway_model
            WHERE enabled = 1 AND catalog_version = ${publishedCatalogVersionSql("?1")}
            ORDER BY model_code`,
        )
        .bind(toSeconds(deps.clock.now()))
        .all<{ catalog_version: string; model_code: string; kind: string; card_json: string }>();
      const models: GatewayModelCard[] = [];
      for (const row of results) {
        const parsed = ModelCardSchema.safeParse(parseJson(row.card_json));
        if (!parsed.success || parsed.data.id !== row.model_code || parsed.data.kind !== row.kind) {
          // A malformed published card is unroutable, never guessed at.
          deps.logger.warn("gateway.catalog_card_invalid", {
            catalogVersion: row.catalog_version,
            model: row.model_code,
          });
          continue;
        }
        models.push(parsed.data);
      }
      return {
        version: results[0]?.catalog_version ?? UNPUBLISHED_CATALOG_VERSION,
        models,
      };
    },

    async providers(_identity, scope): Promise<ProviderAccountAvailability[]> {
      // Tenant BYOK is not served by the official gateway yet (tokens are
      // always minted `official`); an empty list means "no route", never "all".
      if (scope !== "official") return [];
      const { results } = await db
        .prepare(
          `SELECT id, provider_id, upstream_id, api_shape, region, label, priority, weight,
                  supported_model_ids_json, model_priorities_json, configured_credentials
             FROM gateway_upstream_account WHERE enabled = 1
            ORDER BY COALESCE(priority, 1000), id`,
        )
        .all<UpstreamAccountRow>();
      return results.map((row) => {
        const supportedModelIds = stringList(row.supported_model_ids_json);
        const modelPriorities = numberRecord(row.model_priorities_json);
        return {
          id: row.id,
          providerId: row.provider_id,
          ...(row.upstream_id ? { upstreamId: row.upstream_id } : {}),
          ...(row.api_shape ? { apiShape: row.api_shape } : {}),
          ...(row.region ? { region: row.region } : {}),
          ...(row.label ? { label: row.label } : {}),
          enabled: true,
          configuredCredentials: parseConfiguredCredentials(row.configured_credentials),
          ...(supportedModelIds ? { supportedModelIds } : {}),
          ...(modelPriorities ? { modelPriorities } : {}),
          ...(row.priority !== null ? { priority: row.priority } : {}),
          ...(row.weight !== null ? { weight: row.weight } : {}),
        };
      });
    },

    /**
     * The newest published price version effective at `at` (request time) that
     * prices the route: a newer version supersedes an older one, and within a
     * version rows for the exact upstream win over model-wide rows
     * (`upstream_id = ''`). Drafts (`published_at IS NULL`) are never charged;
     * only credit rates are.
     */
    async price({ catalogVersion, route, at }): Promise<GatewayPrice> {
      const atS = toSeconds(at ?? deps.clock.now());
      const [prices, model] = await db.batch([
        db
          .prepare(
            `SELECT price_version, upstream_id, unit, amount_micro, per FROM gateway_price
              WHERE model_code = ?1 AND upstream_id IN (?2, '') AND currency = 'credit'
                AND published_at IS NOT NULL
                AND effective_from <= ?3 AND (effective_to IS NULL OR effective_to > ?3)
              ORDER BY effective_from DESC, price_version DESC, upstream_id = '' ASC`,
          )
          .bind(route.modelCode, route.upstreamId, atS),
        db
          .prepare(
            `SELECT max_output_tokens FROM gateway_model
              WHERE catalog_version = ? AND model_code = ? LIMIT 1`,
          )
          .bind(catalogVersion, route.modelCode),
      ]);
      const rows = (prices?.results ?? []) as PriceRow[];
      const chosen = rows[0];
      if (!chosen)
        throw new GatewayError("GATEWAY_PRICE_UNAVAILABLE", {
          details: { modelCode: route.modelCode, upstreamId: route.upstreamId },
        });
      const rates: GatewayPriceRate[] = [];
      for (const row of rows) {
        if (row.price_version !== chosen.price_version || row.upstream_id !== chosen.upstream_id) continue;
        if (!isGatewayPriceUnit(row.unit)) {
          deps.logger.warn("gateway.price_unit_unknown", { model: route.modelCode, priceVersion: row.price_version });
          continue;
        }
        rates.push({ unit: row.unit, microCredits: row.amount_micro, per: row.per });
      }
      const maxOutputTokens = (model?.results?.[0] as { max_output_tokens: number | null } | undefined)
        ?.max_output_tokens;
      return {
        modelCode: route.modelCode,
        ...(chosen.upstream_id ? { upstreamId: chosen.upstream_id } : {}),
        version: chosen.price_version,
        rates,
        ...(typeof maxOutputTokens === "number" ? { maxOutputTokens } : {}),
      };
    },
  };
}
