/**
 * Official catalog publish (#351) through the Worker app on node:sqlite with
 * every migration applied: official upstream accounts for the media
 * providers the deployment's cards route to (credential fields checked per
 * provider), the AIGC/media-first launch draft, DeepSeek Flash-only on every
 * write path, the "Clash official" row in the product provider lists, and
 * route pins resolving across catalog versions on the D1 routes port.
 *
 * Accounts and expectations are derived from the shared model cards and
 * provider definitions, never restated here.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("../../../containers/render", () => ({
  RenderContainer: class MockRenderContainer {},
}));

import {
  gatewayRoutePin,
  isGatewayError,
  planGatewayRoutes,
  resolveGatewayRoutePin,
  type GatewayIdentity,
  type GatewayLogger,
} from "@clash/gateway-core";
import {
  OFFICIAL_MODEL_PROVIDER_ID,
  OfficialModelProviderSchema,
  listDeclaredModelUpstreamRoutes,
  type ModelCard,
  type OfficialModelProvider,
} from "@clash/shared-types";

import { createApp } from "../../../app";
import { createSqliteD1 } from "../../../../../web/app/test-support/sqlite-d1";
import { hostedBaseModelCards } from "../../../generation/hosted-model-cards";
import { monotonicClock } from "../../../gateway/d1-common";
import { createD1GatewayRoutesPort } from "../../../gateway/d1-routes";
import { readOfficialModelProvider } from "../../../gateway/official-provider";
import { officialChatCard } from "../../../gateway/test-support";
import { signedInAdmin } from "../../../services/admin-session.test-support";

const ORIGIN = "http://localhost:8789";
const { d1, sqlite } = createSqliteD1();
const app = createApp();
const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const env = {
  DB: d1,
  ENVIRONMENT: "test",
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "test-secret-for-gateway-catalog-0123456789",
  GATEWAY_ENCRYPTION_KEY: `catalog-kek-${hex()}${hex()}`,
};
const admin = await signedInAdmin(app, env, ORIGIN);
const CATALOG = "/api/v1/admin/gateway/catalog";

function productUser() {
  const raw = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
  sqlite
    .prepare("INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, 'p', ?, 'clsh_p', 1)")
    .run(`tok-${hex()}`, `user-${hex()}`, sha256(raw));
  return { authorization: `Bearer ${raw}` };
}

function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env as never,
  );
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function expectCode(res: Response, status: number, code: string) {
  const text = await res.clone().text();
  expect(res.status, text).toBe(status);
  expect(res.headers.get("x-clash-error-code"), text).toBe(code);
}

const auditActions = (targetId: string) =>
  (sqlite.prepare(`SELECT action FROM gateway_admin_audit WHERE target_id = ? ORDER BY occurred_at, rowid`).all(targetId) as Array<{
    action: string;
  }>).map((row) => row.action);

const silent: GatewayLogger = { info: () => {}, warn: () => {}, error: () => {} };
const routesPort = () => createD1GatewayRoutesPort(d1, { clock: monotonicClock(), logger: silent });
const identity: GatewayIdentity = { tenantId: "", userId: "", budgetIds: [], credentialScope: "official" };

interface AccountSpec {
  providerId: string;
  upstreamId: string;
  region?: string;
  fields: string[];
}

/** One official account per media provider/upstream/region the deployment's cards route to. */
function mediaAccountSpecs(cards: readonly ModelCard[]): AccountSpec[] {
  const specs = new Map<string, AccountSpec>();
  for (const route of listDeclaredModelUpstreamRoutes(cards)) {
    const providerId = route.providerId ?? route.upstreamId;
    if (route.kind === "text" || providerId === "local" || providerId === "mock") continue;
    const key = `${providerId}\u0000${route.upstreamId}\u0000${route.region ?? ""}`;
    const fields = [...(route.requiredCredentials ?? []), ...(route.credentialRequirements?.anyOf?.[0] ?? [])];
    const previous = specs.get(key);
    specs.set(key, {
      providerId,
      upstreamId: route.upstreamId,
      ...(route.region ? { region: route.region } : {}),
      fields: [...new Set([...(previous?.fields ?? []), ...fields])],
    });
  }
  return [...specs.values()].filter((spec) => spec.fields.length > 0);
}

const credentialsFor = (fields: readonly string[]) =>
  Object.fromEntries(fields.map((field) => [field, field === "baseUrl" ? "https://upstream.example.test" : `${field}-${hex()}${hex()}`]));

type SeedResponse = {
  version: { version: string; status: string; models: Array<{ modelCode: string; kind: string }> };
  excluded: Array<{ modelCode: string; reason: string }>;
  unknownTextModelCodes: string[];
};

const cards = await hostedBaseModelCards();
const text = officialChatCard();
const deepseekPro = cards.find((card) => /deepseek/i.test(card.id) && !/flash/i.test(card.id));
/** A non-Flash DeepSeek id for the write-path refusals; the deployment cards may hold none. */
const blockedDeepSeekId = deepseekPro?.id ?? "deepseek-reasoner";

describe("official catalog publish (#351)", () => {
  const user = productUser();
  const accountIds = new Map<string, string>();
  let v1 = "";
  let seeded: SeedResponse;

  it("shows no official row and refuses to seed while no official account serves anything", async () => {
    const providers = await json<{ official: unknown }>(await call("GET", "/api/v1/model-providers", user));
    expect(providers.official).toBeNull();
    const version = `launch-${hex()}`;
    await expectCode(await call("POST", `${CATALOG}/versions/${version}/seed`, admin.auth, {}), 409, "GATEWAY_CATALOG_SEED_EMPTY");
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM gateway_model WHERE catalog_version = ?`).get(version)).toEqual({ n: 0 });
    expect(auditActions(version)).toEqual([]);
  });

  it("creates official accounts for every media provider, with the credential fields each provider requires", async () => {
    const specs = mediaAccountSpecs(cards);
    // The providers the launch decision names, as the shared cards route them.
    for (const named of ["bfl", "kling", "google-ai-studio", "openai"])
      expect(specs.some((spec) => spec.upstreamId === named), named).toBe(true);

    const kling = specs.find((spec) => spec.providerId === "kling")!;
    expect(kling.fields.length).toBeGreaterThan(1);
    // An API key alone cannot sign Kling requests.
    await expectCode(
      await call("POST", "/api/v1/admin/gateway/upstreams", admin.auth, {
        providerId: kling.providerId,
        upstreamId: kling.upstreamId,
        credential: { apiKey: `sk-${hex()}${hex()}` },
      }),
      400,
      "GATEWAY_UPSTREAM_CREDENTIAL_FIELDS",
    );
    await expectCode(
      await call("POST", "/api/v1/admin/gateway/upstreams", admin.auth, {
        providerId: kling.providerId,
        upstreamId: kling.upstreamId,
        credential: { secretRef: "GATEWAY_UPSTREAM_KLING" },
      }),
      400,
      "GATEWAY_UPSTREAM_CREDENTIAL_FIELDS",
    );

    for (const spec of specs) {
      const credentials = credentialsFor(spec.fields);
      const res = await call("POST", "/api/v1/admin/gateway/upstreams", admin.auth, {
        providerId: spec.providerId,
        upstreamId: spec.upstreamId,
        ...(spec.region ? { region: spec.region } : {}),
        label: `official ${spec.upstreamId}`,
        credential: { credentials },
      });
      const body = await res.clone().text();
      const { upstream } = await json<{ upstream: { id: string; credential: { kind: string; fields: string[] } } }>(res, 201);
      expect(upstream.credential).toMatchObject({ kind: "sealed", fields: Object.keys(credentials) });
      for (const secret of Object.values(credentials)) if (!secret.startsWith("https://")) expect(body).not.toContain(secret);
      accountIds.set(`${spec.providerId}\u0000${spec.upstreamId}\u0000${spec.region ?? ""}`, upstream.id);
    }
    // Rotation is held to the same fields: a Kling account never rotates to an API key alone.
    const klingId = accountIds.get(`${kling.providerId}\u0000${kling.upstreamId}\u0000${kling.region ?? ""}`)!;
    await expectCode(
      await call("POST", `/api/v1/admin/gateway/upstreams/${klingId}/rotate`, admin.auth, {
        credential: { apiKey: `sk-${hex()}${hex()}` },
      }),
      400,
      "GATEWAY_UPSTREAM_CREDENTIAL_FIELDS",
    );
    expect(auditActions(klingId)).toEqual(["upstream.create"]);
    // A Worker secret holding several fields names them.
    await json(
      await call("POST", "/api/v1/admin/gateway/upstreams", admin.auth, {
        providerId: kling.providerId,
        upstreamId: kling.upstreamId,
        enabled: false,
        credential: { secretRef: "GATEWAY_UPSTREAM_KLING", fields: kling.fields },
      }),
      201,
    );

    // The text account serves the configured chat model.
    const textRoute = listDeclaredModelUpstreamRoutes([text]).find((route) => route.providerId === "official")!;
    const { upstream } = await json<{ upstream: { id: string } }>(
      await call("POST", "/api/v1/admin/gateway/upstreams", admin.auth, {
        providerId: "official",
        upstreamId: textRoute.upstreamId,
        apiShape: textRoute.apiShape,
        label: "official text",
        credential: { apiKey: `sk-${hex()}${hex()}` },
      }),
      201,
    );
    accountIds.set("text", upstream.id);
  });

  it("refuses DeepSeek Pro/Reasoner on every account and catalog write path", async () => {
    await expectCode(
      await call("POST", "/api/v1/admin/gateway/upstreams", admin.auth, {
        providerId: "official",
        upstreamId: "openai",
        supportedModelIds: [blockedDeepSeekId],
        credential: { apiKey: `sk-${hex()}${hex()}` },
      }),
      400,
      "GATEWAY_CATALOG_MODEL_BLOCKED",
    );
    await expectCode(
      await call("PATCH", `/api/v1/admin/gateway/upstreams/${accountIds.get("text")}`, admin.auth, {
        modelPriorities: { "deepseek-reasoner": 1 },
      }),
      400,
      "GATEWAY_CATALOG_MODEL_BLOCKED",
    );
    const version = `launch-${hex()}`;
    await expectCode(
      await call("POST", `${CATALOG}/versions/${version}/seed`, admin.auth, { textModelCodes: [blockedDeepSeekId] }),
      400,
      "GATEWAY_CATALOG_MODEL_BLOCKED",
    );
    expect(auditActions(version)).toEqual([]);
  });

  it("seeds a launch draft AIGC/media first, chat-only models only when configured, in one audited batch", async () => {
    const mediaOnly = await json<SeedResponse>(await call("POST", `${CATALOG}/versions/media-${hex()}/seed`, admin.auth, {}), 201);
    expect(mediaOnly.version.status).toBe("draft");
    expect(mediaOnly.version.models.length).toBeGreaterThan(0);
    expect(mediaOnly.version.models.every((model) => model.kind !== "text")).toBe(true);
    expect(mediaOnly.excluded).toContainEqual({ modelCode: text.id, reason: "text-not-configured" });
    if (deepseekPro) expect(mediaOnly.excluded).toContainEqual({ modelCode: deepseekPro.id, reason: "deepseek-not-flash" });

    v1 = `launch-${hex()}`;
    seeded = await json<SeedResponse>(
      await call("POST", `${CATALOG}/versions/${v1}/seed`, admin.auth, { textModelCodes: [text.id, "no-such-model"] }),
      201,
    );
    expect(seeded.unknownTextModelCodes).toEqual(["no-such-model"]);
    const codes = seeded.version.models.map((model) => model.modelCode);
    expect(codes).toContain(text.id);
    expect(new Set(codes)).toEqual(new Set([...mediaOnly.version.models.map((model) => model.modelCode), text.id]));
    expect(codes.every((code) => cards.some((card) => card.id === code))).toBe(true);
    expect(auditActions(v1)).toEqual(["catalog.seed"]);
    // A version is seeded once; a draft is never overwritten.
    await expectCode(await call("POST", `${CATALOG}/versions/${v1}/seed`, admin.auth, {}), 409, "GATEWAY_CONFLICT");
    await expectCode(
      await call("POST", `${CATALOG}/versions/${v1}/seed`, admin.auth, { extra: true }),
      400,
      "GATEWAY_INVALID_REQUEST",
    );
  });

  it("publishes the draft with its catalog_version and shows it as the official row in both provider lists", async () => {
    const published = await json<{ version: { status: string } }>(await call("POST", `${CATALOG}/versions/${v1}/publish`, admin.auth));
    expect(published.version.status).toBe("published");

    const providersRes = await call("GET", "/api/v1/model-providers", user);
    const providersText = await providersRes.clone().text();
    const providers = await json<{ providers: unknown[]; official: OfficialModelProvider }>(providersRes);
    const catalog = await json<{ official: OfficialModelProvider }>(await call("GET", "/api/v1/models/catalog", user));
    expect(OfficialModelProviderSchema.parse(providers.official)).toEqual(providers.official);
    expect(catalog.official).toEqual(providers.official);
    // The managed row is beside the user's BYOK accounts, never one of them.
    expect(providers.providers).toEqual([]);
    const row = providers.official;
    if (row.status !== "published") throw new Error(`official row is ${row.status}`);
    expect(row.catalogVersion).toBe(v1);
    expect(row.publishedAt).not.toBeNull();
    expect(new Set(row.models.map((model) => model.id))).toEqual(new Set(seeded.version.models.map((model) => model.modelCode)));
    const kinds = row.models.map((model) => model.kind);
    expect(kinds.indexOf("text")).toBe(kinds.length - 1);
    for (const named of ["bfl", "kling"]) expect(row.upstreams.map((upstream) => upstream.upstreamId)).toContain(named);
    for (const id of accountIds.values()) expect(providersText).not.toContain(id);
    expect(providersText).not.toMatch(/accessKey-|secretKey-|apiKey-|sk-/);

    // A disabled account stops serving at once: its models leave the row.
    const klingAccount = [...accountIds.entries()].find(([key]) => key.startsWith("kling\u0000"))![1];
    await json(await call("PATCH", `/api/v1/admin/gateway/upstreams/${klingAccount}`, admin.auth, { enabled: false }));
    const after = (await json<{ official: OfficialModelProvider }>(await call("GET", "/api/v1/model-providers", user))).official;
    if (after.status !== "published") throw new Error(`official row is ${after.status}`);
    expect(after.upstreams.map((upstream) => upstream.upstreamId)).not.toContain("kling");
    expect(after.models.flatMap((model) => model.upstreamIds)).not.toContain("kling");
    const klingOnly = row.models.filter((model) => model.upstreamIds.every((upstreamId) => upstreamId === "kling"));
    for (const model of klingOnly) expect(after.models.map((entry) => entry.id)).not.toContain(model.id);
    await json(await call("PATCH", `/api/v1/admin/gateway/upstreams/${klingAccount}`, admin.auth, { enabled: true }));
  });

  it("keeps route pins working after a newer catalog version is published", async () => {
    const routes = routesPort();
    const live1 = await routes.catalog(identity);
    expect(live1.version).toBe(v1);
    const providers = await routes.providers(identity, "official");
    const pins = live1.models.map((model) => {
      const plan = planGatewayRoutes({ modelCode: model.id, kind: model.kind, catalog: live1, scope: "official", providers });
      return gatewayRoutePin(plan, plan.attempts[0]!);
    });
    const dropped = seeded.version.models.find((model) => model.kind !== "text")!.modelCode;

    // v2: a copy of v1 without one model, published.
    const v2 = `launch-${hex()}`;
    await json(await call("POST", `${CATALOG}/versions/${v2}/clone`, admin.auth, { from: v1 }), 201);
    await json(await call("DELETE", `${CATALOG}/versions/${v2}/models/${encodeURIComponent(dropped)}`, admin.auth));
    await json(await call("POST", `${CATALOG}/versions/${v2}/publish`, admin.auth));
    expect((await routes.catalog(identity)).version).toBe(v2);

    for (const pin of pins) {
      const resolved = await resolveGatewayRoutePin(routes, identity, pin);
      expect(resolved.route).toMatchObject({ upstreamId: pin.upstreamId, upstreamModel: pin.upstreamModel, accountId: pin.accountId });
      // The dropped model is served from its pinned snapshot, everything else from the live version.
      expect(resolved.catalogVersion, pin.modelCode).toBe(pin.modelCode === dropped ? v1 : v2);
    }
    // The pinned snapshot is exactly what was published.
    expect((await routes.catalog(identity, { version: v1 })).models.map((model) => model.id)).toEqual(
      live1.models.map((model) => model.id),
    );

    // A draft is not a version a pin can name.
    const draft = `draft-${hex()}`;
    await json(await call("POST", `${CATALOG}/versions/${draft}/clone`, admin.auth, { from: v2 }), 201);
    const error = await routes.catalog(identity, { version: draft }).catch((caught: unknown) => caught);
    expect(isGatewayError(error) && error.code).toBe("GATEWAY_CATALOG_VERSION_NOT_FOUND");
  });

  it("reports the row as unavailable with a code, never an empty catalog, when it cannot be read", async () => {
    const broken = {
      prepare: () => {
        throw new Error("D1 down");
      },
    } as unknown as D1Database;
    const row = await readOfficialModelProvider(broken, { clock: monotonicClock(), logger: silent });
    expect(row).toMatchObject({ id: OFFICIAL_MODEL_PROVIDER_ID, managed: true, status: "unavailable", code: expect.any(String) });
    expect(row).not.toHaveProperty("models");
  });
});

type D1Database = Parameters<typeof createD1GatewayRoutesPort>[0];
