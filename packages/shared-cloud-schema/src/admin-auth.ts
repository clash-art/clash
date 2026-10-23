/**
 * Admin identity store (#394, migration 0040; guide:
 * apps/docs/guide/gateway-admin.md): the tables of the admin Better Auth
 * instance (apps/api-cf/src/admin-auth.ts). They are separate from the product
 * users/sessions/accounts tables in ./auth, so an admin account is never a
 * product user and a product session is never an admin session.
 *
 * The export names are the Better Auth model names that instance configures
 * (user -> adminAccounts, session -> adminSessions, account ->
 * adminCredentials, verification -> adminVerifications), and the column keys
 * are its field names. No foreign keys (AGENTS.md).
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

/** Roles an admin account may hold; the permissions are services/gateway-authz.ts. */
export const ADMIN_ACCOUNT_ROLES = ["platform_admin"] as const;

export const adminAccounts = sqliteTable(
  "admin_accounts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
    image: text("image"),
    role: text("role").notNull().default("platform_admin"),
    /** Set when disabled: sessions and password are gone, sign-in is refused. */
    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(nowMs).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(nowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    emailUnique: uniqueIndex("admin_accounts_email_unique").on(table.email),
    roleCheck: check("admin_accounts_role_check", sql`${table.role} IN ('platform_admin')`),
  }),
);

export const adminSessions = sqliteTable(
  "admin_sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(nowMs).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** adminAccounts.id (Better Auth's session.userId field). */
    userId: text("admin_id").notNull(),
  },
  (table) => ({
    tokenUnique: uniqueIndex("admin_sessions_token_unique").on(table.token),
    adminIdx: index("admin_sessions_admin_id_idx").on(table.userId),
  }),
);

/** Better Auth's "account" model: an admin account's credential (password hash). */
export const adminCredentials = sqliteTable(
  "admin_credentials",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    /** adminAccounts.id (Better Auth's account.userId field). */
    userId: text("admin_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(nowMs).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    adminIdx: index("admin_credentials_admin_id_idx").on(table.userId),
  }),
);

export const adminVerifications = sqliteTable(
  "admin_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(nowMs).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(nowMs)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => ({
    identifierIdx: index("admin_verifications_identifier_idx").on(table.identifier),
  }),
);
