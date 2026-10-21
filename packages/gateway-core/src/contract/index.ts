/**
 * Shared GatewayPorts contract: one Vitest suite every runtime adapter (the
 * in-memory stub, Node/PostgreSQL, Node/SQLite, Workers/D1) runs against its
 * real ports. A `supported` capability must keep its semantics; an
 * `unavailable` one must reject with GATEWAY_CAPABILITY_UNAVAILABLE (501),
 * never resolve silently.
 *
 * A known gap works like `it.fails` at capability granularity: its failures
 * are recorded, and the gap's last case requires at least one, so the suite
 * turns red once the adapter meets the capability and the gap must be removed.
 *
 * Test-only entry (`@clash/gateway-core/contract`); it imports Vitest and is
 * not exported from the package root. The suite takes no clock or randomness
 * of its own: time and ids come from the adapter's ports.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelUpstreamRoute } from "@clash/shared-types/model-routing";

import {
  admitGatewayRequest,
  settleGatewayRequest,
  type GatewayAdmission,
} from "../admission.js";
import {
  createGatewayApp,
  GATEWAY_REQUEST_ID_HEADER,
  GATEWAY_SETTLEMENT_HEADER,
  isOpenAIChatRoute,
  type GatewayAppOptions,
} from "../app.js";
import { GatewayError, isGatewayError, type GatewayErrorCode } from "../errors.js";
import {
  GATEWAY_PORT_NAMES,
  type GatewayIdentity,
  type GatewayPorts,
  type UsageEvent,
} from "../ports.js";
import { priceUsage } from "../pricing.js";
import {
  normalizeMediaGenerationRequest,
  normalizeOpenAIChatRequest,
  type GatewayModelKind,
} from "../request.js";
import {
  GATEWAY_BODY_RETENTION_MS,
  GATEWAY_RETENTION_HEADER,
  gatewayRetentionKeys,
  purgeExpiredGatewayBodies,
  readRetainedExchange,
  retainGatewayExchange,
  sha256Hex,
} from "../retention.js";
import { planGatewayRoutes, type GatewayCredentialScope } from "../routing.js";
import { createUsageAccumulator, emptyUsage, type GatewayMediaUnit } from "../usage.js";

export const GATEWAY_CONTRACT_CAPABILITIES = [
  "identity",
  "routes",
  "credentials",
  "budgets",
  "ledger",
  "limits.rate",
  "limits.concurrency",
  "blobs",
  "retention",
  "scheduler",
  "audit",
] as const;

export type GatewayCapabilityId = (typeof GATEWAY_CONTRACT_CAPABILITIES)[number];

export type GatewayContractCapabilities = Record<
  GatewayCapabilityId,
  "supported" | "unavailable"
>;

export interface GatewayContractHarness {
  ports: GatewayPorts;
  capabilities: GatewayContractCapabilities;
  /** Declared capabilities that do not meet the contract yet; their cases must fail. */
  knownGaps?: GatewayCapabilityId[];
  fixtures: {
    /** A fresh credential of tenant A with at least one limited budget (not yet spent). */
    tenantRequest(): Request;
    /** A credential of a different tenant, for isolation checks. */
    otherTenantRequest(): Request;
    /** No credential at all. */
    anonymousRequest(): Request;
    /** A text model servable and priced for tenant A's scope. */
    textModel: string;
    /** Optional media/AIGC model servable and priced for tenant A's scope. */
    mediaModel?: { code: string; kind: GatewayModelKind; units: Partial<Record<GatewayMediaUnit, number>> };
    /** A credential whose key admits exactly `limit` requests per rate window. */
    rateLimited?: { request(): Request; limit: number };
    /** A credential whose key admits exactly `limit` concurrent requests. */
    concurrencyLimited?: { request(): Request; limit: number };
  };
  close?: () => Promise<void>;
}

async function expectCode(promise: Promise<unknown>, code: GatewayErrorCode): Promise<GatewayError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isGatewayError(caught), `expected ${code}, got ${String(caught)}`).toBe(true);
  expect((caught as GatewayError).code).toBe(code);
  return caught as GatewayError;
}

const other = (scope: GatewayCredentialScope): GatewayCredentialScope =>
  scope === "official" ? "tenant" : "official";

export function describeGatewayContract(
  name: string,
  setup: () => Promise<GatewayContractHarness>,
): void {
  describe(`Gateway contract: ${name}`, () => {
    let harness: GatewayContractHarness;
    let sequence = 0;
    const unique = (prefix: string) => `${prefix}-contract-${(sequence += 1)}`;
    const ports = () => harness.ports;
    const tenant = () => ports().identity.authenticate(harness.fixtures.tenantRequest());

    beforeAll(async () => {
      harness = await setup();
    }, 120_000);
    afterAll(async () => {
      await harness?.close?.();
    });

    const capability = (
      id: GatewayCapabilityId,
      cases: {
        supported: Array<[string, () => Promise<void>]>;
        unavailable: () => Promise<void>;
      },
    ) => {
      describe(id, () => {
        type Variant = ["supported" | "unavailable", string, () => Promise<void>];
        const variants: Variant[] = [
          ...cases.supported.map(([title, body]): Variant => ["supported", title, body]),
          ["unavailable", "rejects with GATEWAY_CAPABILITY_UNAVAILABLE", cases.unavailable],
        ];
        const gap = () => harness.knownGaps?.includes(id) ?? false;
        const failures: string[] = [];
        for (const [variant, title, body] of variants)
          it(`${variant}: ${title}`, async (context) => {
            if (harness.capabilities[id] !== variant) return context.skip();
            if (!gap()) return body();
            try {
              await body();
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              failures.push(`${title}: ${reason}`);
              await context.annotate(`known gap ${id}: ${reason}`);
            }
          });
        it("known gap: still fails", async (context) => {
          if (!gap()) return context.skip();
          expect(
            failures,
            `${id} is listed in knownGaps but now meets the contract: remove it`,
          ).not.toEqual([]);
        });
      });
    };

    it("declares every capability and only known capability gaps", () => {
      for (const id of GATEWAY_CONTRACT_CAPABILITIES)
        expect(["supported", "unavailable"], id).toContain(harness.capabilities[id]);
      for (const id of harness.knownGaps ?? []) {
        expect(GATEWAY_CONTRACT_CAPABILITIES).toContain(id);
        expect(harness.capabilities[id], `${id}: a known gap is a supported capability`).toBe(
          "supported",
        );
      }
    });

    it("provides every port (an unimplemented one is an unavailable port, not a gap)", () => {
      for (const name of GATEWAY_PORT_NAMES) expect(ports()[name], name).toBeTruthy();
    });

    it("clock answers integer epoch milliseconds that never go backwards", () => {
      const first = ports().clock.now();
      const second = ports().clock.now();
      expect(Number.isSafeInteger(first)).toBe(true);
      expect(second).toBeGreaterThanOrEqual(first);
    });

    it("ids are unique", () => {
      const ids = Array.from({ length: 64 }, () => ports().ids.requestId());
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/\S/);
    });

    it("logger never throws", () => {
      expect(() => {
        ports().logger.info("gateway.contract", { requestId: unique("log") });
        ports().logger.warn("gateway.contract", {});
        ports().logger.error("gateway.contract");
      }).not.toThrow();
    });

    const unavailable = (call: () => Promise<unknown>) => async () => {
      await expectCode(call(), "GATEWAY_CAPABILITY_UNAVAILABLE");
    };

    // ─── Identity ────────────────────────────────────────────────────
    capability("identity", {
      supported: [
        [
          "derives a tenant identity from the credential",
          async () => {
            const identity = await tenant();
            expect(identity.tenantId).toMatch(/\S/);
            expect(identity.userId).toMatch(/\S/);
            expect(Array.isArray(identity.budgetIds)).toBe(true);
            expect(["official", "tenant"]).toContain(identity.credentialScope);
            const otherIdentity = await ports().identity.authenticate(
              harness.fixtures.otherTenantRequest(),
            );
            expect(otherIdentity.tenantId).not.toBe(identity.tenantId);
          },
        ],
        [
          "rejects a request without a credential with GATEWAY_AUTH_REQUIRED",
          async () => {
            await expectCode(
              ports().identity.authenticate(harness.fixtures.anonymousRequest()),
              "GATEWAY_AUTH_REQUIRED",
            );
          },
        ],
      ],
      unavailable: unavailable(() => ports().identity.authenticate(harness.fixtures.tenantRequest())),
    });

    // ─── Routes ──────────────────────────────────────────────────────
    const plan = async (identity: GatewayIdentity, model = harness.fixtures.textModel) => {
      const catalog = await ports().routes.catalog(identity);
      return planGatewayRoutes({
        modelCode: model,
        catalog,
        scope: identity.credentialScope,
        providers: await ports().routes.providers(identity, identity.credentialScope),
      });
    };

    capability("routes", {
      supported: [
        [
          "plans the text model within the caller's scope only",
          async () => {
            const identity = await tenant();
            const routePlan = await plan(identity);
            expect(routePlan.catalogVersion).toMatch(/\S/);
            expect(routePlan.attempts.length).toBeGreaterThan(0);
            for (const attempt of routePlan.attempts)
              expect(attempt.scope).toBe(identity.credentialScope);
          },
        ],
        [
          "keeps official and tenant accounts disjoint",
          async () => {
            const identity = await tenant();
            const official = await ports().routes.providers(identity, "official");
            const byok = await ports().routes.providers(identity, "tenant");
            const officialIds = new Set(official.map((provider) => provider.id));
            for (const provider of byok)
              expect(officialIds.has(provider.id), `${provider.id} is in both scopes`).toBe(false);
          },
        ],
        [
          "prices the first route in integer micro-credits",
          async () => {
            const identity = await tenant();
            const routePlan = await plan(identity);
            const price = await ports().routes.price({
              identity,
              catalogVersion: routePlan.catalogVersion,
              route: routePlan.attempts[0]!.route,
            });
            expect(price.version).toMatch(/\S/);
            for (const rate of price.rates) {
              expect(Number.isSafeInteger(rate.microCredits)).toBe(true);
              expect(Number.isSafeInteger(rate.per) && rate.per > 0).toBe(true);
            }
          },
        ],
        [
          "an unknown model is GATEWAY_MODEL_NOT_FOUND",
          async () => {
            const identity = await tenant();
            await expectCode(
              plan(identity, unique("no-such-model")),
              "GATEWAY_MODEL_NOT_FOUND",
            );
          },
        ],
      ],
      unavailable: unavailable(async () => ports().routes.catalog(await tenant())),
    });

    // ─── Credentials ─────────────────────────────────────────────────
    capability("credentials", {
      supported: [
        [
          "resolves a key for the caller's scope and refuses the other scope",
          async () => {
            const identity = await tenant();
            const { route } = (await plan(identity)).attempts[0]!;
            const credential = await ports().credentials.resolve({
              route,
              scope: identity.credentialScope,
              tenantId: identity.tenantId,
            });
            expect(credential.apiKey).toMatch(/\S/);
            expect(credential.keyId).toMatch(/\S/);
            expect(credential.keyId).not.toContain(credential.apiKey);
            await expectCode(
              ports().credentials.resolve({
                route,
                scope: other(identity.credentialScope),
                tenantId: identity.tenantId,
              }),
              "GATEWAY_KEY_UNAVAILABLE",
            );
          },
        ],
      ],
      unavailable: async () => {
        const identity = await tenant();
        // Without routes there is no planned route; an unavailable port must
        // reject whatever it is given, so a placeholder route suffices.
        const route =
          harness.capabilities.routes === "supported"
            ? (await plan(identity)).attempts[0]!.route
            : ({ modelCode: harness.fixtures.textModel, kind: "text" } as ModelUpstreamRoute);
        await expectCode(
          ports().credentials.resolve({ route, scope: identity.credentialScope, tenantId: identity.tenantId }),
          "GATEWAY_CAPABILITY_UNAVAILABLE",
        );
      },
    });

    // ─── Budgets + ledger ────────────────────────────────────────────
    const snapshot = async (identity: GatewayIdentity) =>
      new Map(
        (await ports().budgets.snapshot({ tenantId: identity.tenantId, budgetIds: identity.budgetIds })).map(
          (budget) => [budget.id, budget],
        ),
      );

    /** Money counters only; versions legitimately advance on every write. */
    const counters = async (identity: GatewayIdentity) =>
      [...(await snapshot(identity)).values()]
        .map((budget) => [budget.id, budget.spentMicroCredits, budget.reservedMicroCredits])
        .sort();

    const settlementEvent = (
      identity: GatewayIdentity,
      requestId: string,
      costMicroCredits: number,
      status: UsageEvent["status"] = "settled",
    ): UsageEvent => ({
      requestId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      ...(identity.keyId ? { keyId: identity.keyId } : {}),
      modelCode: harness.fixtures.textModel,
      kind: "text",
      upstreamId: "contract",
      credentialScope: identity.credentialScope,
      usage: emptyUsage(),
      costMicroCredits,
      priceVersion: "contract",
      catalogVersion: "contract",
      status,
      occurredAt: ports().clock.now(),
    });

    const reserve = (identity: GatewayIdentity, hold: number, idempotencyKey?: string) =>
      ports().budgets.reserve({
        requestId: ports().ids.requestId(),
        tenantId: identity.tenantId,
        budgetIds: identity.budgetIds,
        holdMicroCredits: hold,
        expiresAt: ports().clock.now() + 60_000,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });

    capability("budgets", {
      supported: [
        [
          "reserve holds on every budget; settle moves the hold to spent exactly once",
          async () => {
            const identity = await tenant();
            expect(identity.budgetIds.length).toBeGreaterThan(0);
            const before = await snapshot(identity);
            const reservation = await reserve(identity, 3);
            expect(reservation.holds.map((hold) => hold.budgetId).sort()).toEqual(
              [...identity.budgetIds].sort(),
            );
            const held = await snapshot(identity);
            for (const [id, budget] of held) {
              expect(budget.reservedMicroCredits).toBe(before.get(id)!.reservedMicroCredits + 3);
              expect(budget.spentMicroCredits).toBe(before.get(id)!.spentMicroCredits);
            }
            const event = settlementEvent(identity, reservation.requestId, 2);
            const first = await ports().budgets.settle(event);
            expect(first).toMatchObject({ duplicate: false, costMicroCredits: 2 });
            const settled = await snapshot(identity);
            const duplicate = await ports().budgets.settle({ ...event, costMicroCredits: 99 });
            expect(duplicate).toMatchObject({ duplicate: true, costMicroCredits: 2 });
            expect(await snapshot(identity)).toEqual(settled);
            for (const [id, budget] of settled) {
              expect(budget.reservedMicroCredits).toBe(before.get(id)!.reservedMicroCredits);
              expect(budget.spentMicroCredits).toBe(before.get(id)!.spentMicroCredits + 2);
              expect(Number.isSafeInteger(budget.spentMicroCredits)).toBe(true);
              expect(Number.isSafeInteger(budget.reservedMicroCredits)).toBe(true);
            }
          },
        ],
        [
          "an over-limit reservation is GATEWAY_BUDGET_EXCEEDED and holds nothing",
          async () => {
            const identity = await tenant();
            const before = await snapshot(identity);
            const limited = [...before.values()].filter((budget) => budget.limitMicroCredits !== null);
            expect(limited.length, "fixture needs a limited budget").toBeGreaterThan(0);
            const remaining = Math.min(
              ...limited.map(
                (budget) =>
                  budget.limitMicroCredits! - budget.spentMicroCredits - budget.reservedMicroCredits,
              ),
            );
            await expectCode(reserve(identity, remaining + 1), "GATEWAY_BUDGET_EXCEEDED");
            expect(await snapshot(identity)).toEqual(before);
          },
        ],
        [
          "a zero-cost settlement releases the hold without spending",
          async () => {
            const identity = await tenant();
            const before = await snapshot(identity);
            const reservation = await reserve(identity, 5);
            await ports().budgets.settle(
              settlementEvent(identity, reservation.requestId, 0, "upstream_failed"),
            );
            const after = await snapshot(identity);
            for (const [id, budget] of after) {
              expect(budget.spentMicroCredits).toBe(before.get(id)!.spentMicroCredits);
              expect(budget.reservedMicroCredits).toBe(before.get(id)!.reservedMicroCredits);
            }
          },
        ],
        [
          "an idempotency key admits once: in progress, then already settled",
          async () => {
            const identity = await tenant();
            const key = unique("idem");
            const reservation = await reserve(identity, 1, key);
            await expectCode(reserve(identity, 1, key), "GATEWAY_IDEMPOTENCY_IN_PROGRESS");
            await ports().budgets.settle(settlementEvent(identity, reservation.requestId, 1));
            await expectCode(reserve(identity, 1, key), "GATEWAY_IDEMPOTENCY_ALREADY_SETTLED");
          },
        ],
        [
          "a failed settlement is marked settle_failed and stays held; a later settle closes it once",
          async () => {
            const identity = await tenant();
            const before = await snapshot(identity);
            const key = unique("idem");
            const reservation = await reserve(identity, 3, key);
            const mark = {
              requestId: reservation.requestId,
              tenantId: identity.tenantId,
              errorCode: "GATEWAY_INTERNAL",
            };
            expect(await ports().budgets.markSettleFailed(mark)).toEqual({ status: "settle_failed" });
            expect(await ports().budgets.markSettleFailed(mark)).toEqual({ status: "settle_failed" });
            for (const [id, budget] of await snapshot(identity)) {
              expect(budget.reservedMicroCredits).toBe(before.get(id)!.reservedMicroCredits + 3);
              expect(budget.spentMicroCredits).toBe(before.get(id)!.spentMicroCredits);
            }
            await expectCode(reserve(identity, 1, key), "GATEWAY_IDEMPOTENCY_IN_PROGRESS");
            const event = settlementEvent(identity, reservation.requestId, 2);
            expect(await ports().budgets.settle(event)).toMatchObject({ duplicate: false, costMicroCredits: 2 });
            expect(await ports().budgets.settle({ ...event, costMicroCredits: 99 })).toMatchObject({
              duplicate: true,
              costMicroCredits: 2,
            });
            for (const [id, budget] of await snapshot(identity)) {
              expect(budget.reservedMicroCredits).toBe(before.get(id)!.reservedMicroCredits);
              expect(budget.spentMicroCredits).toBe(before.get(id)!.spentMicroCredits + 2);
            }
            expect(await ports().budgets.markSettleFailed(mark)).toEqual({ status: "settled" });
            await expectCode(
              ports().budgets.markSettleFailed({ ...mark, requestId: unique("never-reserved") }),
              "GATEWAY_INTERNAL",
            );
          },
        ],
      ],
      unavailable: unavailable(async () => reserve(await tenant(), 1)),
    });

    capability("ledger", {
      supported: [
        [
          "settlement writes one tenant-scoped ledger row",
          async () => {
            const identity = await tenant();
            const otherIdentity = await ports().identity.authenticate(
              harness.fixtures.otherTenantRequest(),
            );
            const reservation = await reserve(identity, 4);
            await ports().budgets.settle(settlementEvent(identity, reservation.requestId, 4));
            await ports().budgets.settle(settlementEvent(identity, reservation.requestId, 4));
            const row = await ports().ledger.get({
              tenantId: identity.tenantId,
              requestId: reservation.requestId,
            });
            expect(row).toMatchObject({ requestId: reservation.requestId, costMicroCredits: 4 });
            const rows = await ports().ledger.query({ tenantId: identity.tenantId });
            expect(rows.filter((entry) => entry.requestId === reservation.requestId)).toHaveLength(1);
            expect(
              await ports().ledger.get({
                tenantId: otherIdentity.tenantId,
                requestId: reservation.requestId,
              }),
            ).toBeNull();
            const foreign = await ports().ledger.query({ tenantId: otherIdentity.tenantId });
            expect(foreign.some((entry) => entry.requestId === reservation.requestId)).toBe(false);
          },
        ],
      ],
      unavailable: unavailable(async () =>
        ports().ledger.query({ tenantId: (await tenant()).tenantId }),
      ),
    });

    // ─── Limits ──────────────────────────────────────────────────────
    const admitFor = async (request: Request) => {
      const identity = await ports().identity.authenticate(request);
      return ports().limits.admit({
        tenantId: identity.tenantId,
        userId: identity.userId,
        ...(identity.keyId ? { keyId: identity.keyId } : {}),
        modelCode: harness.fixtures.textModel,
        estimatedTokens: 1,
      });
    };

    capability("limits.rate", {
      supported: [
        [
          "admits `limit` requests per window, then GATEWAY_RATE_LIMITED with Retry-After",
          async () => {
            const fixture = harness.fixtures.rateLimited;
            expect(fixture, "fixture rateLimited is required").toBeDefined();
            for (let index = 0; index < fixture!.limit; index += 1)
              expect((await admitFor(fixture!.request())).allowed).toBe(true);
            const denied = await admitFor(fixture!.request());
            expect(denied).toMatchObject({ allowed: false, code: "GATEWAY_RATE_LIMITED" });
            if (!denied.allowed) {
              expect(Number.isSafeInteger(denied.retryAfterMs)).toBe(true);
              expect(denied.retryAfterMs).toBeGreaterThanOrEqual(0);
            }
          },
        ],
      ],
      unavailable: unavailable(() => admitFor(harness.fixtures.tenantRequest())),
    });

    capability("limits.concurrency", {
      supported: [
        [
          "admits `limit` in-flight requests, denies the next, and admits again after a release",
          async () => {
            const fixture = harness.fixtures.concurrencyLimited;
            expect(fixture, "fixture concurrencyLimited is required").toBeDefined();
            const leases: string[] = [];
            for (let index = 0; index < fixture!.limit; index += 1) {
              const decision = await admitFor(fixture!.request());
              expect(decision.allowed).toBe(true);
              if (decision.allowed) leases.push(decision.leaseId);
            }
            const denied = await admitFor(fixture!.request());
            expect(denied).toMatchObject({ allowed: false, code: "GATEWAY_CONCURRENCY_LIMITED" });
            await ports().limits.release({ leaseId: leases[0]! });
            const again = await admitFor(fixture!.request());
            expect(again.allowed).toBe(true);
            for (const leaseId of [...leases.slice(1), ...(again.allowed ? [again.leaseId] : [])])
              await ports().limits.release({ leaseId });
          },
        ],
      ],
      unavailable: unavailable(() => admitFor(harness.fixtures.tenantRequest())),
    });

    // ─── Blobs, scheduler, audit ─────────────────────────────────────
    capability("blobs", {
      supported: [
        [
          "round-trips bytes and deletes",
          async () => {
            const key = unique("blob");
            const body = new Uint8Array([0, 1, 2, 250, 255]);
            await ports().blobs.put(key, { body, contentType: "application/octet-stream" });
            const blob = await ports().blobs.get(key);
            expect(blob && [...blob.body]).toEqual([...body]);
            await ports().blobs.delete(key);
            expect(await ports().blobs.get(key)).toBeNull();
          },
        ],
      ],
      unavailable: unavailable(() => ports().blobs.get(unique("blob"))),
    });

    capability("retention", {
      supported: [
        [
          "records metadata once per request id",
          async () => {
            const identity = await tenant();
            const requestId = unique("retention");
            const keys = gatewayRetentionKeys(requestId);
            const meta = (key: string) => ({ key, bytes: 2, sha256: "00".repeat(32), contentType: "application/json" });
            const entry = {
              requestId,
              tenantId: identity.tenantId,
              userId: identity.userId,
              status: "stored" as const,
              request: meta(keys.request),
              response: meta(keys.response),
              responseStatus: 200,
              storedAt: ports().clock.now(),
              expiresAt: ports().clock.now() + GATEWAY_BODY_RETENTION_MS,
            };
            await ports().retention.record(entry);
            await ports().retention.record({ ...entry, status: "failed", errorCode: "GATEWAY_INTERNAL" });
            expect(await ports().retention.get({ requestId })).toMatchObject({
              requestId,
              tenantId: identity.tenantId,
              status: "stored",
              request: entry.request,
              response: entry.response,
              responseStatus: 200,
            });
            expect(await ports().retention.get({ requestId: unique("retention-missing") })).toBeNull();
          },
        ],
        [
          "retains an exchange, reads back the stored bytes, and purges an expired one once",
          async () => {
            const identity = await tenant();
            const body = (text: string) => new TextEncoder().encode(text);
            const kept = unique("retention-kept");
            const exchange = (requestId: string, ttlMs?: number) =>
              retainGatewayExchange(ports(), {
                requestId,
                identity,
                request: { body: body(`{"prompt":"${requestId}"}`), contentType: "application/json" },
                response: { status: 200, body: body(`{"answer":"${requestId}"}`), contentType: "application/json" },
                ...(ttlMs !== undefined ? { ttlMs } : {}),
              });
            if (harness.capabilities.blobs !== "supported") {
              // Without blob storage nothing is kept, and that is recorded, not silent.
              expect(await exchange(kept)).toMatchObject({ status: "failed", code: "GATEWAY_RETENTION_FAILED", marker: "failed" });
              expect(await ports().retention.get({ requestId: kept })).toMatchObject({
                status: "failed",
                errorCode: "GATEWAY_CAPABILITY_UNAVAILABLE",
              });
              await expectCode(readRetainedExchange(ports(), { requestId: kept }), "GATEWAY_PROMPT_NOT_RETAINED");
              return;
            }
            expect(await exchange(kept)).toEqual({ status: "stored" });
            const read = await readRetainedExchange(ports(), { requestId: kept });
            expect(new TextDecoder().decode(read.request.body)).toBe(`{"prompt":"${kept}"}`);
            expect(new TextDecoder().decode(read.response.body)).toBe(`{"answer":"${kept}"}`);
            expect(read.response.sha256).toBe(await sha256Hex(body(`{"answer":"${kept}"}`)));

            // ttl 0: expired at once, so no clock has to move.
            const gone = unique("retention-expired");
            expect(await exchange(gone, 0)).toEqual({ status: "stored" });
            await expectCode(readRetainedExchange(ports(), { requestId: gone }), "GATEWAY_PROMPT_EXPIRED");
            await purgeExpiredGatewayBodies(ports(), { limit: 1000 });
            const purged = await ports().retention.get({ requestId: gone });
            expect(purged).toMatchObject({ status: "purged" });
            expect(await ports().blobs.get(gatewayRetentionKeys(gone).response)).toBeNull();
            // Idempotent: a purged row is not selected again and keeps its first purge time.
            expect((await ports().retention.expired({ before: ports().clock.now(), limit: 1000 })).map((e) => e.requestId)).not.toContain(gone);
            await ports().retention.markPurged({ requestId: gone, at: ports().clock.now() + 1 });
            expect((await ports().retention.get({ requestId: gone }))?.purgedAt).toBe(purged?.purgedAt);
            await expectCode(readRetainedExchange(ports(), { requestId: gone }), "GATEWAY_PROMPT_EXPIRED");
            // The unexpired exchange is untouched.
            expect((await ports().retention.get({ requestId: kept }))?.status).toBe("stored");
          },
        ],
      ],
      unavailable: unavailable(() => ports().retention.get({ requestId: unique("retention") })),
    });

    capability("scheduler", {
      supported: [
        [
          "enqueueing one job id twice schedules it once",
          async () => {
            const job = { id: unique("job"), kind: "contract", payload: {} };
            expect(await ports().scheduler.enqueue(job)).toMatchObject({ duplicate: false });
            expect(await ports().scheduler.enqueue(job)).toMatchObject({ duplicate: true });
          },
        ],
      ],
      unavailable: unavailable(() =>
        ports().scheduler.enqueue({ id: unique("job"), kind: "contract", payload: {} }),
      ),
    });

    capability("audit", {
      supported: [
        [
          "appends tenant-scoped audit events",
          async () => {
            const identity = await tenant();
            const otherIdentity = await ports().identity.authenticate(
              harness.fixtures.otherTenantRequest(),
            );
            const event = {
              id: unique("audit"),
              actor: identity.userId,
              tenantId: identity.tenantId,
              action: "contract.check",
              target: "contract",
              at: ports().clock.now(),
            };
            await ports().audit.append(event);
            const rows = await ports().audit.query({ tenantId: identity.tenantId });
            expect(rows.some((row) => row.id === event.id)).toBe(true);
            const foreign = await ports().audit.query({ tenantId: otherIdentity.tenantId });
            expect(foreign.some((row) => row.id === event.id)).toBe(false);
          },
        ],
      ],
      unavailable: unavailable(async () =>
        ports().audit.query({ tenantId: (await tenant()).tenantId }),
      ),
    });

    // ─── Composition: admission -> settlement ────────────────────────
    const composed = (title: string, body: (skip: () => void) => Promise<void>) =>
      it(`admission: ${title}`, async (context) => {
        const needed: GatewayCapabilityId[] = ["identity", "routes", "budgets", "ledger", "limits.rate"];
        if (needed.some((id) => harness.capabilities[id] !== "supported" || harness.knownGaps?.includes(id)))
          return context.skip();
        await body(() => context.skip());
      });

    const admitText = (): Promise<GatewayAdmission> =>
      admitGatewayRequest(
        ports(),
        {
          httpRequest: harness.fixtures.tenantRequest(),
          request: normalizeOpenAIChatRequest({
            model: harness.fixtures.textModel,
            messages: [{ role: "user", content: "contract" }],
            max_tokens: 8,
          }),
        },
        { holdTtlMs: 60_000 },
      );

    composed("a completed text request is charged its priced usage once", async () => {
      const admission = await admitText();
      expect(Number.isSafeInteger(admission.holdMicroCredits)).toBe(true);
      const usage = { ...emptyUsage(), inputTokens: 3, outputTokens: 2 };
      const { settlement, result } = await settleGatewayRequest(ports(), admission, {
        attempt: admission.plan.attempts[0]!,
        outcome: "completed",
        usage,
      });
      expect(settlement.costMicroCredits).toBe(priceUsage(usage, admission.price).microCredits);
      expect(result).toMatchObject({ duplicate: false, costMicroCredits: settlement.costMicroCredits });
      const row = await ports().ledger.get({
        tenantId: admission.identity.tenantId,
        requestId: admission.requestId,
      });
      expect(row).toMatchObject({
        status: "settled",
        costMicroCredits: settlement.costMicroCredits,
        priceVersion: admission.price.version,
        catalogVersion: admission.plan.catalogVersion,
      });
    });

    composed("a failed media generation is charged zero", async (skip) => {
      const media = harness.fixtures.mediaModel;
      if (!media) return skip();
      const before = await counters(await tenant());
      const admission = await admitGatewayRequest(
        ports(),
        {
          httpRequest: harness.fixtures.tenantRequest(),
          request: normalizeMediaGenerationRequest({
            model: media.code,
            kind: media.kind,
            units: media.units,
          }),
        },
        { holdTtlMs: 60_000 },
      );
      expect(admission.holdMicroCredits).toBeGreaterThan(0);
      const { result } = await settleGatewayRequest(ports(), admission, {
        attempt: admission.plan.attempts[0]!,
        outcome: "upstream_failed",
        usage: { ...emptyUsage(), units: media.units },
        error: new GatewayError("GATEWAY_UPSTREAM_ERROR"),
      });
      expect(result.costMicroCredits).toBe(0);
      expect(await counters(admission.identity)).toEqual(before);
      expect(
        await ports().ledger.get({ tenantId: admission.identity.tenantId, requestId: admission.requestId }),
      ).toMatchObject({ status: "upstream_failed", costMicroCredits: 0, errorCode: "GATEWAY_UPSTREAM_ERROR" });
    });

    composed("an unauthenticated request is rejected before anything is held", async () => {
      const identity = await tenant();
      const before = await counters(identity);
      await expectCode(
        admitGatewayRequest(
          ports(),
          {
            httpRequest: harness.fixtures.anonymousRequest(),
            request: normalizeOpenAIChatRequest({
              model: harness.fixtures.textModel,
              messages: [{ role: "user", content: "contract" }],
            }),
          },
          { holdTtlMs: 60_000 },
        ),
        "GATEWAY_AUTH_REQUIRED",
      );
      expect(await counters(identity)).toEqual(before);
    });

    // ─── Data plane: createGatewayApp, non-stream chat ───────────────
    // The suite owns the upstream: a fetch stub replaces `ports.upstream`, so
    // no adapter makes a provider call and every expectation is derived from
    // the adapter's own ports (plan, credential, price), never pinned.
    const dataPlane = (title: string, body: () => Promise<void>, also: GatewayCapabilityId[] = []) =>
      it(`data plane: ${title}`, async (context) => {
        const needed: GatewayCapabilityId[] = [
          "identity",
          "routes",
          "credentials",
          "budgets",
          "ledger",
          "limits.rate",
          ...also,
        ];
        if (needed.some((id) => harness.capabilities[id] !== "supported" || harness.knownGaps?.includes(id)))
          return context.skip();
        await body();
      });

    const completion = (model: string) => ({
      id: "chatcmpl-contract",
      object: "chat.completion",
      created: 0,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: "contract reply" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });

    const upstreamStub = (answer: (request: Request, body: Record<string, unknown>) => Response) => {
      const seen: Array<{ request: Request; body: Record<string, unknown> }> = [];
      return {
        seen,
        port: {
          async fetch(request: Request) {
            const body = (await request.clone().json()) as Record<string, unknown>;
            seen.push({ request, body });
            return answer(request, body);
          },
        },
      };
    };

    const chat = (
      upstream: GatewayPorts["upstream"],
      credential: Request,
      body: Record<string, unknown>,
      headers: Record<string, string> = {},
      overrides: Partial<GatewayPorts> = {},
      options: Omit<GatewayAppOptions, "basePath"> = {},
    ) => {
      const app = createGatewayApp({ ...ports(), upstream, ...overrides }, { basePath: "/gateway", ...options });
      const authorization = credential.headers.get("authorization");
      return app.fetch(
        new Request("https://gateway.contract/gateway/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization ? { authorization } : {}),
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      );
    };

    const chatBody = (model = harness.fixtures.textModel, extra: Record<string, unknown> = {}) => ({
      model,
      messages: [{ role: "user", content: "contract" }],
      max_tokens: 8,
      ...extra,
    });

    const firstChatRoute = async (identity: GatewayIdentity) => {
      const catalog = await ports().routes.catalog(identity);
      return planGatewayRoutes({
        modelCode: harness.fixtures.textModel,
        catalog,
        scope: identity.credentialScope,
        providers: await ports().routes.providers(identity, identity.credentialScope),
        isRouteExecutable: isOpenAIChatRoute,
      }).attempts[0]!.route;
    };

    dataPlane("serves a non-stream chat completion and settles it once", async () => {
      const identity = await tenant();
      const route = await firstChatRoute(identity);
      const credential = await ports().credentials.resolve({
        route,
        scope: identity.credentialScope,
        tenantId: identity.tenantId,
      });
      const price = await ports().routes.price({
        identity,
        catalogVersion: (await ports().routes.catalog(identity)).version,
        route,
      });
      const before = await snapshot(identity);
      const stub = upstreamStub((_request, body) => Response.json(completion(String(body.model))));
      const callerRequest = harness.fixtures.tenantRequest();
      const res = await chat(stub.port, callerRequest, chatBody(), {
        // A spoofed identity claim must have no effect.
        "x-user-id": unique("spoofed-user"),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const requestId = res.headers.get(GATEWAY_REQUEST_ID_HEADER);
      expect(requestId).toMatch(/\S/);
      const answer = (await res.json()) as Record<string, unknown>;
      expect(answer.model).toBe(harness.fixtures.textModel);
      expect(answer.choices).toEqual(completion("").choices);

      expect(stub.seen).toHaveLength(1);
      const [sent] = stub.seen;
      expect(sent!.request.method).toBe("POST");
      expect(new URL(sent!.request.url).pathname.endsWith("/chat/completions")).toBe(true);
      expect(sent!.request.headers.get("authorization")).toBe(`Bearer ${credential.apiKey}`);
      expect(sent!.request.headers.get("authorization")).not.toBe(
        callerRequest.headers.get("authorization"),
      );
      expect(sent!.request.headers.get("x-user-id")).toBeNull();
      expect(sent!.body.model).toBe(route.upstreamModel);

      const accumulator = createUsageAccumulator("openai-chat");
      accumulator.observe(completion(route.upstreamModel));
      const cost = priceUsage(accumulator.snapshot(), price).microCredits;
      const row = await ports().ledger.get({ tenantId: identity.tenantId, requestId: requestId! });
      expect(row).toMatchObject({
        requestId,
        userId: identity.userId,
        status: "settled",
        costMicroCredits: cost,
        upstreamId: route.upstreamId,
      });
      for (const [id, budget] of await snapshot(identity)) {
        expect(budget.spentMicroCredits).toBe(before.get(id)!.spentMicroCredits + cost);
        expect(budget.reservedMicroCredits).toBe(before.get(id)!.reservedMicroCredits);
      }
    });

    dataPlane("a failed settlement still answers the completion, coded, and leaves the hold to reconcile", async () => {
      const identity = await tenant();
      const before = await snapshot(identity);
      const stub = upstreamStub((_request, body) => Response.json(completion(String(body.model))));
      const res = await chat(stub.port, harness.fixtures.tenantRequest(), chatBody(), {}, {
        budgets: { ...ports().budgets, settle: () => Promise.reject(new GatewayError("GATEWAY_INTERNAL")) },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(((await res.json()) as Record<string, unknown>).choices).toEqual(completion("").choices);
      const requestId = res.headers.get(GATEWAY_REQUEST_ID_HEADER)!;
      expect(res.headers.get(GATEWAY_SETTLEMENT_HEADER)).toBe(
        `failed; code=GATEWAY_SETTLEMENT_FAILED; request_id=${requestId}`,
      );
      expect(await ports().ledger.get({ tenantId: identity.tenantId, requestId })).toBeNull();
      const held = await snapshot(identity);
      for (const [id, budget] of held) {
        expect(budget.reservedMicroCredits).toBeGreaterThan(before.get(id)!.reservedMicroCredits);
        expect(budget.spentMicroCredits).toBe(before.get(id)!.spentMicroCredits);
      }
      // Reconciliation settles the marked hold exactly once.
      const event = settlementEvent(identity, requestId, 1);
      expect(await ports().budgets.settle(event)).toMatchObject({ duplicate: false });
      expect(await ports().budgets.settle(event)).toMatchObject({ duplicate: true });
      for (const [id, budget] of await snapshot(identity)) {
        expect(budget.reservedMicroCredits).toBe(before.get(id)!.reservedMicroCredits);
        expect(budget.spentMicroCredits).toBe(before.get(id)!.spentMicroCredits + 1);
      }
    });

    const retaining = (title: string, body: () => Promise<void>) => dataPlane(title, body, ["blobs", "retention"]);
    const retain = { retention: { enabled: true } };
    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

    retaining("retains the normalized request and the exact answer, on success and on upstream error, without credentials", async () => {
      const identity = await tenant();
      const route = await firstChatRoute(identity);
      const credential = await ports().credentials.resolve({ route, scope: identity.credentialScope, tenantId: identity.tenantId });
      const callerRequest = harness.fixtures.tenantRequest();
      const callerToken = callerRequest.headers.get("authorization")!.replace(/^Bearer\s+/i, "");
      const secrets = [callerToken, credential.apiKey];

      const ok = upstreamStub((_request, body) => Response.json(completion(String(body.model))));
      const sent = chatBody(harness.fixtures.textModel, { user: unique("end-user") });
      const res = await chat(ok.port, callerRequest, sent, { "x-api-key": callerToken }, {}, retain);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(res.headers.get(GATEWAY_RETENTION_HEADER)).toBeNull();
      const answered = await res.text();
      const requestId = res.headers.get(GATEWAY_REQUEST_ID_HEADER)!;
      const stored = await readRetainedExchange(ports(), { requestId });
      expect(text(stored.response.body)).toBe(answered);
      expect(stored.entry).toMatchObject({ tenantId: identity.tenantId, userId: identity.userId, status: "stored", responseStatus: 200 });
      expect(JSON.parse(text(stored.request.body))).toEqual(sent);
      expect(stored.entry.expiresAt - stored.entry.storedAt).toBe(GATEWAY_BODY_RETENTION_MS);

      const failing = upstreamStub(() => new Response(`{"error":"echo ${credential.apiKey}"}`, { status: 500 }));
      const failed = await chat(failing.port, harness.fixtures.tenantRequest(), chatBody(), {}, {}, { ...retain, maxAttempts: 1 });
      expect(failed.status).toBeGreaterThanOrEqual(500);
      const failedText = await failed.text();
      const failedId = failed.headers.get(GATEWAY_REQUEST_ID_HEADER)!;
      const storedError = await readRetainedExchange(ports(), { requestId: failedId });
      expect(text(storedError.response.body)).toBe(failedText);
      expect(storedError.entry.responseStatus).toBe(failed.status);

      for (const exchange of [stored, storedError])
        for (const secret of secrets) {
          expect(text(exchange.request.body)).not.toContain(secret);
          expect(text(exchange.response.body)).not.toContain(secret);
        }
    });

    retaining("a retention failure is coded on the answer and leaves billing as it would be", async () => {
      const identity = await tenant();
      const route = await firstChatRoute(identity);
      const price = await ports().routes.price({ identity, catalogVersion: (await ports().routes.catalog(identity)).version, route });
      const before = await snapshot(identity);
      const stub = upstreamStub((_request, body) => Response.json(completion(String(body.model))));
      const res = await chat(stub.port, harness.fixtures.tenantRequest(), chatBody(), {}, {
        blobs: { ...ports().blobs, put: () => Promise.reject(new GatewayError("GATEWAY_INTERNAL")) },
      }, retain);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(((await res.json()) as Record<string, unknown>).choices).toEqual(completion("").choices);
      const requestId = res.headers.get(GATEWAY_REQUEST_ID_HEADER)!;
      expect(res.headers.get(GATEWAY_RETENTION_HEADER)).toBe(`failed; code=GATEWAY_RETENTION_FAILED; request_id=${requestId}`);
      expect(res.headers.get(GATEWAY_SETTLEMENT_HEADER)).toBeNull();
      expect(await ports().retention.get({ requestId })).toMatchObject({ status: "failed", errorCode: "GATEWAY_INTERNAL" });
      await expectCode(readRetainedExchange(ports(), { requestId }), "GATEWAY_PROMPT_NOT_RETAINED");

      const accumulator = createUsageAccumulator("openai-chat");
      accumulator.observe(completion(route.upstreamModel));
      const cost = priceUsage(accumulator.snapshot(), price).microCredits;
      expect(await ports().ledger.get({ tenantId: identity.tenantId, requestId })).toMatchObject({ status: "settled", costMicroCredits: cost });
      for (const [id, budget] of await snapshot(identity)) {
        expect(budget.spentMicroCredits).toBe(before.get(id)!.spentMicroCredits + cost);
        expect(budget.reservedMicroCredits).toBe(before.get(id)!.reservedMicroCredits);
      }
    });

    dataPlane("stores nothing when retention is not enabled", async () => {
      const stub = upstreamStub((_request, body) => Response.json(completion(String(body.model))));
      const res = await chat(stub.port, harness.fixtures.tenantRequest(), chatBody());
      expect(res.status).toBe(200);
      const requestId = res.headers.get(GATEWAY_REQUEST_ID_HEADER)!;
      if (harness.capabilities.retention === "supported") expect(await ports().retention.get({ requestId })).toBeNull();
      if (harness.capabilities.blobs === "supported")
        expect(await ports().blobs.get(gatewayRetentionKeys(requestId).response)).toBeNull();
    });

    dataPlane("rejects stream: true with a coded error before holding anything", async () => {
      const identity = await tenant();
      const before = await counters(identity);
      const stub = upstreamStub(() => Response.json({}));
      const res = await chat(
        stub.port,
        harness.fixtures.tenantRequest(),
        chatBody(harness.fixtures.textModel, { stream: true }),
      );
      expect(res.status).toBe(501);
      expect(res.headers.get("x-clash-error-code")).toBe("GATEWAY_CAPABILITY_UNAVAILABLE");
      expect(((await res.json()) as { error: { param: unknown } }).error.param).toBe("stream");
      expect(stub.seen).toHaveLength(0);
      expect(await counters(identity)).toEqual(before);
    });

    dataPlane("maps an upstream failure to a coded 502, leaks nothing and charges zero", async () => {
      const identity = await tenant();
      const route = await firstChatRoute(identity);
      const credential = await ports().credentials.resolve({
        route,
        scope: identity.credentialScope,
        tenantId: identity.tenantId,
      });
      const marker = unique("upstream-secret-marker");
      const before = await counters(identity);
      const stub = upstreamStub(() =>
        Response.json({ error: { message: `Incorrect API key ${marker}` } }, { status: 500 }),
      );
      const res = await chat(stub.port, harness.fixtures.tenantRequest(), chatBody());
      expect(res.status).toBe(502);
      expect(["GATEWAY_UPSTREAM_ERROR", "GATEWAY_ROUTES_EXHAUSTED"]).toContain(
        res.headers.get("x-clash-error-code"),
      );
      const text = await res.text();
      expect(text).not.toContain(marker);
      expect(text).not.toContain(credential.apiKey);
      expect(stub.seen.length).toBeGreaterThan(0);
      expect(await counters(identity)).toEqual(before);
      const row = await ports().ledger.get({
        tenantId: identity.tenantId,
        requestId: res.headers.get(GATEWAY_REQUEST_ID_HEADER)!,
      });
      expect(row).toMatchObject({ status: "upstream_failed", costMicroCredits: 0 });
    });

    dataPlane("answers 401 without a credential and 404 for an unknown model", async () => {
      const stub = upstreamStub(() => Response.json({}));
      const anonymous = await chat(stub.port, harness.fixtures.anonymousRequest(), chatBody());
      expect([anonymous.status, anonymous.headers.get("x-clash-error-code")]).toEqual([
        401,
        "GATEWAY_AUTH_REQUIRED",
      ]);
      const unknown = await chat(
        stub.port,
        harness.fixtures.tenantRequest(),
        chatBody(unique("no-such-model")),
      );
      expect([unknown.status, unknown.headers.get("x-clash-error-code")]).toEqual([
        404,
        "GATEWAY_MODEL_NOT_FOUND",
      ]);
      expect(stub.seen).toHaveLength(0);
    });
  });
}
