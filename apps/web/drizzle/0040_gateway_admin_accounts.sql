-- Admin identity, separate from product users (#394). Guide:
-- apps/docs/guide/gateway-admin.md. Drizzle mirror:
-- packages/shared-cloud-schema/src/admin-auth.ts (admin tables) and
-- packages/shared-cloud-schema/src/gateway.ts (audit). No foreign keys
-- (AGENTS.md).
--
-- Admin accounts are their own Better Auth instance (apps/api-cf/src/admin-auth.ts,
-- base path /api/admin-auth, cookie prefix clash-admin) over these four
-- tables, never the product users/sessions/accounts tables. Timestamps are
-- epoch milliseconds, as Better Auth writes them for the product tables.

CREATE TABLE IF NOT EXISTS admin_accounts (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  email_verified integer NOT NULL DEFAULT 0,
  image text,
  -- The permission set the account holds (services/gateway-authz.ts).
  role text NOT NULL DEFAULT 'platform_admin',
  -- Set when the account is disabled: its sessions and password are deleted
  -- in the same batch, and sign-in is refused.
  disabled_at integer,
  created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  CHECK (role IN ('platform_admin'))
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_email_unique ON admin_accounts(email);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id text PRIMARY KEY NOT NULL,
  expires_at integer NOT NULL,
  token text NOT NULL,
  created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  updated_at integer NOT NULL,
  ip_address text,
  user_agent text,
  admin_id text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_sessions_token_unique ON admin_sessions(token);
CREATE INDEX IF NOT EXISTS admin_sessions_admin_id_idx ON admin_sessions(admin_id);

-- Better Auth's "account" model: the credential (password hash) of an admin account.
CREATE TABLE IF NOT EXISTS admin_credentials (
  id text PRIMARY KEY NOT NULL,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  admin_id text NOT NULL,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at integer,
  refresh_token_expires_at integer,
  scope text,
  password text,
  created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_credentials_admin_id_idx ON admin_credentials(admin_id);

CREATE TABLE IF NOT EXISTS admin_verifications (
  id text PRIMARY KEY NOT NULL,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at integer NOT NULL,
  created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  updated_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))
);
CREATE INDEX IF NOT EXISTS admin_verifications_identifier_idx ON admin_verifications(identifier);

-- Audit actors are an identity kind plus its id: 'admin' (admin_accounts.id),
-- 'user' (a product user acting through a team role), 'bootstrap' (the
-- first-admin script) or 'migration' (this file). Rows written before this
-- migration were product users, except the bootstrap ones. The append-only
-- trigger is lifted for this one backfill of the new column and restored
-- unchanged (0036).
ALTER TABLE gateway_admin_audit RENAME COLUMN actor_user_id TO actor_id;
ALTER TABLE gateway_admin_audit ADD COLUMN actor_kind text NOT NULL DEFAULT 'user';

DROP TRIGGER IF EXISTS gateway_admin_audit_no_update;
UPDATE gateway_admin_audit SET actor_kind = 'bootstrap' WHERE actor_id = 'bootstrap';
CREATE TRIGGER IF NOT EXISTS gateway_admin_audit_no_update
BEFORE UPDATE ON gateway_admin_audit
BEGIN
  SELECT RAISE(ABORT, 'gateway_admin_audit is append-only');
END;

CREATE INDEX IF NOT EXISTS gateway_admin_audit_actor_idx
  ON gateway_admin_audit(actor_kind, actor_id, occurred_at);

-- platform_admin is no longer a grant on product users. Every existing grant
-- is dropped, each recorded as one audit row (actor 'migration'). Re-create
-- the people who need the console as admin accounts with
-- apps/api-cf/scripts/gateway-admin-account.ts (local or staging) or, once
-- one admin exists, POST /api/v1/admin/gateway/admin-accounts.
INSERT INTO gateway_admin_audit
  (id, tenant_id, actor_id, actor_kind, actor_role, action, target_type, target_id, before_json, reason, occurred_at)
SELECT 'gwa_' || lower(hex(randomblob(16))), '', '0040_gateway_admin_accounts', 'migration', NULL,
       'platform_role.drop', 'platform_role', user_id,
       json_object('role', role, 'grantedByUserId', granted_by_user_id),
       'platform_admin moved to admin accounts (#394)', CAST(strftime('%s', 'now') AS INTEGER)
  FROM gateway_platform_role;

DROP TABLE IF EXISTS gateway_platform_role;
