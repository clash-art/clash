-- Streaming data plane (#348). Guide: apps/docs/guide/gateway-data-plane.md.
-- Drizzle mirror: packages/shared-cloud-schema/src/gateway.ts. No foreign keys
-- (AGENTS.md).
--
-- A streamed answer is retained beside the stream, up to a cap. A copy cut at
-- the cap is still `stored`, with response_truncated = 1; the stored object
-- ends in the GATEWAY_RETENTION_TRUNCATED marker, and response_observed_bytes
-- is how many bytes the caller actually received (response_bytes is what was
-- stored).
ALTER TABLE gateway_request_retention ADD COLUMN response_truncated integer NOT NULL DEFAULT 0;
ALTER TABLE gateway_request_retention ADD COLUMN response_observed_bytes integer;

-- The stale-hold sweeper (apps/api-cf/src/gateway/d1-budgets.ts) scans open
-- holds by expiry.
CREATE INDEX IF NOT EXISTS gateway_usage_ledger_hold_expiry_idx
  ON gateway_usage_ledger(kind, status, expires_at);
