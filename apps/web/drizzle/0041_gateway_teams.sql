-- Team settings: owner budget allocation with enforcement modes, configurable
-- member and tenant rate limits, and budget notifications (#354). Guide:
-- apps/docs/guide/gateway-teams.md. Drizzle mirror:
-- packages/shared-cloud-schema/src/gateway.ts (budgets, events) and
-- packages/shared-cloud-schema/src/app.ts (tenant, tenant_member). No foreign
-- keys (AGENTS.md).

-- What a budget's limit does when a hold does not fit under it:
--   hard   refuse (GATEWAY_BUDGET_EXCEEDED, 402); every budget before 0041
--   soft   admit past the limit, flag the request (soft_exceeded event)
--   alert  admit, and notify once when the alert threshold is crossed
-- alert_threshold_pct (1-100) raises an alert at that share of the limit on
-- any enforcement; an `alert` budget without one alerts at 100%. A tenant
-- wallet stays hard: its limit is the purchased credits.
ALTER TABLE gateway_budget ADD COLUMN enforcement text NOT NULL DEFAULT 'hard';
ALTER TABLE gateway_budget ADD COLUMN alert_threshold_pct integer;

-- SQLite cannot add a CHECK to an existing table; triggers refuse what a
-- CHECK would.
CREATE TRIGGER IF NOT EXISTS gateway_budget_enforcement_insert_check
BEFORE INSERT ON gateway_budget
WHEN NEW.enforcement NOT IN ('hard', 'soft', 'alert')
  OR (NEW.scope = 'tenant' AND NEW.enforcement <> 'hard')
  OR (NEW.alert_threshold_pct IS NOT NULL AND (NEW.alert_threshold_pct < 1 OR NEW.alert_threshold_pct > 100))
BEGIN
  SELECT RAISE(ABORT, 'gateway_budget.enforcement must be hard, soft or alert (hard for a tenant wallet); alert_threshold_pct 1-100');
END;

CREATE TRIGGER IF NOT EXISTS gateway_budget_enforcement_update_check
BEFORE UPDATE OF enforcement, alert_threshold_pct ON gateway_budget
WHEN NEW.enforcement NOT IN ('hard', 'soft', 'alert')
  OR (NEW.scope = 'tenant' AND NEW.enforcement <> 'hard')
  OR (NEW.alert_threshold_pct IS NOT NULL AND (NEW.alert_threshold_pct < 1 OR NEW.alert_threshold_pct > 100))
BEGIN
  SELECT RAISE(ABORT, 'gateway_budget.enforcement must be hard, soft or alert (hard for a tenant wallet); alert_threshold_pct 1-100');
END;

-- Budget notifications, written in the reservation's own batch:
--   soft_exceeded    a request admitted past a soft limit (dedupe_key = request id)
--   alert_threshold  the alert threshold crossed (dedupe_key = 'limit=<n>;pct=<p>',
--                    so one alert per limit and threshold; a new limit may alert again)
-- Counters are the budget's after the hold. Metadata only, never content.
CREATE TABLE IF NOT EXISTS gateway_budget_event (
  id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL,
  budget_id text NOT NULL,
  scope text NOT NULL,
  scope_id text NOT NULL,
  kind text NOT NULL,
  enforcement text NOT NULL,
  dedupe_key text NOT NULL,
  request_id text,
  limit_micro_credits integer NOT NULL,
  spent_micro_credits integer NOT NULL,
  reserved_micro_credits integer NOT NULL,
  threshold_pct integer,
  occurred_at integer NOT NULL,
  CHECK (kind IN ('soft_exceeded', 'alert_threshold'))
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_budget_event_dedupe_idx
  ON gateway_budget_event(budget_id, kind, dedupe_key);
CREATE INDEX IF NOT EXISTS gateway_budget_event_tenant_time_idx
  ON gateway_budget_event(tenant_id, occurred_at);

-- Owner-configured rate limits (GatewayRateLimitSchema JSON):
--   tenant.rate_limit_json         tenant-wide, counted with the subscription's
--                                  limit in one tenant counter (tightest wins)
--   tenant_member.rate_limit_json  per member, counted per tenant and member
ALTER TABLE tenant ADD COLUMN rate_limit_json text;
ALTER TABLE tenant_member ADD COLUMN rate_limit_json text;

-- Pending invites by email, for the duplicate check.
CREATE INDEX IF NOT EXISTS tenant_invite_tenant_email_idx
  ON tenant_invite(tenant_id, email, status);
