-- Rate windows and in-flight leases for the gateway limits port (#347).
-- Guide: apps/docs/guide/gateway-schema.md. Drizzle mirror:
-- packages/shared-cloud-schema/src/gateway.ts. No foreign keys (AGENTS.md).
--
-- Limits are configured as rate_limit_json on gateway_key, gateway_model and
-- gateway_tenant_subscription; these tables only count. `subject` is a
-- non-secret counter key such as 'key:<gateway_key.id>',
-- 'model:<model_code>:user:<user_id>' or 'tenant:<tenant_id>'. Timestamps are
-- unix seconds. Old windows of a subject are deleted when it is next counted;
-- an in-flight lease expires on its own if the request never releases it.

CREATE TABLE IF NOT EXISTS gateway_rate_window (
  subject text NOT NULL,
  window_start integer NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  tokens integer NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, window_start)
);

CREATE TABLE IF NOT EXISTS gateway_inflight (
  lease_id text NOT NULL,
  subject text NOT NULL,
  expires_at integer NOT NULL,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (lease_id, subject)
);
CREATE INDEX IF NOT EXISTS gateway_inflight_subject_idx
  ON gateway_inflight(subject, expires_at);
