-- Gateway credit billing on Postgres (#425): subscription packages, top-up
-- packs and tenant subscriptions, mirroring D1 (apps/web/drizzle 0032 +
-- 0050) so gateway-core's GatewayBillingPort has the same semantics on both
-- hosts. The price book (gateway_price) and the credit ledger kinds (grant,
-- topup, expire, adjust) already exist since 0016; the ledger's charge-once
-- uniqueness (request_id, budget_id, kind) is unchanged.
--
-- Conventions as 0016: no foreign keys, unix seconds, bigint micro-credits,
-- fiat prices in integer minor units of price_currency.

-- Fiat prices are integer minor units; a package grants credits_micro per period.
CREATE TABLE gateway_package (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  billing_period text NOT NULL DEFAULT 'month' CHECK (billing_period IN ('month', 'year')),
  price_minor bigint NOT NULL,
  price_currency text NOT NULL,
  credits_micro bigint NOT NULL,
  model_allowlist_json jsonb,
  rate_limit_json jsonb,
  features_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The payment provider's price id (#419): configuration, never in code.
  external_price_id text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK (price_minor >= 0),
  CHECK (credits_micro >= 0)
);

-- Top-up credits do not expire (validity_days stays NULL, as on D1).
CREATE TABLE gateway_topup_pack (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  price_minor bigint NOT NULL,
  price_currency text NOT NULL,
  credits_micro bigint NOT NULL,
  validity_days integer,
  external_price_id text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK (price_minor >= 0),
  CHECK (credits_micro >= 0)
);

-- One provider price id names at most one package / pack. NULLs are distinct
-- in a Postgres unique index, so unset ids (self-host) never collide — the
-- same as the D1 indexes of 0050.
CREATE UNIQUE INDEX gateway_package_external_price_idx
  ON gateway_package (external_price_id);
CREATE UNIQUE INDEX gateway_topup_pack_external_price_idx
  ON gateway_topup_pack (external_price_id);

-- A tenant's subscription to a package. created_at is the period anchor.
-- Top-up purchases are ledger 'topup' entries (ref_kind 'topup_pack').
CREATE TABLE gateway_tenant_subscription (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  package_id text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')),
  current_period_start bigint NOT NULL,
  current_period_end bigint NOT NULL,
  cancel_at bigint,
  canceled_at bigint,
  external_subscription_id text,
  -- Tenant override of the package rate limits.
  rate_limit_json jsonb,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX gateway_tenant_subscription_tenant_status_idx
  ON gateway_tenant_subscription (tenant_id, status);
-- One live subscription per tenant. D1 serializes its batch and checks this
-- with NOT EXISTS; concurrent Postgres transactions need the index.
CREATE UNIQUE INDEX gateway_tenant_subscription_live_idx
  ON gateway_tenant_subscription (tenant_id)
  WHERE status IN ('trialing', 'active');
CREATE INDEX gateway_tenant_subscription_due_idx
  ON gateway_tenant_subscription (current_period_end)
  WHERE status IN ('trialing', 'active');

-- Billing writes are audited like D1: a payment provider's webhook is an
-- actor (kind 'payment', id payment:<provider>), and corrections carry the
-- operator's reason.
ALTER TABLE gateway_admin_audit DROP CONSTRAINT gateway_admin_audit_actor_kind_check;
ALTER TABLE gateway_admin_audit ADD CONSTRAINT gateway_admin_audit_actor_kind_check
  CHECK (actor_kind IN ('admin', 'user', 'bootstrap', 'migration', 'payment'));
ALTER TABLE gateway_admin_audit ADD COLUMN reason text;
CREATE INDEX gateway_admin_audit_tenant_time_idx
  ON gateway_admin_audit (tenant_id, created_at);
