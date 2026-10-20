import { describe, expect, it } from "vitest";
import {
  buildEffectiveModelCards,
  listDeclaredModelUpstreamRoutes,
  listModelUpstreamRoutes,
} from "@clash/shared-types/model-routing";

import { GatewayError } from "./errors.js";
import {
  defaultMayRetryAmbiguousSubmit,
  nextGatewayAttempt,
  planGatewayRoutes,
  type GatewayRoutePlan,
  type PlanGatewayRoutesInput,
  type UpstreamFailure,
} from "./routing.js";
import { catalogFixture } from "./testing/fixtures.js";

const fixture = catalogFixture();

const input = (overrides: Partial<PlanGatewayRoutesInput> = {}): PlanGatewayRoutesInput => ({
  modelCode: fixture.textModel,
  catalog: fixture.catalog,
  scope: "official",
  providers: fixture.providers.official,
  ...overrides,
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof GatewayError ? error.code : "not-coded";
  }
  return "no-error";
};

describe("planGatewayRoutes", () => {
  it("returns the shared resolver's order unchanged", () => {
    const plan = planGatewayRoutes(input());
    const resolver = listModelUpstreamRoutes({
      modelCode: fixture.textModel,
      models: fixture.catalog.models,
      configuredProviders: fixture.providers.official,
    });
    expect(plan.attempts.length).toBeGreaterThan(1);
    expect(plan.attempts.map((attempt) => attempt.route)).toEqual(resolver);
    expect(plan.attempts.map((attempt) => attempt.index)).toEqual(resolver.map((_, index) => index));
    expect(plan.catalogVersion).toBe(fixture.catalog.version);
  });

  it("follows account priority changes made in the provider data", () => {
    const reordered = fixture.providers.official.map((provider, index) => ({
      ...provider,
      priority: fixture.providers.official.length - index,
    }));
    const plan = planGatewayRoutes(input({ providers: reordered }));
    expect(plan.attempts.map((attempt) => attempt.route)).toEqual(
      listModelUpstreamRoutes({
        modelCode: fixture.textModel,
        models: fixture.catalog.models,
        configuredProviders: reordered,
      }),
    );
  });

  it("never mixes scopes: a tenant plan uses tenant accounts only", () => {
    const tenantIds = new Set(fixture.providers.tenant.map((provider) => provider.id));
    const officialIds = new Set(fixture.providers.official.map((provider) => provider.id));
    const tenantPlan = planGatewayRoutes(input({ scope: "tenant", providers: fixture.providers.tenant }));
    for (const attempt of tenantPlan.attempts) {
      expect(attempt.scope).toBe("tenant");
      expect(tenantIds.has(attempt.route.accountId!)).toBe(true);
    }
    for (const attempt of planGatewayRoutes(input()).attempts)
      expect(officialIds.has(attempt.route.accountId!)).toBe(true);
  });

  it("distinguishes an unknown model from a model nobody can serve", () => {
    expect(codeOf(() => planGatewayRoutes(input({ modelCode: "no-such-model" })))).toBe("GATEWAY_MODEL_NOT_FOUND");
    expect(codeOf(() => planGatewayRoutes(input({ providers: [] })))).toBe("GATEWAY_NO_ROUTE");
    const disabled = fixture.providers.official.map((provider) => ({ ...provider, enabled: false }));
    expect(codeOf(() => planGatewayRoutes(input({ providers: disabled })))).toBe("GATEWAY_NO_ROUTE");
    expect(codeOf(() => planGatewayRoutes(input({ isRouteExecutable: () => false })))).toBe(
      "GATEWAY_MODEL_NOT_FOUND",
    );
  });

  it("routes against the supplied catalog, not the compiled one", () => {
    expect(codeOf(() => planGatewayRoutes(input({ catalog: { version: "empty", models: [] } })))).toBe(
      "GATEWAY_MODEL_NOT_FOUND",
    );
  });

  it("never serves on-device routes", (context) => {
    const localOnly = buildEffectiveModelCards().find((card) => {
      const routes = listDeclaredModelUpstreamRoutes([card]);
      return routes.length > 0 && routes.every((route) => route.upstreamId === "local");
    });
    if (!localOnly) return context.skip();
    const catalog = { version: "local", models: [localOnly] };
    expect(
      codeOf(() =>
        planGatewayRoutes(
          input({
            modelCode: localOnly.id,
            catalog,
            providers: [{ id: "local", providerId: "local", upstreamId: "local" }],
          }),
        ),
      ),
    ).toBe("GATEWAY_MODEL_NOT_FOUND");
  });

  it("caps attempts while keeping the order", () => {
    const full = planGatewayRoutes(input());
    const capped = planGatewayRoutes(input({ maxAttempts: 1 }));
    expect(capped.attempts.map((attempt) => attempt.route)).toEqual([full.attempts[0]!.route]);
  });

  it("attaches the retry class and timeout chosen per route", () => {
    const plan = planGatewayRoutes(
      input({
        mayRetryAmbiguousSubmit: (route) => route.upstreamId === "openai",
        firstByteTimeoutMs: (route) => (route.upstreamId === "openai" ? 1000 : undefined),
      }),
    );
    for (const attempt of plan.attempts) {
      expect(attempt.retryClass).toBe(attempt.route.upstreamId === "openai" ? "idempotent" : "at-most-once");
      expect(attempt.firstByteTimeoutMs).toBe(attempt.route.upstreamId === "openai" ? 1000 : undefined);
    }
  });

  it("never retries an ambiguous submit to an executor plugin route", () => {
    const route = planGatewayRoutes(input()).attempts[0]!.route;
    expect(defaultMayRetryAmbiguousSubmit({ ...route, executorPluginId: "plugin" })).toBe(false);
  });
});

describe("failover", () => {
  const plan: GatewayRoutePlan = planGatewayRoutes(input({ mayRetryAmbiguousSubmit: () => true }));
  const atMostOnce: GatewayRoutePlan = planGatewayRoutes(input({ mayRetryAmbiguousSubmit: () => false }));
  const last = plan.attempts[plan.attempts.length - 1]!;

  it.each<[string, UpstreamFailure]>([
    ["connect failure", { state: "not-sent" }],
    ["429", { state: "answered", status: 429 }],
    ["503", { state: "answered", status: 503 }],
    ["upstream key refused", { state: "answered", status: 401 }],
  ])("moves to the next route in order after a %s", (_label, failure) => {
    const decision = nextGatewayAttempt(plan, plan.attempts[0]!, failure);
    expect(decision.action).toBe("failover");
    if (decision.action === "failover") expect(decision.next).toBe(plan.attempts[1]);
  });

  it("is exhausted after the last route with GATEWAY_ROUTES_EXHAUSTED", () => {
    const decision = nextGatewayAttempt(plan, last, { state: "answered", status: 502 });
    expect(decision.action).toBe("fail");
    expect(decision.error.code).toBe("GATEWAY_ROUTES_EXHAUSTED");
    expect(decision.error.details).toMatchObject({ attempts: plan.attempts.length, upstreamStatus: 502 });
  });

  it("walks every route exactly once before exhaustion", () => {
    const visited = [plan.attempts[0]!];
    for (;;) {
      const decision = nextGatewayAttempt(plan, visited[visited.length - 1]!, { state: "not-sent" });
      if (decision.action === "fail") {
        expect(decision.error.code).toBe("GATEWAY_ROUTES_EXHAUSTED");
        break;
      }
      visited.push(decision.next);
    }
    expect(visited).toEqual(plan.attempts);
  });

  it("never retries after the first byte reached the caller", () => {
    const decision = nextGatewayAttempt(plan, plan.attempts[0]!, { state: "streaming" });
    expect(decision).toMatchObject({ action: "fail" });
    expect(decision.error.code).toBe("GATEWAY_UPSTREAM_ERROR");
  });

  it("does not fail over a request the upstream judged invalid", () => {
    const decision = nextGatewayAttempt(plan, plan.attempts[0]!, { state: "answered", status: 400 });
    expect(decision).toMatchObject({ action: "fail" });
    expect(decision.error.code).toBe("GATEWAY_UPSTREAM_REJECTED");
  });

  it("retries an unknown outcome only for idempotent attempts", () => {
    expect(nextGatewayAttempt(plan, plan.attempts[0]!, { state: "unknown" }).action).toBe("failover");
    const decision = nextGatewayAttempt(atMostOnce, atMostOnce.attempts[0]!, { state: "unknown" });
    expect(decision.action).toBe("fail");
    expect(decision.error.code).toBe("GATEWAY_UPSTREAM_TIMEOUT");
  });
});
