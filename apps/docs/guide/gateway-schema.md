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
- **No prompt, completion or response bodies in D1.** Retained bodies
  (30 days, hosted only) are R2 objects; D1 holds only their metadata in
  `gateway_request_retention` (0037). See
  [gateway-admin.md](gateway-admin.md#staff-prompt-access-and-body-retention).

## Tables

| Table                         | Purpose                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant.kind`                 | `personal` (existing `personal:<userId>`) or `team`.                                                                                                                                                |
| `tenant_invite`               | Team invites; stores only the SHA-256 of the invite secret.                                                                                                                                         |
| `gateway_key`                 | Virtual keys (`sk_gw_…`): hash + prefix, scopes, model allowlist, `credential_scope`, key budget, `rate_limit_json`.                                                                                |
| `gateway_token`               | Short-lived tokens minted from a session, `clsh_` token or key; `parent_kind`/`parent_id` (0033) name a session or `clsh_` parent. See [gateway-tokens.md](gateway-tokens.md).                     |
| `gateway_upstream_account`    | Official upstream credentials. No tenant or user column, so it is disjoint from tenant BYOK `provider_account`. Holds a `secret_ref` or a sealed `encrypted_credentials` envelope, never plaintext. (0043) `key_prefix` (display only), `key_serial` (highest version ever issued, never reused) and the `draining_*` columns: the previous version while a rotation drains; triggers require a draining version to have a secret and differ from `key_version`. See [gateway-admin.md](gateway-admin.md#upstream-key-rotation). |
| `gateway_upstream_health`     | (0043) Circuit-breaker counters per official upstream account: `consecutive_failures`, `open_until_ms`, last failure code and time, last success time (epoch ms). Operational state only, no request, tenant or key material. See [gateway-data-plane.md](gateway-data-plane.md#upstream-keys-and-failover). |
| `gateway_model`               | Versioned published catalog: one model card (`card_json`) per model per `catalog_version`.                                                                                                          |
| `gateway_price`               | Price book: one rate per `(price_version, model_code, upstream_id, unit)`, `amount_micro` per `per` units of `currency` (default `credit`). `published_at` (0035) is `NULL` for a draft, which is never charged. See [gateway-price-book.md](gateway-price-book.md). |
| `gateway_budget`              | `tenant` = team wallet, `user` = member budget allocated by the owner (`parent_budget_id`), `key` = per-key cap. `NULL` limit is explicitly unlimited. (0041) `enforcement` `hard`/`soft`/`alert` (a wallet is always `hard`, enforced by triggers) and `alert_threshold_pct` (1-100). See [gateway-teams.md](gateway-teams.md). |
| `gateway_budget_event`        | (0041) Budget notifications written in the reservation's batch: `soft_exceeded` once per request admitted past a soft limit, `alert_threshold` once per budget, limit and threshold (unique `(budget_id, kind, dedupe_key)`). Counters after the hold; metadata only. |
| `tenant.rate_limit_json`, `tenant_member.rate_limit_json` | (0041) Owner-configured team-wide and per-member rate limits.                                                                                                              |
| `gateway_usage_ledger`        | Append-only money journal (below).                                                                                                                                                                  |
| `gateway_admin_audit`         | One row per admin mutation with redacted before/after snapshots. Append-only: 0036 triggers refuse `UPDATE` and any `DELETE` inside the 13-month retention. (0040) The actor is `actor_kind` (`admin`, `user`, `system` for an abuse threshold (0046), `bootstrap`, `migration`) plus `actor_id` (an admin account id for `admin`). See [gateway-admin.md](gateway-admin.md). |
| `admin_accounts` and `admin_sessions`, `admin_credentials`, `admin_verifications` | (0040, #394) The admin identity store: the tables of the separate admin Better Auth instance, never the product `users`/`sessions`. `admin_accounts.role` is `platform_admin` or (0046, #356, a rebuild of the table) `support_agent`; `disabled_at` locks an account. 0040 dropped the 0036 `gateway_platform_role` grant on product users. |
| `gateway_abuse_observation`   | (0046, #356) Per-minute counters of authenticated requests and 401 answers per `kind`, tenant, key and client fingerprint (a truncated hash; never the address). `''` tenant/key: an unrecognized credential. Pruned after 24 hours. |
| `gateway_abuse_threshold`     | (0046) One configured threshold per abuse signal (`window_minutes`, `alert_at`, `suspend_at` or `NULL` for alert only); no row: shown, never acted on. |
| `gateway_abuse_alert`         | (0046) Threshold alerts, unique per signal, subject, window start and action; `suspension_id` names the suspension an alert created. |
| `gateway_suspension`          | (0046) Manual or automatic suspensions of a tenant or key; at most one active (`lifted_at` NULL) per subject. The data plane refuses a suspended caller with `GATEWAY_SUSPENDED`. History, never deleted. See [gateway-admin.md](gateway-admin.md#abuse). |
| `gateway_request_retention`   | (0037) One row per retained gateway request: tenant, user and key ids, the R2 keys, sizes, SHA-256 and content types of the request and response bodies, the answer status, `status` (`stored`, `failed` with `error_code`, `purged`), `stored_at`, `expires_at` (+30 days), `purged_at`. (0039) `response_truncated` = 1 for a streamed answer whose copy was cut at the retention cap, with `response_observed_bytes` delivered. Never the bodies. |
| `gateway_upstream_report`, `gateway_upstream_usage` | (0052, #355) One imported upstream usage report per UTC day and source (`invoice`, `ai_gateway`), and its daily totals per upstream account and model code. Counts only. See [gateway-usage.md](gateway-usage.md#nightly-reconciliation). |
| `gateway_reconciliation_run`  | (0052, #355) One reconciliation of one UTC day: status (`matched`, `adjusted`, `incomplete`, `source_missing`), per-group diffs, and the signed sum of the platform `adjust` ledger entries it wrote (`ref_kind = 'reconcile'`). 0052 also indexes the ledger by `occurred_at` and by `(ref_kind, ref_id)`. |
| `gateway_package`             | Subscription packages: fiat `price_minor` in `price_currency`, `credits_micro` granted per period. Nullable unique `external_price_id` (0050, #419): the payment provider's price id.                                                                                                  |
| `gateway_topup_pack`          | One-off credit packs. A purchase is a ledger `topup` entry. Nullable unique `external_price_id` (0050, #419).                                                                                                                                         |
| `gateway_tenant_subscription` | A tenant's package subscription and period.                                                                                                                                                         |
| `gateway_rate_window`         | (0034) Fixed-window request/token counters per `subject` for the limits port, every subject prefixed with its tenant (#354): `tenant:<t>`, `tenant:<t>:key:<k>`, `tenant:<t>:user:<u>`, `tenant:<t>:model:<m>:user:<u>`. See [gateway-data-plane.md](gateway-data-plane.md). |
| `gateway_inflight`            | (0034) In-flight concurrency leases per `subject`; a lease expires on its own if never released.                                                                                                    |
| `gateway_media_job`           | (0049, #359) One official media/AIGC job per hosted generation task (unique `task_id`), keyed by its ledger `request_id`. `job_json` is the gateway-core `GatewayMediaJob` (identity, frozen route, quantities, price instant), never a prompt, output or credential. `status` moves forward only: `planned` → `admitted` (`lease_id`) → `settled`, or `planned` → `refused` (`error_code`). See [gateway-data-plane.md](gateway-data-plane.md#media-and-aigc). |

Rate limits are configurable JSON (`rate_limit_json`, gateway-core
`GatewayRateLimitSchema`) on keys, members, tenants, models, upstream
accounts, packages and tenant subscriptions.

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
| `grant` / `topup` / `expire` | Subscription credits, purchased credits, and expiry of unused grants, on the tenant wallet with `status = 'posted'`. They move the wallet's `limit_micro_credits` (+, +, −), never its spend. See [gateway-price-book.md](gateway-price-book.md). |

Indexes: `(tenant_id, occurred_at)`, `(key_id, occurred_at)`,
`(budget_id, status)` (open holds per budget, for invariant checks), and
`(kind, status, expires_at)` (0039, open holds by expiry for the stale-hold
sweeper, which moves them `open` → `expired` with a zero-cost `expired`
settle entry; see [gateway-data-plane.md](gateway-data-plane.md#stale-hold-sweeper)).

At quiescence, `gateway_budget.reserved_micro_credits` equals the sum of its
`open` and `settle_failed` `hold` entries. For usage budgets, `spent_micro_credits` equals the sum
of its `settle` entries. The integration test
`apps/api-cf/src/integration/gateway-schema.integration.test.ts` runs a
hold → settle round trip in workerd D1 with conditional `batch` statements
and checks both invariants.

## Retention

SQLite does not enforce these limits; jobs do.

| Data                                                                                                                                                                                         | Retention                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Prompt and response bodies (R2 `gateway-retention/<requestId>/…`, hosted only)                                                                                                             | 30 days, then purged.            |
| Usage metadata: ledger `upstream_id`, `account_id`, `provider_request_id`, `error_code`; ended `gateway_token` rows; terminal `tenant_invite` rows; `gateway_request_retention` rows | 30 days, then NULLed or deleted. |
| Ledger rows (money, kind, status, model, versions, token counts) and `gateway_admin_audit`                                                                                                 | 13 months.                       |

Bodies are enforced today: `purgeExpiredGatewayBodies` runs from the api-cf
`scheduled` handler every minute (and `POST /api/v1/admin/gateway/retention/purge`),
deletes the R2 objects of every row past `expires_at` and marks it `purged`;
a row past `expires_at` is unreadable even before that. The 0036 triggers keep
`gateway_admin_audit` for 13 months. The metadata/ledger retention job
(`enforceGatewayDataRetention`, hourly from the same handler and
`POST /api/v1/admin/gateway/retention/enforce`) NULLs or deletes the other
30-day metadata (including purged `gateway_request_retention` markers) and
deletes ledger rows, upstream reports, reconciliation runs and audit rows
after 13 months, in one bounded D1 batch. See
[gateway-usage.md](gateway-usage.md#retention).
