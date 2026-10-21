/**
 * Catalog administration over D1 (`gateway_model`; guide:
 * apps/docs/guide/gateway-admin.md). A catalog version is the whole set of
 * models the data plane routes once it is the newest published version
 * (d1-common.ts `publishedCatalogVersionSql`), so a change is made by
 * cloning the live version into a draft, editing the draft, and publishing it:
 *
 * - draft:   rows with `published_at IS NULL`. Models are upserted or removed
 *            one at a time; the data plane never reads them.
 * - publish: one UPDATE stamps every row of the version; it routes at once.
 *            A published row never changes again.
 *
 * Every card is a shared-types `ModelCard` whose id and kind match the row,
 * and the gateway's catalog policy applies before a draft is accepted:
 * DeepSeek is served through Flash models only (GATEWAY_CATALOG_MODEL_BLOCKED).
 * Every mutation appends its `gateway_admin_audit` row in the same batch.
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
  GatewayError,
  applyGatewayCatalogPolicy,
  isBlockedDeepSeekModel,
  type GatewayClock,
} from "@clash/gateway-core";
import { ModelCardSchema } from "@clash/shared-types";

import { sha256Hex } from "../services/api-token";
import { adminAuditStatement, type GatewayAdminActor } from "./d1-admin-audit";
import type { RateLimitConfig } from "./d1-billing";
import { parseJson, publishedCatalogVersionSql, toMs, toSeconds } from "./d1-common";

export interface CatalogModelView {
  modelCode: string;
  kind: string;
  displayName: string | null;
  enabled: boolean;
  maxOutputTokens: number | null;
  rateLimit: RateLimitConfig | null;
  publishedAt: string | null;
  card: unknown;
}

export interface CatalogVersionSummary {
  version: string;
  status: "draft" | "published";
  /** True for the published version the data plane routes now. */
  live: boolean;
  models: number;
  publishedAt: string | null;
  createdAt: string;
}

export interface CatalogModelInput {
  version: string;
  modelCode: string;
  card: unknown;
  displayName?: string | null;
  enabled: boolean;
  maxOutputTokens?: number | null;
  rateLimit?: RateLimitConfig | null;
  actor: GatewayAdminActor;
}

interface ModelRow {
  catalog_version: string;
  model_code: string;
  kind: string;
  display_name: string | null;
  enabled: number;
  card_json: string;
  max_output_tokens: number | null;
  rate_limit_json: string | null;
  published_at: number | null;
}

const MODEL_COLUMNS = `catalog_version, model_code, kind, display_name, enabled, card_json,
  max_output_tokens, rate_limit_json, published_at`;

const iso = (seconds: number) => new Date(toMs(seconds)).toISOString();

function modelView(row: ModelRow): CatalogModelView {
  return {
    modelCode: row.model_code,
    kind: row.kind,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    maxOutputTokens: row.max_output_tokens,
    rateLimit: (parseJson(row.rate_limit_json) as RateLimitConfig | undefined) ?? null,
    publishedAt: row.published_at === null ? null : iso(row.published_at),
    card: parseJson(row.card_json) ?? null,
  };
}

/** Audit snapshot of a model: the card is summarized by its hash, not copied. */
async function modelSnapshot(row: Pick<ModelRow, "kind" | "display_name" | "enabled" | "card_json" | "max_output_tokens" | "rate_limit_json">) {
  return {
    kind: row.kind,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    maxOutputTokens: row.max_output_tokens,
    rateLimit: parseJson(row.rate_limit_json) ?? null,
    cardSha256: await sha256Hex(row.card_json),
  };
}

/**
 * Aborts the whole batch when `condition` (SQL over ?1 = version) holds: the
 * inserted row breaks gateway_model's NOT NULL card_json, so D1 rolls back.
 */
function abortWhen(db: D1Database, version: string, condition: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO gateway_model (id, catalog_version, model_code, kind, card_json)
       SELECT 'abort:' || ?1, ?1, '', '', NULL WHERE ${condition}`,
    )
    .bind(version);
}

const PUBLISHED_ROW = `EXISTS (SELECT 1 FROM gateway_model WHERE catalog_version = ?1 AND published_at IS NOT NULL)`;

/** Validate a card for `modelCode` against ModelCardSchema and the catalog policy. */
export function validateCatalogCard(modelCode: string, card: unknown) {
  const parsed = ModelCardSchema.safeParse(card);
  if (!parsed.success)
    throw new GatewayError("GATEWAY_CATALOG_MODEL_INVALID", {
      details: { modelCode, fields: parsed.error.issues.slice(0, 20).map((issue) => issue.path.join(".")) },
    });
  if (parsed.data.id !== modelCode)
    throw new GatewayError("GATEWAY_CATALOG_MODEL_INVALID", { details: { modelCode, reason: "id_mismatch" } });
  const { excluded } = applyGatewayCatalogPolicy({ version: "draft", models: [parsed.data] });
  if (excluded.length > 0 || isBlockedDeepSeekModel(modelCode))
    throw new GatewayError("GATEWAY_CATALOG_MODEL_BLOCKED", { details: { modelCode } });
  return parsed.data;
}

export function createD1CatalogAdmin(db: D1Database, deps: { clock: GatewayClock }) {
  const nowSeconds = () => toSeconds(deps.clock.now());

  async function versionRows(version: string): Promise<ModelRow[]> {
    const { results } = await db
      .prepare(`SELECT ${MODEL_COLUMNS} FROM gateway_model WHERE catalog_version = ? ORDER BY model_code`)
      .bind(version)
      .all<ModelRow>();
    return results;
  }

  async function requireDraft(version: string): Promise<ModelRow[]> {
    const rows = await versionRows(version);
    const published = rows.find((row) => row.published_at !== null);
    if (published)
      throw new GatewayError("GATEWAY_CATALOG_VERSION_PUBLISHED", {
        details: { version, publishedAt: iso(published.published_at!) },
      });
    return rows;
  }

  async function read(
    version: string,
  ): Promise<{ version: string; status: "draft" | "published"; models: CatalogModelView[] }> {
    const rows = await versionRows(version);
    if (rows.length === 0) throw new GatewayError("GATEWAY_CATALOG_VERSION_NOT_FOUND", { details: { version } });
    return {
      version,
      status: rows.some((row) => row.published_at !== null) ? "published" : "draft",
      models: rows.map(modelView),
    };
  }

  /** Explain a refused batch: published meanwhile, or a concurrent change. */
  async function refused(version: string, cause: unknown): Promise<never> {
    await requireDraft(version);
    throw new GatewayError("GATEWAY_CONFLICT", { details: { version }, cause });
  }

  return {
    /** Every catalog version, newest first, with the live one marked. */
    async list(): Promise<CatalogVersionSummary[]> {
      const { results } = await db
        .prepare(
          `SELECT catalog_version, COUNT(*) AS models, MAX(published_at) AS published_at,
                  MIN(created_at) AS created_at,
                  catalog_version = ${publishedCatalogVersionSql("?1")} AS live
             FROM gateway_model
            GROUP BY catalog_version
            ORDER BY (MAX(published_at) IS NULL) DESC, MAX(published_at) DESC, MIN(created_at) DESC, catalog_version DESC`,
        )
        .bind(nowSeconds())
        .all<{ catalog_version: string; models: number; published_at: number | null; created_at: number; live: number | null }>();
      return results.map((row) => ({
        version: row.catalog_version,
        status: row.published_at === null ? "draft" : "published",
        live: row.live === 1,
        models: row.models,
        publishedAt: row.published_at === null ? null : iso(row.published_at),
        createdAt: iso(row.created_at),
      }));
    },

    read,

    /** Create a draft version holding a copy of every model of `from`. */
    async cloneVersion(input: { version: string; from: string; actor: GatewayAdminActor }) {
      const existing = await requireDraft(input.version);
      if (existing.length > 0) throw new GatewayError("GATEWAY_CONFLICT", { details: { version: input.version, reason: "exists" } });
      const source = await versionRows(input.from);
      if (source.length === 0) throw new GatewayError("GATEWAY_CATALOG_VERSION_NOT_FOUND", { details: { version: input.from } });
      const nowS = nowSeconds();
      try {
        await db.batch([
          abortWhen(db, input.version, `EXISTS (SELECT 1 FROM gateway_model WHERE catalog_version = ?1)`),
          db
            .prepare(
              `INSERT INTO gateway_model
                 (id, catalog_version, model_code, kind, display_name, enabled, card_json,
                  max_output_tokens, rate_limit_json, published_at, created_at)
               SELECT 'gwm_' || lower(hex(randomblob(16))), ?1, model_code, kind, display_name, enabled,
                      card_json, max_output_tokens, rate_limit_json, NULL, ?3
                 FROM gateway_model WHERE catalog_version = ?2`,
            )
            .bind(input.version, input.from, nowS),
          adminAuditStatement(db, {
            tenantId: "",
            actor: input.actor,
            action: "catalog.clone",
            targetType: "catalog_version",
            targetId: input.version,
            after: { from: input.from, models: source.map((row) => row.model_code) },
            nowS,
            when: "changes() > 0",
          }),
        ]);
      } catch (cause) {
        await refused(input.version, cause);
      }
      return read(input.version);
    },

    /** Create or replace one model of a draft version. */
    async putModel(input: CatalogModelInput): Promise<CatalogModelView> {
      const card = validateCatalogCard(input.modelCode, input.card);
      const rows = await requireDraft(input.version);
      const before = rows.find((row) => row.model_code === input.modelCode);
      const next = {
        kind: card.kind,
        display_name: input.displayName ?? null,
        enabled: input.enabled ? 1 : 0,
        card_json: JSON.stringify(card),
        max_output_tokens: input.maxOutputTokens ?? null,
        rate_limit_json: input.rateLimit ? JSON.stringify(input.rateLimit) : null,
      };
      const nowS = nowSeconds();
      try {
        await db.batch([
          abortWhen(db, input.version, PUBLISHED_ROW),
          db
            .prepare(
              `INSERT INTO gateway_model
                 (id, catalog_version, model_code, kind, display_name, enabled, card_json,
                  max_output_tokens, rate_limit_json, published_at, created_at)
               VALUES ('gwm_' || lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)
               ON CONFLICT (catalog_version, model_code) DO UPDATE SET
                 kind = excluded.kind, display_name = excluded.display_name, enabled = excluded.enabled,
                 card_json = excluded.card_json, max_output_tokens = excluded.max_output_tokens,
                 rate_limit_json = excluded.rate_limit_json
               WHERE gateway_model.published_at IS NULL`,
            )
            .bind(
              input.version,
              input.modelCode,
              next.kind,
              next.display_name,
              next.enabled,
              next.card_json,
              next.max_output_tokens,
              next.rate_limit_json,
              nowS,
            ),
          adminAuditStatement(db, {
            tenantId: "",
            actor: input.actor,
            action: before ? "catalog.model.update" : "catalog.model.create",
            targetType: "catalog_model",
            targetId: `${input.version}/${input.modelCode}`,
            ...(before ? { before: await modelSnapshot(before) } : {}),
            after: await modelSnapshot(next),
            nowS,
            when: "changes() = 1",
          }),
        ]);
      } catch (cause) {
        await refused(input.version, cause);
      }
      const row = (await versionRows(input.version)).find((entry) => entry.model_code === input.modelCode);
      if (!row) throw new GatewayError("GATEWAY_INTERNAL", { message: "The catalog model is missing after a write." });
      return modelView(row);
    },

    /** Remove one model from a draft version. */
    async removeModel(input: { version: string; modelCode: string; actor: GatewayAdminActor }): Promise<void> {
      const rows = await requireDraft(input.version);
      const before = rows.find((row) => row.model_code === input.modelCode);
      if (!before)
        throw new GatewayError("GATEWAY_CATALOG_VERSION_NOT_FOUND", {
          details: { version: input.version, modelCode: input.modelCode },
        });
      const nowS = nowSeconds();
      const [removed] = await db.batch([
        db
          .prepare(`DELETE FROM gateway_model WHERE catalog_version = ? AND model_code = ? AND published_at IS NULL`)
          .bind(input.version, input.modelCode),
        adminAuditStatement(db, {
          tenantId: "",
          actor: input.actor,
          action: "catalog.model.remove",
          targetType: "catalog_model",
          targetId: `${input.version}/${input.modelCode}`,
          before: await modelSnapshot(before),
          nowS,
          when: "changes() = 1",
        }),
      ]);
      if (!removed?.meta.changes) await refused(input.version, undefined);
    },

    /** Publish a draft: every row at once; it becomes the live catalog. */
    async publish(input: { version: string; actor: GatewayAdminActor }) {
      const rows = await requireDraft(input.version);
      if (rows.length === 0) throw new GatewayError("GATEWAY_CATALOG_VERSION_NOT_FOUND", { details: { version: input.version } });
      // Cards were validated when written; re-check so a policy change can never publish a blocked model.
      for (const row of rows) validateCatalogCard(row.model_code, parseJson(row.card_json));
      const nowS = nowSeconds();
      let published;
      try {
        [, published] = await db.batch([
          // Published concurrently since the read above: change nothing.
          abortWhen(db, input.version, PUBLISHED_ROW),
          db
            .prepare(`UPDATE gateway_model SET published_at = ?2 WHERE catalog_version = ?1 AND published_at IS NULL`)
            .bind(input.version, nowS),
          adminAuditStatement(db, {
            tenantId: "",
            actor: input.actor,
            action: "catalog.publish",
            targetType: "catalog_version",
            targetId: input.version,
            before: { status: "draft" },
            after: { status: "published", publishedAt: nowS, models: rows.map((row) => row.model_code) },
            nowS,
            when: "changes() > 0",
          }),
        ]);
      } catch (cause) {
        await refused(input.version, cause);
      }
      if (!published?.meta.changes) await refused(input.version, undefined);
      return read(input.version);
    },
  };
}

export type D1CatalogAdmin = ReturnType<typeof createD1CatalogAdmin>;
