/**
 * Test support (not imported by the Worker): seeds a migrated D1 with a
 * published catalog, a price, a sealed official upstream key, budgets and
 * limited virtual keys, and returns a gateway-core contract harness over the
 * real D1 ports. Used by the node:sqlite unit run and the miniflare/workerd
 * integration run, so both execute the same contract.
 *
 * The text model is a built-in shared-types card with an official
 * OpenAI-compatible route, and the messages model one with an official
 * anthropic-compatible route (#349), both published through
 * `gateway_model.card_json`: the catalog stays data. Seeded amounts are fixture inputs; the contract derives
 * every expectation from the ports, never from these numbers.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { GatewayContractHarness } from "@clash/gateway-core/contract";
import type { BudgetEnforcement, GatewayClock, GatewayPorts } from "@clash/gateway-core";
import { listDeclaredModelUpstreamRoutes, MODEL_CARDS, type ModelCard } from "@clash/shared-types";

import { sha256Hex } from "../services/api-token";
import { createGatewayTokenStore, type GatewayTokenScope } from "../services/gateway-tokens";
import { toSeconds } from "./d1-common";
import { sealGatewayUpstreamCredentials } from "./d1-credentials";
import { createD1GatewayPorts } from "./index";
import type { GatewayBlobBucket } from "./r2-blobs";

export const CONTRACT_ORIGIN = "https://gateway.contract";

/** An in-memory stand-in for the R2 bucket on node:sqlite runs (workerd runs use the real binding). */
export function createMemoryBucket(): GatewayBlobBucket & { objects: Map<string, { body: Uint8Array; contentType?: string }> } {
  const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
  return {
    objects,
    async put(key, value, options) {
      const contentType = options?.httpMetadata?.contentType;
      objects.set(key, { body: value.slice(), ...(contentType ? { contentType } : {}) });
      return {};
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        arrayBuffer: async () => object.body.slice().buffer as ArrayBuffer,
        ...(object.contentType ? { httpMetadata: { contentType: object.contentType } } : {}),
      };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A built-in text card the official gateway can serve over the OpenAI wire format. */
export function officialChatCard(): ModelCard {
  const card = MODEL_CARDS.find(
    (candidate) =>
      candidate.kind === "text" &&
      listDeclaredModelUpstreamRoutes([candidate]).some(
        (route) =>
          route.providerId === "official" &&
          route.apiShape === "openai-compatible" &&
          route.upstreamId === "openai" &&
          !route.executorPluginId,
      ),
  );
  if (!card) throw new Error("shared-types has no official OpenAI-compatible text card");
  return card;
}

/**
 * A built-in text card the official gateway can serve over the Anthropic
 * Messages wire format. It is the only anthropic-compatible card the seed
 * publishes, so an agent's model id maps to it alone.
 */
export function officialMessagesCard(): ModelCard {
  const card = MODEL_CARDS.find(
    (candidate) =>
      candidate.kind === "text" &&
      listDeclaredModelUpstreamRoutes([candidate]).some(
        (route) =>
          route.providerId === "official" &&
          route.apiShape === "anthropic-compatible" &&
          route.upstreamId === "anthropic" &&
          !route.executorPluginId,
      ),
  );
  if (!card) throw new Error("shared-types has no official anthropic-compatible text card");
  return card;
}

export interface TenantTokenOptions {
  modelAllowlist?: string[];
  scopes?: GatewayTokenScope[];
  budgets?: boolean;
}

export interface SeededGateway {
  db: D1Database;
  /** Blob storage behind the seeded ports, when the run has one. */
  bucket?: GatewayBlobBucket;
  clock: GatewayClock;
  encryptionKey: string;
  textModel: string;
  /** Served over the Anthropic Messages route (#349). */
  messagesModel: string;
  catalogVersion: string;
  upstreamAccountId: string;
  upstreamApiKey: string;
  /** The official anthropic-compatible account serving `messagesModel`. */
  messagesAccountId: string;
  ports(overrides?: Partial<GatewayPorts>): GatewayPorts;
  /** Mint a token for a fresh user in their own personal tenant, with limited budgets unless `budgets: false`. */
  tenantToken(options?: TenantTokenOptions): Promise<{ token: string; userId: string; tenantId: string }>;
  /** A fresh tenant whose member budget has a zero limit with `enforcement`, under an ample hard wallet. */
  memberBudgetToken(enforcement: BudgetEnforcement): Promise<{ token: string; userId: string; tenantId: string }>;
  /** A token minted from a virtual key carrying `rateLimit`. */
  keyToken(owner: { userId: string; tenantId: string }, rateLimit: Record<string, number>): Promise<string>;
}

export async function seedGateway(db: D1Database, options: { bucket?: GatewayBlobBucket } = {}): Promise<SeededGateway> {
  // A frozen clock keeps every contract step in one rate window.
  const t0 = Date.now();
  const clock: GatewayClock = { now: () => t0 };
  const nowS = toSeconds(t0);
  const run = hex(6);
  const encryptionKey = `contract-kek-${hex(16)}`;
  const card = officialChatCard();
  const catalogVersion = `contract-${run}`;
  const upstreamAccountId = `gwu_contract_${run}`;
  const upstreamApiKey = `sk-contract-${hex(12)}`;
  const messagesCard = officialMessagesCard();
  const messagesAccountId = `${upstreamAccountId}_messages`;
  const published = messagesCard.id === card.id ? [card] : [card, messagesCard];

  await db.batch([
    ...published.flatMap((model, index) => [
      db
        .prepare(
          `INSERT INTO gateway_model (id, catalog_version, model_code, kind, enabled, card_json, max_output_tokens, published_at)
           VALUES (?, ?, ?, ?, 1, ?, 4096, ?)`,
        )
        .bind(`gwm_${run}_${index}`, catalogVersion, model.id, model.kind, JSON.stringify(model), nowS - 60),
      ...[
        ["input_token", 3_000_000],
        ["output_token", 15_000_000],
      ].map(([unit, amount]) =>
        db
          .prepare(
            `INSERT INTO gateway_price (id, price_version, model_code, upstream_id, unit, amount_micro, per, effective_from, published_at)
             VALUES (?, ?, ?, '', ?, ?, 1000000, ?, ?)`,
          )
          .bind(`gwp_${run}_${index}_${unit}`, `price-${run}`, model.id, unit, amount, nowS - 60, nowS - 60),
      ),
    ]),
    db
      .prepare(
        `INSERT INTO gateway_upstream_account
           (id, provider_id, upstream_id, api_shape, enabled, encrypted_credentials, configured_credentials)
         VALUES (?, 'official', 'openai', 'openai-compatible', 1, ?, '["apiKey"]')`,
      )
      .bind(upstreamAccountId, await sealGatewayUpstreamCredentials({ apiKey: upstreamApiKey }, encryptionKey)),
    db
      .prepare(
        `INSERT INTO gateway_upstream_account
           (id, provider_id, upstream_id, api_shape, enabled, encrypted_credentials, configured_credentials)
         VALUES (?, 'official', 'anthropic', 'anthropic-compatible', 1, ?, '["apiKey"]')`,
      )
      .bind(messagesAccountId, await sealGatewayUpstreamCredentials({ apiKey: `sk-ant-contract-${hex(12)}` }, encryptionKey)),
  ]);

  const tokens = createGatewayTokenStore(db, { clock });

  async function tenantToken(tokenOptions: TenantTokenOptions = {}) {
    const userId = `gw-user-${hex(8)}`;
    const parentId = `gw-parent-${hex(8)}`;
    await db
      .prepare(`INSERT INTO api_token (id, user_id, name, token_hash, token_prefix) VALUES (?, ?, 'gw', ?, 'clsh_gw')`)
      .bind(parentId, userId, await sha256Hex(`clsh_${hex(20)}`))
      .run();
    const minted = await tokens.mint({
      userId,
      parent: { kind: "api_token", id: parentId },
      ...(tokenOptions.modelAllowlist ? { modelAllowlist: tokenOptions.modelAllowlist } : {}),
      ...(tokenOptions.scopes ? { scopes: tokenOptions.scopes } : {}),
    });
    if (tokenOptions.budgets === false) return { token: minted.token, userId, tenantId: minted.tenantId };
    await db.batch([
      db
        .prepare(
          `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits) VALUES (?, ?, 'tenant', ?, 50000000)`,
        )
        .bind(`gwb_t_${hex(8)}`, minted.tenantId, minted.tenantId),
      db
        .prepare(`INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits) VALUES (?, ?, 'user', ?, NULL)`)
        .bind(`gwb_u_${hex(8)}`, minted.tenantId, userId),
    ]);
    return { token: minted.token, userId, tenantId: minted.tenantId };
  }

  /** A fresh tenant whose member budget has a zero limit with `enforcement`, under an ample hard wallet. */
  async function memberBudgetToken(enforcement: BudgetEnforcement) {
    const minted = await tenantToken({ budgets: false });
    await db.batch([
      db
        .prepare(`INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits) VALUES (?, ?, 'tenant', ?, 1000000000)`)
        .bind(`gwb_t_${hex(8)}`, minted.tenantId, minted.tenantId),
      db
        .prepare(
          `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits, enforcement) VALUES (?, ?, 'user', ?, 0, ?)`,
        )
        .bind(`gwb_u_${hex(8)}`, minted.tenantId, minted.userId, enforcement),
    ]);
    return minted;
  }

  async function keyToken(owner: { userId: string; tenantId: string }, rateLimit: Record<string, number>) {
    const keyId = `gwk_${hex(8)}`;
    const publicId = hex(12);
    const token = `sk_gw_${publicId}.${hex(32)}`;
    await db.batch([
      db
        .prepare(
          `INSERT INTO gateway_key (id, tenant_id, user_id, name, token_prefix, token_hash, scopes_json, rate_limit_json)
           VALUES (?, ?, ?, 'contract', 'sk_gw_', ?, '["models:invoke"]', ?)`,
        )
        .bind(keyId, owner.tenantId, owner.userId, await sha256Hex(`key-${keyId}`), JSON.stringify(rateLimit)),
      db
        .prepare(
          `INSERT INTO gateway_token (id, token_hash, key_id, tenant_id, user_id, scopes_json, credential_scope, expires_at)
           VALUES (?, ?, ?, ?, ?, '["models:invoke"]', 'official', ?)`,
        )
        .bind(`gwt_${publicId}`, await sha256Hex(token), keyId, owner.tenantId, owner.userId, nowS + 900),
    ]);
    return token;
  }

  return {
    db,
    ...(options.bucket ? { bucket: options.bucket } : {}),
    clock,
    encryptionKey,
    textModel: card.id,
    messagesModel: messagesCard.id,
    catalogVersion,
    upstreamAccountId,
    upstreamApiKey,
    messagesAccountId,
    ports: (overrides = {}) => ({
      ...createD1GatewayPorts({
        db,
        clock,
        ...(options.bucket ? { bucket: options.bucket } : {}),
        secrets: { encryptionKey, secret: () => undefined },
        logger: { info() {}, warn() {}, error() {} },
      }),
      ...overrides,
    }),
    tenantToken,
    memberBudgetToken,
    keyToken,
  };
}

export const gatewayRequest = (token?: string) =>
  new Request(`${CONTRACT_ORIGIN}/gateway/v1/chat/completions`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

/** The gateway-core contract over the D1 ports: every capability but scheduler and audit (blobs when seeded with a bucket). */
export async function d1ContractHarness(seeded: SeededGateway): Promise<GatewayContractHarness> {
  const tenantA = await seeded.tenantToken();
  const tenantB = await seeded.tenantToken();
  const rateLimited = await seeded.keyToken(tenantA, { requestsPerMinute: 3 });
  const concurrencyLimited = await seeded.keyToken(tenantA, { concurrency: 2 });
  return {
    ports: seeded.ports(),
    capabilities: {
      identity: "supported",
      routes: "supported",
      credentials: "supported",
      upstreamHealth: "supported",
      budgets: "supported",
      ledger: "supported",
      "limits.rate": "supported",
      "limits.concurrency": "supported",
      blobs: seeded.bucket ? "supported" : "unavailable",
      retention: "supported",
      scheduler: "unavailable",
      audit: "unavailable",
    },
    fixtures: {
      tenantRequest: () => gatewayRequest(tenantA.token),
      otherTenantRequest: () => gatewayRequest(tenantB.token),
      anonymousRequest: () => gatewayRequest(),
      textModel: seeded.textModel,
      messagesModel: seeded.messagesModel,
      rateLimited: { request: () => gatewayRequest(rateLimited), limit: 3 },
      concurrencyLimited: { request: () => gatewayRequest(concurrencyLimited), limit: 2 },
      memberBudget: async (enforcement) => gatewayRequest((await seeded.memberBudgetToken(enforcement)).token),
    },
  };
}
