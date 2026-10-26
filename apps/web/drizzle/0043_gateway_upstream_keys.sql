-- Official upstream key vault: dual-key rotation and circuit-breaker health
-- (#350). Guide: apps/docs/guide/gateway-admin.md#upstream-key-rotation.
-- Drizzle mirror: packages/shared-cloud-schema/src/gateway.ts. No foreign keys
-- (AGENTS.md).

-- An account holds at most two usable key versions. The active one
-- (secret_ref / encrypted_credentials / key_version, as before) is sent first;
-- the draining one is the previous version, kept while a rotation drains so a
-- refused new key falls back to it before the first byte. Adding a version
-- moves the active one here; revoking clears it. key_serial is the highest
-- version number ever issued, so a revoked number is never reused. key_prefix
-- is the few leading characters an admin may see; never the key.
ALTER TABLE gateway_upstream_account ADD COLUMN key_prefix text;
ALTER TABLE gateway_upstream_account ADD COLUMN key_serial integer NOT NULL DEFAULT 1;
ALTER TABLE gateway_upstream_account ADD COLUMN draining_key_version text;
ALTER TABLE gateway_upstream_account ADD COLUMN draining_secret_ref text;
ALTER TABLE gateway_upstream_account ADD COLUMN draining_encrypted_credentials text;
ALTER TABLE gateway_upstream_account ADD COLUMN draining_configured_credentials text;
ALTER TABLE gateway_upstream_account ADD COLUMN draining_key_prefix text;
ALTER TABLE gateway_upstream_account ADD COLUMN draining_since integer;

-- Accounts rotated in place before 0043 carry their number in key_version.
UPDATE gateway_upstream_account
   SET key_serial = CAST(substr(key_version, 2) AS INTEGER)
 WHERE key_version GLOB 'v[0-9]*' AND CAST(substr(key_version, 2) AS INTEGER) > key_serial;

-- SQLite cannot add a CHECK to an existing table; triggers refuse what a
-- CHECK would: a draining version has a secret, and is not the active one.
CREATE TRIGGER IF NOT EXISTS gateway_upstream_account_draining_insert_check
BEFORE INSERT ON gateway_upstream_account
WHEN (NEW.draining_key_version IS NULL) <> (NEW.draining_secret_ref IS NULL AND NEW.draining_encrypted_credentials IS NULL)
  OR NEW.draining_key_version = NEW.key_version
BEGIN
  SELECT RAISE(ABORT, 'gateway_upstream_account: a draining key version needs a secret and must differ from the active one');
END;

CREATE TRIGGER IF NOT EXISTS gateway_upstream_account_draining_update_check
BEFORE UPDATE ON gateway_upstream_account
WHEN (NEW.draining_key_version IS NULL) <> (NEW.draining_secret_ref IS NULL AND NEW.draining_encrypted_credentials IS NULL)
  OR NEW.draining_key_version = NEW.key_version
BEGIN
  SELECT RAISE(ABORT, 'gateway_upstream_account: a draining key version needs a secret and must differ from the active one');
END;

-- Circuit-breaker counters per official upstream account (gateway-core
-- circuit.ts decides; this row stores). Times are epoch milliseconds (the
-- _ms columns), because a cooldown is seconds long. Advisory: the data plane
-- routes as if every circuit were closed when this table cannot be read.
-- Operational state only: no request, tenant or key material.
CREATE TABLE IF NOT EXISTS gateway_upstream_health (
  account_id text PRIMARY KEY NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0,
  open_until_ms integer,
  last_failure_code text,
  last_failure_at_ms integer,
  last_success_at_ms integer,
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  CHECK (consecutive_failures >= 0)
);
