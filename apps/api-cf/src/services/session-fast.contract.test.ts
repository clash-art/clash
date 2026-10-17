/**
 * Contract: the one-query session check (#135) must agree with Better Auth's
 * own getSession for every cookie it answers, and defer to it ("fallback")
 * whenever Better Auth would write.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth, createAuthForHandler } from "../auth";
import { createSqliteD1 } from "../../../web/app/test-support/sqlite-d1";
import { betterAuthSessionCookieParams, verifySessionFast } from "./session-fast";
import { leanSessionCookieParams } from "./session-cookie";

for (const origin of ["http://localhost:8789", "https://staging.example.test"]) {
  describe(`fast session check vs Better Auth (${origin})`, () => {
    const { d1, sqlite, counter } = createSqliteD1();
    const env = {
      DB: d1,
      ENVIRONMENT: "test",
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: "contract-secret-0123456789abcdef0123456789",
    } as never;
    let cookie = "";
    let token = "";

    const request = (c: string) => new Request(`${origin}/api/projects`, { headers: { cookie: c } });
    const official = async (c: string) => {
      const s = (await createAuth(env).api.getSession({ headers: new Headers({ cookie: c }) })) as
        | { user: { id: string }; session: { id: string } }
        | null;
      return s ? { userId: s.user.id, sessionId: s.session.id } : null;
    };
    const fast = async (c: string) => {
      const r = await verifySessionFast(request(c), env);
      return r && r !== "fallback" ? { userId: r.userId, sessionId: r.sessionId } : r;
    };

    beforeAll(async () => {
      const res = await createAuthForHandler(env).handler(
        new Request(`${origin}/api/better-auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ email: "contract@example.com", password: "contract-pass-123", name: "C" }),
        }),
      );
      expect(res.status).toBe(200);
      cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      token = (sqlite.prepare("SELECT token FROM sessions").get() as { token: string }).token;
      if (origin.startsWith("https")) expect(cookie).toContain("__Secure-better-auth.session_token=");
    });

    it("lean Worker params (no better-auth) equal the live Better Auth context (#138)", async () => {
      const lean = await leanSessionCookieParams(env as never)!;
      const official = await betterAuthSessionCookieParams(env);
      const pick = (p: typeof lean) => ({
        cookieName: p.cookieName,
        dontRememberCookieName: p.dontRememberCookieName,
        expiresInMs: p.expiresInMs,
        updateAgeMs: p.updateAgeMs,
      });
      expect(pick(lean)).toEqual(pick(official));
    });

    it("lean params with no baseURL need an explicit secure-cookie pin", async () => {
      const unpinned = { BETTER_AUTH_SECRET: "s" };
      expect(leanSessionCookieParams(unpinned)).toBeNull();
      const noBase = { DB: d1, ENVIRONMENT: "test", BETTER_AUTH_SECRET: "contract-secret-no-base-0123456789" } as never;
      const official = await betterAuthSessionCookieParams(noBase);
      const lean = await leanSessionCookieParams({ BETTER_AUTH_SECRET: "x", BETTER_AUTH_SECURE_COOKIES: "false" })!;
      expect(lean.cookieName).toBe(official.cookieName);
    });

    it("valid cookie: same user and session, one D1 query", async () => {
      const expected = await official(cookie);
      expect(expected).not.toBeNull();
      counter.reset();
      expect(await fast(cookie)).toEqual(expected);
      expect(counter.count).toBe(1);
    });

    it("no cookie / other cookies only: both null, no query", async () => {
      counter.reset();
      expect(await fast("theme=dark")).toBeNull();
      expect(counter.count).toBe(0);
      expect(await official("theme=dark")).toBeNull();
    });

    it("tampered signature or token: both null", async () => {
      const [name, value] = cookie.split("; ").find((c) => c.includes("session_token"))!.split("=");
      const decoded = decodeURIComponent(value!);
      const badSig = `${name}=${encodeURIComponent(decoded.slice(0, -5) + "AAAA=")}`;
      // Always change the first character (a token that already starts with "x"
      // would otherwise stay valid and fail this test about 1 run in 62).
      const badToken = `${name}=${encodeURIComponent((decoded[0] === "x" ? "y" : "x") + decoded.slice(1))}`;
      for (const c of [badSig, badToken, `${name}=garbage`]) {
        expect(await official(c)).toBeNull();
        expect(await fast(c)).toBeNull();
      }
    });

    it("wrong cookie name variant: both null", async () => {
      const swapped = origin.startsWith("https")
        ? cookie.replace("__Secure-better-auth", "better-auth")
        : cookie.replace("better-auth.session_token", "__Secure-better-auth.session_token");
      expect(await official(swapped)).toBeNull();
      expect(await fast(swapped)).toBeNull();
    });

    it("refresh due: defers to Better Auth, which extends the session", async () => {
      const soon = Date.now() + 60 * 60 * 1000; // expires in 1h: well inside updateAge
      sqlite.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(soon, token);
      expect(await fast(cookie)).toBe("fallback");
      expect(await official(cookie)).not.toBeNull();
      const after = (sqlite.prepare("SELECT expires_at FROM sessions WHERE token = ?").get(token) as { expires_at: number }).expires_at;
      expect(after).toBeGreaterThan(soon);
      expect(await fast(cookie)).not.toBe("fallback");
    });

    it("expired: defers, Better Auth returns null and deletes the row", async () => {
      sqlite.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(Date.now() - 1000, token);
      expect(await fast(cookie)).toBe("fallback");
      expect(await official(cookie)).toBeNull();
      expect(await fast(cookie)).toBeNull();
    });

    it("revoked session or deleted user: null immediately", async () => {
      const res = await createAuthForHandler(env).handler(
        new Request(`${origin}/api/better-auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ email: "contract@example.com", password: "contract-pass-123" }),
        }),
      );
      const c2 = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      expect(await fast(c2)).not.toBeNull();
      sqlite.exec("DELETE FROM users");
      expect(await official(c2)).toBeNull();
      expect(await fast(c2)).toBeNull();
    });
  });
}
