# Gateway D1 Schema

The Clash official model gateway stores its control-plane state in D1. The
migration is `apps/web/drizzle/0032_gateway.sql`; the Drizzle mirror is
`@clash/shared-cloud-schema/gateway` (plus `tenant_invite` and `tenant.kind` in
`@clash/shared-cloud-schema/app`). The decisions live in
`@clash/gateway-core`; these tables are what a D1 adapter makes durable.

## Conventions

- **No foreign keys.** The store and admin API enforce references.
- **Text ids, unix seconds.** `gateway-core` uses epoch milliseconds
  (`GatewayClock.now()`, `ReserveInput.expiresAt`, `UsageEvent.occurredAt`); the
  D1 adapter converts at the port boundary.
- **Integer micro-credits.** 1 credit = 1,000,000 micro-credits, the core's
  `MicroCredits`. SQLite `INTEGER` is 64-bit; values stay `Number.isSafeInteger`.
  The price book is the charged amount: there are no markup or percentage fields.
- **`''` instead of `NULL`** for optional columns that take part in a unique
  index (`gateway_price.upstream_id`, `gateway_usage_ledger.budget_id`), because
  SQLite treats NULLs as distinct.
- **No prompt, completion or response bodies** in any column.

## Tables

| Table                         | Purpose                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant.kind`                 | `personal` (existing `personal:<userId>`) or `team`.                                                                                                                                                |
| `tenant_invite`               | Team invites; stores only the SHA-256 of the invite secret.                                                                                                                                         |
| `gateway_key`                 | Virtual keys (`sk_gw_…`): hash + prefix, scopes, model allowlist, `credential_scope`, key budget, `rate_limit_json`.                                                                                |
| `gateway_token`               | Short-lived tokens minted from a session, `clsh_` token or key; `parent_kind`/`parent_id` (0033) name a session or `clsh_` parent. See [gateway-tokens.md](gateway-tokens.md).                     |
| `gateway_upstream_account`    | Official upstream credentials. No tenant or user column, so it is disjoint from tenant BYOK `provider_account`. Holds a `secret_ref` or a sealed `encrypted_credentials` envelope, never plaintext. |
| `gateway_model`               | Versioned published catalog: one model card (`card_json`) per model per `catalog_version`.                                                                                                          |
| `gateway_price`               | Price book: one rate per `(price_version, model_code, upstream_id, unit)`, `amount_micro` per `per` units of `currency` (default `credit`).                                                         |
| `gateway_budget`              | `tenant` = team wallet, `user` = member budget allocated by the owner (`parent_budget_id`), `key` = per-key cap. `NULL` limit is explicitly unlimited.                                              |
| `gateway_usage_ledger`        | Append-only money journal (below).                                                                                                                                                                  |
| `gateway_admin_audit`         | One row per admin mutation with redacted before/after snapshots.                                                                                                                                    |
| `gateway_package`             | Subscription packages: fiat `price_minor` in `price_currency`, `credits_micro` granted per period.                                                                                                  |
| `gateway_topup_pack`          | One-off credit packs. A purchase is a ledger `topup` entry.                                                                                                                                         |
| `gateway_tenant_subscription` | A tenant's package subscription and period.                                                                                                                                                         |
| `gateway_rate_window`         | (0034) Fixed-window request/token counters per `subject` (`key:…`, `model:…:user:…`, `tenant:…`) for the limits port. See [gateway-data-plane.md](gateway-data-plane.md).                         |
| `gateway_inflight`            | (0034) In-flight concurrency leases per `subject`; a lease expires on its own if never released.                                                                                                    |

Rate limits are configurable JSON (`rate_limit_json`) on keys, models,
upstream accounts, packages and tenant subscriptions.

## Ledger

One entry per `(request_id, budget_id, kind)`, enforced by a unique index;
`request_id` is the idempotency anchor (the gateway request id, or the
order/period id for credits). Amounts are non-negative; direction follows
from `kind`:

| Kind                         | Meaning                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hold`                       | Reserve on one budget. `status` moves `open` → `settled`/`released`/`expired`, in the same batch that appends the closing entry. A failed settlement instead moves it `open` → `settle_failed` (with `error_code`), still reserved, until a later settle closes it. These are the only in-place changes. |
| `settle`                     | Actual cost; `status` is the outcome (`settled`, `partial`, `client_aborted`, `upstream_failed`, `gateway_failed`, `expired`) and the row carries the billing basis. |
| `release`                    | Hold returned unused.                                                                                                                                                |
| `refund`                     | Credit back after a settle; `ref_id` names the refunded entry.                                                                                                       |
| `adjust`                     | Reconciliation or admin correction, with `actor_user_id` and `reason`.                                                                                               |
| `grant` / `topup` / `expire` | Subscription credits, purchased credits, and expiry of unused grants.                                                                                                |

Indexes: `(tenant_id, occurred_at)`, `(key_id, occurred_at)`,
`(budget_id, status)` (open holds per budget, for the sweeper and invariant
checks).

At quiescence, `gateway_budget.reserved_micro_credits` equals the sum of its
`open` and `settle_failed` `hold` entries. For usage budgets, `spent_micro_credits` equals the sum
of its `settle` entries. The integration test
`apps/api-cf/src/integration/gateway-schema.integration.test.ts` runs a
hold → settle round trip in workerd D1 with conditional `batch` statements
and checks both invariants.

## Retention

The gateway retention job enforces these limits. SQLite does not.

| Data                                                                                                                                               | Retention                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Prompt / response bodies                                                                                                                           | Never stored.                    |
| Usage metadata: ledger `upstream_id`, `account_id`, `provider_request_id`, `error_code`; ended `gateway_token` rows; terminal `tenant_invite` rows | 30 days, then NULLed or deleted. |
| Ledger rows (money, kind, status, model, versions, token counts) and `gateway_admin_audit`                                                         | 13 months.                       |
