-- Clash official model gateway — Postgres (Node self-host) schema (#362).
-- Guide starting shape: NODES §2.2; money model: N2 / settle-design (#399).
--
-- Deliberate deviations from NODES §2.2 (authoritative overrides):
--   * Credits, not micro-USD (product decision 2). Money columns are
--     bigint micro-credits (1 credit = 1_000_000).
--   * Budget scopes are tenant | user | key (D1 / gateway-core), not
--     user | team | key.
--   * Ledger kinds are N2: debit (media prepay) + refund (media failure),
--     charge (text postpay), plus adjust / grant / topup / expire. There is
--     no hold / settle / release product path on this table.
--   * Charge-once uniqueness is (request_id, budget_id, kind) — not
--     request_id alone (NODES) — so one request can carry debit+refund or
--     charge+adjust, and one write per budget line. budget_id '' when the
--     entry draws on no budget.
--   * No first-class long-lived gateway_budget_hold table. N2 admits media
--     with an exact debit and text with a balance check; follow-ups are
--     durable settle intents (#399), not a hold sweeper.
--   * gateway_settle_intent is thin, short-lived bookkeeping for durable
--     settle parity on Node; the ledger is authoritative. Rows are not a
--     metering primary path.
--   * Price book matches the credits shape (model_code, unit, amount_micro,
--     per), not per-token micro-USD columns from NODES.
--   * No SQLite DDL product path (decision 12).
--
-- Conventions (AGENTS.md + gateway guides):
--   * No foreign keys.
--   * bigint for money and token counts (pg returns bigint as string).
--   * Empty string, not NULL, for composite uniqueness dimensions.
--   * No prompt / completion / response body columns.
--   * Ledger retention 13 months (enforced by jobs, not by this DDL).

-- Budgets --------------------------------------------------------------------

-- scope tenant = team wallet; user = member budget; key = per-key cap.
-- limit_micro_credits NULL = explicitly unlimited. reserved_micro_credits is
-- kept at 0 under N2 (no long-lived holds); spent moves on debit/charge/refund.
CREATE TABLE gateway_budget (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('tenant', 'user', 'key')),
  scope_id text NOT NULL,
  parent_budget_id text,
  allocated_by_user_id text,
  period text NOT NULL DEFAULT 'none'
    CHECK (period IN ('none', 'daily', 'monthly', 'one_time')),
  period_start bigint,
  reset_at bigint,
  limit_micro_credits bigint,
  spent_micro_credits bigint NOT NULL DEFAULT 0,
  reserved_micro_credits bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  version bigint NOT NULL DEFAULT 0,
  enforcement text NOT NULL DEFAULT 'hard'
    CHECK (enforcement IN ('hard', 'soft', 'alert')),
  alert_threshold_pct integer,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK (limit_micro_credits IS NULL OR limit_micro_credits >= 0),
  CHECK (spent_micro_credits >= 0),
  CHECK (reserved_micro_credits >= 0),
  CHECK (
    alert_threshold_pct IS NULL
    OR (alert_threshold_pct >= 1 AND alert_threshold_pct <= 100)
  )
);
CREATE UNIQUE INDEX gateway_budget_scope_idx
  ON gateway_budget (tenant_id, scope, scope_id);

-- Requests -------------------------------------------------------------------

-- Lifecycle of one gateway request (ledger anchor). States are N2-oriented
-- (no reserved/released hold machine). team_id / key_id use '' not NULL.
CREATE TABLE gateway_request (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  team_id text NOT NULL DEFAULT '',
  key_id text NOT NULL DEFAULT '',
  idempotency_key text,
  route_key text,
  model_id text,
  model_kind text,
  state text NOT NULL
    CHECK (state IN ('admitted', 'streaming', 'completed', 'failed', 'expired')),
  debit_micro_credits bigint NOT NULL DEFAULT 0,
  charged_micro_credits bigint,
  attempt integer NOT NULL DEFAULT 1,
  lease_owner text,
  lease_until bigint,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX gateway_request_idem_idx
  ON gateway_request (tenant_id, user_id, key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX gateway_request_tenant_time_idx
  ON gateway_request (tenant_id, created_at);

-- Idempotency claim taken at admission (replaces hold-carried claims).
CREATE TABLE gateway_idempotency_claim (
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_id text NOT NULL,
  expires_at bigint NOT NULL,
  ended_at bigint,
  created_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE INDEX gateway_idempotency_claim_request_idx
  ON gateway_idempotency_claim (request_id);

-- Thin settle intent (durable settle parity for Node / #399). Non-authoritative
-- short-lived bookkeeping: the ledger is the money truth. A crash before this
-- row exists may lose a follow-up (accepted N2 edge wear). After apply, rows
-- may be pruned; they are not a hold/sweeper path.
CREATE TABLE gateway_settle_intent (
  request_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('charge', 'refund')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'abandoned')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (request_id, kind)
);
CREATE INDEX gateway_settle_intent_status_idx
  ON gateway_settle_intent (status, updated_at);

-- Ledger ---------------------------------------------------------------------

-- Append-only money journal. Kinds (N2):
--   debit   media/AIGC exact prepay at admission
--   charge  text/LLM actual cost after success (postpay)
--   refund  full return of a failed media debit
--   adjust  admin / reconciliation correction
--   grant   subscription-period credits
--   topup   purchased credits
--   expire  unused grant removal
-- Charge-once: UNIQUE (request_id, budget_id, kind). budget_id '' when none.
CREATE TABLE gateway_usage_ledger (
  id text PRIMARY KEY,
  request_id text NOT NULL,
  budget_id text NOT NULL DEFAULT '',
  kind text NOT NULL
    CHECK (kind IN ('debit', 'charge', 'refund', 'adjust', 'grant', 'topup', 'expire')),
  status text NOT NULL,
  tenant_id text NOT NULL,
  user_id text,
  key_id text,
  amount_micro_credits bigint NOT NULL,
  model_code text,
  model_kind text,
  credential_scope text,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  units_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage_source text,
  price_version text,
  catalog_version text,
  ref_kind text,
  ref_id text,
  actor_user_id text,
  reason text,
  upstream_id text,
  account_id text,
  provider_request_id text,
  error_code text,
  billing_basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at bigint NOT NULL,
  created_at bigint NOT NULL,
  CHECK (amount_micro_credits >= 0)
);
CREATE UNIQUE INDEX gateway_usage_ledger_entry_idx
  ON gateway_usage_ledger (request_id, budget_id, kind);
CREATE INDEX gateway_usage_ledger_tenant_time_idx
  ON gateway_usage_ledger (tenant_id, occurred_at);
CREATE INDEX gateway_usage_ledger_key_time_idx
  ON gateway_usage_ledger (key_id, occurred_at);
CREATE INDEX gateway_usage_ledger_budget_status_idx
  ON gateway_usage_ledger (budget_id, status);

-- Catalog + price book -------------------------------------------------------

CREATE TABLE gateway_model (
  id text PRIMARY KEY,
  catalog_version text NOT NULL,
  model_code text NOT NULL,
  kind text NOT NULL,
  display_name text,
  enabled integer NOT NULL DEFAULT 1,
  card_json jsonb NOT NULL,
  max_output_tokens integer,
  rate_limit_json jsonb,
  published_at bigint,
  created_at bigint NOT NULL
);
CREATE UNIQUE INDEX gateway_model_version_code_idx
  ON gateway_model (catalog_version, model_code);

-- Credits price book (decision 2). published_at NULL = draft, never charged.
CREATE TABLE gateway_price (
  id text PRIMARY KEY,
  price_version text NOT NULL,
  model_code text NOT NULL,
  upstream_id text NOT NULL DEFAULT '',
  unit text NOT NULL,
  amount_micro bigint NOT NULL,
  per integer NOT NULL,
  currency text NOT NULL DEFAULT 'credit',
  effective_from bigint NOT NULL,
  effective_to bigint,
  source text NOT NULL DEFAULT 'manual',
  created_by_user_id text,
  published_at bigint,
  created_at bigint NOT NULL,
  CHECK (amount_micro >= 0),
  CHECK (per > 0)
);
CREATE UNIQUE INDEX gateway_price_rate_idx
  ON gateway_price (price_version, model_code, upstream_id, unit);
CREATE INDEX gateway_price_model_effective_idx
  ON gateway_price (model_code, effective_from);

-- Limits ---------------------------------------------------------------------

-- Fixed-window counters; subject is always tenant-prefixed
-- (tenant:<t>, tenant:<t>:user:<u>, tenant:<t>:key:<k>, …).
CREATE TABLE gateway_rate_window (
  subject text NOT NULL,
  window_start bigint NOT NULL,
  requests bigint NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, window_start)
);

-- In-flight concurrency leases; expire on their own if never released.
CREATE TABLE gateway_inflight (
  lease_id text NOT NULL,
  subject text NOT NULL,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (lease_id, subject)
);
CREATE INDEX gateway_inflight_subject_idx
  ON gateway_inflight (subject, expires_at);

-- Config + credentials -------------------------------------------------------

CREATE TABLE gateway_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  version bigint NOT NULL,
  updated_at bigint NOT NULL
);

-- Official / tenant upstream credentials. Separate from provider_account
-- (BYOK). tenant_key '' = official/global. Empty strings for uniqueness dims.
CREATE TABLE gateway_upstream_credential (
  id text PRIMARY KEY,
  tenant_key text NOT NULL DEFAULT '',
  scope text NOT NULL CHECK (scope IN ('official', 'tenant')),
  provider_id text NOT NULL,
  upstream_id text NOT NULL DEFAULT '',
  account_id text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  label text,
  encrypted_credentials text NOT NULL,
  key_version text NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  priority integer,
  weight integer,
  max_rps integer,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (tenant_key, scope, provider_id, upstream_id, account_id, region)
);
CREATE INDEX gateway_upstream_credential_provider_idx
  ON gateway_upstream_credential (provider_id, upstream_id, region);
