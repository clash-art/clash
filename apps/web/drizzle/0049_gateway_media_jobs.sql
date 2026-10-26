-- Official media/AIGC jobs through the gateway ledger (#359). Guide:
-- apps/docs/guide/gateway-data-plane.md#media-and-aigc. Drizzle mirror:
-- packages/shared-cloud-schema/src/gateway.ts. No foreign keys (AGENTS.md).
--
-- One row per hosted generation run served by Clash official upstream
-- accounts. It is the server-side record that the run is official (so only
-- the run that planned it resolves official credentials) and the durable
-- anchor of its ledger request: `request_id` is the gateway request id of
-- the job's hold and settle rows in gateway_usage_ledger. `job_json` is the
-- gateway-core GatewayMediaJob (identity, frozen route, measured quantities,
-- price instant); never a prompt, output or credential.
--
-- status: planned (route frozen, nothing held) -> admitted (held, limits
-- lease `lease_id`) -> settled (ledger settle row written: the delivered
-- units on success, zero on any failure); or planned -> refused (never
-- admitted: admission refused, or the run ended first; nothing held,
-- `error_code`).
CREATE TABLE IF NOT EXISTS gateway_media_job (
  request_id text PRIMARY KEY NOT NULL,
  task_id text NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  model_code text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'admitted', 'settled', 'refused')),
  job_json text NOT NULL,
  lease_id text,
  error_code text,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS gateway_media_job_task_idx
  ON gateway_media_job(task_id);
CREATE INDEX IF NOT EXISTS gateway_media_job_tenant_time_idx
  ON gateway_media_job(tenant_id, created_at);
