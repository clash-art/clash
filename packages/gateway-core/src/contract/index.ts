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

import {
  admitGatewayRequest,
  settleGatewayRequest,
  type GatewayAdmission,
} from "../admission.js";
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
import { planGatewayRoutes, type GatewayCredentialScope } from "../routing.js";
import { emptyUsage, type GatewayMediaUnit } from "../usage.js";

export const GATEWAY_CONTRACT_CAPABILITIES = [
  "identity",
  "routes",
  "credentials",
  "budgets",
  "ledger",
  "limits.rate",
  "limits.concurrency",
  "blobs",
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
        const { route } = (await plan(identity)).attempts[0]!;
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
  });
}
