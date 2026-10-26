/**
 * Price-book administration over D1 (`gateway_price`, 0032 + 0035; guide:
 * apps/docs/guide/gateway-price-book.md). A version is a set of credit rates
 * sharing one effective window:
 *
 * - draft:   `published_at IS NULL`. Replaced as a whole in one batch; never
 *            charged by the data plane (d1-routes.ts reads published rows only).
 * - publish: one UPDATE stamps every row of the version. A version never takes
 *            effect before it is published: an `effective_from` already past
 *            moves to the publish instant. A published row never changes.
 *
 * Old usage is never repriced: each `settle` ledger row carries the
 * `price_version` it was charged under, and the data plane prices a request
 * as of its admission. Every mutation appends a `gateway_admin_audit` row in
 * the same batch. Policy (units, integer amounts, DeepSeek Flash only) is
 * gateway-core's `assertPriceDraftPolicy`.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  GatewayError,
  assertPriceDraftPolicy,
  type GatewayClock,
  type GatewayPriceBookPort,
  type GatewayPriceUnit,
  type PriceDraftRate,
} from "@clash/gateway-core";

import { adminAuditStatement, type GatewayAdminActor } from "./d1-admin-audit";
import { toMs, toSeconds } from "./d1-common";

export interface PriceRateView {
  modelCode: string;
  /** '' prices every upstream of the model. */
  upstreamId: string;
  unit: GatewayPriceUnit;
  /** Price of `per` units, in micro-credits. */
  amountMicroCredits: number;
  per: number;
}

export interface PriceVersionView {
  version: string;
  status: "draft" | "published";
  effectiveFrom: string;
  effectiveTo: string | null;
  publishedAt: string | null;
  createdByUserId: string | null;
  rates: PriceRateView[];
}

export interface PriceDraftInput {
  version: string;
  /** Epoch ms. */
  effectiveFrom: number;
  /** Epoch ms; null: open-ended. */
  effectiveTo: number | null;
  rates: readonly PriceDraftRate[];
  actor: GatewayAdminActor;
}

interface PriceRow {
  price_version: string;
  model_code: string;
  upstream_id: string;
  unit: string;
  amount_micro: number;
  per: number;
  effective_from: number;
  effective_to: number | null;
  published_at: number | null;
  created_by_user_id: string | null;
}

const PRICE_COLUMNS = `price_version, model_code, upstream_id, unit, amount_micro, per,
  effective_from, effective_to, published_at, created_by_user_id`;

const iso = (seconds: number) => new Date(toMs(seconds)).toISOString();

/** Group rows (ordered by version) into version views. */
function versionViews(rows: readonly PriceRow[]): PriceVersionView[] {
  const views = new Map<string, PriceVersionView>();
  for (const row of rows) {
    let view = views.get(row.price_version);
    if (!view) {
      view = {
        version: row.price_version,
        status: row.published_at === null ? "draft" : "published",
        effectiveFrom: iso(row.effective_from),
        effectiveTo: row.effective_to === null ? null : iso(row.effective_to),
        publishedAt: row.published_at === null ? null : iso(row.published_at),
        createdByUserId: row.created_by_user_id,
        rates: [],
      };
      views.set(row.price_version, view);
    }
    view.rates.push({
      modelCode: row.model_code,
      upstreamId: row.upstream_id,
      unit: row.unit as GatewayPriceUnit,
      amountMicroCredits: row.amount_micro,
      per: row.per,
    });
  }
  return [...views.values()];
}

/**
 * Aborts the whole batch when `condition` (SQL over ?1 = version) holds: the
 * inserted row breaks gateway_price's CHECK (per > 0), so D1 rolls back.
 */
function abortWhen(db: D1Database, version: string, condition: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO gateway_price (id, price_version, model_code, unit, amount_micro, per, effective_from)
       SELECT 'abort:' || ?1, ?1, '', '', 0, 0, 0 WHERE ${condition}`,
    )
    .bind(version);
}

const PUBLISHED_ROW = `EXISTS (SELECT 1 FROM gateway_price WHERE price_version = ?1 AND published_at IS NOT NULL)`;

/** The D1 adapter of gateway-core's GatewayPriceBookPort (#425). */
export function createD1PriceBook(db: D1Database, deps: { clock: GatewayClock }) {
  async function versionRows(version: string): Promise<PriceRow[]> {
    const { results } = await db
      .prepare(
        `SELECT ${PRICE_COLUMNS} FROM gateway_price
          WHERE price_version = ? AND currency = 'credit'
          ORDER BY model_code, upstream_id, unit`,
      )
      .bind(version)
      .all<PriceRow>();
    return results;
  }

  async function read(version: string): Promise<PriceVersionView> {
    const view = versionViews(await versionRows(version))[0];
    if (!view)
      throw new GatewayError("GATEWAY_PRICE_VERSION_NOT_FOUND", {
        details: { version },
      });
    return view;
  }

  function audit(input: {
    action: string;
    version: string;
    actor: GatewayAdminActor;
    before: unknown;
    after: unknown;
    nowS: number;
    when: string;
  }): D1PreparedStatement {
    // Only admin accounts hold prices.write (services/gateway-authz.ts).
    return adminAuditStatement(db, {
      tenantId: "",
      actor: input.actor,
      action: input.action,
      targetType: "price_version",
      targetId: input.version,
      before: input.before,
      after: input.after,
      nowS: input.nowS,
      when: input.when,
    });
  }

  const port = {
    /** Every credit price version, newest effective first; optionally only versions pricing `modelCode`. */
    async list(filter: { modelCode?: string; status?: "draft" | "published" } = {}): Promise<PriceVersionView[]> {
      const { results } = await db
        .prepare(
          `SELECT ${PRICE_COLUMNS} FROM gateway_price
            WHERE currency = 'credit'
              AND (?1 IS NULL OR price_version IN (
                    SELECT price_version FROM gateway_price WHERE model_code = ?1))
              AND (?2 IS NULL OR (?2 = 'draft') = (published_at IS NULL))
            ORDER BY effective_from DESC, price_version DESC, model_code, upstream_id, unit`,
        )
        .bind(filter.modelCode ?? null, filter.status ?? null)
        .all<PriceRow>();
      return versionViews(results);
    },

    read,

    /** Create or wholly replace a draft version. A published version is GATEWAY_PRICE_VERSION_PUBLISHED. */
    async putDraft(input: PriceDraftInput): Promise<PriceVersionView> {
      assertPriceDraftPolicy(input.rates);
      const fromS = toSeconds(input.effectiveFrom);
      const toS = input.effectiveTo === null ? null : toSeconds(input.effectiveTo);
      if (toS !== null && toS <= fromS)
        throw new GatewayError("GATEWAY_PRICE_WINDOW_INVALID", {
          details: { param: "effectiveTo" },
        });
      const before = versionViews(await versionRows(input.version))[0];
      if (before?.status === "published")
        throw new GatewayError("GATEWAY_PRICE_VERSION_PUBLISHED", {
          details: { version: input.version, publishedAt: before.publishedAt },
        });
      const nowS = toSeconds(deps.clock.now());
      const statements: D1PreparedStatement[] = [
        // Published concurrently since the read above: change nothing.
        abortWhen(db, input.version, PUBLISHED_ROW),
        db.prepare(`DELETE FROM gateway_price WHERE price_version = ? AND published_at IS NULL`).bind(input.version),
        ...input.rates.map((rate) =>
          db
            .prepare(
              `INSERT INTO gateway_price
                 (id, price_version, model_code, upstream_id, unit, amount_micro, per, currency,
                  effective_from, effective_to, source, created_by_user_id, created_at, published_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'credit', ?, ?, 'manual', ?, ?, NULL)`,
            )
            .bind(
              `gwp_${crypto.randomUUID().replaceAll("-", "")}`,
              input.version,
              rate.modelCode,
              rate.upstreamId,
              rate.unit,
              rate.microCredits,
              rate.per,
              fromS,
              toS,
              input.actor.id,
              nowS,
            ),
        ),
        audit({
          action: "price.draft",
          version: input.version,
          actor: input.actor,
          before,
          after: {
            effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo,
            rates: input.rates,
          },
          nowS,
          when: "1",
        }),
      ];
      try {
        await db.batch(statements);
      } catch (cause) {
        const now = versionViews(await versionRows(input.version))[0];
        if (now?.status === "published")
          throw new GatewayError("GATEWAY_PRICE_VERSION_PUBLISHED", {
            details: { version: input.version, publishedAt: now.publishedAt },
          });
        throw new GatewayError("GATEWAY_CONFLICT", {
          details: { version: input.version },
          cause,
        });
      }
      return read(input.version);
    },

    /**
     * Publish a draft: every row of the version at once, effective from
     * max(effectiveFrom, now). Publishing twice is GATEWAY_PRICE_VERSION_PUBLISHED.
     */
    async publish(input: { version: string; actor: GatewayAdminActor }): Promise<PriceVersionView> {
      const before = await read(input.version);
      if (before.status === "published")
        throw new GatewayError("GATEWAY_PRICE_VERSION_PUBLISHED", {
          details: { version: input.version, publishedAt: before.publishedAt },
        });
      const nowS = toSeconds(deps.clock.now());
      const ended = (sql: string) => `${sql}effective_to IS NOT NULL AND ${sql}effective_to <= ?2`;
      if (before.effectiveTo !== null && toSeconds(Date.parse(before.effectiveTo)) <= nowS)
        throw new GatewayError("GATEWAY_PRICE_WINDOW_INVALID", {
          details: {
            version: input.version,
            reason: "ended",
            effectiveTo: before.effectiveTo,
          },
        });
      const [published] = await db.batch([
        db
          .prepare(
            `UPDATE gateway_price SET published_at = ?2, effective_from = MAX(effective_from, ?2)
              WHERE price_version = ?1 AND published_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM gateway_price p WHERE p.price_version = ?1 AND (${ended("p.")}))`,
          )
          .bind(input.version, nowS),
        audit({
          action: "price.publish",
          version: input.version,
          actor: input.actor,
          before: { status: "draft" },
          after: { status: "published", publishedAt: nowS },
          nowS,
          when: "changes() > 0",
        }),
      ]);
      if (!published?.meta.changes) {
        const now = versionViews(await versionRows(input.version))[0];
        if (!now)
          throw new GatewayError("GATEWAY_PRICE_VERSION_NOT_FOUND", {
            details: { version: input.version },
          });
        if (now.status === "published")
          throw new GatewayError("GATEWAY_PRICE_VERSION_PUBLISHED", {
            details: { version: input.version, publishedAt: now.publishedAt },
          });
        throw new GatewayError("GATEWAY_CONFLICT", {
          details: { version: input.version },
        });
      }
      return read(input.version);
    },
  } satisfies GatewayPriceBookPort;
  return port;
}

export type D1PriceBook = ReturnType<typeof createD1PriceBook>;
