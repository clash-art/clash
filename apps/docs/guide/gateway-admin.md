# Gateway Admin Console

The `/admin` console configures and observes the Clash official model gateway
(#353): the model catalog, prices, upstream accounts, packages and top-up
packs, budgets and rate limits, usage, abuse signals, teams and their members
(read-only), platform admins, and the admin audit log. It is for the platform
admin only. The tables are in [gateway-schema.md](gateway-schema.md); prices,
packages and wallets in [gateway-price-book.md](gateway-price-book.md).

## Roles

Roles live in D1. There is no environment-variable grant, and there are no
job roles (#392):

- **Team roles** (`tenant_member.role`, migration 0038): `owner` or `member`,
  nothing else. A team role acts on its own team only. The owner runs the
  team (members, budget allocation, keys and limits, billing); a member uses
  the gateway and reads their own usage and budget. Team settings, where
  owners manage members and allocate budgets, are #354; the admin console has
  no team role assignment.
- **Platform role** (`gateway_platform_role`, migration 0036):
  `platform_admin`, nothing else. A separate grant, never a team role. It
  holds every permission: every platform permission, and every tenant
  permission on every tenant.

Migration 0038 rewrote every team row (and pending invite) holding an earlier
role to `member` (idempotently), and D1 triggers refuse any role other than
`owner` or `member` from then on.

### Permission matrix

`apps/api-cf/src/services/gateway-authz.ts` is the one authorization module.
Every check names a permission (`authorizeGatewayAccess(access,
"team.budgets.allocate", tenantId)`); which role holds which permission is
data in that module (`GATEWAY_TENANT_ROLE_PERMISSIONS`,
`GATEWAY_PLATFORM_ROLE_PERMISSIONS`) and nowhere else, so configurable
permission groups could later replace the role tables without touching a
check. Every `/api/v1/admin/gateway/*` route and every tenant billing route
(`/api/v1/gateway/tenants/:tenantId/*`) authorizes through it. The server
answers `GATEWAY_FORBIDDEN` (403, `details.permission`) whatever the UI
shows, and `GATEWAY_AUTH_REQUIRED` (401) without a credential.

| Tenant permission       | owner | member | platform_admin | Used by                         |
| ----------------------- | :---: | :----: | :------------: | ------------------------------- |
| `usage.read_own`        |   ✓   |   ✓    |       ✓        | team settings (#354)            |
| `budgets.read_own`      |   ✓   |   ✓    |       ✓        | team settings (#354)            |
| `tenant.read`           |   ✓   |        |       ✓        | team settings (#354)            |
| `usage.read`            |   ✓   |        |       ✓        | team settings (#354)            |
| `audit.read`            |   ✓   |        |       ✓        | team settings (#354)            |
| `team.members.read`     |   ✓   |        |       ✓        | team settings; console members  |
| `team.members.manage`   |   ✓   |        |       ✓        | team settings (#354)            |
| `budgets.read`          |   ✓   |        |       ✓        | team settings; console budgets  |
| `team.budgets.allocate` |   ✓   |        |       ✓        | team settings; console budgets  |
| `keys.read`             |   ✓   |        |       ✓        | team settings; console keys     |
| `limits.write`          |   ✓   |        |       ✓        | team settings; console limits   |
| `billing.read`          |   ✓   |        |       ✓        | `/api/v1/gateway/tenants/:t`    |
| `billing.purchase`      |   ✓   |        |       ✓        | `/api/v1/gateway/tenants/:t`    |

Platform permissions, `platform_admin` only: `tenants.list`, `catalog.read`,
`catalog.write`, `prices.read`, `prices.write`, `packages.read`,
`packages.write`, `billing.rollover`, `upstreams.read`, `upstreams.write`,
`wallet.adjust`, `subscription.limits.write`, `platform_roles.read`,
`platform_roles.write`, `usage.read_all`, `audit.read_all`, `abuse.read`,
`prompts.view`, `retention.purge`, `holds.sweep`.

The admin console authorizes with `platformRoute`: the permission must come
from a platform grant, so a team owner is refused there even for a tenant
permission they hold in their own team. Tenant billing uses `tenantRoute`
(the caller's role in that team, or `platform_admin`). Console reads such as
usage and audit are platform-wide, and `?tenantId=` narrows them to one
tenant.

### Bootstrapping the first platform admin

Nobody can grant `platform_admin` through the API until someone holds it. The
first grant is an explicit, idempotent statement, run against a **local or
staging** D1 only; production is refused:

```bash
# Local dev D1 (apps/web wrangler config, as `make db-local` uses)
node apps/api-cf/scripts/gateway-platform-admin.ts --user <better-auth user id> --local
# Staging
node apps/api-cf/scripts/gateway-platform-admin.ts --user <id> --env staging
# Print the SQL and the wrangler command without running them
node apps/api-cf/scripts/gateway-platform-admin.ts --user <id> --local --dry-run
```

The script runs `wrangler d1 execute` with `INSERT OR IGNORE` into
`gateway_platform_role` plus one `gateway_admin_audit` row (actor
`bootstrap`) written only when the grant is new, so repeating it changes
nothing. Every later grant or revocation goes through the audited API
(`POST /platform-admins`, `POST /platform-admins/:userId/revoke`). The last
platform admin cannot be revoked (`GATEWAY_LAST_PLATFORM_ADMIN`).

## Audit

Every admin mutation appends one `gateway_admin_audit` row:

- written by `apps/api-cf/src/gateway/d1-admin-audit.ts`, as a statement in
  the **same D1 batch** as the mutation, chained on `changes()`, so both are
  written or neither is. A mutation that changes nothing records nothing.
- with redacted `before`/`after` snapshots: keys naming secret material
  (`apiKey`, `*Token`, `*Hash`, `password`, `encrypted*`, …) and values shaped
  like credentials (`sk-…`, `clsh_…`, `sk_gw_…`, `Bearer …`) become
  `"[redacted]"`. Upstream secrets are never put into a snapshot in the first
  place: only the credential kind, field names and key version.
- with a `reason` for overrides, rotations, wallet corrections and role
  changes, and the actor's role (`platform_admin` or the team role).

Covered mutations: price drafts and publishes, packages, top-up packs,
billing rollover, subscriptions and top-ups, catalog clone/model
upsert/remove/publish, upstream create/update/disable/rotate, member and key
budgets, wallet corrections and status, key and subscription rate limits,
team role changes (`setMemberRole` in `d1-tenant-admin.ts`, for team
settings; the last owner is kept, `GATEWAY_LAST_OWNER`), platform role grants
and revocations, retention purges that deleted something, hold sweeps that
expired something, and every staff prompt view (whatever its outcome).

The log is append-only: there is no update or delete API, and 0036 triggers
refuse `UPDATE` and any `DELETE` of a row younger than 13 months (the
retention job may delete older rows).

## API

All under `/api/v1/admin/gateway`. Errors are coded (`x-clash-error-code`).

| Area           | Routes                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Access         | `GET /me`; `GET/POST /platform-admins`; `POST /platform-admins/:userId/revoke`                                                                   |
| Catalog        | `GET /catalog`; `GET /catalog/versions/:v`; `POST …/:v/clone {from}`; `PUT/DELETE …/:v/models/:modelCode`; `POST …/:v/publish`                 |
| Prices, packs  | see [gateway-price-book.md](gateway-price-book.md)                                                                                              |
| Upstreams      | `GET/POST /upstreams`; `PATCH /upstreams/:id`; `POST /upstreams/:id/rotate`                                                                     |
| Tenants        | `GET /tenants`; `GET /tenants/:t/members` (read-only)                                                                                           |
| Budgets        | `GET /tenants/:t/budgets`; `PUT /tenants/:t/budgets/(user\|key)/:id`; `POST /tenants/:t/wallet/adjust`; `POST /tenants/:t/wallet/status`         |
| Rate limits    | `GET /tenants/:t/keys`; `PUT /tenants/:t/keys/:keyId/rate-limit`; `PUT /tenants/:t/subscription/rate-limit`; model limits on catalog drafts     |
| Reads          | `GET /overview`, `GET /usage`, `GET /audit` (each `?tenantId=` or platform-wide); `GET /abuse`                                                   |
| Prompt access  | `POST /prompts/:requestId/access {reason}`; `POST /retention/purge {limit?}`                                                                    |
| Holds          | `POST /holds/sweep {limit?}`: the stale-hold sweeper now ([gateway-data-plane.md](gateway-data-plane.md#stale-hold-sweeper))                       |

**Catalog.** The data plane routes the newest published catalog version as a
whole, so a change is: clone the live version into a draft, upsert or remove
models, publish. Each card must parse as a shared-types `ModelCard` whose id
is the model code (`GATEWAY_CATALOG_MODEL_INVALID`), and DeepSeek is served
through Flash models only (`GATEWAY_CATALOG_MODEL_BLOCKED`). A published
version never changes (`GATEWAY_CATALOG_VERSION_PUBLISHED`).

**Upstream accounts.** Secrets are write-only: either a `GATEWAY_UPSTREAM_*`
Worker secret *name* (`secret_ref`) or an API key sealed at once under
`GATEWAY_ENCRYPTION_KEY` (`GATEWAY_ENCRYPTION_KEY_MISSING`, 503, when the key
is not configured). Responses, the audit log and errors carry only the
credential kind, field names and `key_version`. `enabled: false` disables an
account for routing; rotation replaces the secret, bumps the key version and
stamps `rotated_at`.

**Budgets.** `team.budgets.allocate` (the team owner in team settings, the
platform admin in the console) sets member (`user`) and key budgets under the
tenant wallet; a limit below spend + open holds is
`GATEWAY_BUDGET_BELOW_USAGE`, `null` is explicitly unlimited (the wallet still
caps it). The wallet itself changes only through purchases and platform
corrections: `wallet/adjust` posts a ledger `adjust` entry (`ref_kind`
`admin_credit`/`admin_debit`, the reason, one idempotency key per correction)
and `wallet/status` suspends or reactivates it.

**Rate limits.** `rate_limit_json` on keys, catalog models, upstream accounts,
packages and subscriptions is validated with one schema
(`GatewayRateLimitSchema`: `requestsPerMinute`, `tokensPerMinute`,
`concurrency`, positive integers, at least one, no unknown fields) and
enforced by `d1-limits.ts`. `null` clears a limit.

**Abuse.** Only live counters exist today (`gateway_rate_window`,
`gateway_inflight`). Denied requests (rate-limited, forbidden) are not
recorded, so the response states `events.available: false` rather than
showing an empty list as if nothing happened.

## Staff prompt access and body retention

Product decision 2026-10-20 (it replaces the earlier "no body storage"
rule): the hosted gateway keeps each request's prompt **and** response for 30
days so platform staff can view them. Viewing is `platform_admin`-only and
audited.

### The switch

One hosted-only Worker variable, `GATEWAY_STAFF_PROMPT_ACCESS=enabled`,
turns on both storage and the view:

| Config                                        | Value       | Effect                                        |
| --------------------------------------------- | ----------- | --------------------------------------------- |
| `apps/api-cf/wrangler.toml` top-level `[vars]` | unset       | OSS / self-host: nothing stored, view refused |
| `[env.staging.vars]`                          | `"enabled"` | stored and viewable                           |
| clash-hosted production overlay               | `"enabled"` | must set it the same way                      |

Any other value is off. While it is off, the data plane stores nothing and
the view answers `GATEWAY_PROMPT_ACCESS_DISABLED` (403). Purge runs whatever
the flag says, so turning it off never leaves bodies past their 30 days.

### Storage

For every admitted `/gateway/v1/*` request (it has a request id and a ledger
entry), after settlement, the data plane stores two R2 objects in the
`R2_BUCKET` binding:

- `gateway-retention/<requestId>/request.json`: the normalized request body
  (the caller's JSON body as parsed);
- `gateway-retention/<requestId>/response.json`: the exact bytes of the
  answer the caller received. That is the completion, or the coded gateway
  error after an upstream failure, never the upstream's own error body.

Streamed answers are retained too (product decision 2026-10-20, #348). The
object holds the event stream as the caller received it, including any coded
trailer. It is copied beside the stream as each chunk is handed over, so the
caller is never held back, and it is stored when the stream ends, after
settlement. The copy is capped (`retention.maxStreamBytes`, 8 MiB by
default). A longer stream is stored cut at the cap, and:

- the object ends in
  `: x-gateway-retention: truncated; code=GATEWAY_RETENTION_TRUNCATED; stored_bytes=<n>; observed_bytes=<m>`;
- the row has `response_truncated = 1` and `response_observed_bytes` (0038);
- `gateway.retention_truncated` is logged.

A truncated copy is never silent. A stream whose caller disconnected is
stored with what the caller received up to that point.

It also writes one `gateway_request_retention` row (migration 0037) with the
request, tenant, user and key ids, the object keys, sizes, SHA-256, content
types, the answer's HTTP status, `stored_at` and `expires_at = stored_at +
30 days`. The row holds no content. Requests refused before admission
(authentication, invalid JSON) have no request id and are not stored.

Headers are never stored. The caller's `Authorization` / `x-api-key`
credential and the upstream key both travel only in headers, so neither can
reach storage.

A storage failure is never silent, and it never changes the answer or its
billing (storage runs after settlement):

- the answer carries
  `x-gateway-retention: failed; code=GATEWAY_RETENTION_FAILED; request_id=<id>`;
- any object already written is deleted, so no body outlives its metadata;
- the row is recorded with `status = 'failed'` and `error_code`;
- the `gateway.retention_failed` error log carries `requestId`, `code`,
  `cause` and `marker` (`failed`, or `unrecorded` with `markCause` when even
  the row could not be written).

### Viewing

`POST /prompts/:requestId/access {reason}` requires `prompts.view`
(`platform_admin` only; team owners and members get `GATEWAY_FORBIDDEN`) and
a `reason`. Every call, whatever its outcome, first writes one
`gateway_admin_audit` row: action `prompt.view`, the actor, the request id
(`target_id` and `request_id`), the reason, and an `after` snapshot with the
outcome (`viewed`, `expired`, `not_retained`, `failed`), the sizes and
SHA-256. The audit never holds the body. If the audit row cannot be written,
nothing is returned.

| State                                          | Answer                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| Stored and not expired                         | 200 `{ prompt }` with both bodies                  |
| No row, or storage had failed                  | `GATEWAY_PROMPT_NOT_RETAINED` (404), `requestFound` |
| Past `expires_at`, even if purge has not run   | `GATEWAY_PROMPT_EXPIRED` (410)                     |
| An object is missing or fails its SHA-256      | `GATEWAY_RETENTION_FAILED` (500)                   |

`prompt.request.body` and `prompt.response.body` are the stored bytes,
decoded as the UTF-8 text they were written as (JSON, or a stream's SSE), with
`bytes` and `sha256` so they can be checked against the original. Each body
also has `truncated`; a truncated stream copy adds `observedBytes`, and the
view's audit `after` records `responseTruncated`.

### Purge

`purgeExpiredGatewayBodies` (gateway-core) deletes both objects of every
expired, unpurged row and marks it `purged` (`purged_at`). It is idempotent:
a purged row is never selected again, deleting a missing object succeeds, and
a row whose purge failed stays unreadable and is retried on the next run. It
runs:

- every minute from the api-cf Worker `scheduled` handler
  (`purgeGatewayRetention` in `apps/api-cf/src/gateway/d1-retention.ts`, on
  the existing `* * * * *` cron), up to 200 rows per run;
- on demand through `POST /retention/purge {limit?}` (`retention.purge`,
  `platform_admin` only), audited as `retention.purge` when it deleted
  something.

### Retention summary

| Data                                                           | Kept                 |
| -------------------------------------------------------------- | -------------------- |
| Prompt and response bodies (R2)                                | 30 days, then purged |
| Usage metadata, and body metadata (`gateway_request_retention`) | 30 days              |
| Ledger                                                         | 13 months            |
| `gateway_admin_audit`                                          | 13 months            |

Bodies are enforced by the purge above. A purged `gateway_request_retention`
row stays as a content-free marker (ids, sizes, hashes) so a late view still
answers `GATEWAY_PROMPT_EXPIRED`. Deleting it, like NULLing the other
30-day usage metadata, belongs to the gateway metadata retention job, which
is not implemented yet ([gateway-schema.md](gateway-schema.md#retention)).

## UI

`apps/web/app/routes/admin._index.tsx` and `admin.<page>.tsx` are
loader-guarded through `apps/web/app/lib/adminRoute.tsx`: each loader calls
`/api/v1/admin/gateway/me` before the page's API, redirects to
`/login?returnTo=` on 401, throws a coded 403 route error
(`GATEWAY_FORBIDDEN`) when the caller's platform grants do not include the
page's permission (every team owner and member; the page's API is then never
called), and a 404 route error (`ADMIN_CONSOLE_UNAVAILABLE`) where the
deployment has no admin API. The server still authorizes every call.
Tenant-scoped pages read `?tenant=` (chosen from the tenant list) and show it
with a way back to all tenants.

| Path               | Page                                                  | Opens with       |
| ------------------ | ----------------------------------------------------- | ---------------- |
| `/admin`           | Overview                                              | `usage.read_all` |
| `/admin/models`    | Catalog versions and price book                       | `catalog.read`   |
| `/admin/upstreams` | Upstream accounts                                     | `upstreams.read` |
| `/admin/users`     | Tenants, their members and roles (read-only), platform admins | `tenants.list`   |
| `/admin/budgets`   | Wallet, budgets, key and tenant rate limits           | `tenants.list`   |
| `/admin/packages`  | Packages and top-up packs                             | `packages.read`  |
| `/admin/usage`     | Ledger, per-model totals, prompt viewer               | `usage.read_all` |
| `/admin/abuse`     | Live rate-limit counters                              | `abuse.read`     |
| `/admin/audit`     | Audit log                                             | `audit.read_all` |

Components live in `packages/web-ui/src/components/admin/` with the typed
client `packages/web-ui/src/lib/adminClient.ts`; controls the caller's grants
cannot use are not rendered, and failed actions show the coded error inline.

On `/admin/usage`, when `/me` reports `promptAccess` (the flag is on and the
caller holds `prompts.view`), each `settle` row has a **View** button and a
request-id field opens the same viewer (`AdminPromptViewer`, the shared
Radix dialog). The viewer asks for a reason, makes the audited call, and
shows the request and response bodies verbatim with their size and SHA-256,
or the coded error (expired, not retained).

## Tests

- `apps/api-cf/src/services/gateway-authz.test.ts`: matrix properties; the
  retired environment-variable grant and the removed team roles are gone
  from code, tests and docs.
- `apps/api-cf/src/gateway/team-roles-migration.test.ts`: 0038 maps earlier
  team roles to `member`, is idempotent, and D1 refuses any other role.
- `apps/api-cf/src/routes/v1/admin/gateway-console.test.ts`: every console
  route refused to team owners and members, tenant billing per role through
  the Worker, team role changes keeping one owner, audit per
  mutation and rollback when the audit write fails, upstream secret custody,
  rate-limit validation; staff prompt view (platform_admin only, the stored
  bytes, every view audited without the body, nothing disclosed when the
  audit fails, expiry before purge, idempotent purge, a truncated stream
  copy); the hold sweep (platform_admin only, expires once, audited only
  when it changed something).
- `packages/gateway-core/src/retention.test.ts` and the contract cases
  (`retention`, data plane): body stored on success and on upstream error,
  credentials never stored, coded failure with unchanged billing, expiry,
  integrity, purge retry. They run on the memory stub, D1 on node:sqlite and
  D1 + R2 in workerd (`gateway-data-plane.integration.test.ts`, which also
  views a stored request through the Worker).
- `apps/api-cf/src/gateway/platform-admin-bootstrap.test.ts`: bootstrap
  idempotency and target refusal.
- `apps/web/app/routes/admin.test.ts`: loader guard (401 redirect, 403
  without calling the page API, unavailable deployment, tenant scoping).
- `packages/web-ui/src/components/admin/*.test.tsx`,
  `packages/web-ui/src/lib/adminClient.test.ts`: permission-gated controls,
  write-only secrets, coded errors shown inline, request shapes, the prompt
  viewer (reason required, stored bytes shown unchanged, coded expiry).
