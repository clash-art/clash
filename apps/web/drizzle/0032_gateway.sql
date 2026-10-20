-- Clash official model gateway: tenancy extensions, virtual keys, catalog,
-- price book, official upstream credentials, budgets, usage ledger, admin
-- audit, subscription packages and top-up packs. Guide:
-- apps/docs/guide/gateway-schema.md. Drizzle mirror:
-- packages/shared-cloud-schema/src/gateway.ts (tenant_invite in app.ts).
--
-- Conventions
--   * No foreign keys. Referential integrity is enforced by the gateway store
--     and the admin API, as for provider_account.
--   * Text ids. Timestamps are unix seconds.
--   * Money is INTEGER micro-credits (1 credit = 1,000,000). SQLite INTEGER is
--     64-bit; the TypeScript boundary keeps values Number.isSafeInteger. Prices
--     are the charged amount: there are no markup or percentage columns.
--   * Optional dimensions that take part in uniqueness use '' rather than NULL
--     (SQLite treats NULLs as distinct in a unique index).
--   * No prompt, completion, message or response body columns anywhere.
--     Only ids, counts, codes, prices and redacted admin snapshots are stored.
--
-- Retention (enforced by the gateway retention job, not by SQLite)
--   * Usage metadata: 30 days. Operational columns on gateway_usage_ledger
--     (provider_request_id, account_id, upstream_id, error_code) are NULLed 30
--     days after occurred_at; expired/revoked gateway_token rows and terminal
--     tenant_invite rows are deleted 30 days after they end.
--   * Ledger: 13 months. gateway_usage_ledger rows (money, kind, status, model,
--     price/catalog version and token counts as billing basis) and
--     gateway_admin_audit rows are deleted 13 months after occurred_at.
--   * Prompt/response bodies: never stored.

-- Tenancy -------------------------------------------------------------------

-- 'personal' tenants are the existing lazily created personal:<userId> rows;
-- 'team' tenants own a shared wallet. tenant_member.role values used by the
-- gateway: owner, admin, finance, support, viewer, member.
ALTER TABLE tenant ADD COLUMN kind text NOT NULL DEFAULT 'personal';

CREATE TABLE IF NOT EXISTS tenant_invite (
  id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  email text NOT NULL,
  role text NOT NULL,
  -- SHA-256 of the invite secret; the secret itself is only in the invite link.
  token_hash text NOT NULL,
  invited_by_user_id text NOT NULL,
  -- pending | accepted | revoked | expired
  status text NOT NULL DEFAULT 'pending',
  accepted_by_user_id text,
  accepted_at integer,
  expires_at integer NOT NULL,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_invite_token_hash_idx
  ON tenant_invite(token_hash);
CREATE INDEX IF NOT EXISTS tenant_invite_tenant_status_idx
  ON tenant_invite(tenant_id, status);

-- Credentials ---------------------------------------------------------------

-- Virtual keys (sk_gw_…). Only the SHA-256 hash and a display prefix are stored.
CREATE TABLE IF NOT EXISTS gateway_key (
  id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  token_prefix text NOT NULL,
  token_hash text NOT NULL,
  -- JSON string[] of granted scopes.
  scopes_json text NOT NULL DEFAULT '[]',
  -- JSON string[] of model codes; NULL means the whole published catalog.
  model_allowlist_json text,
  -- official (platform-held upstream keys) | tenant (tenant BYOK). Never mixed.
  credential_scope text NOT NULL DEFAULT 'official',
  -- Key-scoped budget drawn on in addition to the user and tenant budgets.
  budget_id text,
  -- Configurable rate limits, e.g. {"requestsPerMinute":60,"tokensPerMinute":200000,"concurrency":4}.
  rate_limit_json text,
  expires_at integer,
  revoked_at integer,
  last_used_at integer,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  CHECK (credential_scope IN ('official', 'tenant'))
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_key_token_hash_idx
  ON gateway_key(token_hash);
CREATE INDEX IF NOT EXISTS gateway_key_tenant_user_idx
  ON gateway_key(tenant_id, user_id);

-- Short-lived gateway tokens minted from a session, clsh_ token or virtual key.
CREATE TABLE IF NOT EXISTS gateway_token (
  id text PRIMARY KEY NOT NULL,
  token_hash text NOT NULL,
  -- Parent virtual key, when minted from one.
  key_id text,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  scopes_json text NOT NULL DEFAULT '[]',
  model_allowlist_json text,
  credential_scope text NOT NULL DEFAULT 'official',
  expires_at integer NOT NULL,
  revoked_at integer,
  last_used_at integer,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  CHECK (credential_scope IN ('official', 'tenant'))
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_token_token_hash_idx
  ON gateway_token(token_hash);
CREATE INDEX IF NOT EXISTS gateway_token_tenant_user_idx
  ON gateway_token(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS gateway_token_expires_at_idx
  ON gateway_token(expires_at);

-- Official upstream credentials. Server-owned: there is no tenant_id/user_id,
-- so tenant BYOK rows (provider_account) can never be selected from here.
-- Secrets are a reference to a Worker secret / Secrets Store binding
-- (secret_ref) or a sealed envelope (encrypted_credentials, under a gateway
-- key-encryption key distinct from ACTION_SECRET_KEY). Never plaintext.
CREATE TABLE IF NOT EXISTS gateway_upstream_account (
  id text PRIMARY KEY NOT NULL,
  provider_id text NOT NULL,
  upstream_id text NOT NULL DEFAULT '',
  api_shape text,
  region text NOT NULL DEFAULT '',
  label text,
  enabled integer NOT NULL DEFAULT 1,
  priority integer,
  weight integer,
  -- JSON string[] / Record<modelCode, priority>, as on provider_account.
  supported_model_ids_json text,
  model_priorities_json text,
  secret_ref text,
  encrypted_credentials text,
  -- Non-secret credential key names, for catalog availability checks.
  configured_credentials text,
  key_version text NOT NULL DEFAULT 'v1',
  -- Upstream-side caps, e.g. {"requestsPerMinute":500}.
  rate_limit_json text,
  rotated_at integer,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  CHECK (secret_ref IS NOT NULL OR encrypted_credentials IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS gateway_upstream_account_provider_idx
  ON gateway_upstream_account(provider_id, upstream_id, region);

-- Catalog and price book ----------------------------------------------------

-- Versioned published catalog: one row per model per catalog version. card_json
-- is the non-secret model card (including providerImplementations) the route
-- resolver reads; a published version is never edited in place.
CREATE TABLE IF NOT EXISTS gateway_model (
  id text PRIMARY KEY NOT NULL,
  catalog_version text NOT NULL,
  model_code text NOT NULL,
  -- ModelUpstreamRoute kind: text | image | video | audio | …
  kind text NOT NULL,
  display_name text,
  enabled integer NOT NULL DEFAULT 1,
  card_json text NOT NULL,
  -- Output-token ceiling used for holds when a request omits max_tokens.
  max_output_tokens integer,
  -- Default per-model rate limits; a key or subscription may tighten them.
  rate_limit_json text,
  published_at integer,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_model_version_code_idx
  ON gateway_model(catalog_version, model_code);

-- One rate per (price_version, model, upstream, unit). amount_micro is the
-- price of `per` units in micro-units of `currency` (credits by default).
CREATE TABLE IF NOT EXISTS gateway_price (
  id text PRIMARY KEY NOT NULL,
  price_version text NOT NULL,
  model_code text NOT NULL,
  -- '' applies to every upstream of the model.
  upstream_id text NOT NULL DEFAULT '',
  -- input_token | output_token | cached_input_token | cache_write_token |
  -- image | video_second | audio_second | character | request
  unit text NOT NULL,
  amount_micro integer NOT NULL,
  per integer NOT NULL,
  currency text NOT NULL DEFAULT 'credit',
  effective_from integer NOT NULL,
  effective_to integer,
  -- manual | upstream-list | import
  source text NOT NULL DEFAULT 'manual',
  created_by_user_id text,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  CHECK (amount_micro >= 0),
  CHECK (per > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_price_rate_idx
  ON gateway_price(price_version, model_code, upstream_id, unit);
CREATE INDEX IF NOT EXISTS gateway_price_model_effective_idx
  ON gateway_price(model_code, effective_from);

-- Budgets and ledger --------------------------------------------------------

-- scope 'tenant' is the team wallet; 'user' is a member budget the owner
-- allocates from it (parent_budget_id); 'key' caps one virtual key. A request
-- holds the full amount on every budget it draws on. limit_micro_credits NULL
-- is an explicitly unlimited budget; a missing row is never unlimited.
CREATE TABLE IF NOT EXISTS gateway_budget (
  id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  scope text NOT NULL,
  scope_id text NOT NULL,
  parent_budget_id text,
  allocated_by_user_id text,
  -- none | daily | monthly
  period text NOT NULL DEFAULT 'none',
  period_start integer,
  reset_at integer,
  limit_micro_credits integer,
  spent_micro_credits integer NOT NULL DEFAULT 0,
  reserved_micro_credits integer NOT NULL DEFAULT 0,
  -- active | suspended
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  CHECK (scope IN ('tenant', 'user', 'key')),
  CHECK (limit_micro_credits IS NULL OR limit_micro_credits >= 0),
  CHECK (spent_micro_credits >= 0),
  CHECK (reserved_micro_credits >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_budget_scope_idx
  ON gateway_budget(tenant_id, scope, scope_id);

-- Append-only money journal, one entry per (request_id, budget_id, kind).
--   hold     reserve on a budget; status open → settled | released | expired
--            is the only in-place change, made in the same batch that appends
--            the closing entry.
--   settle   actual cost of an ended request; status is the request outcome
--            (settled | partial | client_aborted | upstream_failed |
--            gateway_failed | expired) and the row carries the billing basis.
--   release  hold returned unused (zero cost).
--   refund   credit back after a settle; ref_id names the refunded entry.
--   adjust   reconciliation or admin correction; actor_user_id and reason set.
--   grant    subscription-period credits added to a wallet.
--   topup    purchased top-up pack credits added to a wallet.
--   expire   unused granted credits removed at period end.
-- request_id is the idempotency anchor: the gateway request id for usage, the
-- order/period id for grant/topup/expire. budget_id '' means no budget.
-- amount_micro_credits is non-negative; its direction follows from kind.
CREATE TABLE IF NOT EXISTS gateway_usage_ledger (
  id text PRIMARY KEY NOT NULL,
  request_id text NOT NULL,
  budget_id text NOT NULL DEFAULT '',
  kind text NOT NULL,
  status text NOT NULL,
  tenant_id text NOT NULL,
  user_id text,
  key_id text,
  amount_micro_credits integer NOT NULL,
  -- Billing basis (13-month retention).
  model_code text,
  model_kind text,
  credential_scope text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  -- JSON Partial<Record<GatewayMediaUnit, number>>.
  units_json text NOT NULL DEFAULT '{}',
  -- reported | estimated
  usage_source text,
  price_version text,
  catalog_version text,
  ref_kind text,
  ref_id text,
  actor_user_id text,
  -- Short operator note for adjust/refund; never request content.
  reason text,
  -- Operational metadata (30-day retention, then NULLed).
  upstream_id text,
  account_id text,
  provider_request_id text,
  error_code text,
  -- Hold expiry for the sweeper.
  expires_at integer,
  occurred_at integer NOT NULL,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  CHECK (kind IN ('hold', 'settle', 'release', 'refund', 'adjust', 'grant', 'topup', 'expire')),
  CHECK (amount_micro_credits >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_usage_ledger_entry_idx
  ON gateway_usage_ledger(request_id, budget_id, kind);
CREATE INDEX IF NOT EXISTS gateway_usage_ledger_tenant_time_idx
  ON gateway_usage_ledger(tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS gateway_usage_ledger_key_time_idx
  ON gateway_usage_ledger(key_id, occurred_at);
CREATE INDEX IF NOT EXISTS gateway_usage_ledger_budget_status_idx
  ON gateway_usage_ledger(budget_id, status);

-- Admin audit ---------------------------------------------------------------

-- One append-only row per admin mutation. before/after are redacted snapshots:
-- never key material, token hashes or request content.
CREATE TABLE IF NOT EXISTS gateway_admin_audit (
  id text PRIMARY KEY NOT NULL,
  -- '' for platform-wide changes (catalog, price book, upstream accounts).
  tenant_id text NOT NULL DEFAULT '',
  actor_user_id text NOT NULL,
  actor_role text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  before_json text,
  after_json text,
  reason text,
  request_id text,
  occurred_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_admin_audit_tenant_time_idx
  ON gateway_admin_audit(tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS gateway_admin_audit_target_idx
  ON gateway_admin_audit(target_type, target_id);

-- Billing: subscription packages and top-up packs --------------------------

-- Fiat prices are integer minor units of price_currency (e.g. cents, fen);
-- credits are micro-credits. A package grants credits_micro per period.
CREATE TABLE IF NOT EXISTS gateway_package (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  -- active | archived
  status text NOT NULL DEFAULT 'active',
  -- month | year
  billing_period text NOT NULL DEFAULT 'month',
  price_minor integer NOT NULL,
  price_currency text NOT NULL,
  credits_micro integer NOT NULL,
  model_allowlist_json text,
  rate_limit_json text,
  features_json text NOT NULL DEFAULT '{}',
  external_price_id text,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  CHECK (price_minor >= 0),
  CHECK (credits_micro >= 0)
);

CREATE TABLE IF NOT EXISTS gateway_topup_pack (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  price_minor integer NOT NULL,
  price_currency text NOT NULL,
  credits_micro integer NOT NULL,
  -- Days until purchased credits expire; NULL never expires.
  validity_days integer,
  external_price_id text,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  CHECK (price_minor >= 0),
  CHECK (credits_micro >= 0)
);

-- A tenant's subscription to a package. Top-up purchases are ledger 'topup'
-- entries (ref_kind 'topup_pack'), not rows here.
CREATE TABLE IF NOT EXISTS gateway_tenant_subscription (
  id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  package_id text NOT NULL,
  -- trialing | active | past_due | canceled | expired
  status text NOT NULL,
  current_period_start integer NOT NULL,
  current_period_end integer NOT NULL,
  cancel_at integer,
  canceled_at integer,
  external_subscription_id text,
  -- Tenant-specific override of the package rate limits.
  rate_limit_json text,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX IF NOT EXISTS gateway_tenant_subscription_tenant_status_idx
  ON gateway_tenant_subscription(tenant_id, status);
