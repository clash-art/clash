-- Gateway settlement (#399): media/AIGC prepay + refund, text/LLM postpay
-- under a credit floor, follow-ups delivered as `api-cf:gateway-settle`
-- Durable Runs on cloud_durable_run_journal (0025). Guide:
-- apps/docs/guide/gateway-data-plane.md#settlement. Drizzle mirror:
-- packages/shared-cloud-schema/src/gateway.ts. No foreign keys (AGENTS.md).
--
-- Ledger rows per request, unique on (request_id, budget_id, kind):
--   settle  the money a request owes: a media debit at admission (exact
--           price), or a text charge written by its settle run (actual cost)
--   refund  a failed media debit returned in full by its settle run;
--           ref_kind 'settle', ref_id the refunded row
-- New requests write no `hold` rows and never `settle_failed`.

-- An Idempotency-Key's claim, taken at admission (a hold carried it before).
-- A second request under the key is GATEWAY_IDEMPOTENCY_IN_PROGRESS while the
-- claim is open (ended_at NULL, before expires_at), and
-- GATEWAY_IDEMPOTENCY_ALREADY_SETTLED after it: a key never runs twice.
CREATE TABLE IF NOT EXISTS gateway_idempotency_claim (
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_id text NOT NULL,
  expires_at integer NOT NULL,
  ended_at integer,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS gateway_idempotency_claim_request_idx
  ON gateway_idempotency_claim(request_id);

-- Keys the retired holds claimed stay claimed (and are already ended below).
INSERT OR IGNORE INTO gateway_idempotency_claim
  (tenant_id, idempotency_key, request_id, expires_at, ended_at)
SELECT tenant_id, ref_id, MIN(request_id), MAX(COALESCE(expires_at, occurred_at)), strftime('%s', 'now')
  FROM gateway_usage_ledger
 WHERE kind = 'hold' AND ref_kind = 'idempotency' AND ref_id IS NOT NULL
 GROUP BY tenant_id, ref_id;

-- Release every hold the retired reserve path left open or settle_failed:
-- the request is closed at zero (a zero `settle` row of status `expired`
-- where it has none), its hold leaves `reserved`, and the hold row is
-- `expired`. A settle_failed hold's charge is the accepted edge (#396 is not
-- reopened). After this, `reserved_micro_credits` is zero on every budget.
INSERT OR IGNORE INTO gateway_usage_ledger
  (id, request_id, budget_id, kind, status, tenant_id, amount_micro_credits, occurred_at)
SELECT h.request_id || ':settle:' || h.budget_id, h.request_id, h.budget_id, 'settle', 'expired',
       h.tenant_id, 0, strftime('%s', 'now')
  FROM gateway_usage_ledger h
 WHERE h.kind = 'hold' AND h.status IN ('open', 'settle_failed');

UPDATE gateway_budget
   SET reserved_micro_credits = MAX(0, reserved_micro_credits - COALESCE((
         SELECT SUM(h.amount_micro_credits) FROM gateway_usage_ledger h
          WHERE h.budget_id = gateway_budget.id AND h.kind = 'hold' AND h.status IN ('open', 'settle_failed')
       ), 0)),
       version = version + 1,
       updated_at = strftime('%s', 'now')
 WHERE EXISTS (SELECT 1 FROM gateway_usage_ledger h
                WHERE h.budget_id = gateway_budget.id AND h.kind = 'hold' AND h.status IN ('open', 'settle_failed'));

UPDATE gateway_usage_ledger SET status = 'expired'
 WHERE kind = 'hold' AND status IN ('open', 'settle_failed');

-- The stale-hold sweeper is retired with the holds it scanned.
DROP INDEX IF EXISTS gateway_usage_ledger_hold_expiry_idx;
