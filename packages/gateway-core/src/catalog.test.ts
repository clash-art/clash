import { describe, expect, it } from "vitest";
import {
  MODEL_PROVIDER_DEFINITIONS,
  OfficialModelProviderSchema,
  buildEffectiveModelCards,
  listDeclaredModelUpstreamRoutes,
  type ProviderAccountAvailability,
} from "@clash/shared-types/model-routing";

import {
  buildOfficialModelProvider,
  gatewayRoutePin,
  isGatewayMediaKind,
  missingOfficialUpstreamCredentials,
  planGatewayLaunchCatalog,
  resolveGatewayRoutePin,
} from "./catalog.js";
import { GatewayError, isGatewayError } from "./errors.js";
import type { GatewayIdentity, GatewayRoutesPort } from "./ports.js";
import { planGatewayRoutes, type GatewayCatalog, type GatewayModelCard } from "./routing.js";

const builtIn = buildEffectiveModelCards();

/**
 * A non-Flash DeepSeek card for the Flash-only policy tests, with the
 * official account that would serve it. The built-in catalog ships no
 * DeepSeek card, so this is the official OpenAI-compatible text card renamed.
 */
function nonFlashDeepSeekCard(): { card: GatewayModelCard; account: ProviderAccountAvailability } {
  const { card, account } = officialTextCard();
  return { card: { ...card, id: "deepseek-pro" }, account: { ...account, id: "deepseek-capable" } };
}

/** One official account per upstream an official media route of the built-in cards names. */
function officialMediaAccounts(cards: readonly GatewayModelCard[] = builtIn): ProviderAccountAvailability[] {
  const accounts = new Map<string, ProviderAccountAvailability>();
  for (const route of listDeclaredModelUpstreamRoutes(cards)) {
    if (route.kind === "text" || route.providerId !== "official") continue;
    const key = `${route.upstreamId}:${route.region ?? ""}`;
    const previous = accounts.get(key);
    accounts.set(key, {
      id: `official-${route.upstreamId}-${route.region ?? "any"}`,
      providerId: "official",
      upstreamId: route.upstreamId,
      ...(route.region ? { region: route.region } : {}),
      configuredCredentials: [
        ...new Set([
          ...(previous?.configuredCredentials ?? []),
          ...(route.requiredCredentials ?? []),
          ...(route.credentialRequirements?.anyOf?.[0] ?? []),
        ]),
      ],
    });
  }
  return [...accounts.values()];
}

/** A text card a plain official OpenAI-compatible account serves, from the built-in catalog. */
function officialTextCard(): { card: GatewayModelCard; account: ProviderAccountAvailability } {
  const route = listDeclaredModelUpstreamRoutes(builtIn).find(
    (candidate) => candidate.kind === "text" && candidate.providerId === "official" && candidate.apiShape === "openai-compatible",
  );
  expect(route, "the built-in catalog has an official OpenAI-compatible text route").toBeDefined();
  return {
    card: builtIn.find((card) => card.id === route!.modelCode)!,
    account: {
      id: "official-openai-text",
      providerId: "official",
      upstreamId: route!.upstreamId,
      apiShape: route!.apiShape,
      ...(route!.region ? { region: route!.region } : {}),
      configuredCredentials: [...(route!.requiredCredentials ?? []), ...(route!.credentialRequirements?.anyOf?.[0] ?? [])],
    },
  };
}

describe("planGatewayLaunchCatalog (AIGC/media first)", () => {
  const accounts = officialMediaAccounts();

  it("seeds AIGC/media cards an official account serves and no chat-only card unless configured", () => {
    const plan = planGatewayLaunchCatalog({ cards: builtIn, accounts });
    expect(plan.models.length).toBeGreaterThan(0);
    expect(plan.models.every((card) => isGatewayMediaKind(card.kind))).toBe(true);
    const excluded = new Set(plan.excluded.map((entry) => entry.modelCode));
    for (const card of builtIn.filter((model) => model.kind === "text")) expect(excluded.has(card.id), card.id).toBe(true);
    // Every seeded card is routable through the given accounts.
    for (const card of plan.models)
      expect(
        () => planGatewayRoutes({ modelCode: card.id, catalog: { version: "seed", models: plan.models }, scope: "official", providers: accounts }),
        card.id,
      ).not.toThrow();
  });

  it("adds configured text cards after every AIGC/media card", () => {
    const { card, account } = officialTextCard();
    const plan = planGatewayLaunchCatalog({ cards: builtIn, accounts: [...accounts, account], textModelCodes: [card.id] });
    const kinds = plan.models.map((model) => model.kind);
    const firstText = kinds.indexOf("text");
    expect(plan.models[firstText]?.id).toBe(card.id);
    expect(kinds.slice(firstText).every((kind) => kind === "text")).toBe(true);
    expect(kinds.slice(0, firstText).every((kind) => kind !== "text")).toBe(true);
  });

  it("never seeds a DeepSeek Pro card, even when it is configured and an account serves it", () => {
    const { card: pro, account } = nonFlashDeepSeekCard();
    const plan = planGatewayLaunchCatalog({ cards: [...builtIn, pro], accounts: [account], textModelCodes: [pro.id] });
    expect(plan.models.map((card) => card.id)).not.toContain(pro.id);
    expect(plan.excluded).toContainEqual({ modelCode: pro.id, reason: "deepseek-not-flash" });
    // Control: the same account seeds the card under its own (non-DeepSeek) id.
    const { card: control } = officialTextCard();
    const seeded = planGatewayLaunchCatalog({ cards: [control], accounts: [account], textModelCodes: [control.id] });
    expect(seeded.models.map((card) => card.id)).toEqual([control.id]);
  });

  it("excludes cards no enabled account serves and reports unknown text codes", () => {
    const disabled = accounts.map((account) => ({ ...account, enabled: false }));
    const plan = planGatewayLaunchCatalog({ cards: builtIn, accounts: disabled, textModelCodes: ["no-such-text-model"] });
    expect(plan.models).toEqual([]);
    expect(plan.excluded.some((entry) => entry.reason === "no-official-account")).toBe(true);
    expect(plan.unknownTextModelCodes).toEqual(["no-such-text-model"]);
  });
});

describe("buildOfficialModelProvider", () => {
  it("lists only served models, AIGC/media first, without account ids or credentials", () => {
    const accounts = officialMediaAccounts();
    const { card, account } = officialTextCard();
    const catalog: GatewayCatalog = { version: "c1", models: [card, ...builtIn.filter((model) => model.kind !== "text")] };
    const row = buildOfficialModelProvider({ catalog, accounts: [...accounts, account], publishedAt: null });
    expect(OfficialModelProviderSchema.parse(row)).toEqual(row);
    expect(row.catalogVersion).toBe("c1");
    const kinds = row.models.map((model) => model.kind);
    expect(kinds.at(-1)).toBe("text");
    expect(kinds.indexOf("text")).toBe(kinds.length - 1);
    // Served = the data plane's own route planner finds a route for it.
    const served = catalog.models.filter((model) => {
      try {
        planGatewayRoutes({ modelCode: model.id, kind: model.kind, catalog, scope: "official", providers: [...accounts, account] });
        return true;
      } catch {
        return false;
      }
    });
    expect(row.models.map((model) => model.id).sort()).toEqual(served.map((model) => model.id).sort());
    const text = JSON.stringify(row);
    for (const entry of [...accounts, account]) expect(text).not.toContain(entry.id!);
    expect(text).not.toMatch(/apiKey|secret/i);
    expect(new Set(row.upstreams.map((upstream) => upstream.upstreamId))).toEqual(
      new Set(row.models.flatMap((model) => model.upstreamIds)),
    );
  });

  it("never lists a DeepSeek Pro card, and nothing without an enabled account", () => {
    const { card: pro, account } = nonFlashDeepSeekCard();
    const catalog = { version: "c1", models: [pro] };
    expect(buildOfficialModelProvider({ catalog, accounts: [account], publishedAt: null }).models).toEqual([]);
    // Control: the same card under its own (non-DeepSeek) id is listed through that account.
    const { card: control } = officialTextCard();
    const listed = buildOfficialModelProvider({ catalog: { version: "c1", models: [control] }, accounts: [account], publishedAt: null });
    expect(listed.models.map((model) => model.id)).toEqual([control.id]);
    expect(
      buildOfficialModelProvider({ catalog: { version: "c1", models: builtIn }, accounts: [], publishedAt: null }).models,
    ).toEqual([]);
  });
});

describe("route pins across catalog versions", () => {
  const account: ProviderAccountAvailability = {
    id: "official-compatible",
    providerId: "official",
    upstreamId: "openai",
    apiShape: "openai-compatible",
    configuredCredentials: ["apiKey"],
  };
  const identity: GatewayIdentity = { tenantId: "t", userId: "u", budgetIds: [], credentialScope: "official" };
  const card = (modelId: string, upstreamModel: string) =>
    buildEffectiveModelCards({
      baseModels: [],
      providers: [account],
      configs: [
        {
          modelId,
          custom: true,
          name: modelId,
          kind: "text",
          providerBindings: [{ providerAccountId: account.id!, upstreamModel }],
        },
      ],
    });

  function routes(live: GatewayCatalog, published: GatewayCatalog[], accounts = [account]): Pick<GatewayRoutesPort, "catalog" | "providers"> {
    return {
      async catalog(_identity, query) {
        if (!query?.version) return live;
        const found = [live, ...published].find((catalog) => catalog.version === query.version);
        if (!found) throw new GatewayError("GATEWAY_CATALOG_VERSION_NOT_FOUND");
        return found;
      },
      async providers() {
        return accounts;
      },
    };
  }

  const v1: GatewayCatalog = { version: "v1", models: card("house-chat", "house-model-1") };
  const pinOf = (catalog: GatewayCatalog, modelCode: string) => {
    const plan = planGatewayRoutes({ modelCode, catalog, scope: "official", providers: [account] });
    return gatewayRoutePin(plan, plan.attempts[0]!);
  };

  async function code(promise: Promise<unknown>) {
    const error = await promise.then(() => undefined, (caught: unknown) => caught);
    return isGatewayError(error) ? error.code : String(error);
  }

  it("resolves through a newer version that keeps the implementation", async () => {
    const pin = pinOf(v1, "house-chat");
    const v2 = { version: "v2", models: v1.models };
    const resolved = await resolveGatewayRoutePin(routes(v2, [v1]), identity, pin);
    expect(resolved.catalogVersion).toBe("v2");
    expect(resolved.route.upstreamModel).toBe(pin.upstreamModel);
    expect(resolved.route.accountId).toBe(account.id);
  });

  it("resolves through the pinned snapshot when a newer version dropped or changed the implementation", async () => {
    const pin = pinOf(v1, "house-chat");
    const dropped = await resolveGatewayRoutePin(routes({ version: "v2", models: card("other", "x") }, [v1]), identity, pin);
    expect(dropped).toMatchObject({ catalogVersion: "v1", route: { upstreamModel: pin.upstreamModel } });
    const changed = await resolveGatewayRoutePin(routes({ version: "v3", models: card("house-chat", "house-model-2") }, [v1]), identity, pin);
    expect(changed).toMatchObject({ catalogVersion: "v1", route: { upstreamModel: pin.upstreamModel } });
  });

  it("ends every pin on a disabled account and never resolves an unpublished version", async () => {
    const pin = pinOf(v1, "house-chat");
    expect(await code(resolveGatewayRoutePin(routes(v1, [], [{ ...account, enabled: false }]), identity, pin))).toBe(
      "GATEWAY_ROUTE_PIN_UNAVAILABLE",
    );
    expect(await code(resolveGatewayRoutePin(routes(v1, [], []), identity, pin))).toBe("GATEWAY_ROUTE_PIN_UNAVAILABLE");
    // v1 is not a published version any more (a draft name, say): nothing serves the pin.
    expect(await code(resolveGatewayRoutePin(routes({ version: "v2", models: [] }, []), identity, pin))).toBe(
      "GATEWAY_ROUTE_PIN_UNAVAILABLE",
    );
  });

  it("never resolves a DeepSeek Pro/Reasoner pin, from the live catalog or a snapshot", async () => {
    const reasoner: GatewayCatalog = { version: "v1", models: card("deepseek-reasoner", "deepseek-reasoner") };
    const plan = planGatewayRoutes({ modelCode: "deepseek-reasoner", catalog: reasoner, scope: "official", providers: [account] });
    const pin = gatewayRoutePin(plan, plan.attempts[0]!);
    expect(await code(resolveGatewayRoutePin(routes(reasoner, []), identity, pin))).toBe("GATEWAY_ROUTE_PIN_UNAVAILABLE");
    expect(await code(resolveGatewayRoutePin(routes({ version: "v2", models: [] }, [reasoner]), identity, pin))).toBe(
      "GATEWAY_ROUTE_PIN_UNAVAILABLE",
    );
  });
});

describe("missingOfficialUpstreamCredentials", () => {
  it("names the fields a known provider requires and the account lacks", () => {
    for (const definition of MODEL_PROVIDER_DEFINITIONS) {
      if (definition.providerId === "local" || !definition.requiredCredentials?.length) continue;
      const account = { providerId: definition.providerId, upstreamId: definition.upstreamId, apiShape: definition.apiShape };
      expect(missingOfficialUpstreamCredentials({ ...account, fields: [] }), definition.upstreamId).toEqual(
        definition.requiredCredentials,
      );
      expect(missingOfficialUpstreamCredentials({ ...account, fields: definition.requiredCredentials })).toEqual([]);
    }
  });

  it("has no requirement for a provider no shared definition names", () => {
    expect(missingOfficialUpstreamCredentials({ providerId: "custom", upstreamId: "house", fields: [] })).toEqual([]);
  });
});
