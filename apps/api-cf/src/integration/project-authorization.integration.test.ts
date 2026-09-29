import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProjectAuthenticator } from "@clash/shared-runtime/project-authorization";
import { createD1ProjectAuthorizationStore } from "../loro/auth";

async function digest(token: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

describe("shared authorization policy over migrated D1", () => {
  it("checks owner, token revocation and project deletion using current persisted records", async () => {
    const projectId = "auth-contract-project";
    const token = "clsh_contract_owner";
    const tokenHash = await digest(token);
    await env.DB.prepare(
      "INSERT INTO project (id, owner_id, name) VALUES (?, 'auth-owner', 'Auth')",
    )
      .bind(projectId)
      .run();
    await env.DB.prepare(
      "INSERT INTO api_token (id, user_id, name, token_hash, token_prefix) VALUES ('auth-token', 'auth-owner', 'CLI', ?, 'clsh_')",
    )
      .bind(tokenHash)
      .run();
    const auth = createProjectAuthenticator({
      store: createD1ProjectAuthorizationStore(env),
    });
    const request = new Request("https://cloud.example/sync/project", {
      headers: { authorization: `Bearer ${token}` },
    });
    try {
      const identity = await auth.authenticate(request, projectId);
      expect(identity.userId).toBe("auth-owner");
      expect(await auth.revalidate(identity)).toBe(true);
      await env.DB.prepare("UPDATE project SET owner_id = 'other' WHERE id = ?")
        .bind(projectId)
        .run();
      await expect(auth.authenticate(request, projectId)).rejects.toThrow(
        "Forbidden",
      );
      expect(await auth.revalidate(identity)).toBe(false);
      await env.DB.prepare(
        "UPDATE project SET owner_id = 'auth-owner', deleted_at = 1 WHERE id = ?",
      )
        .bind(projectId)
        .run();
      expect(await auth.revalidate(identity)).toBe(false);
      await env.DB.prepare("UPDATE project SET deleted_at = NULL WHERE id = ?")
        .bind(projectId)
        .run();
      expect(await auth.revalidate(identity)).toBe(true);
      await env.DB.prepare(
        "DELETE FROM api_token WHERE id = 'auth-token'",
      ).run();
      expect(await auth.revalidate(identity)).toBe(false);
      await expect(auth.authenticate(request, projectId)).rejects.toThrow(
        "Unauthorized",
      );
    } finally {
      await env.DB.prepare(
        "DELETE FROM api_token WHERE id = 'auth-token'",
      ).run();
      await env.DB.prepare("DELETE FROM project WHERE id = ?")
        .bind(projectId)
        .run();
    }
  });

  it("rejects revoked or expired Better Auth session evidence in D1", async () => {
    const projectId = "auth-session-project",
      userId = "auth-session-owner";
    const expiresAt = Date.now() + 60_000;
    await env.DB.prepare(
      "INSERT INTO users (id, name, email, created_at, updated_at) VALUES (?, 'Auth', 'auth-contract@example.test', 0, 0)",
    )
      .bind(userId)
      .run();
    await env.DB.prepare(
      "INSERT INTO project (id, owner_id, name) VALUES (?, ?, 'Auth')",
    )
      .bind(projectId, userId)
      .run();
    await env.DB.prepare(
      "INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES ('auth-session', ?, 'auth-session-token', ?, 0, 0)",
    )
      .bind(userId, expiresAt)
      .run();
    const auth = createProjectAuthenticator({
      store: createD1ProjectAuthorizationStore(env),
      resolveSession: async () => ({
        user: { id: userId },
        session: { id: "auth-session", expiresAt },
      }),
    });
    try {
      const request = new Request("https://cloud.example", {
        headers: { cookie: "opaque" },
      });
      const identity = await auth.authenticate(request, projectId);
      await env.DB.prepare(
        "UPDATE sessions SET expires_at = 0 WHERE id = 'auth-session'",
      ).run();
      expect(await auth.revalidate(identity)).toBe(false);
      await expect(auth.authenticate(request, projectId)).rejects.toThrow();
      await env.DB.prepare(
        "DELETE FROM sessions WHERE id = 'auth-session'",
      ).run();
      expect(await auth.revalidate(identity)).toBe(false);
    } finally {
      await env.DB.prepare(
        "DELETE FROM sessions WHERE id = 'auth-session'",
      ).run();
      await env.DB.prepare("DELETE FROM project WHERE id = ?")
        .bind(projectId)
        .run();
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    }
  });
});
