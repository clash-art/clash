-- Usage explorer, metadata retention and nightly reconciliation (#355).
-- Guide: apps/docs/guide/gateway-usage.md. Drizzle mirror:
-- packages/shared-cloud-schema/src/gateway.ts. No foreign keys (AGENTS.md).
--
-- Nothing here stores a prompt or response body: upstream reports are daily
-- totals (requests, tokens, media units) per upstream account and model, and
-- a reconciliation run keeps only its per-group counts and amounts.

-- The usage explorer and the retention job scan the ledger by time across
-- tenants (platform-wide reads, NULLing operational columns after 30 days,
-- deleting rows after 13 months).
CREATE INDEX IF NOT EXISTS gateway_usage_ledger_time_idx
  ON gateway_usage_ledger(occurred_at);

-- Reconciliation adjustments are found by ref_kind = 'reconcile' and their run.
CREATE INDEX IF NOT EXISTS gateway_usage_ledger_ref_idx
  ON gateway_usage_ledger(ref_kind, ref_id);

-- One imported upstream usage report: a UTC day from one source (an invoice
-- export or AI Gateway logs), normalized to daily totals per official
-- upstream account and public model code by the importer. A report with no
-- groups is a real report (the upstream billed nothing), so the header is its
-- own row. Re-importing a day and source replaces the report and its groups
-- in one batch, audited. Kept 13 months, like the ledger.
CREATE TABLE IF NOT EXISTS gateway_upstream_report (
  id text PRIMARY KEY NOT NULL,
  -- UTC day, YYYY-MM-DD.
  day text NOT NULL,
  -- invoice | ai_gateway
  source text NOT NULL,
  groups integer NOT NULL DEFAULT 0,
  imported_at integer NOT NULL,
  -- The admin account that imported it.
  imported_by text NOT NULL,
  CHECK (source IN ('invoice', 'ai_gateway')),
  CHECK (groups >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_upstream_report_day_source_idx
  ON gateway_upstream_report(day, source);

-- The groups of a report: counts only, never content.
CREATE TABLE IF NOT EXISTS gateway_upstream_usage (
  id text PRIMARY KEY NOT NULL,
  day text NOT NULL,
  source text NOT NULL,
  upstream_id text NOT NULL,
  account_id text NOT NULL,
  model_code text NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  -- JSON Partial<Record<GatewayMediaUnit, number>>.
  units_json text NOT NULL DEFAULT '{}',
  CHECK (source IN ('invoice', 'ai_gateway')),
  CHECK (requests >= 0 AND input_tokens >= 0 AND output_tokens >= 0
    AND cached_input_tokens >= 0 AND cache_write_tokens >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_upstream_usage_group_idx
  ON gateway_upstream_usage(day, source, upstream_id, account_id, model_code);

-- One row per reconciliation of one UTC day (nightly or on demand). Its
-- adjustments are ledger `adjust` entries with ref_kind = 'reconcile' and
-- ref_id = the run id, written in the same batch. `source_missing` records a
-- day without any upstream report, so a missing report never reads as matched.
CREATE TABLE IF NOT EXISTS gateway_reconciliation_run (
  id text PRIMARY KEY NOT NULL,
  day text NOT NULL,
  source text,
  -- matched | adjusted | incomplete | source_missing
  status text NOT NULL,
  error_code text,
  groups integer NOT NULL DEFAULT 0,
  -- Adjustments this run wrote, counted in its own batch.
  adjustments integer NOT NULL DEFAULT 0,
  -- Signed sum of this run's adjustments (positive: the upstream reported more).
  adjusted_micro_credits integer NOT NULL DEFAULT 0,
  -- Per group: ledger and upstream counts, the valued delta, what was posted.
  diffs_json text NOT NULL DEFAULT '[]',
  -- admin (an admin account id) | system (the nightly job)
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  started_at integer NOT NULL,
  CHECK (status IN ('matched', 'adjusted', 'incomplete', 'source_missing'))
);
CREATE INDEX IF NOT EXISTS gateway_reconciliation_run_day_idx
  ON gateway_reconciliation_run(day, started_at);
