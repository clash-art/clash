import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authenticateApiToken,
  createProjectAuthenticator,
  shouldTouchToken,
  TOKEN_TOUCH_INTERVAL_MS,
} from "./project-authorization";
import { createPostgresProjectAuthorizationStore } from "./project-authorization-postgres";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// PostgreSQL contract fixture for the authority's consumed columns, not a
// deployment migration. Native timestamptz must normalize to policy milliseconds.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clash-pg-auth-"));
  roots.push(root);
  const path = join(root, "postgres");
  const db = new PGlite(path);
  await db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, deleted_at TIMESTAMPTZ);
    CREATE TABLE api_token (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, last_used_at TIMESTAMPTZ);
    CREATE TABLE auth_user (id TEXT PRIMARY KEY, name TEXT NOT NULL, image TEXT);
    CREATE TABLE auth_session (id TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "expiresAt" TIMESTAMPTZ NOT NULL);
    INSERT INTO project VALUES ('project', 'owner', NULL);`);
  return { db, path };
}
async function hash(token: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
function authenticator(db: PGlite) {
  return createProjectAuthenticator({
    store: createPostgresProjectAuthorizationStore(db),
  });
}
function request(token = "clsh_owner") {
  return new Request("https://cloud.example/sync/project", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("PostgreSQL project authorization", () => {
  it("authenticates after database reopen, then rejects token revocation on the same connection", async () => {
    const { db, path } = await fixture();
    await db.query("INSERT INTO api_token VALUES ($1, 'owner', 'CLI', NULL)", [
      await hash("clsh_owner"),
    ]);
    await db.close();
    const reopened = new PGlite(path);
    try {
      const auth = authenticator(reopened);
      const identity = await auth.authenticate(request(), "project");
      expect(identity.userId).toBe("owner");
      expect(JSON.stringify(identity)).not.toContain("clsh_owner");
      expect(await auth.revalidate(identity)).toBe(true);
      await reopened.query("DELETE FROM api_token WHERE token_hash = $1", [
        await hash("clsh_owner"),
      ]);
      expect(await auth.revalidate(identity)).toBe(false);
      await expect(auth.authenticate(request(), "project")).rejects.toThrow();
    } finally {
      await reopened.close();
    }
  });
  it("rejects cross-owner access and soft deletion after admission", async () => {
    const { db } = await fixture();
    try {
      await db.query(
        "INSERT INTO api_token VALUES ($1, 'owner', 'CLI', NULL)",
        [await hash("clsh_owner")],
      );
      await db.query(
        "INSERT INTO api_token VALUES ($1, 'other', 'CLI', NULL)",
        [await hash("clsh_other")],
      );
      const auth = authenticator(db);
      await expect(
        auth.authenticate(request("clsh_other"), "project"),
      ).rejects.toThrow("Forbidden");
      const identity = await auth.authenticate(request(), "project");
      await db.exec(
        "UPDATE project SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'project'",
      );
      expect(await auth.revalidate(identity)).toBe(false);
      await expect(auth.authenticate(request(), "project")).rejects.toThrow(
        "Forbidden",
      );
    } finally {
      await db.close();
    }
  });
  it("normalizes native timestamp expiry and rechecks session revocation", async () => {
    const { db } = await fixture();
    try {
      const expiresAt = Date.now() + 60_000;
      await db.query(
        "INSERT INTO auth_session VALUES ('session', 'owner', $1)",
        [new Date(expiresAt)],
      );
      const store = createPostgresProjectAuthorizationStore(db);
      expect((await store.readSession("session"))?.expiresAt).toBe(expiresAt);
      const auth = createProjectAuthenticator({
        store,
        resolveSession: async () => ({
          user: { id: "owner" },
          session: { id: "session", expiresAt },
        }),
      });
      const cookieRequest = new Request("https://cloud.example", {
        headers: { cookie: "opaque" },
      });
      const identity = await auth.authenticate(cookieRequest, "project");
      await db.exec(
        "UPDATE auth_session SET \"expiresAt\" = TIMESTAMPTZ '2000-01-01 00:00:00+00'",
      );
      expect(await auth.revalidate(identity)).toBe(false);
      await expect(
        auth.authenticate(cookieRequest, "project"),
      ).rejects.toThrow();
      await db.exec("DELETE FROM auth_session");
      expect(await auth.revalidate(identity)).toBe(false);
    } finally {
      await db.close();
    }
  });
  // #102: the token's label ("Clash CLI") was reported as the person's name.
  it("names a token-authenticated identity after its user, keeping the token label separate", async () => {
    const { db } = await fixture();
    try {
      await db.query(
        "INSERT INTO api_token VALUES ($1, 'owner', 'Token label', NULL)",
        [await hash("clsh_owner")],
      );
      const auth = authenticator(db);
      // A token whose user row is absent has no display name to report.
      expect(
        (await auth.authenticate(request(), "project")).userName,
      ).toBeUndefined();
      await db.query(
        "INSERT INTO auth_user VALUES ('owner', 'Owner Person', 'https://cdn.example/owner.png')",
      );
      expect(await auth.authenticate(request(), "project")).toMatchObject({
        userName: "Owner Person",
        userAvatar: "https://cdn.example/owner.png",
        credentialName: "Token label",
      });
    } finally {
      await db.close();
    }
  });
  it("does not interpret user input as SQL and records token usage with a PostgreSQL timestamp", async () => {
    const { db } = await fixture();
    try {
      const tokenHash = await hash("clsh_owner");
      await db.query(
        "INSERT INTO api_token VALUES ($1, 'owner', 'CLI', NULL)",
        [tokenHash],
      );
      const store = createPostgresProjectAuthorizationStore(db);
      expect(await store.readProject("project' OR TRUE --")).toBeNull();
      await store.touchApiToken(tokenHash);
      const result = await db.query<{ used: boolean }>(
        "SELECT last_used_at IS NOT NULL AS used FROM api_token",
      );
      expect(result.rows[0].used).toBe(true);
    } finally {
      await db.close();
    }
  });
  it("records token usage at most once per touch interval (#141)", async () => {
    const { db } = await fixture();
    try {
      const tokenHash = await hash("clsh_owner");
      await db.query(
        "INSERT INTO api_token VALUES ($1, 'owner', 'CLI', NULL)",
        [tokenHash],
      );
      const store = createPostgresProjectAuthorizationStore(db);
      expect((await store.readApiToken(tokenHash))?.lastUsedAt).toBeNull();
      await authenticateApiToken(request(), store);
      await new Promise((r) => setTimeout(r, 20));
      const first = (await store.readApiToken(tokenHash))?.lastUsedAt;
      expect(first).toBeGreaterThan(Date.now() - 60_000);
      // A recent timestamp: the guarded UPDATE leaves it alone even when
      // called directly (concurrent first requests write once).
      await db.query(
        "UPDATE api_token SET last_used_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'",
      );
      const pinned = (await store.readApiToken(tokenHash))?.lastUsedAt;
      await store.touchApiToken(tokenHash);
      expect((await store.readApiToken(tokenHash))?.lastUsedAt).toBe(pinned);
      // Stale (> 5 min): recorded again.
      await db.query(
        "UPDATE api_token SET last_used_at = CURRENT_TIMESTAMP - INTERVAL '6 minutes'",
      );
      await store.touchApiToken(tokenHash);
      expect((await store.readApiToken(tokenHash))?.lastUsedAt).toBeGreaterThan(
        Date.now() - 60_000,
      );
    } finally {
      await db.close();
    }
  });
});

describe("token touch interval", () => {
  it("touches unknown/never-used tokens and skips fresh ones", () => {
    const now = 1_000_000_000_000;
    expect(shouldTouchToken(undefined, now)).toBe(true);
    expect(shouldTouchToken(null, now)).toBe(true);
    expect(shouldTouchToken(now - 1000, now)).toBe(false);
    expect(shouldTouchToken(now - TOKEN_TOUCH_INTERVAL_MS + 1, now)).toBe(false);
    expect(shouldTouchToken(now - TOKEN_TOUCH_INTERVAL_MS, now)).toBe(true);
  });

  it("authenticateApiToken skips the usage write when the token was just used", async () => {
    let touches = 0;
    const store = {
      readProject: async () => null,
      readSession: async () => null,
      readApiToken: async () => ({ userId: "owner", lastUsedAt: Date.now() - 1000 }),
      touchApiToken: async () => {
        touches++;
      },
    };
    await authenticateApiToken(request(), store);
    expect(touches).toBe(0);
    store.readApiToken = async () => ({ userId: "owner", lastUsedAt: Date.now() - TOKEN_TOUCH_INTERVAL_MS - 1 });
    await authenticateApiToken(request(), store);
    expect(touches).toBe(1);
  });
});
