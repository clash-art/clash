# Gateway Admin Console

The `/admin` console configures and observes the Clash official model gateway
(#353): the model catalog, prices, upstream accounts, packages and top-up
packs, budgets and rate limits, usage, abuse signals, users and roles, and the
admin audit log. The tables are in [gateway-schema.md](gateway-schema.md);
prices, packages and wallets in [gateway-price-book.md](gateway-price-book.md).

## Roles

Roles live in D1. There is no environment-variable grant.

- **Tenant roles** (`tenant_member.role`): `owner`, `admin`, `finance`,
  `support`, `viewer`. A tenant role acts on its own tenant only. `member`
  uses the gateway but has no console permission.
- **Platform role** (`gateway_platform_role`, migration 0036):
  `platform_admin`. A separate grant, never a tenant role. It holds every
  platform permission, and every tenant permission on every tenant.

### Permission matrix

`apps/api-cf/src/services/gateway-authz.ts` is the one authorization module.
Every `/api/v1/admin/gateway/*` route and every tenant billing route
(`/api/v1/gateway/tenants/:tenantId/*`) authorizes through it. The server
answers `GATEWAY_FORBIDDEN` (403, `details.permission`) whatever the UI
shows, and `GATEWAY_AUTH_REQUIRED` (401) without a credential.

| Tenant permission  | owner | admin | finance | support | viewer |
| ------------------ | :---: | :---: | :-----: | :-----: | :----: |
| `tenant.read`      |   ✓   |   ✓   |    ✓    |    ✓    |   ✓    |
| `usage.read`       |   ✓   |   ✓   |    ✓    |    ✓    |   ✓    |
| `budgets.read`     |   ✓   |   ✓   |    ✓    |    ✓    |   ✓    |
| `members.read`     |   ✓   |   ✓   |    ✓    |    ✓    |   ✓    |
| `keys.read`        |   ✓   |   ✓   |    ✓    |    ✓    |        |
| `audit.read`       |   ✓   |   ✓   |    ✓    |    ✓    |        |
| `billing.read`     |   ✓   |   ✓   |    ✓    |         |        |
| `budgets.write`    |   ✓   |   ✓   |    ✓    |         |        |
| `limits.write`     |   ✓   |   ✓   |         |         |        |
| `billing.purchase` |   ✓   |       |    ✓    |         |        |
| `roles.write`      |   ✓   |       |         |         |        |

Platform permissions, `platform_admin` only: `tenants.list`, `catalog.read`,
`catalog.write`, `prices.read`, `prices.write`, `packages.read`,
`packages.write`, `billing.rollover`, `upstreams.read`, `upstreams.write`,
`wallet.adjust`, `subscription.limits.write`, `platform_roles.read`,
`platform_roles.write`, `usage.read_all`, `audit.read_all`, `abuse.read`,
`prompts.view`.

Reads such as usage and audit are tenant-scoped with `?tenantId=` (tenant
permission) and platform-wide without it (platform permission).

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
  changes, and the actor's role (`platform_admin` or the tenant role).

Covered mutations: price drafts and publishes, packages, top-up packs,
billing rollover, subscriptions and top-ups, catalog clone/model
upsert/remove/publish, upstream create/update/disable/rotate, member and key
budgets, wallet corrections and status, key and subscription rate limits,
tenant roles, platform role grants and revocations, and staff prompt access.

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
| Tenants        | `GET /tenants`; `GET /tenants/:t/members`; `PUT /tenants/:t/members/:userId/role`                                                               |
| Budgets        | `GET /tenants/:t/budgets`; `PUT /tenants/:t/budgets/(user\|key)/:id`; `POST /tenants/:t/wallet/adjust`; `POST /tenants/:t/wallet/status`         |
| Rate limits    | `GET /tenants/:t/keys`; `PUT /tenants/:t/keys/:keyId/rate-limit`; `PUT /tenants/:t/subscription/rate-limit`; model limits on catalog drafts     |
| Reads          | `GET /overview`, `GET /usage`, `GET /audit` (each `?tenantId=` or platform-wide); `GET /abuse`                                                   |
| Prompt access  | `POST /prompts/:requestId/access {reason}`                                                                                                      |

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

**Budgets.** Tenant roles with `budgets.write` set member (`user`) and key
budgets under the tenant wallet; a limit below spend + open holds is
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

## Staff prompt access (decision 10)

Hosted staff may view user prompts, gated as follows:

- the `prompts.view` permission, held by `platform_admin` only;
- the hosted-only Worker variable `GATEWAY_STAFF_PROMPT_ACCESS=enabled`.
  Unset (the default, and every self-host) answers
  `GATEWAY_PROMPT_ACCESS_DISABLED` (403);
- a required `reason`, and an audit row (`prompt.view`) for every access.

The gateway stores **no request or response bodies** (no body column exists
anywhere; retention for bodies is zero). An allowed access is therefore
audited and answers `GATEWAY_PROMPT_NOT_RETAINED` (404), with
`requestFound` telling whether the request id exists in the ledger. Body
storage is not added by this feature; any future opt-in capture would need
its own retention policy and product decision.

## UI

`apps/web/app/routes/admin._index.tsx` and `admin.<page>.tsx` are
loader-guarded through `apps/web/app/lib/adminRoute.tsx`: each loader calls
`/api/v1/admin/gateway/me` before the page's API, redirects to
`/login?returnTo=` on 401, throws a coded 403 route error
(`GATEWAY_FORBIDDEN`) when the caller holds none of the page's permissions
(the page's API is then never called), and a 404 route error
(`ADMIN_CONSOLE_UNAVAILABLE`) where the deployment has no admin API. The
server still authorizes every call. Tenant-scoped pages read `?tenant=`; a
tenant the caller holds no role in falls back to one that grants the page.

| Path               | Page                                        | Opens with                      |
| ------------------ | ------------------------------------------- | ------------------------------- |
| `/admin`           | Overview                                    | `tenant.read` / `usage.read_all` |
| `/admin/models`    | Catalog versions and price book             | `catalog.read`                  |
| `/admin/upstreams` | Upstream accounts                           | `upstreams.read`                |
| `/admin/users`     | Tenants, members and roles, platform admins | `members.read` / `tenants.list` |
| `/admin/budgets`   | Wallet, budgets, key and tenant rate limits | `budgets.read` / `tenants.list` |
| `/admin/packages`  | Packages and top-up packs                   | `packages.read`                 |
| `/admin/usage`     | Ledger, per-model totals, prompt access     | `usage.read` / `usage.read_all` |
| `/admin/abuse`     | Live rate-limit counters                    | `abuse.read`                    |
| `/admin/audit`     | Audit log                                   | `audit.read` / `audit.read_all` |

Components live in `packages/web-ui/src/components/admin/` with the typed
client `packages/web-ui/src/lib/adminClient.ts`; controls a role cannot use
are not rendered, and failed actions show the coded error inline.

## Tests

- `apps/api-cf/src/services/gateway-authz.test.ts`: matrix properties; the
  retired environment-variable grant is gone from code, config and docs.
- `apps/api-cf/src/routes/v1/admin/gateway-console.test.ts`: every role ×
  every tenant action through the Worker, platform-only routes, audit per
  mutation and rollback when the audit write fails, upstream secret custody,
  rate-limit validation, prompt-access gating.
- `apps/api-cf/src/gateway/platform-admin-bootstrap.test.ts`: bootstrap
  idempotency and target refusal.
- `apps/web/app/routes/admin.test.ts`: loader guard (401 redirect, 403
  without calling the page API, unavailable deployment, tenant scoping).
- `packages/web-ui/src/components/admin/*.test.tsx`,
  `packages/web-ui/src/lib/adminClient.test.ts`: role-gated controls,
  write-only secrets, coded errors shown inline, request shapes.
