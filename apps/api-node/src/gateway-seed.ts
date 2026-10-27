/**
 * Explicit Postgres gateway seed (#362): catalog + credits price book for
 * staging/test. DeepSeek is Flash only — any DeepSeek model code or upstream
 * that is not Flash is refused (mirrors @clash/gateway-core catalog-policy).
 *
 * Usage: DATABASE_URL=… pnpm --filter @clash/api-node gateway seed
 * (after `gateway migrate`). Never runs on startup; staging/test databases only.
 */
import { databaseUrl } from "./config.ts";
import { openPostgres, type SqlConnection } from "./postgres.ts";
import { runMigrations, type MigrationDatabase } from "./migrations.ts";

const DEEPSEEK = /deepseek/i;
const FLASH = /flash/i;

/**
 * Same rule as @clash/gateway-core `isBlockedDeepSeekModel`: a model code or
 * upstream naming DeepSeek must be a Flash model code. Kept local so the seed
 * CLI does not need a built gateway-core dist (#362 schema/seed only).
 */
function isBlockedDeepSeekModel(modelCode: string, upstreamId = ""): boolean {
  return (
    (DEEPSEEK.test(modelCode) || DEEPSEEK.test(upstreamId)) &&
    !FLASH.test(modelCode)
  );
}

export const GATEWAY_SEED_CATALOG_VERSION = "seed-1";
export const GATEWAY_SEED_PRICE_VERSION = "seed-1";
/** The only DeepSeek model this seed may publish. */
export const GATEWAY_SEED_DEEPSEEK_FLASH = "deepseek-v4-flash";

export interface GatewaySeedModel {
  modelCode: string;
  kind: string;
  displayName: string;
  /** Upstream id for the price row; '' = every upstream. */
  upstreamId?: string;
  card: Record<string, unknown>;
  /** Micro-credits per `per` input tokens. */
  inputAmountMicro: number;
  outputAmountMicro: number;
  per?: number;
}

export interface GatewaySeedInput {
  models: readonly GatewaySeedModel[];
  /** Epoch seconds; defaults to now. */
  nowSeconds?: number;
}

export class GatewaySeedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewaySeedError";
    this.code = code;
  }
}

/** Upstream ids/models of the card's provider implementations, when present. */
function cardImplementations(
  card: Record<string, unknown> | undefined,
): { upstreamId: string; upstreamModel: string }[] {
  const implementations = card?.providerImplementations;
  if (!Array.isArray(implementations)) return [];
  return implementations.map((entry: unknown) => {
    const value = (entry ?? {}) as Record<string, unknown>;
    return {
      upstreamId: typeof value.upstreamId === "string" ? value.upstreamId : "",
      upstreamModel:
        typeof value.upstreamModel === "string" ? value.upstreamModel : "",
    };
  });
}

/**
 * Refuse any DeepSeek model that is not Flash (product lock, 2026-10-20): the
 * model code, its price upstream, and every card implementation. A Flash
 * card that routes to a non-Flash DeepSeek upstream model is refused here,
 * where gateway-core's catalog policy would silently drop that route.
 */
export function assertGatewaySeedFlashOnly(
  models: readonly (Pick<GatewaySeedModel, "modelCode" | "upstreamId"> & {
    card?: Record<string, unknown>;
  })[],
): void {
  for (const model of models) {
    const upstreamId = model.upstreamId ?? "";
    if (isBlockedDeepSeekModel(model.modelCode, upstreamId)) {
      throw new GatewaySeedError(
        "GATEWAY_SEED_MODEL_BLOCKED",
        `DeepSeek seed models must be Flash only; refused ${model.modelCode}` +
          (upstreamId ? ` (upstream ${upstreamId})` : ""),
      );
    }
    for (const implementation of cardImplementations(model.card)) {
      if (
        (DEEPSEEK.test(implementation.upstreamId) ||
          DEEPSEEK.test(implementation.upstreamModel)) &&
        !FLASH.test(implementation.upstreamModel)
      )
        throw new GatewaySeedError(
          "GATEWAY_SEED_MODEL_BLOCKED",
          `DeepSeek seed models must be Flash only; ${model.modelCode} routes to ${implementation.upstreamModel || "an unnamed model"} (upstream ${implementation.upstreamId || "unknown"})`,
        );
    }
  }
}

export function defaultGatewaySeedModels(): GatewaySeedModel[] {
  return [
    {
      modelCode: GATEWAY_SEED_DEEPSEEK_FLASH,
      kind: "text",
      displayName: "DeepSeek V4 Flash",
      upstreamId: "deepseek",
      inputAmountMicro: 100,
      outputAmountMicro: 200,
      per: 1_000_000,
      card: {
        id: GATEWAY_SEED_DEEPSEEK_FLASH,
        kind: "text",
        name: "DeepSeek V4 Flash",
        provider: "deepseek",
        providerImplementations: [
          {
            providerAccountId: "official-deepseek",
            upstreamId: "deepseek",
            upstreamModel: "deepseek-v4-flash",
          },
        ],
      },
    },
  ];
}

export async function seedGatewayDatabase(
  db: { transaction<T>(work: (tx: SqlConnection) => Promise<T>): Promise<T> },
  input: GatewaySeedInput = { models: defaultGatewaySeedModels() },
): Promise<{ models: number; prices: number }> {
  assertGatewaySeedFlashOnly(input.models);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return db.transaction(async (tx) => {
    let models = 0;
    let prices = 0;
    for (const model of input.models) {
      const modelId = `${GATEWAY_SEED_CATALOG_VERSION}:${model.modelCode}`;
      await tx.query(
        `INSERT INTO gateway_model (
           id, catalog_version, model_code, kind, display_name, enabled,
           card_json, published_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,1,$6::jsonb,$7,$7)
         ON CONFLICT (id) DO UPDATE SET
           card_json = EXCLUDED.card_json,
           display_name = EXCLUDED.display_name,
           published_at = EXCLUDED.published_at`,
        [
          modelId,
          GATEWAY_SEED_CATALOG_VERSION,
          model.modelCode,
          model.kind,
          model.displayName,
          JSON.stringify(model.card),
          now,
        ],
      );
      models += 1;
      const per = model.per ?? 1_000_000;
      const upstreamId = model.upstreamId ?? "";
      for (const [unit, amount] of [
        ["input_token", model.inputAmountMicro],
        ["output_token", model.outputAmountMicro],
      ] as const) {
        const priceId = `${GATEWAY_SEED_PRICE_VERSION}:${model.modelCode}:${upstreamId}:${unit}`;
        await tx.query(
          `INSERT INTO gateway_price (
             id, price_version, model_code, upstream_id, unit, amount_micro, per,
             currency, effective_from, source, published_at, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'credit',$8,'seed',$8,$8)
           ON CONFLICT (id) DO UPDATE SET
             amount_micro = EXCLUDED.amount_micro,
             per = EXCLUDED.per,
             published_at = EXCLUDED.published_at`,
          [
            priceId,
            GATEWAY_SEED_PRICE_VERSION,
            model.modelCode,
            upstreamId,
            unit,
            amount,
            per,
            now,
          ],
        );
        prices += 1;
      }
    }
    await tx.query(
      `INSERT INTO gateway_config (key, value, version, updated_at)
       VALUES ('seed.catalog_version', $1::jsonb, 1, $2)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         version = gateway_config.version + 1,
         updated_at = EXCLUDED.updated_at`,
      [JSON.stringify({ catalogVersion: GATEWAY_SEED_CATALOG_VERSION }), now],
    );
    return { models, prices };
  });
}

/**
 * Seed a database `gateway migrate` already brought to this release. The
 * seed never migrates: schema changes go through the one migrate path, so a
 * pending migration is refused instead of applied behind the rollout.
 */
export async function seedGatewaySchemaReady(
  db: MigrationDatabase,
  input?: GatewaySeedInput,
): Promise<{ models: number; prices: number }> {
  const plan = await runMigrations(db, { plan: true });
  if (plan.pending.length)
    throw new GatewaySeedError(
      "GATEWAY_SEED_SCHEMA_PENDING",
      `Run gateway migrate first; pending: ${plan.pending.map((migration) => migration.id).join(", ")}`,
    );
  return seedGatewayDatabase(db, input);
}

export async function seedGateway(
  env: Record<string, string | undefined> = process.env,
): Promise<{ models: number; prices: number }> {
  const database = openPostgres({ connectionString: databaseUrl(env), max: 1 });
  try {
    return await seedGatewaySchemaReady(database.db);
  } finally {
    await database.close();
  }
}
