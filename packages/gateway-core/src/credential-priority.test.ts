/**
 * Credential scope resolution (#369): the caller's scope order picks one
 * scope per request, every attempt stays in it, and the budget check
 * learns that scope. A plan mixing scopes never reaches the budget.
 */
import { describe, expect, it, vi } from "vitest";
import { credentialScopeOrder, payAdmission, planForIdentity } from "./admission.js";
import { catalogFixture } from "./testing/fixtures.js";
import type { GatewayIdentity, GatewayPorts } from "./ports.js";
import type { GatewayRoutePlan } from "./routing.js";

const fixture = catalogFixture();
const identity = (over: Partial<GatewayIdentity> = {}): GatewayIdentity => ({
  tenantId: "t1",
  userId: "u1",
  budgetIds: [],
  credentialScope: "official",
  ...over,
});
const routes = (available: { official?: boolean; tenant?: boolean }) => ({
  providers: vi.fn(async (_identity: GatewayIdentity, scope: "official" | "tenant") =>
    available[scope] === false ? [] : fixture.providers[scope],
  ),
});
const plan = (who: GatewayIdentity, available: { official?: boolean; tenant?: boolean }) =>
  planForIdentity({ routes: routes(available) as never }, who, {
    modelCode: fixture.textModel,
    kind: "text",
    catalog: fixture.catalog,
  });

describe("credential scope resolution", () => {
  it("defaults to the credential's own scope", () => {
    expect(credentialScopeOrder(identity())).toEqual(["official"]);
    expect(credentialScopeOrder(identity({ credentialScope: "tenant", credentialPriority: [] }))).toEqual(["tenant"]);
    expect(credentialScopeOrder(identity({ credentialPriority: ["tenant", "official", "tenant"] }))).toEqual([
      "tenant",
      "official",
    ]);
  });

  it("plans in the first scope with a route and keeps every attempt in it", async () => {
    const byokFirst = identity({ credentialPriority: ["tenant", "official"] });
    const first = await plan(byokFirst, {});
    expect(first.identity.credentialScope).toBe("tenant");
    expect(first.plan.attempts.every((attempt) => attempt.scope === "tenant")).toBe(true);
    const fallback = await plan(byokFirst, { tenant: false });
    expect(fallback.identity.credentialScope).toBe("official");
    expect(fallback.plan.attempts.every((attempt) => attempt.scope === "official")).toBe(true);
    await expect(plan(identity({ credentialPriority: ["tenant"] }), { tenant: false })).rejects.toMatchObject({
      code: "GATEWAY_NO_ROUTE",
    });
  });

  it("passes the resolved scope to the budget check and refuses a mixed-scope plan before it", async () => {
    const check = vi.fn(async (_input: { requestId: string; credentialScope: string }) => ({}));
    const release = vi.fn(async () => undefined);
    const ports = {
      clock: { now: () => 1_000 },
      limits: { admit: async () => ({ allowed: true, leaseId: "l1" }), release },
      budgets: { check },
      logger: { warn: () => undefined },
    } as unknown as GatewayPorts;
    const { plan: tenantPlan, identity: who } = await plan(identity({ credentialPriority: ["tenant"] }), {});
    const price = {
      modelCode: fixture.textModel,
      version: "p",
      rates: [
        { unit: "input_token", microCredits: 1, per: 1 },
        { unit: "output_token", microCredits: 1, per: 1 },
      ],
    };
    const request = { protocol: "openai", kind: "text", model: fixture.textModel, estimatedInputTokens: 1, maxOutputTokens: 1 };
    const admit = (p: GatewayRoutePlan) =>
      payAdmission(ports, {
        requestId: "r1",
        identity: who,
        request: request as never,
        plan: p,
        price: price as never,
        pricedAt: 1_000,
      });
    const { plan: officialPlan } = await plan(identity(), {});
    const mixed: GatewayRoutePlan = {
      ...tenantPlan,
      attempts: [...tenantPlan.attempts, { ...officialPlan.attempts[0]!, index: tenantPlan.attempts.length }],
    };
    await expect(admit(mixed)).rejects.toMatchObject({ code: "GATEWAY_INTERNAL" });
    expect(check).not.toHaveBeenCalled();
    await admit(tenantPlan);
    expect(check).toHaveBeenCalledOnce();
    expect(check.mock.calls[0]![0]).toMatchObject({ credentialScope: "tenant" });
  });
});
