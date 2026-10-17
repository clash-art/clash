/**
 * D1 round trips per authenticated route, against real SQL (web/drizzle
 * migrations on node:sqlite) and a real Better Auth session cookie.
 *
 * Every D1 query from a Worker outside the database's region costs a network
 * round trip (~85 ms IAD -> WNAM on staging), so these budgets are latency
 * budgets. If a change adds a query to a hot route, update the budget on
 * purpose.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("./containers/render", () => ({
  RenderContainer: class MockRenderContainer {},
}));

import { createApp } from "./app";
import { createSqliteD1 } from "./test-support/sqlite-d1";

const ORIGIN = "http://localhost:8789";
const PROJECT = "proj-count-1";

/** Budgets: [route, D1 queries]. Session auth is one JOIN (#135); route
 * data follows. Before #133/#135 these were 6, 6, 4, 5, 6, 2. */
export const D1_QUERY_BUDGET: [string, number][] = [
  ["/api/projects", 3],
  [`/api/projects/${PROJECT}`, 3],
  [`/api/v1/projects/${PROJECT}`, 3],
  ["/api/settings/tokens", 2],
  [`/loro/${PROJECT}/metadata`, 3],
  ["/api/better-auth/get-session", 2],
];

describe("D1 queries per authenticated request", () => {
  const { d1, sqlite, counter } = createSqliteD1();
  const env = {
    DB: d1,
    ENVIRONMENT: "test",
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: "test-secret-for-d1-count-0123456789abcdef",
  } as never;
  const app = createApp();
  let cookie = "";

  beforeAll(async () => {
    const res = await app.request(
      "/api/better-auth/sign-up/email",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email: "count@example.com", password: "count-password-123", name: "Count" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie).toContain("session_token");
    const user = sqlite.prepare("SELECT id FROM users WHERE email = ?").get("count@example.com") as { id: string };
    sqlite
      .prepare("INSERT INTO project (id, owner_id, name, created_at, updated_at) VALUES (?, ?, 'Count', 1, 1)")
      .run(PROJECT, user.id);
  });

  for (const [path, budget] of D1_QUERY_BUDGET) {
    it(`GET ${path} uses ${budget} D1 queries`, async () => {
      counter.reset();
      const res = await app.request(path, { headers: { cookie, origin: ORIGIN } }, env);
      expect(res.status, await res.clone().text()).toBe(200);
      if (process.env.D1_COUNT_DEBUG) (await import("node:fs")).appendFileSync(process.env.D1_COUNT_DEBUG, `${path} ${JSON.stringify(counter.sql)}\n`);
      expect(counter.sql, `queries for ${path}`).toHaveLength(budget);
    });
  }

  it("rejects a request without a session before any D1 query", async () => {
    counter.reset();
    const res = await app.request("/api/projects", {}, env);
    expect(res.status).toBe(401);
    expect(counter.count).toBe(0);
  });

  it("verifies a session once per request even when called repeatedly", async () => {
    for (let i = 0; i < 3; i++) {
      counter.reset();
      const res = await app.request("/api/settings/tokens", { headers: { cookie } }, env);
      expect(res.status).toBe(200);
      expect(counter.sql.filter((s) => /from "?sessions"? /i.test(s))).toHaveLength(1);
    }
  });

  it("records API token usage at most once per 5 minutes (#141)", async () => {
    const raw = "clsh_count_touch_token";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const user = sqlite.prepare("SELECT id FROM users WHERE email = ?").get("count@example.com") as { id: string };
    sqlite
      .prepare("INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES ('tok-touch', ?, 'touch', ?, 'clsh_cou', 1)")
      .run(user.id, hash);
    const updates = () => counter.sql.filter((s) => /^UPDATE api_token/i.test(s));
    const call = async () => {
      counter.reset();
      const res = await app.request(`/api/v1/projects/${PROJECT}`, { headers: { authorization: `Bearer ${raw}` } }, env);
      expect(res.status, await res.clone().text()).toBe(200);
      await new Promise((r) => setTimeout(r, 0)); // flush the fire-and-forget touch
      return updates().length;
    };
    expect(await call()).toBe(1); // never used -> recorded
    const first = sqlite.prepare("SELECT last_used_at FROM api_token WHERE id = 'tok-touch'").get() as { last_used_at: number };
    expect(first.last_used_at).toBeGreaterThan(0);
    expect(await call()).toBe(0); // fresh -> no primary write
    expect(await call()).toBe(0);
    sqlite.prepare("UPDATE api_token SET last_used_at = unixepoch() - 301 WHERE id = 'tok-touch'").run();
    expect(await call()).toBe(1); // stale -> recorded again
  });

  it("reuses one Better Auth instance without tripping its rate limiter", async () => {
    // 150 > the 100/min global rule: server-side getSession bypasses it.
    for (let i = 0; i < 150; i++) {
      const res = await app.request("/api/settings/tokens", { headers: { cookie } }, env);
      expect(res.status).toBe(200);
    }
  });
});
