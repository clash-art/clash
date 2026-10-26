# Gateway Admin Console

The `/admin` console configures and observes the Clash official model gateway
(#353): the model catalog, prices, upstream accounts, packages and top-up
packs, budgets and rate limits, usage, abuse signals, teams and their members
(read-only), admin accounts, and the admin audit log. It is for admin
accounts only: a separate identity with its own sign-in (#394, below). The
tables are in [gateway-schema.md](gateway-schema.md); prices, packages and
wallets in [gateway-price-book.md](gateway-price-book.md).

## Admin identity

Admins are not product users (#394). An **admin account** lives in its own
store (`admin_accounts`, `admin_sessions`, `admin_credentials`,
`admin_verifications`, migration 0040; Drizzle mirror
`packages/shared-cloud-schema/src/admin-auth.ts`) and signs in through its
own Better Auth instance, `apps/api-cf/src/admin-auth.ts`, configured the way
Better Auth runs a second, independent auth:

| Setting       | Admin instance                                         | Product instance              |
| ------------- | ------------------------------------------------------ | ----------------------------- |
| Base path     | `/api/admin-auth` (api-cf; the web Worker proxies it)  | `/api/better-auth`            |
| Tables        | `admin_*` (model names `adminAccounts`, …)             | `users`, `sessions`, …        |
| Cookies       | `clash-admin.*`, `SameSite=Strict`, no cookie cache    | `better-auth.*`               |
| Sign-in       | email and password only; sign-up disabled              | email/OTP/Google, sign-up     |
| Session       | 12 hours, refreshed hourly                             | Better Auth defaults          |
| Account ids   | `adm_…`                                                | Better Auth ids               |
| Secret        | `ADMIN_AUTH_SECRET`, else the product auth secret      | `BETTER_AUTH_SECRET`          |

Sign-in is rate limited (5 attempts a minute per client address). A disabled
account cannot sign in (`ADMIN_ACCOUNT_DISABLED`, 403) and has no sessions or
password left. Better Auth hashes and checks passwords, signs cookies and
stores sessions; nothing here re-implements them.

**Isolation, enforced by api-cf before any route runs**
(`apps/api-cf/src/services/admin-identity.ts`, called by the `/api/*`
middleware):

- `/api/v1/admin/*` resolves the admin session only, never a product
  identity. No credential is `GATEWAY_AUTH_REQUIRED` (401). A product
  session, a `clsh_` or `sk_gw_` token, any other `Authorization` or
  `x-api-key` header is `GATEWAY_ADMIN_SESSION_REQUIRED` (403,
  `details.presented` = `token` or `product_session`), even next to a valid
  admin cookie for a token. A browser signed in to both carries both cookies;
  the admin cookie decides there.
- Product routes never resolve an admin session as a user: the product
  verifiers read only the product cookie and tables. Where the web gateway
  asks api-cf to fail closed (every `/api/v1/*` but the two public
  endpoints), a request whose only credential is an admin session is
  `ADMIN_SESSION_NOT_ACCEPTED` (403, `x-clash-error-code`); elsewhere the
  route's own 401 answers, as for any caller without a product identity. The
  lean metadata Worker likewise answers its own 401.
- In the browser, an admin 401 never signs the product session out
  (`runtimeFetch` in `packages/web-ui/src/lib/runtimeConfig.ts`), and the
  admin sign-out (`/api/admin-auth/sign-out`) leaves the product session
  alone.

## Roles

Roles live in D1. There is no environment-variable grant, and there are no
job roles (#392):

- **Team roles** (`tenant_member.role`, migration 0038): `owner` or `member`,
  nothing else, held by product users. A team role acts on its own team
  only. The owner runs the team (members, budget allocation, keys and
  limits, billing); a member uses the gateway and reads their own usage and
  budget. Owners do all of it in team settings, in the product
  ([gateway-teams.md](gateway-teams.md), #354); the admin console only views
  teams: no role assignment, member or key budget allocation, or key, member
  and team rate limits.
- **Admin account role** (`admin_accounts.role`, migration 0040):
  `platform_admin`, nothing else, held by admin accounts only. It holds every
  permission: every platform permission, and every tenant permission on
  every tenant. Until #394 this was a grant on product users
  (`gateway_platform_role`, 0036); 0040 dropped every such grant (below).

Migration 0038 rewrote every team row (and pending invite) holding an earlier
role to `member` (idempotently), and D1 triggers refuse any role other than
`owner` or `member` from then on.

### Permission matrix

`apps/api-cf/src/services/gateway-authz.ts` is the one authorization module.
Every check names a permission (`authorizeGatewayAccess(access,
"team.budgets.allocate", tenantId)` for a product user's team role,
`authorizeAdminAccess(admin, "catalog.write")` for an admin account); which
role holds which permission is data in that module
(`GATEWAY_TENANT_ROLE_PERMISSIONS`, `GATEWAY_PLATFORM_ROLE_PERMISSIONS`) and
nowhere else, so configurable permission groups could later replace the role
tables without touching a check. Every `/api/v1/admin/gateway/*` route and
every tenant billing route (`/api/v1/gateway/tenants/:tenantId/*`)
authorizes through it. The server answers `GATEWAY_FORBIDDEN` (403,
`details.permission`) whatever the UI shows, and `GATEWAY_AUTH_REQUIRED`
(401) without a credential.

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
| `team.budgets.allocate` |   ✓   |        |       ✓        | team settings (#354)            |
| `keys.read`             |   ✓   |        |       ✓        | team settings; console keys     |
| `limits.write`          |   ✓   |        |       ✓        | team settings (#354)            |
| `billing.read`          |   ✓   |        |       ✓        | `/api/v1/gateway/tenants/:t`    |
| `billing.purchase`      |   ✓   |        |       ✓        | `/api/v1/gateway/tenants/:t`    |

Platform permissions, admin accounts (`platform_admin`) only: `tenants.list`,
`catalog.read`, `catalog.write`, `prices.read`, `prices.write`,
`packages.read`, `packages.write`, `billing.rollover`, `upstreams.read`,
`upstreams.write`, `wallet.adjust`, `subscription.limits.write`,
`admin_accounts.read`, `admin_accounts.write`, `usage.read_all`,
`audit.read_all`, `abuse.read`, `prompts.view`, `retention.purge`,
`holds.sweep`.

The admin console authorizes with `platformRoute`: the caller is the admin
account the middleware verified, and the permission must come from its role.
A team owner never reaches it (a product credential is refused before the
route). Tenant billing uses `tenantRoute`: the product user's role in that
team; admin accounts never reach it (a product route), and correct a wallet
with `wallet/adjust` in the console instead. Console reads such as usage and
audit are platform-wide, and `?tenantId=` narrows them to one tenant.

### Bootstrapping the first admin account

Nobody can create an admin account through the API until one can sign in.
The first is an explicit, idempotent statement, run against a **local or
staging** D1 only; production (`--remote`, `--production`, `--env
production`) is refused:

```bash
# Local dev D1 (apps/web wrangler config, as `make db-local` uses)
node apps/api-cf/scripts/gateway-admin-account.ts --email ops@example.com --local
# Staging, password from the environment instead of the prompt
CLASH_ADMIN_PASSWORD=… node apps/api-cf/scripts/gateway-admin-account.ts --email ops@example.com --name Ops --env staging
# Print the SQL (password hash redacted) and the wrangler command without running them
node apps/api-cf/scripts/gateway-admin-account.ts --email ops@example.com --local --dry-run
```

The password comes from `CLASH_ADMIN_PASSWORD` or a prompt that echoes
nothing (12 to 128 characters), never from the command line (`--password`
is refused), and is never printed. The script hashes it with Better Auth's
own hasher (`better-auth/crypto`) and runs `wrangler d1 execute --file` (so
the hash stays out of the process list) with `INSERT OR IGNORE` into
`admin_accounts` on the unique email, plus the credential row and one
`gateway_admin_audit` row (actor kind `bootstrap`) written only when the
account is new: repeating it changes nothing, the password included. It
never touches the product `users` table. Sign in at `/admin/login`.

Every later account goes through the audited API: `POST /admin-accounts`
creates one, `POST /admin-accounts/:id/disable` signs it out everywhere and
deletes its password. The last enabled admin account cannot be disabled
(`GATEWAY_LAST_ADMIN_ACCOUNT`).

### Migration from product-user grants (0040)

Migration 0040 drops `gateway_platform_role`: `platform_admin` is no longer
stored on product users, and no product user keeps console access. Each
dropped grant is recorded as one audit row (`platform_role.drop`, actor kind
`migration`, the user id as target, the grant as `before`), so who held it
stays on record. The grants are not converted into admin accounts (an admin
account needs its own email and password). To restore access, re-create the
people who need the console as admin accounts: the first with the bootstrap
script above (local or staging), the rest through `POST /admin-accounts`.
Production's first admin account is created by an operator outside this
repository's tooling, as before.

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
  changes, and the actor: `actor_kind` plus `actor_id` (0040) and
  `actor_role`. Console mutations are `admin` with the admin account's
  `adm_…` id and role; team owners' mutations (purchases, team settings) are
  `user` with the product user id and team role; the bootstrap script writes
  `bootstrap`, migration 0040 `migration`. Rows written before 0040 keep
  their actor id and read `user` (or `bootstrap`). Other columns that record
  who acted (the ledger's `actor_user_id`, budget `allocated_by_user_id`,
  price `created_by`) hold the same actor id.

Covered mutations: price drafts and publishes, packages, top-up packs,
billing rollover, subscriptions and top-ups, catalog clone/model
upsert/remove/publish, upstream create/update/disable/rotate/key revoke, wallet
corrections and status, subscription rate limits, admin account creation and
disabling, retention purges that deleted something, hold sweeps that expired
something, and every staff prompt view (whatever its outcome). Team settings
(#354, written by team owners, [gateway-teams.md](gateway-teams.md)) audit the
same way: team creation, invites, role changes and removals (the last owner
is kept, `GATEWAY_LAST_OWNER`), member and key budgets and their overrides,
and key, member and team rate limits.

The log is append-only: there is no update or delete API, and 0036 triggers
refuse `UPDATE` and any `DELETE` of a row younger than 13 months (the
retention job may delete older rows).

## API

All under `/api/v1/admin/gateway`, with an admin account session only.
Errors are coded (`x-clash-error-code`).

| Area           | Routes                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in        | `POST /api/admin-auth/sign-in/email {email, password}`, `POST /api/admin-auth/sign-out`, `GET /api/admin-auth/get-session` (Better Auth)        |
| Access         | `GET /me` (the account, its permissions); `GET/POST /admin-accounts {email, name, password, reason?}`; `POST /admin-accounts/:id/disable`        |
| Catalog        | `GET /catalog`; `GET /catalog/versions/:v`; `POST …/:v/clone {from}`; `PUT/DELETE …/:v/models/:modelCode`; `POST …/:v/publish`                 |
| Prices, packs  | see [gateway-price-book.md](gateway-price-book.md)                                                                                              |
| Upstreams      | `GET/POST /upstreams`; `PATCH /upstreams/:id`; `POST /upstreams/:id/rotate {credential, drain?, reason?}`; `POST /upstreams/:id/revoke {keyVersion, reason?}` |
| Tenants        | `GET /tenants`; `GET /tenants/:t/members` (read-only)                                                                                           |
| Budgets        | `GET /tenants/:t/budgets` (read-only); `POST /tenants/:t/wallet/adjust`; `POST /tenants/:t/wallet/status`                                      |
| Rate limits    | `GET /tenants/:t/keys` (read-only); `PUT /tenants/:t/subscription/rate-limit`; model limits on catalog drafts                                   |
| Reads          | `GET /overview`, `GET /usage`, `GET /audit` (each `?tenantId=` or platform-wide; audit also `?actorKind=&actorId=`); `GET /abuse`               |
| Prompt access  | `POST /prompts/:requestId/access {reason}`; `POST /retention/purge {limit?}`                                                                    |
| Holds          | `POST /holds/sweep {limit?}`: the stale-hold sweeper now ([gateway-data-plane.md](gateway-data-plane.md#stale-hold-sweeper))                       |

**Catalog.** The data plane routes the newest published catalog version as a
whole, so a change is: clone the live version into a draft, upsert or remove
models, publish. Each card must parse as a shared-types `ModelCard` whose id
is the model code (`GATEWAY_CATALOG_MODEL_INVALID`), and DeepSeek is served
through Flash models only (`GATEWAY_CATALOG_MODEL_BLOCKED`). A published
version never changes (`GATEWAY_CATALOG_VERSION_PUBLISHED`).

**Upstream accounts.** Secrets are write-only: either the *name* of a
`GATEWAY_UPSTREAM_*` Worker secret or Cloudflare Secrets Store binding
(`secret_ref`), or an API key sealed at once under `GATEWAY_ENCRYPTION_KEY`
(`GATEWAY_ENCRYPTION_KEY_MISSING`, 503, when the key is not configured;
`GATEWAY_ENCRYPTION_KEY_SHARED`, 503, when it equals the tenant BYOK key
`ACTION_SECRET_KEY`). Responses and errors carry only the credential kind,
field names, `key_version` and `keyPrefix` (at most 8 leading characters and
a quarter of the key, none under 16 characters); the audit log carries no
prefix. A `secret_ref` view also says whether the binding currently resolves
(`secretPresent`). `enabled: false` disables an account for routing. Each
account also shows its circuit-breaker state (`health`), see
[gateway-data-plane.md](gateway-data-plane.md#upstream-keys-and-failover).
Rotation is versioned, below.

### Upstream key rotation

(#350, 0043.) An account holds at most two usable key versions: the
**active** one, sent first, and while a rotation drains the **draining** one,
the previous active version. The data plane retries a key the upstream refuses
(401/403) with the draining version before the first byte, so a new key the
upstream does not accept yet falls back to the old one instead of failing the
request.

1. **Add vN+1**: `POST /upstreams/:id/rotate {credential}`. The new version
   becomes active and the previous active version drains (`draining`, with
   `since`). While a version drains, another rotation is
   `GATEWAY_UPSTREAM_ROTATION_IN_PROGRESS` (409): one rotation at a time.
2. **Drain**: traffic uses the new key; the old one serves only refused-key
   retries. Watch the circuit (`health`) and the `gateway.upstream_key_refused`
   log (it names the version, never the key).
3. **Revoke**: `POST /upstreams/:id/revoke {keyVersion}`. Revoking the
   draining version ends the drain. Revoking the active version while one
   drains rolls back to the draining version. The only key left is never
   revoked (`GATEWAY_UPSTREAM_LAST_KEY`, 409): rotate or disable the account.
   An unknown version is `GATEWAY_UPSTREAM_KEY_VERSION_NOT_FOUND` (404).

`drain: false` on rotate revokes every previous version at once (a leaked
key). Version numbers are never reused (`key_serial`, the response's
`nextKeyVersion`). Every rotate and revoke is one D1 batch with its audit row
(`upstream.rotate`, `upstream.revoke_key`; versions in `before`/`after` and a
`revoked` list) and clears the account's circuit, because its failures were
the old key's. A Secrets Store or Worker secret is created and deleted with
`wrangler` on staging; the console only names it.

**Budgets.** The console shows the wallet and the member and key budgets
(enforcement, limit, spent, held). The team owner allocates them in team
settings ([gateway-teams.md](gateway-teams.md)). The wallet itself changes
only through purchases and platform corrections: `wallet/adjust` posts a
ledger `adjust` entry (`ref_kind` `admin_credit`/`admin_debit`, the reason,
one idempotency key per correction) and `wallet/status` suspends or
reactivates it.

**Rate limits.** `rate_limit_json` on keys, members, teams, catalog models,
upstream accounts, packages and subscriptions is validated with one schema
(`GatewayRateLimitSchema` in `@clash/gateway-core`: `requestsPerMinute`,
`tokensPerMinute`, `concurrency`, `mediaJobs`, positive integers, at least
one, no unknown fields) and enforced by `d1-limits.ts`. `null` clears a
limit. The console sets the catalog's, the upstreams' and the
subscription's; key, member and team limits are the owner's.

**Abuse.** Only live counters exist today (`gateway_rate_window`,
`gateway_inflight`, every subject prefixed with its tenant: `tenant:<t>…`).
Denied requests (rate-limited, forbidden) are not recorded, so the response
states `events.available: false` rather than showing an empty list as if
nothing happened.

## Staff prompt access and body retention

Product decision 2026-10-20 (it replaces the earlier "no body storage"
rule): the hosted gateway keeps each request's prompt **and** response for 30
days so platform staff can view them. Viewing is for admin accounts only
(`platform_admin`) and audited.

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
- the row has `response_truncated = 1` and `response_observed_bytes` (0039);
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
(admin accounts only; team owners' and members' product credentials get
`GATEWAY_ADMIN_SESSION_REQUIRED`) and
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
  admin accounts only), audited as `retention.purge` when it deleted
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
`/api/v1/admin/gateway/me` before the page's API, redirects to the admin
sign-in `/admin/login?returnTo=` (never the product `/login`) on 401 or on
`GATEWAY_ADMIN_SESSION_REQUIRED` (only a product session), throws a coded 403
route error (`GATEWAY_FORBIDDEN`) when the admin account's permissions do not
include the page's (the page's API is then never called), and a 404 route
error (`ADMIN_CONSOLE_UNAVAILABLE`) where the deployment has no admin API.
The server still authorizes every call. Tenant-scoped pages read `?tenant=`
(chosen from the tenant list) and show it with a way back to all tenants.

`/admin/login` (`admin.login.tsx`, `AdminLogin`) signs in through
`/api/admin-auth/sign-in/email` and shows Better Auth's coded refusal
(`INVALID_EMAIL_OR_PASSWORD`, `ADMIN_ACCOUNT_DISABLED`, `HTTP_429`). An
already signed-in admin is sent back to `returnTo`, which must be a console
page (`/admin…`, never another origin, a product page or the sign-in itself);
otherwise to `/admin`. The console header shows the signed-in account and a
**Sign out** button (`/api/admin-auth/sign-out`, then `/admin/login`).

| Path               | Page                                                  | Opens with       |
| ------------------ | ----------------------------------------------------- | ---------------- |
| `/admin/login`     | Admin account sign-in                                 | (no session)     |
| `/admin`           | Overview                                              | `usage.read_all` |
| `/admin/models`    | Catalog versions and price book                       | `catalog.read`   |
| `/admin/upstreams` | Upstream accounts                                     | `upstreams.read` |
| `/admin/users`     | Tenants, their members and roles (read-only), admin accounts | `tenants.list`   |
| `/admin/budgets`   | Wallet and its corrections, budgets and key limits (read-only), subscription rate limit | `tenants.list`   |
| `/admin/packages`  | Packages and top-up packs                             | `packages.read`  |
| `/admin/usage`     | Ledger, per-model totals, prompt viewer               | `usage.read_all` |
| `/admin/abuse`     | Live rate-limit counters                              | `abuse.read`     |
| `/admin/audit`     | Audit log                                             | `audit.read_all` |

Components live in `packages/web-ui/src/components/admin/` with the typed
client `packages/web-ui/src/lib/adminClient.ts`; controls the caller's grants
cannot use are not rendered, and failed actions show the coded error inline.

On `/admin/upstreams` (`AdminUpstreams`), each account shows its active and
draining key versions with their prefixes (an unbound `secret_ref` is marked
`unbound`) and its circuit. With `upstreams.write`, **Rotate key** adds
`nextKeyVersion` (optionally revoking the previous versions at once), and
while a version drains **Revoke vN** ends the drain and **Roll back to vN**
revokes the active version, each with an optional audit reason.

On `/admin/usage`, when `/me` reports `promptAccess` (the flag is on and the
caller holds `prompts.view`), each `settle` row has a **View** button and a
request-id field opens the same viewer (`AdminPromptViewer`, the shared
Radix dialog). The viewer asks for a reason, makes the audited call, and
shows the request and response bodies verbatim with their size and SHA-256,
or the coded error (expired, not retained).

## Tests

- `apps/api-cf/src/services/gateway-authz.test.ts`: matrix properties; the
  retired environment-variable grant, the removed team roles and the dropped
  product-user grant table are gone from code, tests and docs.
- `apps/api-cf/src/routes/v1/admin/admin-identity.test.ts`: admin sign-in,
  session and sign-out on the admin instance (only `clash-admin` cookies,
  rows in `admin_sessions`, never `users`/`sessions`), closed sign-up, the
  sign-in rate limit, a disabled account refused; every
  `/api/v1/admin/*` route **read from the route table** answers 401 without a
  credential and 403 `GATEWAY_ADMIN_SESSION_REQUIRED` to a product session,
  `clsh_`, `sk_gw_`, `x-api-key` or a spoofed `x-user-id`; every product
  `/api/v1` route from its route table answers 403
  `ADMIN_SESSION_NOT_ACCEPTED` to an admin session; admin accounts created
  and disabled through the API with the admin account as audit actor, and
  the last enabled one kept.
- `apps/api-cf/src/gateway/admin-accounts-migration.test.ts`: 0040 drops every
  product-user `platform_admin` grant with one `migration` audit row each,
  keeps earlier audit rows (actor kind backfilled) and the log append-only,
  and starts the admin store empty.
- `apps/api-cf/src/gateway/team-roles-migration.test.ts`: 0038 maps earlier
  team roles to `member`, is idempotent, and D1 refuses any other role.
- `apps/api-cf/src/routes/v1/admin/gateway-console.test.ts`: every console
  route refused to team owners' and members' product credentials, tenant
  billing per role through the Worker, team role changes keeping one owner,
  teams view-only (every team write route is absent from the console),
  audit per mutation (actor = the admin account, or the team owner for team
  settings) and rollback when the audit write fails, upstream secret
  custody, key rotation (vN+1 with drain, revoke, rollback, never-reused
  versions, audit rows holding no key or prefix, a KEK shared with BYOK
  refused), rate-limit validation; staff prompt
  view (admin accounts only, the stored bytes, every view audited without
  the body, nothing disclosed when the audit fails, expiry before purge,
  idempotent purge, a truncated stream copy); the hold sweep (admin accounts
  only, expires once, audited only when it changed something).
- `packages/gateway-core/src/retention.test.ts` and the contract cases
  (`retention`, data plane): body stored on success and on upstream error,
  credentials never stored, coded failure with unchanged billing, expiry,
  integrity, purge retry. They run on the memory stub, D1 on node:sqlite and
  D1 + R2 in workerd (`gateway-data-plane.integration.test.ts`, which also
  views a stored request through the Worker).
- `apps/api-cf/src/gateway/admin-account-bootstrap.test.ts`: the bootstrap
  creates one admin account (never a product user) whose password Better
  Auth verifies, is idempotent, refuses production and `--password`, and
  never prints the hash.
- `apps/web/app/routes/admin.test.ts`: loader guard (redirect to
  `/admin/login` without an admin session or with only a product session,
  403 without calling the page API, unavailable deployment, tenant scoping)
  and the sign-in route (form without a session, safe `returnTo`).
- `packages/web-ui/src/components/admin/*.test.tsx`,
  `packages/web-ui/src/lib/adminClient.test.ts`: permission-gated controls,
  write-only secrets, coded errors shown inline, request shapes, the prompt
  viewer (reason required, stored bytes shown unchanged, coded expiry); the
  admin sign-in form and sign-out (admin endpoints only, coded refusals),
  admin accounts create/disable, and an admin 401 never signing the product
  session out.
