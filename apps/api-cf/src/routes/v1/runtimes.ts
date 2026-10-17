/** Browser-facing registry and session routes for connected Clash runtimes. */

import { Hono } from "hono";
import type { Env } from "../../config";
import { deriveRuntimeStatus } from "../../lib/runtime-status";
import {
  TOKEN_TOUCH_INTERVAL_S,
  shouldTouchToken,
} from "@clash/shared-runtime/project-authorization";

/** Browser-facing routes — mounted under /api/v1/runtimes. */
export const runtimesRoutes = new Hono<{ Bindings: Env }>();

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// GET / — list user's runtimes (with derived agents array, no token).
runtimesRoutes.get("/", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const { results } = await c.env.DB.prepare(
    `SELECT id, machine_id, hostname, os, agents_json, version, status, last_heartbeat, created_at
     FROM runtime WHERE owner_user_id = ? ORDER BY created_at DESC`,
  ).bind(userId).all<{
    id: string;
    machine_id: string;
    hostname: string;
    os: string;
    agents_json: string;
    version: string;
    status: string;
    last_heartbeat: number | null;
    created_at: number;
  }>();

  return c.json({
    runtimes: (results ?? []).map((r) => ({
      id: r.id,
      machine_id: r.machine_id,
      hostname: r.hostname,
      os: r.os,
      agents: JSON.parse(r.agents_json || "[]"),
      version: r.version,
      status: deriveRuntimeStatus(r.status, r.last_heartbeat),
      last_heartbeat: r.last_heartbeat,
      created_at: r.created_at,
    })),
  });
});

// POST /:rid/sessions — start a new local-runtime chat session on a runtime.
// Payload: { agent_member_id, project_id, resume_session_id? }.
// The server resolves the claimed agent member to its bundled template and
// selected ACP CLI before dispatching to the daemon.
runtimesRoutes.post("/:rid/sessions", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const rid = c.req.param("rid");
  const body = (await c.req.json().catch(() => ({}))) as {
    agent_member_id?: string;
    project_id?: string;
    cwd?: string;
    resume_session_id?: string;
  };

  const requestedAgentMemberId = body.agent_member_id?.trim() ?? "";
  if (!requestedAgentMemberId) {
    return c.json({ error: "agent_member_id required" }, 400);
  }
  const agentMember = await c.env.DB.prepare(
    "SELECT id, template_id, runtime_id, agent_id FROM agent_member WHERE id = ? AND user_id = ?",
  ).bind(requestedAgentMemberId, userId).first<{
    id: string; template_id: string; runtime_id: string; agent_id: string | null;
  }>();
  if (!agentMember) return c.json({ error: "agent member not found" }, 404);
  if (agentMember.runtime_id !== rid) {
    return c.json({ error: "agent member belongs to a different runtime" }, 400);
  }
  const agentTemplateId = agentMember.template_id;
  const agentMemberId = agentMember.id;
  const agentOverride = agentMember.agent_id;

  const runtime = await c.env.DB.prepare(
    "SELECT id, status, last_heartbeat FROM runtime WHERE id = ? AND owner_user_id = ?",
  ).bind(rid, userId).first<{ id: string; status: string; last_heartbeat: number | null }>();
  if (!runtime) return c.json({ error: "runtime not found" }, 404);
  // Use the derived status so a row that's still flagged `'online'`
  // but hasn't heartbeat for 90s+ gets rejected here. Without this
  // check the browser's auto-reconnect loop pumps out orphan
  // runtime_session rows every few seconds against a dead daemon —
  // we saw 239 leak in a single afternoon before this guard landed.
  if (deriveRuntimeStatus(runtime.status, runtime.last_heartbeat) !== "online") {
    return c.json({ error: "runtime offline" }, 409);
  }

  const sessionId = crypto.randomUUID();
  // cwd column overload remains: it's still being used to hold project_id
  // (existing hack). When that's split into its own column the room
  // mention dispatcher in projects.ts will need the same change.
  await c.env.DB.prepare(
    `INSERT INTO runtime_session
       (id, user_id, runtime_id, agent_template_id, agent_member_id, cwd, status, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', unixepoch(), unixepoch())`,
  ).bind(sessionId, userId, rid, agentTemplateId, agentMemberId, body.project_id ?? "").run();

  const doStub = c.env.RUNTIME_ROOM.get(c.env.RUNTIME_ROOM.idFromName(rid));
  const ok = await (doStub as unknown as {
    sendToDaemon(msg: Record<string, unknown>): Promise<boolean>;
  }).sendToDaemon({
    type: "session.start",
    session_id: sessionId,
    agent_template_id: agentTemplateId,
    agent_member_id: agentMemberId,
    // agent_id override — daemon prefers this over the bundled
    // template's runtime.json default. Lets each user pick which CLI
    // (claude-agent-acp / codex / gemini / …) powers their agent.
    ...(agentOverride ? { agent_id: agentOverride } : {}),
    ...(body.project_id ? { project_id: body.project_id } : {}),
    ...(body.resume_session_id ? { resume: { acp_session_id: body.resume_session_id } } : {}),
  });

  if (!ok) {
    await c.env.DB.prepare(
      "UPDATE runtime_session SET status = 'closed' WHERE id = ?",
    ).bind(sessionId).run();
    return c.json({ error: "runtime daemon not reachable; try again" }, 503);
  }

  return c.json({ session_id: sessionId });
});

// GET /:rid/local-sessions/scan — RPC the daemon for local CC transcripts
// it can resume. Used by the runtime picker dialog so the user can pick
// "Resume X" instead of "Start fresh". Returns [] if daemon offline /
// unreachable / RPC times out.
runtimesRoutes.get("/:rid/local-sessions/scan", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const rid = c.req.param("rid");
  const runtime = await c.env.DB.prepare(
    "SELECT id, status FROM runtime WHERE id = ? AND owner_user_id = ?",
  ).bind(rid, userId).first<{ id: string; status: string }>();
  if (!runtime) return c.json({ error: "runtime not found" }, 404);
  if (runtime.status !== "online") return c.json({ sessions: [] });

  const doStub = c.env.RUNTIME_ROOM.get(c.env.RUNTIME_ROOM.idFromName(rid));
  const sessions = await (doStub as unknown as {
    listLocalSessions(timeoutMs?: number): Promise<unknown[]>;
  }).listLocalSessions(5000).catch(() => []);
  return c.json({ sessions });
});

// DELETE /:id — revoke runtime: kill all its tokens + delete runtime row.
// The daemon will get auth-rejected on next /attach and stop reconnecting
// after a few backoff cycles.
runtimesRoutes.delete("/:id", async (c) => {
  const userId = c.req.header("x-user-id");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const id = c.req.param("id");

  // Verify ownership before deleting.
  const owned = await c.env.DB.prepare(
    "SELECT id FROM runtime WHERE id = ? AND owner_user_id = ?",
  ).bind(id, userId).first<{ id: string }>();
  if (!owned) return c.json({ error: "not found" }, 404);

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE runtime_token SET revoked_at = ? WHERE runtime_id = ? AND revoked_at IS NULL").bind(now, id),
    c.env.DB.prepare("DELETE FROM runtime WHERE id = ?").bind(id),
  ]);

  return c.json({ ok: true });
});

/**
 * Helper for the WS /attach route (defined in app.ts) — validates a
 * `Authorization: Bearer sk_machine_…` header against runtime_token,
 * returns the runtime row on success.
 */
export async function authenticateRuntimeToken(
  env: Env,
  bearer: string,
): Promise<{ runtime_id: string; user_id: string } | null> {
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : bearer;
  if (!token.startsWith("sk_machine_")) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT t.runtime_id, r.owner_user_id AS user_id, t.last_used_at
     FROM runtime_token t JOIN runtime r ON r.id = t.runtime_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
  ).bind(hash).first<{ runtime_id: string; user_id: string; last_used_at: number | null }>();
  if (!row) return null;
  // Best-effort last_used_at refresh, at most every 5 min (#141); don't block on it.
  if (shouldTouchToken(row.last_used_at == null ? null : row.last_used_at * 1000))
    env.DB.prepare(
      `UPDATE runtime_token SET last_used_at = unixepoch()
        WHERE token_hash = ? AND (last_used_at IS NULL OR last_used_at < unixepoch() - ?)`,
    ).bind(hash, TOKEN_TOUCH_INTERVAL_S).run().catch(() => {});
  return { runtime_id: row.runtime_id, user_id: row.user_id };
}
