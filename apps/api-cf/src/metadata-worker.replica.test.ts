/**
 * Read replicas (#139): with D1_READ_REPLICAS=auto the metadata Worker reads
 * GETs through a Sessions API session, and re-checks auth/not-found answers on
 * the primary so a lagging replica never hides a just-created session,
 * token or project. Writes never use the replica session.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("./containers/render", () => ({ RenderContainer: class MockRenderContainer {} }));

import { createApp } from "./app";
import { createMetadataWorker } from "./metadata-worker";
import { createSqliteD1 } from "./test-support/sqlite-d1";

const ORIGIN = "http://localhost:8789";

describe("metadata Worker D1 read replicas", () => {
  const primary = createSqliteD1();
  const lagging = createSqliteD1(); // migrated, but has none of the primary's rows
  const sessions: string[] = [];
  const withSession = (db: D1Database, session: () => D1Database) =>
    ({
      prepare: (sql: string) => db.prepare(sql),
      batch: (s: D1PreparedStatement[]) => db.batch(s),
      withSession: session,
    }) as unknown as D1Database;
  const DB = withSession(primary.d1 as unknown as D1Database, ((constraint: string) => {
    sessions.push(constraint);
    return lagging.d1;
  }) as never);
  const ROOM = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json([]) }),
  };
  const base = {
    ROOM,
    ENVIRONMENT: "test",
    JWT_SECRET: "replica-jwt-secret",
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: "replica-secret-0123456789abcdef0123456789",
  };
  const env = { ...base, DB, D1_READ_REPLICAS: "auto" } as never;
  const plainEnv = { ...base, DB: primary.d1 } as never;
  const meta = createMetadataWorker();
  let cookie = "";
  let token = "";

  beforeAll(async () => {
    const app = createApp();
    const res = await app.request(
      "/api/better-auth/sign-up/email",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email: "replica@example.com", password: "replica-pass-123", name: "Replica" }),
      },
      plainEnv,
    );
    expect(res.status).toBe(200);
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const userId = (primary.sqlite.prepare("SELECT id FROM users").get() as { id: string }).id;
    primary.sqlite
      .prepare("INSERT INTO project (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("p1", userId, "One", 1_790_000_000, 1_790_000_100);
    const created = await app.request(
      "/api/settings/tokens",
      { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ name: "Replica CLI" }) },
      plainEnv,
    );
    token = ((await created.json()) as { token: string }).token;
  });

  const get = async (e: never, path: string, headers: Record<string, string>) => {
    const r = await meta.fetch(new Request(`${ORIGIN}${path}`, { headers }), e);
    return { status: r.status, body: await r.text() };
  };

  for (const path of ["/api/projects", "/api/projects/p1", "/api/v1/projects/p1", "/api/settings/tokens", "/loro/p1/metadata"]) {
    it(`${path}: a lagging replica falls back to the primary (cookie and token)`, async () => {
      const variants: Record<string, string>[] = [{ cookie }, { authorization: `Bearer ${token}` }];
      for (const headers of variants) {
        const before = sessions.length;
        const r = await get(env, path, headers);
        expect(sessions.length).toBe(before + 1);
        expect(sessions.at(-1)).toBe("first-unconstrained");
        expect(r).toEqual(await get(plainEnv, path, headers));
        // Session-only routes answer API tokens with 401 on the primary too.
        if ("cookie" in headers) expect(r.status).toBe(200);
      }
    });
  }

  it("serves from the replica when it is current", async () => {
    const replicaQueries = lagging.counter.count;
    const primaryQueries = primary.counter.count;
    const fresh = withSession(primary.d1 as unknown as D1Database, () => primary.d1 as unknown as D1Database);
    // Same database for the session: one pass, no retry.
    const r = await get({ ...base, DB: fresh, D1_READ_REPLICAS: "auto" } as never, "/api/projects", { cookie });
    expect(r.status).toBe(200);
    expect(lagging.counter.count).toBe(replicaQueries);
    expect(primary.counter.count).toBeGreaterThan(primaryQueries);
  });

  it("unauthenticated requests still answer 401 after the primary re-check", async () => {
    expect((await get(env, "/api/projects", {})).status).toBe(401);
  });

  it("writes never use the replica session", async () => {
    const before = sessions.length;
    const r = await meta.fetch(
      new Request(`${ORIGIN}/loro/p1/metadata`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ name: "Renamed" }),
      }),
      env,
    );
    expect(r.status).toBeLessThan(500);
    expect(sessions.length).toBe(before);
  });

  it("without D1_READ_REPLICAS no session is opened", async () => {
    const before = sessions.length;
    await get({ ...base, DB } as never, "/api/projects", { cookie });
    expect(sessions.length).toBe(before);
  });
});
