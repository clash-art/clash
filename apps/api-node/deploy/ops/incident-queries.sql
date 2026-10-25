-- Gateway-node incident queries (staging).
-- Issue #384. Postgres-only; no SQLite path.
--
-- TODO(#362): align identifiers with the gateway-node PG migration when it
-- lands. Names below follow gateway-core / cloud D1 conventions
-- (micro-credits, ledger kind/status). Do not invent alternate units.

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

-- spent drift vs settle sum
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

-- overspend under hard limit (must be empty)
SELECT id, limit_micro_credits, spent_micro_credits, reserved_micro_credits
  FROM gateway_budget
 WHERE limit_micro_credits IS NOT NULL
   AND spent_micro_credits + reserved_micro_credits > limit_micro_credits;

-- stuck holds past expiry
-- TODO(#362): confirm expires_at representation after PG schema lands
SELECT id, budget_id, status, expires_at, amount_micro_credits
  FROM gateway_usage_ledger
 WHERE kind = 'hold'
   AND status IN ('open', 'settle_failed')
   AND expires_at < EXTRACT(EPOCH FROM NOW())::bigint;
