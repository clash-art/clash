-- Request/response body retention metadata (#353; product decision
-- 2026-10-20). Guide: apps/docs/guide/gateway-admin.md. Drizzle mirror:
-- packages/shared-cloud-schema/src/gateway.ts. No foreign keys (AGENTS.md).
--
-- One row per retained gateway request. The bodies themselves are R2 objects
-- (`request_key`, `response_key`, under `gateway-retention/`); this table
-- holds only where they are, their sizes and SHA-256, never content.
--
-- status: 'stored' (both bodies in R2), 'failed' (storage failed with
-- `error_code`; nothing to show), 'purged' (past expires_at, bodies deleted).
-- expires_at = stored_at + 30 days. A row past expires_at is unreadable even
-- before the purge job (apps/api-cf/src/gateway/d1-retention.ts) runs.

CREATE TABLE IF NOT EXISTS gateway_request_retention (
  request_id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  key_id text,
  status text NOT NULL,
  error_code text,
  request_key text NOT NULL,
  request_bytes integer NOT NULL,
  request_sha256 text NOT NULL,
  request_type text NOT NULL,
  response_key text NOT NULL,
  response_bytes integer NOT NULL,
  response_sha256 text NOT NULL,
  response_type text NOT NULL,
  response_status integer NOT NULL,
  stored_at integer NOT NULL,
  expires_at integer NOT NULL,
  purged_at integer,
  CHECK (status IN ('stored', 'failed', 'purged'))
);

-- Purge scans unpurged rows by expiry.
CREATE INDEX IF NOT EXISTS gateway_request_retention_expiry_idx
  ON gateway_request_retention(status, expires_at);

CREATE INDEX IF NOT EXISTS gateway_request_retention_tenant_time_idx
  ON gateway_request_retention(tenant_id, stored_at);
