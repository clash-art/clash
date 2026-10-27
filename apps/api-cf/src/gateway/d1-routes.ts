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

interface CatalogRow {
  catalog_version: string;
  model_code: string;
  kind: string;
  card_json: string;
  enabled: number;
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
    async catalog(_identity, query): Promise<GatewayCatalog> {
      const nowS = toSeconds(deps.clock.now());
      const { results } = query?.version
        ? // A named version: published (and started) rows only, disabled ones included so an
          // all-disabled version is still found; a draft is never a version a pin can name.
          await db
            .prepare(
              `SELECT catalog_version, model_code, kind, card_json, enabled FROM gateway_model
                WHERE catalog_version = ?1 AND published_at IS NOT NULL AND published_at <= ?2
                ORDER BY model_code`,
            )
            .bind(query.version, nowS)
            .all<CatalogRow>()
        : await db
            .prepare(
              `SELECT catalog_version, model_code, kind, card_json, enabled FROM gateway_model
                WHERE enabled = 1 AND catalog_version = ${publishedCatalogVersionSql("?1")}
                ORDER BY model_code`,
            )
            .bind(nowS)
            .all<CatalogRow>();
      if (query?.version && results.length === 0)
        throw new GatewayError("GATEWAY_CATALOG_VERSION_NOT_FOUND", { details: { version: query.version } });
      const models: GatewayModelCard[] = [];
      for (const row of results) {
        if (row.enabled !== 1) continue;
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
        version: query?.version ?? results[0]?.catalog_version ?? UNPUBLISHED_CATALOG_VERSION,
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
     * prices the route (priceRowsStatement/priceFromRows), with the model's
     * output ceiling, in one batch.
     */
    async price({ catalogVersion, route, at }): Promise<GatewayPrice> {
      const [prices, model] = await db.batch([
        priceRowsStatement(db, { modelCode: route.modelCode, upstreamId: route.upstreamId, at: at ?? deps.clock.now() }),
        db
          .prepare(
            `SELECT max_output_tokens FROM gateway_model
              WHERE catalog_version = ? AND model_code = ? LIMIT 1`,
          )
          .bind(catalogVersion, route.modelCode),
      ]);
      const price = priceFromRows((prices?.results ?? []) as PriceRow[], route, deps);
      const maxOutputTokens = (model?.results?.[0] as { max_output_tokens: number | null } | undefined)
        ?.max_output_tokens;
      return { ...price, ...(typeof maxOutputTokens === "number" ? { maxOutputTokens } : {}) };
    },
  };
}

/**
 * Published credit price rows for a model and upstream effective at `at`
 * (epoch ms), newest first: a newer version supersedes an older one, and
 * within a version rows for the exact upstream sort before model-wide rows
 * (`upstream_id = ''`). Drafts (`published_at IS NULL`) are never charged.
 */
function priceRowsStatement(db: D1Database, input: { modelCode: string; upstreamId: string; at: number }) {
  return db
    .prepare(
      `SELECT price_version, upstream_id, unit, amount_micro, per FROM gateway_price
        WHERE model_code = ?1 AND upstream_id IN (?2, '') AND currency = 'credit'
          AND published_at IS NOT NULL
          AND effective_from <= ?3 AND (effective_to IS NULL OR effective_to > ?3)
        ORDER BY effective_from DESC, price_version DESC, upstream_id = '' ASC`,
    )
    .bind(input.modelCode, input.upstreamId, toSeconds(input.at));
}

function priceFromRows(
  rows: PriceRow[],
  input: { modelCode: string; upstreamId: string },
  deps: { logger: GatewayLogger },
): GatewayPrice {
  const chosen = rows[0];
  if (!chosen)
    throw new GatewayError("GATEWAY_PRICE_UNAVAILABLE", {
      details: { modelCode: input.modelCode, upstreamId: input.upstreamId },
    });
  const rates: GatewayPriceRate[] = [];
  for (const row of rows) {
    if (row.price_version !== chosen.price_version || row.upstream_id !== chosen.upstream_id) continue;
    if (!isGatewayPriceUnit(row.unit)) {
      deps.logger.warn("gateway.price_unit_unknown", { model: input.modelCode, priceVersion: row.price_version });
      continue;
    }
    rates.push({ unit: row.unit, microCredits: row.amount_micro, per: row.per });
  }
  return {
    modelCode: input.modelCode,
    ...(chosen.upstream_id ? { upstreamId: chosen.upstream_id } : {}),
    version: chosen.price_version,
    rates,
  };
}

/**
 * The price a request for this model and upstream would have been charged at
 * `at`. Reconciliation (d1-reconciliation.ts) values differences with it, so
 * a difference is priced exactly as the data plane prices a request.
 */
export async function publishedPriceAt(
  db: D1Database,
  input: { modelCode: string; upstreamId: string; at: number },
  deps: { logger: GatewayLogger },
): Promise<GatewayPrice> {
  const { results } = await priceRowsStatement(db, input).all<PriceRow>();
  return priceFromRows(results, input, deps);
}
