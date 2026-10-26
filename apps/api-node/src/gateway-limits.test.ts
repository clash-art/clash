/**
 * Postgres gateway rate limits + in-flight concurrency (#364), on PGlite with
 * the real 0016 schema. Several port instances over one database stand in for
 * several stateless gateway nodes.
 */

import { PGlite } from "@electric-sql/pglite";
import {
  gatewayErrorResponseInit,
  GatewayError,
  requireAdmission,
} from "@clash/gateway-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GatewayBudgetDatabase,
  GatewayBudgetSqlClient,
} from "./gateway-budget.ts";
import {
  createPgGatewayLimitPort,
  gatewayLimitConfigKeys,
  gatewayPgLimitSubjects,
} from "./gateway-limits.ts";
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

let pglite: PGlite;
let db: GatewayBudgetDatabase;

async function setConfig(key: string, value: unknown) {
  await pglite.query(
    `INSERT INTO gateway_config (key, value, version, updated_at) VALUES ($1, $2::jsonb, 1, 0)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}

const base = {
  tenantId: "t1",
  userId: "u1",
  keyId: "k1",
  modelCode: "m1",
  estimatedTokens: 0,
};

beforeEach(async () => {
  pglite = new PGlite();
  await migrateDatabase(pglite);
  db = adapt(pglite);
});
afterEach(async () => {
  await pglite.close();
});

describe("PG gateway limits", () => {
  it("admits everything when no limit is configured", async () => {
    const port = createPgGatewayLimitPort(db);
    const decision = await port.admit(base);
    expect(decision.allowed).toBe(true);
    expect(decision.headers).toEqual({});
  });

  it("200-way race across 4 nodes admits exactly the configured count", async () => {
    await setConfig(gatewayLimitConfigKeys.key("t1", "k1"), {
      requestsPerMinute: 37,
    });
    const nodes = Array.from({ length: 4 }, () => createPgGatewayLimitPort(db));
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => nodes[i % 4]!.admit(base)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(37);
    const denied = results.filter((r) => !r.allowed);
    expect(denied).toHaveLength(163);
    for (const r of denied) {
      expect(r.allowed || r.code).toBe("GATEWAY_RATE_LIMITED");
      expect(r.headers["retry-after"]).toMatch(/^\d+$/);
      expect(r.headers["x-ratelimit-remaining-requests"]).toBe("0");
    }
  });

  it("200-way concurrency race leases exactly the bound and release frees a slot", async () => {
    await setConfig(gatewayLimitConfigKeys.user("t1", "u1"), {
      concurrency: 5,
    });
    const nodes = [createPgGatewayLimitPort(db), createPgGatewayLimitPort(db)];
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => nodes[i % 2]!.admit(base)),
    );
    const allowed = results.filter((r) => r.allowed);
    expect(allowed).toHaveLength(5);
    const denied = results.find((r) => !r.allowed)!;
    expect(!denied.allowed && denied.code).toBe("GATEWAY_CONCURRENCY_LIMITED");
    const { rows } = await pglite.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM gateway_inflight",
    );
    expect(rows[0]!.n).toBe(5);
    await nodes[1]!.release({
      leaseId: (allowed[0] as { leaseId: string }).leaseId,
    });
    await nodes[1]!.release({
      leaseId: (allowed[0] as { leaseId: string }).leaseId,
    }); // idempotent
    expect((await nodes[0]!.admit(base)).allowed).toBe(true);
  });

  it("emits OpenAI-style headers and Retry-After on the 429 wire response", async () => {
    await setConfig(gatewayLimitConfigKeys.defaultFor("tenant"), {
      requestsPerMinute: 2,
      tokensPerMinute: 100,
    });
    const port = createPgGatewayLimitPort(db);
    const first = await port.admit({ ...base, estimatedTokens: 10 });
    expect(first.headers["x-ratelimit-limit-requests"]).toBe("2");
    expect(first.headers["x-ratelimit-remaining-requests"]).toBe("1");
    expect(first.headers["x-ratelimit-limit-tokens"]).toBe("100");
    expect(first.headers["x-ratelimit-remaining-tokens"]).toBe("90");
    expect(first.headers["x-ratelimit-reset-requests"]).toMatch(/^\d+s$/);
    await port.admit(base);
    const third = await port.admit(base);
    expect(third.allowed).toBe(false);
    let error: unknown;
    try {
      requireAdmission(third);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GatewayError);
    const wire = gatewayErrorResponseInit(error as GatewayError, "openai");
    expect(wire.status).toBe(429);
    expect(Number(wire.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(wire.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(wire.headers["x-ratelimit-limit-requests"]).toBe("2");
    expect(wire.headers["x-ratelimit-remaining-requests"]).toBe("0");
  });

  it("windows come from database time, not the node clock", async () => {
    await setConfig(gatewayLimitConfigKeys.tenant("t1"), {
      requestsPerMinute: 10,
    });
    await createPgGatewayLimitPort(db).admit(base);
    const { rows } = await pglite.query<{ window_start: string; db_s: string }>(
      `SELECT window_start::text, (floor(extract(epoch FROM clock_timestamp()) / 60) * 60)::bigint::text AS db_s
         FROM gateway_rate_window`,
    );
    expect(rows).toHaveLength(1);
    expect(
      Math.abs(Number(rows[0]!.window_start) - Number(rows[0]!.db_s)),
    ).toBeLessThanOrEqual(60);
    expect(Number(rows[0]!.window_start) % 60).toBe(0);
  });

  it("specific config overrides the default; tenant counters are isolated", async () => {
    await setConfig(gatewayLimitConfigKeys.defaultFor("user"), {
      requestsPerMinute: 1,
    });
    await setConfig(gatewayLimitConfigKeys.user("t1", "vip"), {
      requestsPerMinute: 3,
    });
    const port = createPgGatewayLimitPort(db);
    const vip = { ...base, userId: "vip" };
    const vipResults = [
      await port.admit(vip),
      await port.admit(vip),
      await port.admit(vip),
      await port.admit(vip),
    ];
    expect(vipResults.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect((await port.admit(base)).allowed).toBe(true);
    expect((await port.admit(base)).allowed).toBe(false);
    expect((await port.admit({ ...base, tenantId: "t2" })).allowed).toBe(true);
  });

  it("applies the published model limit per member and model, and mediaJobs only to media", async () => {
    await pglite.query(
      `INSERT INTO gateway_model (id, catalog_version, model_code, kind, card_json, rate_limit_json, published_at, created_at)
       VALUES ('gm1', 'v1', 'm1', 'text', '{}'::jsonb, '{"requestsPerMinute":1}'::jsonb, 1, 1)`,
    );
    await setConfig(gatewayLimitConfigKeys.key("t1", "k1"), { mediaJobs: 1 });
    const port = createPgGatewayLimitPort(db);
    expect((await port.admit({ ...base, media: true })).allowed).toBe(true);
    const second = await port.admit(base);
    expect(!second.allowed && second.code).toBe("GATEWAY_RATE_LIMITED");
    const other = { ...base, modelCode: "m2" };
    expect((await port.admit({ ...other, media: true })).allowed).toBe(false);
    expect((await port.admit(other)).allowed).toBe(true);
  });

  it("fails closed on a malformed configured limit", async () => {
    await setConfig(gatewayLimitConfigKeys.tenant("t1"), {
      requestsPerMinute: -1,
    });
    await expect(
      createPgGatewayLimitPort(db).admit(base),
    ).rejects.toMatchObject({ code: "GATEWAY_INTERNAL" });
  });

  it("expired leases stop counting and the sweeper repairs them", async () => {
    await setConfig(gatewayLimitConfigKeys.key("t1", "k1"), { concurrency: 1 });
    const crashed = createPgGatewayLimitPort(db);
    expect((await crashed.admit(base)).allowed).toBe(true);
    expect((await createPgGatewayLimitPort(db).admit(base)).allowed).toBe(
      false,
    );
    // The node holding the lease died; age it past its TTL.
    await pglite.query("UPDATE gateway_inflight SET expires_at = 0");
    await pglite.query(
      `INSERT INTO gateway_inflight (lease_id, subject, expires_at, created_at) VALUES ('old', 'tenant:x', 0, 0)`,
    );
    await pglite.query(
      `INSERT INTO gateway_rate_window (subject, window_start, requests) VALUES ('tenant:x', 0, 9)`,
    );
    const sweeper = createPgGatewayLimitPort(db);
    expect(await sweeper.sweep()).toEqual({ leases: 2, windows: 1 });
    expect(await sweeper.sweep()).toEqual({ leases: 0, windows: 0 });
    expect((await sweeper.admit(base)).allowed).toBe(true);
    const { rows } = await pglite.query<{ subject: string }>(
      "SELECT subject FROM gateway_inflight",
    );
    expect(rows.map((r) => r.subject)).toEqual([
      gatewayPgLimitSubjects.key("t1", "k1"),
    ]);
  });
});
