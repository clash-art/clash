-- Gateway-node incident queries (staging).
-- Issue #384 / #399. Postgres-only; no SQLite path.
--
-- N2 settlement (media prepay+refund, text postpay+floor): there are no open
-- holds and no sweeper. Prefer Durable Run / settle-journal recovery, then
-- audited wallet/adjust. Never rewrite historical settle/charge/debit rows.
--
-- Queries marked HISTORICAL below target the retired reserve/hold path
-- (migration 0042 released remaining holds; `reserved_micro_credits` should
-- stay 0). Keep them for archaeology on old backups; do not run them as the
-- primary recovery checklist on a live N2 node.

-- ─── N2 (current) ───────────────────────────────────────────────────────────

-- reserved must stay zero under N2 (expect 0 rows)
SELECT id AS budget_id, reserved_micro_credits
  FROM gateway_budget
 WHERE reserved_micro_credits <> 0;

-- spent drift vs debit+charge−refund (Node ledger kinds) — expect 0 rows
SELECT b.id AS budget_id,
       b.spent_micro_credits AS budget_spent,
       COALESCE(s.ledger_sum, 0) AS ledger_sum
  FROM gateway_budget b
  LEFT JOIN (
    SELECT budget_id,
           SUM(CASE
                 WHEN kind IN ('debit', 'charge') THEN amount_micro_credits
                 WHEN kind = 'refund' THEN -amount_micro_credits
                 ELSE 0
               END) AS ledger_sum
      FROM gateway_usage_ledger
     WHERE kind IN ('debit', 'charge', 'refund')
     GROUP BY budget_id
  ) s ON s.budget_id = b.id
 WHERE b.spent_micro_credits <> COALESCE(s.ledger_sum, 0);

-- Hard budgets at or below the credit floor (admission will 402). Not drift:
-- a single postpay charge may push past -floor; this is an ops signal only.
-- Replace :floor with gateway_config settlement.floor_micro_credits (or 0).
-- SELECT id, limit_micro_credits, spent_micro_credits,
--        (limit_micro_credits - spent_micro_credits) AS balance_micro_credits
--   FROM gateway_budget
--  WHERE status = 'active'
--    AND enforcement = 'hard'
--    AND limit_micro_credits IS NOT NULL
--    AND (limit_micro_credits - spent_micro_credits) <= -:floor;

-- ─── HISTORICAL (pre-N2 hold path) ──────────────────────────────────────────
-- reserved drift vs open/settle_failed holds (expect 0 rows at quiescence)
SELECT b.id AS budget_id,
       b.reserved_micro_credits AS budget_reserved,
       COALESCE(h.hold_sum, 0) AS hold_sum
  FROM gateway_budget b
  LEFT JOIN (
    SELECT budget_id, SUM(amount_micro_credits) AS hold_sum
      FROM gateway_usage_ledger
     WHERE kind = 'hold' AND status IN ('open', 'settle_failed')
     GROUP BY budget_id
  ) h ON h.budget_id = b.id
 WHERE b.reserved_micro_credits <> COALESCE(h.hold_sum, 0);

-- spent drift vs settle sum (cloud D1 kind name; Node uses debit/charge)
SELECT b.id AS budget_id,
       b.spent_micro_credits AS budget_spent,
       COALESCE(s.settle_sum, 0) AS settle_sum
  FROM gateway_budget b
  LEFT JOIN (
    SELECT budget_id, SUM(amount_micro_credits) AS settle_sum
      FROM gateway_usage_ledger
     WHERE kind = 'settle'
     GROUP BY budget_id
  ) s ON s.budget_id = b.id
 WHERE b.spent_micro_credits <> COALESCE(s.settle_sum, 0);

-- overspend under hard limit — misleading under text postpay (spent may exceed
-- limit after a full actual charge). Soft/alert budgets also debit past limit.
-- Kept for historical hold-era drills only.
SELECT id, limit_micro_credits, spent_micro_credits, reserved_micro_credits
  FROM gateway_budget
 WHERE limit_micro_credits IS NOT NULL
   AND spent_micro_credits + reserved_micro_credits > limit_micro_credits;

-- stuck holds past expiry (N2 writes none)
SELECT id, budget_id, status, expires_at, amount_micro_credits
  FROM gateway_usage_ledger
 WHERE kind = 'hold'
   AND status IN ('open', 'settle_failed')
   AND expires_at < EXTRACT(EPOCH FROM NOW())::bigint;
