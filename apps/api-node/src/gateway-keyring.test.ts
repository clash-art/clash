/**
 * Key ring + upstream credential store + audited rotation (#366) on PGlite
 * with the real 0016/0017 schema. Two stores over one database stand in for
 * two stateless gateway nodes. Every key is generated here; no real secrets.
 */

import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { encryptSecretJson } from "@clash/shared-runtime/secret-envelope";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GatewayBudgetDatabase,
  GatewayBudgetSqlClient,
} from "./gateway-budget.ts";
import { createPgGatewayCredentialStore } from "./gateway-credentials.ts";
import {
  createGatewayKeyAdminRoutes,
  GATEWAY_KEY_ADMIN_PREFIX,
} from "./gateway-key-admin.ts";
import {
  createGatewayKeyRing,
  envelopeKid,
  GATEWAY_CREDENTIALS_SALT,
  gatewayKeyRingFromEnv,
  GatewayKeyRingError,
} from "./gateway-keyring.ts";
import { migrateDatabase } from "./migrations.ts";

function adapt(pglite: PGlite): GatewayBudgetDatabase {
  const wrap = (q: { query: PGlite["query"] }): GatewayBudgetSqlClient => ({
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) {
      const result = await q.query<Row>(sql, parameters ?? []);
      return { rows: result.rows };
    },
  });
  return {
    ...wrap(pglite),
    transaction: (work) =>
      pglite.transaction(async (tx) => work(wrap(tx as never))),
  };
}

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const legacy = randomBytes(24).toString("base64");
const apiKey = `test-${randomBytes(12).toString("hex")}`;
const tenantApiKey = `test-${randomBytes(12).toString("hex")}`;
const ringWith = (current = "k1") =>
  createGatewayKeyRing({ keys: { k1, k2 }, current, legacyKey: legacy });
const route = (accountId: string) =>
  ({ accountId, providerId: "openai", upstreamId: "", kind: "chat" }) as never;

let pglite: PGlite;
let db: GatewayBudgetDatabase;

beforeEach(async () => {
  pglite = new PGlite();
  db = adapt(pglite);
  await migrateDatabase(pglite);
});
afterEach(async () => {
  await pglite.close();
});

const ctx = { scope: "official" as const, tenantKey: "", credentialId: "c1" };

describe("key ring", () => {
  it("seals v2 with the kid and opens it; never contains the plaintext", async () => {
    const ring = ringWith();
    const env = await ring.seal({ apiKey }, ctx, "k1");
    expect(env.startsWith("v2.k1.")).toBe(true);
    expect(env).not.toContain(apiKey);
    expect(envelopeKid(env)).toBe("k1");
    expect(await ring.open(env, ctx)).toEqual({
      value: { apiKey },
      format: "v2",
      kid: "k1",
    });
  });

  it("binds scope, tenant and row: a moved envelope does not open", async () => {
    const ring = ringWith();
    const env = await ring.seal({ apiKey }, ctx, "k1");
    for (const other of [
      { ...ctx, credentialId: "c2" },
      { scope: "tenant" as const, tenantKey: "t1", credentialId: "c1" },
    ])
      await expect(ring.open(env, other)).rejects.toMatchObject({
        reason: "decrypt_failed",
      });
  });

  it("accepts v1 (official only) and refuses unknown kids", async () => {
    const ring = ringWith();
    const v1 = await encryptSecretJson(
      { apiKey },
      legacy,
      GATEWAY_CREDENTIALS_SALT,
    );
    expect(await ring.open(v1, ctx)).toEqual({
      value: { apiKey },
      format: "v1",
    });
    await expect(
      ring.open(v1, { scope: "tenant", tenantKey: "t", credentialId: "c1" }),
    ).rejects.toMatchObject({
      reason: "v1_scope",
    });
    const other = createGatewayKeyRing({
      keys: { k9: randomBytes(32) },
      current: "k9",
    });
    await expect(
      other.open(await ring.seal({ apiKey }, ctx, "k1"), ctx),
    ).rejects.toMatchObject({
      reason: "kid_unknown",
    });
  });

  it("parses env, refuses short keys and keys shared with tenant BYOK", () => {
    const keys = JSON.stringify({ k1: k1.toString("base64") });
    expect(
      gatewayKeyRingFromEnv({
        GATEWAY_ENCRYPTION_KEYS: keys,
        GATEWAY_ENCRYPTION_CURRENT: "k1",
      }).kids,
    ).toEqual(["k1"]);
    expect(() =>
      gatewayKeyRingFromEnv({
        GATEWAY_ENCRYPTION_KEYS: JSON.stringify({ k1: "c2hvcnQ=" }),
      }),
    ).toThrow(GatewayKeyRingError);
    expect(() =>
      gatewayKeyRingFromEnv({
        GATEWAY_ENCRYPTION_KEYS: keys,
        ACTION_SECRET_KEY: k1.toString("base64"),
      }),
    ).toThrow(/shared_with_byok/);
    expect(() =>
      gatewayKeyRingFromEnv({
        GATEWAY_ENCRYPTION_KEYS: keys,
        GATEWAY_ENCRYPTION_CURRENT: "nope",
      }),
    ).toThrow(/current_kid_unknown/);
  });
});

describe("credential store", () => {
  it("keeps official and tenant scopes apart", async () => {
    const store = createPgGatewayCredentialStore({ db, ring: ringWith() });
    const official = await store.put({
      scope: "official",
      providerId: "openai",
      credentials: { apiKey },
    });
    const tenant = await store.put({
      scope: "tenant",
      tenantId: "t1",
      providerId: "openai",
      credentials: { apiKey: tenantApiKey },
    });
    expect(
      (
        await store.resolve({
          route: route(official.id),
          scope: "official",
          tenantId: "t1",
        })
      ).apiKey,
    ).toBe(apiKey);
    expect(
      (
        await store.resolve({
          route: route(tenant.id),
          scope: "tenant",
          tenantId: "t1",
        })
      ).apiKey,
    ).toBe(tenantApiKey);
    await expect(
      store.resolve({
        route: route(official.id),
        scope: "tenant",
        tenantId: "t1",
      }),
    ).rejects.toMatchObject({
      code: "GATEWAY_KEY_UNAVAILABLE",
    });
    await expect(
      store.resolve({
        route: route(tenant.id),
        scope: "official",
        tenantId: "t1",
      }),
    ).rejects.toMatchObject({
      code: "GATEWAY_KEY_UNAVAILABLE",
    });
    await expect(
      store.resolve({
        route: route(tenant.id),
        scope: "tenant",
        tenantId: "t2",
      }),
    ).rejects.toMatchObject({
      code: "GATEWAY_KEY_UNAVAILABLE",
    });
    // Flipping the scope column on a row cannot make its envelope serve the other scope.
    await pglite.query(
      "UPDATE gateway_upstream_credential SET scope = 'official', tenant_key = '', account_id = 'moved' WHERE id = $1",
      [tenant.id],
    );
    await expect(
      store.resolve({
        route: route(tenant.id),
        scope: "official",
        tenantId: "t1",
      }),
    ).rejects.toMatchObject({
      details: { reason: "decrypt_failed" },
    });
    await expect(
      pglite.query(
        "UPDATE gateway_upstream_credential SET tenant_key = 't9' WHERE id = $1",
        [official.id],
      ),
    ).rejects.toThrow(/scope_tenant_chk/);
    await expect(
      store.put({
        scope: "tenant",
        providerId: "openai",
        credentials: { apiKey },
      }),
    ).rejects.toMatchObject({
      code: "GATEWAY_INVALID_REQUEST",
    });
  });

  it("lazily re-encrypts v1 rows under the current kid", async () => {
    const store = createPgGatewayCredentialStore({ db, ring: ringWith() });
    const v1 = await encryptSecretJson(
      { apiKey },
      legacy,
      GATEWAY_CREDENTIALS_SALT,
    );
    await pglite.query(
      `INSERT INTO gateway_upstream_credential (id, scope, provider_id, encrypted_credentials, key_version, created_at, updated_at)
       VALUES ('legacy', 'official', 'openai', $1, '1', 0, 0)`,
      [v1],
    );
    expect(
      (
        await store.resolve({
          route: route("legacy"),
          scope: "official",
          tenantId: "t1",
        })
      ).apiKey,
    ).toBe(apiKey);
    const { rows } = await pglite.query<{ e: string }>(
      "SELECT encrypted_credentials e FROM gateway_upstream_credential",
    );
    expect(envelopeKid(rows[0]!.e)).toBe("k1");
    expect(
      (
        await store.resolve({
          route: route("legacy"),
          scope: "official",
          tenantId: "t1",
        })
      ).apiKey,
    ).toBe(apiKey);
  });
});

describe("admin rotation", () => {
  const admin = { id: "adm_1", role: "platform_admin" };
  function node(identity: { id: string; role: string } | null = admin) {
    const ring = ringWith("k1");
    const store = createPgGatewayCredentialStore({ db, ring });
    const app = createGatewayKeyAdminRoutes({
      db,
      ring,
      store,
      verifyAdmin: async () => identity,
    });
    const call = (path: string, body?: unknown) =>
      app.request(`${GATEWAY_KEY_ADMIN_PREFIX}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { store, call };
  }

  it("rotates with an audit row; next request on every node seals with the new kid, in-flight keeps the old", async () => {
    const a = node();
    const b = node();
    const { id } = await a.store.put({
      scope: "official",
      providerId: "openai",
      credentials: { apiKey },
    });
    const inFlight = await b.store.resolve({
      route: route(id),
      scope: "official",
      tenantId: "t1",
    });

    const rotated = await a.call("/rotate", { kid: "k2" });
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toEqual({
      previous: "k1",
      current: "k2",
      configVersion: 1,
    });
    expect(inFlight.apiKey).toBe(apiKey);

    // Node b (never told directly) seals the next write under k2.
    const next = await b.store.put({
      scope: "tenant",
      tenantId: "t1",
      providerId: "openai",
      credentials: { apiKey: tenantApiKey },
    });
    expect(next.kid).toBe("k2");
    // The k1 row still opens on node b and is lazily resealed under k2.
    expect(
      (
        await b.store.resolve({
          route: route(id),
          scope: "official",
          tenantId: "t1",
        })
      ).apiKey,
    ).toBe(apiKey);
    const { rows } = await pglite.query<{ e: string }>(
      "SELECT encrypted_credentials e FROM gateway_upstream_credential ORDER BY id",
    );
    expect(rows.map((r) => envelopeKid(r.e))).toEqual(["k2", "k2"]);

    const audit = await pglite.query<Record<string, unknown>>(
      "SELECT * FROM gateway_admin_audit",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_kind: "admin",
      actor_id: "adm_1",
      action: "gateway.encryption.rotate",
      target_id: "k2",
      before_json: { kid: "k1" },
    });
    const everything =
      JSON.stringify(audit.rows) +
      JSON.stringify(await (await a.call("")).json());
    for (const secret of [
      apiKey,
      tenantApiKey,
      k1.toString("base64"),
      k2.toString("base64"),
      legacy,
    ])
      expect(everything).not.toContain(secret);
    await expect(
      pglite.query("DELETE FROM gateway_admin_audit"),
    ).rejects.toThrow(/append-only/);
  });

  it("reencrypt batch is audited and reseals old envelopes", async () => {
    const a = node();
    await a.store.put({
      scope: "official",
      providerId: "openai",
      credentials: { apiKey },
    });
    await a.call("/rotate", { kid: "k2" });
    const res = await a.call("/reencrypt", {});
    expect(await res.json()).toEqual({ current: "k2", resealed: 1, failed: 0 });
    const status = await (await a.call("")).json();
    expect(status).toEqual({
      current: "k2",
      ringKids: ["k1", "k2"],
      envelopes: [{ kid: "k2", scope: "official", count: 1 }],
    });
    const audit = await pglite.query(
      "SELECT action FROM gateway_admin_audit ORDER BY created_at, action",
    );
    expect(audit.rows).toHaveLength(2);
  });

  it("refuses non-admins, product roles and unknown kids without writing audit", async () => {
    expect((await node(null).call("/rotate", { kid: "k2" })).status).toBe(403);
    expect(
      (await node({ id: "u1", role: "owner" }).call("/rotate", { kid: "k2" }))
        .status,
    ).toBe(403);
    expect((await node().call("/rotate", { kid: "k7" })).status).toBe(400);
    expect(
      (await pglite.query("SELECT 1 FROM gateway_admin_audit")).rows,
    ).toHaveLength(0);
  });
});
