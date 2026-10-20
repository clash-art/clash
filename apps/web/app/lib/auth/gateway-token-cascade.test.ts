/**
 * #346: sign-out through the web Worker's Better Auth instance (the hosted
 * sign-out path) revokes the gateway tokens minted from that session only.
 */
import { describe, expect, it } from "vitest";

import { createSqliteD1 } from "../../test-support/sqlite-d1";
import { createAuth } from "./better-auth.server";

const ORIGIN = "http://localhost:3000";

describe("gateway token sign-out cascade (web Better Auth)", () => {
  it("revokes the signed-out session's child tokens and leaves other sessions' tokens live", async () => {
    const { d1, sqlite } = createSqliteD1(new URL("../../../drizzle", import.meta.url).pathname);
    const env = {
      DB: d1,
      ENVIRONMENT: "test",
      BETTER_AUTH_URL: ORIGIN,
      BETTER_AUTH_SECRET: "gateway-cascade-test-secret-0123456789abcdef",
    };
    const auth = createAuth(env as never);
    const post = async (path: string, body: unknown, ip: string, cookie = "") => {
      const res = await auth.handler(
        new Request(`${ORIGIN}/api/better-auth${path}`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": ip, cookie },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(200);
      return res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    };
    const credentials = { email: "cascade@example.com", password: "cascade-pass-123" };
    const first = await post("/sign-up/email", { ...credentials, name: "C" }, "10.9.0.1");
    await post("/sign-in/email", credentials, "10.9.0.2");
    const sessions = sqlite.prepare("SELECT id, user_id FROM sessions ORDER BY created_at").all() as {
      id: string;
      user_id: string;
    }[];
    expect(sessions).toHaveLength(2);
    const insert = sqlite.prepare(
      `INSERT INTO gateway_token (id, token_hash, tenant_id, user_id, expires_at, parent_kind, parent_id)
       VALUES (?, ?, ?, ?, unixepoch() + 900, 'session', ?)`,
    );
    sessions.forEach((session, i) =>
      insert.run(`gwt_${i}`, `hash-${i}`, `personal:${session.user_id}`, session.user_id, session.id),
    );

    await post("/sign-out", {}, "10.9.0.3", first);

    const revoked = (id: string) =>
      (sqlite.prepare("SELECT revoked_at FROM gateway_token WHERE id = ?").get(id) as { revoked_at: number | null })
        .revoked_at;
    expect(revoked("gwt_0")).toEqual(expect.any(Number));
    expect(revoked("gwt_1")).toBeNull();
  });
});
