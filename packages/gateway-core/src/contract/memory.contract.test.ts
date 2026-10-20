import { describeGatewayContract } from "./index.js";
import { catalogFixture } from "../testing/fixtures.js";
import { createMemoryGatewayPorts } from "../testing/memory-ports.js";

const bearer = (token?: string) =>
  new Request("https://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describeGatewayContract("in-memory stub", async () => {
  const fixture = catalogFixture();
  const identity = (tenantId: string, keyId: string, budgetIds: string[]) => ({
    tenantId,
    userId: `${tenantId}-user`,
    keyId,
    budgetIds,
    credentialScope: "official" as const,
  });
  const gateway = createMemoryGatewayPorts({
    identities: {
      "tenant-a": identity("tenant-a", "key-a", ["budget-a-key", "budget-a-team"]),
      "tenant-b": identity("tenant-b", "key-b", ["budget-b"]),
      "rate-limited": identity("tenant-a", "key-rate", []),
      "concurrency-limited": identity("tenant-a", "key-concurrency", []),
    },
    catalog: fixture.catalog,
    providers: fixture.providers,
    keys: fixture.keys,
    prices: [
      {
        modelCode: fixture.textModel,
        version: "price-fixture-1",
        maxOutputTokens: 4096,
        rates: [
          { unit: "input_token", microCredits: 3_000_000, per: 1_000_000 },
          { unit: "output_token", microCredits: 15_000_000, per: 1_000_000 },
        ],
      },
      ...(fixture.mediaModel
        ? [
            {
              modelCode: fixture.mediaModel.code,
              version: "price-fixture-1",
              rates: [{ unit: "image" as const, microCredits: 40_000, per: 1 }],
            },
          ]
        : []),
    ],
    budgets: [
      { id: "budget-a-key", tenantId: "tenant-a", scope: "key", scopeId: "key-a", limitMicroCredits: 50_000_000, spentMicroCredits: 0, reservedMicroCredits: 0, version: 0 },
      { id: "budget-a-team", tenantId: "tenant-a", scope: "tenant", scopeId: "tenant-a", limitMicroCredits: null, spentMicroCredits: 0, reservedMicroCredits: 0, version: 0 },
      { id: "budget-b", tenantId: "tenant-b", scope: "tenant", scopeId: "tenant-b", limitMicroCredits: 1_000_000, spentMicroCredits: 0, reservedMicroCredits: 0, version: 0 },
    ],
    rateLimits: { "key-rate": { windowMs: 60_000, limit: 3 } },
    startAt: 1_700_000_000_000,
  });
  return {
    ports: gateway.ports,
    capabilities: {
      identity: "supported",
      routes: "supported",
      credentials: "supported",
      budgets: "supported",
      ledger: "supported",
      "limits.rate": "supported",
      "limits.concurrency": "supported",
      blobs: "supported",
      scheduler: "unavailable",
      audit: "supported",
    },
    // The stub counts rate windows only; it has no in-flight counter.
    knownGaps: ["limits.concurrency"],
    fixtures: {
      tenantRequest: () => bearer("tenant-a"),
      otherTenantRequest: () => bearer("tenant-b"),
      anonymousRequest: () => bearer(),
      textModel: fixture.textModel,
      ...(fixture.mediaModel
        ? { mediaModel: { ...fixture.mediaModel, units: { image: 2 } } }
        : {}),
      rateLimited: { request: () => bearer("rate-limited"), limit: 3 },
      concurrencyLimited: { request: () => bearer("concurrency-limited"), limit: 2 },
    },
  };
});
