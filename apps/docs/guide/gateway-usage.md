# Gateway usage explorer, retention and reconciliation

Issue #355 (Epic A #343). The usage explorer and its CSV export, the metadata
and ledger retention job, and the nightly reconciliation of the ledger with
what the upstream itself reported. Product decisions (2026-10-20): metadata is
kept 30 days, no request or response body is kept for usage, the ledger is
kept 13 months (decision 8); a failed media/AIGC request is never charged and
is visible in the explorer (decision 11).

Code: `packages/gateway-core/src/{usage-export,reconcile,retention}.ts`
(shared facts and the reconciliation algorithm), `apps/api-cf/src/gateway/`
`d1-usage-explorer.ts`, `d1-reconciliation.ts`, `d1-retention.ts`,
`scheduled.ts` (D1 adapters and jobs), routes in
`apps/api-cf/src/routes/v1/admin/gateway-{insights,reconciliation}.ts` and
`apps/api-cf/src/routes/v1/gateway-team.ts`, migration
`apps/web/drizzle/0045_gateway_usage_reconciliation.sql`. Settlement semantics
are not part of this guide (issue #399).

## Usage explorer

The explorer reads `gateway_usage_ledger`. Entries are metadata only: ids,
kind, status, money, token and media-unit counts, model, price version, usage
source, the upstream (30 days) and the error code (30 days). Nothing here reads
a prompt or response body; body retention for staff prompt access is a
separate, hosted-only feature behind `GATEWAY_STAFF_PROMPT_ACCESS`
([gateway-admin.md](gateway-admin.md#staff-prompt-access-and-body-retention)),
off by default.

Filters: tenant, user, key, model, ledger kind (default: every kind but
legacy `hold` and `release`), status and time (`from` inclusive, `to`
exclusive, ISO instants; `to` not after `from` is `GATEWAY_INVALID_REQUEST`).
Pages are newest first, keyed by `(occurred_at, id)`: `nextCursor` is opaque
and a cursor the server did not hand out is `GATEWAY_INVALID_REQUEST`.
`byModel` totals the settle entries of the whole filter, with `notCharged`
counting requests settled at zero.

A request settles once per budget it held on, with the same amount on each
row; the explorer, its totals and the export show one settle entry per
request (the row on the lowest budget id, as `GatewayLedgerPort.query`
does), so nothing is double counted.

Each entry carries `chargeMicroCredits` (gateway-core
`ledgerChargeMicroCredits`: a settlement charges its amount, a refund gives it
back, legacy holds/releases and wallet moves charge nothing) and `notCharged`
(`isUnchargedSettlement`: a settle entry that is not `settled` and has amount
zero). A media/AIGC request that fails after acceptance is refunded in full
under N2 (prepay + refund); explorer rows that still show a zero-charge settle
are the pre-N2 shape. A partial text request is charged for what it delivered
(full actual; no floor-capped unbilled remainder).

### CSV export

`GET …/usage/export` takes the explorer filter (no cursor) and streams RFC
4180 CSV (CRLF records, quoted commas, quotes and line breaks), page by page.
A text cell a spreadsheet would evaluate (`= + - @`, tab, CR) is prefixed with
`'`; numbers stay numeric. A filter matching more than 100 000 rows is
`GATEWAY_EXPORT_TOO_LARGE` (413) before any byte is sent. The response is
`text/csv`, `cache-control: no-store`, with `x-gateway-export-rows` and a
`gateway-usage[-<scope>]-<from>-<to>.csv` attachment name. Columns:
`usageExportColumns` in gateway-core; a team export (`tenant` audience) never
carries `upstream_id`.

### Who reads what

| Route                                                      | Who                               |
| ---------------------------------------------------------- | --------------------------------- |
| `GET /api/v1/admin/gateway/usage` (`?tenantId`, filters, `cursor`, `limit`) | admin accounts, `usage.read_all` |
| `GET /api/v1/admin/gateway/usage/export`                   | admin accounts, `usage.read_all`  |
| `GET /api/v1/gateway/tenants/:t/usage` (filters, `cursor`) | team owner, `usage.read`          |
| `GET /api/v1/gateway/tenants/:t/usage/export`              | team owner, `usage.read`          |
| `GET /api/v1/gateway/tenants/:t/me/usage` (+ `/export`)    | any member, `usage.read_own`: the user is always the caller |

Team reads are pinned to the tenant and to settle entries, and never show the
upstream or account that served a request
([gateway-teams.md](gateway-teams.md)).

UI: the console's Usage page (`/admin/usage`, `AdminUsage`) keeps every filter
and the page cursor in the URL and downloads the export; team settings show
the team's usage (owner: older pages and export) or the member's own (export).

## Retention

| Data                                                                                      | Kept      | How                    |
| ----------------------------------------------------------------------------------------- | --------- | ---------------------- |
| Ledger `upstream_id`, `account_id`, `provider_request_id`, `error_code`                    | 30 days   | NULLed                 |
| Ended `gateway_token` rows, terminal `tenant_invite` rows, purged body-retention markers   | 30 days   | deleted                |
| Ledger rows                                                                               | 13 months | deleted                |
| Upstream reports and their groups, reconciliation runs                                    | 13 months | deleted                |
| `gateway_admin_audit`                                                                     | 13 months | deleted                |

13 months is 396 days (`GATEWAY_LEDGER_RETENTION_MS`), the window the 0036
audit trigger enforces, so ledger and audit age out the same day.
`enforceGatewayDataRetention` runs every statement in one D1 batch, each
bounded (2 000 rows by default; `more: true` when one hit its limit, so a
backlog drains over the next runs). Legacy hold rows still marked open /
`settle_failed` (retired reserve path) are never touched; N2 writes no new
holds. The audit cutoff is also bounded by the database's own clock, so a
skewed Worker clock can never make the 0036 trigger abort the batch.

It runs from the every-minute `scheduled` handler once an hour at minute 45
(`isRetentionEnforcementDue`), and on demand through
`POST /api/v1/admin/gateway/retention/enforce {limit?}` (`retention.purge`),
audited as `retention.enforce` when it removed something.

## Nightly reconciliation

Reconciliation compares one UTC day of the ledger with what the upstream
reported for it, per official upstream account and public model code
(`gateway-core` `reconcileGatewayUsageDay`).

- **Ledger side**: settle entries of official-scope requests in the day, one
  per request: requests, tokens, media units and the amount charged.
- **Upstream side**: an imported report, `invoice` (what the platform pays)
  or `ai_gateway` (Cloudflare AI Gateway logs), normalized by the importer to
  daily totals per account and model. When both exist, the invoice wins unless
  a source is named.
- **Difference**: when the usage differs, both sides are valued at the
  published price for that model and upstream at the end of the day (the
  data plane's own price lookup, `publishedPriceAt`) and the signed
  difference is recorded as a platform `adjust` ledger entry: `tenant_id = ''`,
  `ref_kind = 'reconcile'`, `ref_id` = the run, request id
  `reconcile:<day>:<groupKey>:<n>`. Ledger amounts are unsigned, so the
  direction is the status: `upstream_over` (the upstream reported more) or
  `upstream_under`. An adjustment never charges or credits a tenant wallet.
- **Idempotent**: a group's adjustments for a day add up to its valued
  difference. A re-run posts only `delta − posted`, so repeating a day posts
  nothing and a corrected report posts (or reverses) only the change. The run
  row, its adjustments and (for an admin run) its audit row are one D1 batch,
  and each adjustment is written only while the group's posted sum is still
  what the run read, so two concurrent runs never both post.
- **Visible failures**: a day without any report is recorded as
  `source_missing` (`GATEWAY_RECONCILE_SOURCE_MISSING`), never as `matched`; a
  group the price book cannot value posts nothing and makes the run
  `incomplete` with its code. A day that has not ended, or whose start is past
  the 30-day metadata window (the ledger's upstream and account are gone), is
  `GATEWAY_RECONCILE_WINDOW_CLOSED` (409).

Run statuses: `matched`, `adjusted`, `incomplete`, `source_missing`.

The nightly job runs from the `scheduled` handler at 01:15 UTC
(`isNightlyReconcileDue`): yesterday, plus every earlier day inside the
metadata window whose report was imported or replaced after its last run.
Each day is its own batch; one failing day never stops the others.

### Admin API

All under `/api/v1/admin/gateway`, admin accounts only.

| Route                                                   | Permission             |
| ------------------------------------------------------- | ---------------------- |
| `GET /reconciliation/reports` (`?from`, `?to` days)      | `reconciliation.read`  |
| `PUT /reconciliation/reports/:day/:source {groups, reason?}` | `reconciliation.write` |
| `GET /reconciliation/runs` (`?day`, `?status`)           | `reconciliation.read`  |
| `GET /reconciliation/runs/:id` (with per-group diffs)    | `reconciliation.read`  |
| `POST /reconciliation/runs {day, source?}`               | `reconciliation.write` |

An import replaces that day's report from that source in one audited batch
(`reconciliation.import`). Every group names an upstream account by id and its
own upstream (`GATEWAY_UPSTREAM_NOT_FOUND` otherwise), appears once, and
DeepSeek models must be Flash ones (`GATEWAY_CATALOG_MODEL_BLOCKED`). A
future day is refused. Reports hold counts only, never content.

UI: the console's Reconciliation page (`/admin/reconciliation`,
`AdminReconciliation`) lists runs and reports, opens a run's differences, and
with `reconciliation.write` imports a report and reconciles a day.

## Tests

- `packages/gateway-core/src/reconcile.test.ts`, `usage-export.test.ts`:
  the algorithm (valuation, idempotency, reversal, source preference,
  `source_missing`, `incomplete`, window), charge sign, CSV encoding.
- `apps/api-cf/src/routes/v1/admin/gateway-usage.test.ts` (node:sqlite, every
  migration): explorer filters, cursor paging, one settle entry per request,
  failed media at zero, exports and their audiences, export size limit,
  retention limits and bounds, reconciliation posting, races, missing reports,
  windows, the nightly selection and the scheduled minutes.
- `apps/api-cf/src/integration/gateway-usage.integration.test.ts` (workerd
  D1): requests served through `/gateway/v1/chat/completions` appear in the
  explorer and CSV without their prompt or answer, reconcile into one valued
  adjustment once, and retention runs under the audit trigger.
- `packages/web-ui` `AdminPages.test.tsx`, `TeamSettings.test.tsx` and
  `apps/web/app/routes/admin.test.ts`: the pages call these routes with the
  filters, page and export the user chose, and show coded refusals.
