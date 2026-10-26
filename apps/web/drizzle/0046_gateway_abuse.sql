-- Abuse signals, configurable thresholds, alerts and key/tenant suspension,
-- and the support_agent admin account role (#356). Guide:
-- apps/docs/guide/gateway-admin.md#abuse. Drizzle mirrors:
-- packages/shared-cloud-schema/src/gateway.ts and admin-auth.ts. No foreign
-- keys (AGENTS.md).

-- Raw observations of the data plane, one counter per kind, tenant, key,
-- client fingerprint and minute (window_start, unix seconds):
--   request       an authenticated request (velocity, shared-key fingerprints)
--   auth_failure  a 401 answer (unknown, expired or revoked credential)
-- tenant_id and key_id are '' when the credential was not recognized. key_id
-- is the suspendable key: the virtual key a token was minted from, else its
-- clsh_ parent (api_token.id), else the gateway token. The fingerprint is a truncated SHA-256 of the client address
-- and user agent; neither is stored. Rows are deleted after 24 hours, the
-- longest threshold window.
CREATE TABLE IF NOT EXISTS gateway_abuse_observation (
  kind text NOT NULL,
  tenant_id text NOT NULL DEFAULT '',
  key_id text NOT NULL DEFAULT '',
  fingerprint text NOT NULL,
  window_start integer NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, tenant_id, key_id, fingerprint, window_start),
  CHECK (kind IN ('request', 'auth_failure'))
);
CREATE INDEX IF NOT EXISTS gateway_abuse_observation_time_idx
  ON gateway_abuse_observation(kind, window_start);

-- One threshold per signal (gateway-core GatewayAbuseThresholdSchema). No row:
-- the signal is shown, never acted on. suspend_at NULL: alert only.
CREATE TABLE IF NOT EXISTS gateway_abuse_threshold (
  signal text PRIMARY KEY NOT NULL,
  window_minutes integer NOT NULL,
  alert_at integer NOT NULL,
  suspend_at integer,
  updated_at integer NOT NULL,
  updated_by text NOT NULL,
  CHECK (signal IN ('spend', 'auth_failures', 'shared_key', 'velocity')),
  CHECK (window_minutes BETWEEN 1 AND 1440),
  CHECK (alert_at > 0 AND (suspend_at IS NULL OR suspend_at >= alert_at))
);

-- Suspensions of a tenant or a key (gateway_key.id, a clsh_ parent's
-- api_token.id, or gateway_token.id).
-- Token verification refuses a credential while any suspension of its tenant,
-- its token or its virtual key is active (lifted_at NULL): GATEWAY_SUSPENDED.
-- source: manual (an admin account) or auto (a threshold's suspend_at, with
-- the signal). Rows are history: lifting stamps lifted_*, nothing is deleted.
CREATE TABLE IF NOT EXISTS gateway_suspension (
  id text PRIMARY KEY NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  tenant_id text NOT NULL,
  source text NOT NULL,
  signal text,
  reason text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  created_at integer NOT NULL,
  lifted_at integer,
  lifted_by text,
  lift_reason text,
  CHECK (subject_kind IN ('tenant', 'key')),
  CHECK (source IN ('manual', 'auto')),
  CHECK (source = 'manual' OR signal IS NOT NULL)
);
-- At most one active suspension per subject.
CREATE UNIQUE INDEX IF NOT EXISTS gateway_suspension_active_idx
  ON gateway_suspension(subject_kind, subject_id) WHERE lifted_at IS NULL;
CREATE INDEX IF NOT EXISTS gateway_suspension_tenant_idx
  ON gateway_suspension(tenant_id, created_at);

-- Alerts raised by thresholds: one per signal, subject, threshold window
-- (window_start, unix seconds) and action, so repeated evaluation inside a
-- window never repeats an alert or re-suspends a subject an admin has just
-- lifted, while a subject alerted early in a window is still suspended once
-- it crosses suspend_at.
-- action = 'suspend' when the alert crossed suspend_at; suspension_id names
-- the suspension it created (NULL when the subject was already suspended).
CREATE TABLE IF NOT EXISTS gateway_abuse_alert (
  id text PRIMARY KEY NOT NULL,
  signal text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  tenant_id text NOT NULL DEFAULT '',
  value integer NOT NULL,
  threshold integer NOT NULL,
  window_minutes integer NOT NULL,
  window_start integer NOT NULL,
  action text NOT NULL,
  suspension_id text,
  created_at integer NOT NULL,
  CHECK (signal IN ('spend', 'auth_failures', 'shared_key', 'velocity')),
  CHECK (subject_kind IN ('tenant', 'key', 'client')),
  CHECK (action IN ('alert', 'suspend'))
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_abuse_alert_dedupe_idx
  ON gateway_abuse_alert(signal, subject_kind, subject_id, window_start, action);
CREATE INDEX IF NOT EXISTS gateway_abuse_alert_time_idx
  ON gateway_abuse_alert(created_at);

-- The support_agent admin account role: abuse triage and suspension by id,
-- with no credential, prompt or configuration permission
-- (services/gateway-authz.ts). It is an admin account role, not the team
-- role 0038 retired.
-- SQLite cannot alter a CHECK, so admin_accounts (0040) is rebuilt with the
-- same columns, rows and index; no other table references it (no foreign keys).
CREATE TABLE admin_accounts_0046 (
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
  CHECK (role IN ('platform_admin', 'support_agent'))
);
INSERT INTO admin_accounts_0046 (id, name, email, email_verified, image, role, disabled_at, created_at, updated_at)
SELECT id, name, email, email_verified, image, role, disabled_at, created_at, updated_at FROM admin_accounts;
DROP TABLE admin_accounts;
ALTER TABLE admin_accounts_0046 RENAME TO admin_accounts;
CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_email_unique ON admin_accounts(email);
