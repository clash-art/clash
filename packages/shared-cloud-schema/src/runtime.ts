import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Runtime — a user's machine running the clash daemon.
 * Keyed by (owner, machine_id) — machine_id is a daemon-computed stable
 * fingerprint so reinstalling on the same box reuses the row instead of
 * accumulating zombies.
 *
 * `agents_json` is the manifest the daemon last reported (PATH-detected
 * ACP agents). `status` is set to 'online' when the WS attaches and
 * back to 'offline' on close or via a sweeper if heartbeat goes stale.
 */
export const runtime = sqliteTable(
  "runtime",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerUserId: text("owner_user_id").notNull(),
    machineId: text("machine_id").notNull(),
    hostname: text("hostname").notNull(),
    os: text("os").notNull(),
    agentsJson: text("agents_json").notNull().default("[]"),
    version: text("version").notNull(),
    status: text("status").notNull().default("offline"),
    lastHeartbeat: integer("last_heartbeat", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    runtimeOwnerIdx: index("runtime_owner_idx").on(table.ownerUserId),
    runtimeUniqueIdx: index("runtime_unique_idx").on(
      table.ownerUserId,
      table.machineId,
    ),
  }),
);

/**
 * Runtime Token — long-lived bearer credential the daemon uses to attach.
 * Token format: `sk_machine_<60-hex>`. Only sha256(token) is stored.
 *
 * `created_by_user_id` separated from runtime.owner_user_id so v2 (org
 * admin issues tokens for shared runtimes) can land without migration.
 */
export const runtimeToken = sqliteTable(
  "runtime_token",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runtimeId: text("runtime_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
  },
  (table) => ({
    runtimeTokenRuntimeIdx: index("runtime_token_runtime_idx").on(
      table.runtimeId,
    ),
    runtimeTokenHashIdx: index("runtime_token_hash_idx").on(table.tokenHash),
  }),
);

/**
 * Runtime Session — index of agent sessions on user runtimes.
 * Powers resume / history. The actual transcript lives on the user's disk
 * (e.g. ~/.claude/projects/<hash>/<acp_session_id>.jsonl); we just store
 * enough metadata to tell the daemon "load session X next time".
 */
export const runtimeSession = sqliteTable(
  "runtime_session",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    agentTemplateId: text("agent_template_id").notNull(),
    agentMemberId: text("agent_member_id").notNull(),
    acpSessionId: text("acp_session_id"),
    cwd: text("cwd").notNull(),
    title: text("title"),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
    lastActiveAt: integer("last_active_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    runtimeSessionUserIdx: index("runtime_session_user_idx").on(
      table.userId,
      table.lastActiveAt,
    ),
    runtimeSessionRuntimeIdx: index("runtime_session_runtime_idx").on(
      table.runtimeId,
    ),
    runtimeSessionAgentMemberIdx: index("runtime_session_agent_member_idx").on(
      table.agentMemberId,
    ),
  }),
);

/**
 * Chat history per local-runtime session.
 *
 * One row per logical message (user prompt or assembled agent turn).
 * Streaming chunks aren't persisted — they're broadcast live via the
 * RuntimeRoom DO and the assembled message gets written on
 * session.complete (events_json holds the raw ACP events; browser
 * uses the same parser as the live stream to render).
 *
 * Why D1 not Loro: chat is append-only, no concurrent-edit case.
 * Cross-session queries (history page, future search) are trivial
 * SQL here vs cross-DO fan-out for Loro.
 */
export const chatMessage = sqliteTable(
  "chat_message",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    sessionId: text("session_id").notNull(),
    userId: text("user_id").notNull(),
    senderKind: text("sender_kind").notNull(), // 'user' | 'agent'
    senderId: text("sender_id").notNull(), // agent_member_id or user_id
    turnId: text("turn_id"),
    eventsJson: text("events_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    chatMessageSessionIdx: index("chat_message_session_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    chatMessageUserIdx: index("chat_message_user_idx").on(
      table.userId,
      table.createdAt,
    ),
  }),
);

/**
 * Claimed agent members — concrete instances of bundled agent templates.
 *
 * Templates (Director / Canvas Editor / …) ship in the local Clash runtime
 * as read-only role definitions. A user "claims" a template + runtime
 * to create one of these rows — e.g. "Alice's Director on alice-mac".
 *
 * Once claimed, the row is the durable identity used to spawn sessions.
 *
 * Display name defaults to template label; user can rename to
 * distinguish multiple instances of the same template.
 */
export const agentMember = sqliteTable(
  "agent_member",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    templateId: text("template_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    // ACP CLI to spawn (claude-agent-acp / codex / gemini / …).
    agentId: text("agent_id").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    // ── Per-agent budget (Phase 0 multi-actor billing) ───────
    // Set in Settings → Agent budgets; read by the (closed-source)
    // billing plugin at generation time. Platform code only plumbs.
    // budgetCredits = NULL means "no cap" (unlimited).
    budgetCredits: integer("budget_credits"),
    // 'monthly' | 'one-time' | 'unlimited'. Plugin owns the reset
    // semantics; we just store the user's choice.
    budgetPeriod: text("budget_period").default("monthly"),
    budgetUsed: integer("budget_used").default(0),
    budgetResetAt: integer("budget_reset_at"),
  },
  (table) => ({
    agentMemberUserIdx: index("agent_member_user_idx").on(
      table.userId,
      table.createdAt,
    ),
    agentMemberRuntimeIdx: index("agent_member_runtime_idx").on(
      table.runtimeId,
    ),
  }),
);
