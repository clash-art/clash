/**
 * Issue #154: get-session through the Better Auth cookie cache, the
 * per-isolate instance and D1 read replicas. Real Better Auth and real SQL
 * (node:sqlite behind a D1-shaped adapter that counts round trips).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSqliteD1 } from "../../../../api-cf/src/test-support/sqlite-d1";
import {
  createAuth,
  DEFAULT_COOKIE_CACHE_SECONDS,
  resolveCookieCacheSeconds,
} from "./better-auth.server";
import { handleGetSession } from "./get-session.server";
import { getUserIdFromRequest } from "./session.server";

const ORIGIN = "http://localhost:3000";
const SECRET = "get-session-test-secret-0123456789abcdef0123";

type Jar = Map<string, string>;

function apply(jar: Jar, res: Response) {
  for (const raw of res.headers.getSetCookie()) {
    const [kv, ...attrs] = raw.split(";");
    const i = kv.indexOf("=");
    const name = kv.slice(0, i).trim();
    const value = kv.slice(i + 1).trim();
    const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim()));
    if (expired || value === "") jar.delete(name);
    else jar.set(name, value);
  }
}
// Better Auth's memory rate limiter is module-level (per isolate), so give
// every test its own client address.
let ipSeq = 0;
const nextIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const cookieOf = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

function makeEnv(extra: Record<string, unknown> = {}) {
  const primary = createSqliteD1(new URL("../../../drizzle", import.meta.url).pathname);
  const env = {
    DB: primary.d1 as unknown as D1Database,
    ENVIRONMENT: "test",
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: SECRET,
    ...extra,
  };
  return { env, primary };
}

async function call(env: object, path: string, jar: Jar, init: RequestInit = {}) {
  const request = new Request(`${ORIGIN}/api/better-auth${path}`, {
    ...init,
    headers: { origin: ORIGIN, cookie: cookieOf(jar), ...(init.headers ?? {}) },
  });
  const res =
    path === "/get-session" && (init.method ?? "GET") === "GET"
      ? await handleGetSession(request, env as never)
      : await createAuth(env as never).handler(request);
  apply(jar, res);
  return res;
}

async function signUp(env: object, email: string): Promise<Jar> {
  const jar: Jar = new Map();
  const res = await call(env, "/sign-up/email", jar, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
    body: JSON.stringify({ email, password: "get-session-pass-123", name: "G" }),
  });
  expect(res.status).toBe(200);
  return jar;
}

async function signIn(env: object, email: string): Promise<Jar> {
  const jar: Jar = new Map();
  const res = await call(env, "/sign-in/email", jar, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
    body: JSON.stringify({ email, password: "get-session-pass-123" }),
  });
  expect(res.status).toBe(200);
  return jar;
}

async function sessionUser(env: object, jar: Jar): Promise<string | null> {
  const res = await call(env, "/get-session", jar);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user?: { email?: string } } | null;
  return body?.user?.email ?? null;
}

const serverUserId = (env: object, jar: Jar) =>
  getUserIdFromRequest(new Request(`${ORIGIN}/x`, { headers: { cookie: cookieOf(jar) } }), env as never);

describe("get-session cookie cache (#154)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: Date.now() }));
  afterEach(() => vi.useRealTimers());

  it("sign-in sets the signed cache cookie; a browser hit costs no D1 query", async () => {
    const { env, primary } = makeEnv();
    const jar = await signUp(env, "hit@example.com");
    expect([...jar.keys()]).toEqual(
      expect.arrayContaining(["better-auth.session_token", "better-auth.session_data"]),
    );
    primary.counter.reset();
    for (let i = 0; i < 3; i++) expect(await sessionUser(env, jar)).toBe("hit@example.com");
    expect(primary.counter.count).toBe(0);
  });

  it("token-only request (cache miss) reads D1 once per table and re-issues the cache cookie", async () => {
    const { env, primary } = makeEnv();
    const jar = await signUp(env, "miss@example.com");
    jar.delete("better-auth.session_data");
    primary.counter.reset();
    expect(await sessionUser(env, jar)).toBe("miss@example.com");
    expect(primary.counter.count).toBeGreaterThan(0);
    expect(jar.has("better-auth.session_data")).toBe(true);
    primary.counter.reset();
    expect(await sessionUser(env, jar)).toBe("miss@example.com");
    expect(primary.counter.count).toBe(0);
  });

  it("a tampered cache cookie is not trusted", async () => {
    const { env, primary } = makeEnv();
    const jar = await signUp(env, "tamper@example.com");
    const data = jar.get("better-auth.session_data")!;
    const decoded = JSON.parse(Buffer.from(decodeURIComponent(data), "base64url").toString());
    decoded.session.user.email = "evil@example.com";
    jar.set("better-auth.session_data", Buffer.from(JSON.stringify(decoded)).toString("base64url"));
    primary.counter.reset();
    expect(await sessionUser(env, jar)).toBe("tamper@example.com");
    expect(primary.counter.count).toBeGreaterThan(0);
  });

  it("sign-out invalidates immediately: both cookies expire and the row is gone", async () => {
    const { env, primary } = makeEnv();
    const jar = await signUp(env, "out@example.com");
    const stolen = new Map(jar);
    expect(await sessionUser(env, jar)).toBe("out@example.com");
    const res = await call(env, "/sign-out", jar, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(jar.size).toBe(0);
    expect(await sessionUser(env, jar)).toBeNull();
    expect(primary.sqlite.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    // Data routes never accept the signed-out token, even with old cookies.
    expect(await serverUserId(env, stolen)).toBeNull();
  });

  it("a session revoked elsewhere: server-side checks reject at once, get-session within maxAge", async () => {
    const { env } = makeEnv();
    await signUp(env, "revoke@example.com");
    const victim = await signIn(env, "revoke@example.com");
    const admin = await signIn(env, "revoke@example.com");
    expect(await sessionUser(env, victim)).toBe("revoke@example.com");

    const res = await call(env, "/revoke-other-sessions", admin, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);

    // Authorization (DB-backed, like api-cf/meta) rejects immediately.
    expect(await serverUserId(env, victim)).toBeNull();
    expect(await serverUserId(env, admin)).not.toBeNull();
    // get-session may still answer from the signed cache inside the window...
    expect(await sessionUser(env, new Map(victim))).toBe("revoke@example.com");
    // ...but never after maxAge.
    vi.setSystemTime(Date.now() + (DEFAULT_COOKIE_CACHE_SECONDS + 1) * 1000);
    expect(await sessionUser(env, victim)).toBeNull();
    expect(victim.has("better-auth.session_token")).toBe(false);
  });

  it("BETTER_AUTH_COOKIE_CACHE_SECONDS=0 turns the cache off (revocation is immediate)", async () => {
    const { env } = makeEnv({ BETTER_AUTH_COOKIE_CACHE_SECONDS: "0" });
    await signUp(env, "off@example.com");
    const victim = await signIn(env, "off@example.com");
    const admin = await signIn(env, "off@example.com");
    expect(victim.has("better-auth.session_data")).toBe(false);
    await call(env, "/revoke-other-sessions", admin, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(await sessionUser(env, victim)).toBeNull();
  });

  it("cache lifetime is bounded", () => {
    const at = (v?: string) => resolveCookieCacheSeconds({ DB: {} as D1Database, BETTER_AUTH_COOKIE_CACHE_SECONDS: v });
    expect(at(undefined)).toBe(60);
    expect(at("0")).toBe(0);
    expect(at("30")).toBe(30);
    expect(at("3600")).toBe(60);
    expect(at("abc")).toBe(60);
  });

  it("one Better Auth instance per env (isolate)", () => {
    const { env } = makeEnv();
    expect(createAuth(env as never)).toBe(createAuth(env as never));
    expect(createAuth(makeEnv().env as never)).not.toBe(createAuth(env as never));
  });
});

describe("get-session read replicas on a cache miss (#154)", () => {
  function withReplica(replicaD1: D1Database | null) {
    const { env, primary } = makeEnv({ D1_READ_REPLICAS: "auto" });
    const constraints: string[] = [];
    (env.DB as unknown as { withSession: unknown }).withSession = (c: string) => {
      constraints.push(c);
      return replicaD1 ?? env.DB;
    };
    return { env, primary, constraints };
  }

  it("serves a miss from the replica when it has the row (no primary query)", async () => {
    const replica = createSqliteD1(new URL("../../../drizzle", import.meta.url).pathname);
    const { env, primary, constraints } = withReplica(replica.d1 as unknown as D1Database);
    const jar = await signUp(env, "rep@example.com");
    // Mirror the primary into the replica (caught-up replica).
    for (const t of ["users", "sessions"]) {
      for (const row of primary.sqlite.prepare(`SELECT * FROM ${t}`).all() as Record<string, never>[]) {
        const cols = Object.keys(row);
        replica.sqlite
          .prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
          .run(...cols.map((c) => row[c]));
      }
    }
    jar.delete("better-auth.session_data");
    primary.counter.reset();
    replica.counter.reset();
    expect(await sessionUser(env, jar)).toBe("rep@example.com");
    expect(constraints).toEqual(["first-unconstrained"]);
    expect(replica.counter.count).toBeGreaterThan(0);
    expect(primary.counter.count).toBe(0);
  });

  it("a lagging replica (row missing) falls back to the primary instead of signing out", async () => {
    const lagging = createSqliteD1(new URL("../../../drizzle", import.meta.url).pathname);
    const { env, primary } = withReplica(lagging.d1 as unknown as D1Database);
    const jar = await signUp(env, "lag@example.com");
    jar.delete("better-auth.session_data");
    primary.counter.reset();
    expect(await sessionUser(env, jar)).toBe("lag@example.com");
    expect(lagging.counter.count).toBeGreaterThan(0);
    expect(primary.counter.count).toBeGreaterThan(0);
    expect(jar.has("better-auth.session_token")).toBe(true);
  });

  it("no session cookie: no replica handle, plain null", async () => {
    const { env, constraints } = withReplica(null);
    expect(await sessionUser(env, new Map())).toBeNull();
    expect(constraints).toEqual([]);
  });
});
