# Gateway Teams, Budgets and Rate Limits

Team settings (#354) are where a **team owner** runs a team on the Clash
official model gateway: members and roles, invites, the team wallet's
packages and top-ups, member and key budgets, and rate limits. They live in
the product (`/team` in `apps/web`), on the product session. The admin
console only views teams ([gateway-admin.md](gateway-admin.md)). Tables are in
[gateway-schema.md](gateway-schema.md), the wallet and purchases in
[gateway-price-book.md](gateway-price-book.md), and the request flow in
[gateway-data-plane.md](gateway-data-plane.md).

## Roles

Team roles are `owner` and `member` (`tenant_member.role`, 0038). The
permission matrix in `apps/api-cf/src/services/gateway-authz.ts` decides every
call:

- the **owner** holds every tenant permission: members and roles
  (`team.members.*`), budget allocation (`team.budgets.allocate`), keys and
  limits (`keys.read`, `limits.write`), billing (`billing.*`), usage and audit;
- a **member** holds `usage.read_own` and `budgets.read_own`: their own role,
  budget, keys, usage and budget notifications, nothing of anyone else's.

The server answers `GATEWAY_FORBIDDEN` (403, `details.permission`) whatever
the UI shows. A team keeps at least one owner (`GATEWAY_LAST_OWNER`, 409) when
a role changes or a member is removed.

## Teams and invites

| Step    | What happens                                                                                                                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create  | `POST /teams {name}` creates a `team` tenant (`team:<hex>`) with the caller as owner.                                                                                                                                        |
| Invite  | `POST /tenants/:t/invites {email, role}` returns the invite secret once, with `acceptPath` (`/team/invite?token=…`). Only its SHA-256 is stored. It is valid for 7 days. A member's email is `GATEWAY_MEMBER_EXISTS`; a second pending invite for the email is `GATEWAY_INVITE_EXISTS`. |
| Lookup  | `POST /invites/lookup {token}`: the team and role the link offers, never the secret.                                                                                                                                         |
| Accept  | `POST /invites/accept {token}`: the signed-in account's email must be the invited one (`GATEWAY_INVITE_EMAIL_MISMATCH`, 403). The membership, the invite's `accepted` status and the audit row (actor: the new member) are one batch. |
| Refused | A revoked, accepted or unknown invite is `GATEWAY_INVITE_NOT_FOUND` (404); an expired one `GATEWAY_INVITE_EXPIRED` (410).                                                                                                   |
| Revoke  | `DELETE /tenants/:t/invites/:inviteId`.                                                                                                                                                                                       |
| Remove  | `DELETE /tenants/:t/members/:userId`. The member's virtual keys in the team are revoked in the same batch; their gateway tokens stop verifying because the membership is gone. Budgets and ledger rows stay as history.     |

A personal workspace (`personal:<userId>`) has no members to manage:
invites and removals there are `GATEWAY_TENANT_NOT_TEAM` (409).

## The team wallet

The team buys packages and top-ups as a whole (#352): the owner subscribes or
buys from team settings (`billing.purchase`), and the credits fund the team's
`tenant` budget, the wallet every member's requests draw on. A member cannot
buy. `GET /tenants/:t/billing/offers` lists the active packages and top-up
packs. The wallet is always `hard`: purchased credits are the ceiling.

## Budgets the owner allocates

`PUT /tenants/:t/budgets/(user|key)/:id` sets a member's or a key's budget
under the wallet. A request draws on the wallet, the member's budget and the
key's budget together, and holds the full amount on each (stream and
non-stream alike, before any byte is sent).

| Field               | Meaning                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `limitMicroCredits` | The cap; `null` is explicitly unlimited (the wallet still caps it).                                                           |
| `enforcement`       | `hard`, `soft` or `alert` (below). A new budget is `hard`; omitted keeps the current one.                                   |
| `alertThresholdPct` | 1-100: raise an alert at this share of the limit, on any enforcement. `null` clears it. An `alert` budget without one alerts at 100%. |
| `status`            | `active` or `suspended` (a suspended budget refuses every request).                                                          |
| `override`, `reason` | A limit below what is already used and reserved is `GATEWAY_BUDGET_BELOW_USAGE` (409) unless `override: true` with a `reason`; the audit row is then `budget.override` with the reason and the usage it overrode. |

Enforcement is explicit; no budget state is silent:

| Enforcement | A hold that does not fit under the limit                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hard`      | Refused: `402 GATEWAY_BUDGET_EXCEEDED` naming the budget (`budget_id`, `reset_at`), before any upstream call.                                              |
| `soft`      | Admitted and flagged: a `soft_exceeded` budget event for that request, the `x-gateway-budget` answer header, and the `gateway.budget_soft_exceeded` log.   |
| `alert`     | Admitted. Crossing the threshold records one `alert_threshold` event per limit and threshold (a new limit or threshold may alert again), with the header and the `gateway.budget_alert` log. |

The events (`gateway_budget_event`, 0041) are written in the reservation's
own batch, so a flag exists exactly when the hold does. The owner sees them
under *Budget notifications*; a member sees their own. The answer header is
`x-gateway-budget: <soft_exceeded|alert_threshold>; budget_id=<id>; scope=<user|key>`
(comma-separated when several), on plain answers and on the stream's headers.

Budgets show their limit, used (`spentMicroCredits`), reserved (open holds)
and what is left.

## Rate limits

Every limit is configuration (`rate_limit_json`), validated with one schema,
`GatewayRateLimitSchema` in `@clash/gateway-core`: `requestsPerMinute`,
`tokensPerMinute`, `concurrency` (requests in flight) and `mediaJobs`
(media/AIGC generations in flight), positive integers, at least one, no
unknown fields (`GATEWAY_INVALID_REQUEST` otherwise). `null` clears a limit.
There is no built-in product default.

| Scope  | Set by                                           | Route                                       | Counted as                      |
| ------ | ------------------------------------------------ | ------------------------------------------- | ------------------------------- |
| Key    | Team owner                                       | `PUT /tenants/:t/keys/:keyId/rate-limit`    | `tenant:<t>:key:<k>`            |
| Member | Team owner                                       | `PUT /tenants/:t/members/:userId/rate-limit` | `tenant:<t>:user:<u>`           |
| Team   | Team owner (`tenant.rate_limit_json`) and the package (subscription, platform) | `PUT /tenants/:t/rate-limit` | `tenant:<t>`, the tighter bound per field |
| Model  | Platform (catalog)                               | admin console                                | `tenant:<t>:model:<m>:user:<u>` |

Every counter starts with its tenant, so one team's burst never throttles
another, even for a user in both. A denial is `429` with `Retry-After` (whole
seconds) and `GATEWAY_RATE_LIMITED` (windows) or `GATEWAY_CONCURRENCY_LIMITED`
(in flight), `details.scope` naming the scope. A stored limit that does not
parse fails closed (`GATEWAY_INTERNAL`).

## API

All under `/api/v1/gateway`, with a product session or `clsh_` token. Errors
are coded (`x-clash-error-code`).

| Route                                              | Permission                         |
| -------------------------------------------------- | ---------------------------------- |
| `GET/POST /teams`                                  | signed in                          |
| `POST /invites/lookup`, `POST /invites/accept`     | signed in (accept: invited email)  |
| `GET /tenants/:t`, `PUT /tenants/:t/rate-limit`    | `tenant.read`, `limits.write`      |
| `GET /tenants/:t/members`                          | `team.members.read`                |
| `PUT …/members/:userId/role`, `DELETE …/members/:userId` | `team.members.manage`        |
| `PUT …/members/:userId/rate-limit`                 | `limits.write`                     |
| `GET/POST …/invites`, `DELETE …/invites/:id`       | `team.members.read` / `.manage`    |
| `GET …/budgets` (wallet, budgets, notifications)   | `budgets.read`                     |
| `PUT …/budgets/(user\|key)/:id`                    | `team.budgets.allocate`            |
| `GET …/keys`, `PUT …/keys/:keyId/rate-limit`       | `keys.read`, `limits.write`        |
| `GET …/usage` (filters, `cursor`), `GET …/usage/export` (CSV), `GET …/audit` | `usage.read`, `audit.read` |
| `GET …/billing`, `GET …/billing/offers`            | `billing.read`                     |
| `POST …/subscription`, `…/subscription/cancel`, `…/topups` | `billing.purchase`         |
| `GET …/me` (own role, budget, keys, usage)         | `usage.read_own` + `budgets.read_own` |
| `GET …/me/usage` (filters, `cursor`), `GET …/me/usage/export` | `usage.read_own` (always the caller) |

Usage rows carry billing facts only (model code, status, tokens, credits),
never the upstream or account that served them. A failed media generation
appears at zero with `notCharged: true`. See [gateway-usage.md](gateway-usage.md).

## Audit

Every team mutation writes one `gateway_admin_audit` row in the same D1 batch
(actor kind `user`, the product user and their team role), or nothing at all:
`team.create`, `invite.create`, `invite.revoke`, `invite.accept`,
`member.role`, `member.remove`, `budget.create`/`update`/`override`,
`key.rate_limit`, `member.rate_limit`, `tenant.rate_limit`, plus the billing
actions. A batch whose audit row cannot be written rolls back with
`GATEWAY_CONFLICT`. The owner reads the team's log in team settings.

## UI

`/team` (`apps/web/app/routes/team.tsx`) picks a team (`?team=`, else the
caller's first team) and renders `TeamSettings`
(`packages/web-ui/src/components/team/`): for an owner, members and roles,
invites (the link shown once), the wallet with packages and top-ups, budgets
(enforcement, limit, used, reserved, left, alert threshold) with the
allocation form and override, budget notifications, team, member and key
rate limits, usage and the audit log; for a member, only their own budget,
keys, notifications and usage. `/team/invite?token=` (`team.invite.tsx`)
shows what the link offers and joins. Without a product session, both send
the caller to `/login` and back. Refusals show their code inline.

## Tests

- `apps/api-cf/src/routes/v1/gateway-team.test.ts`: invite/accept/revoke,
  expiry and email checks, role changes and removal with the last-owner
  guard, audit per mutation and rollback without it, the permission matrix per
  role, owner-only purchases, hard/soft/alert on plain and streamed requests,
  overrides with a reason, a member's own view, rate-limit validation and a
  `429` with `Retry-After`.
- `apps/api-cf/src/gateway/d1-limits.test.ts`: member and team limits,
  tightest of team and subscription, media jobs, tenant-scoped counters,
  fail-closed config.
- The gateway-core contract (memory, node:sqlite, workerd) covers hard, soft
  and alert reservations at the port and through the data plane, plain and
  streamed.
- `packages/web-ui/src/components/team/TeamSettings.test.tsx` and
  `apps/web/app/routes/team.test.ts`: request shapes, inline codes, no owner
  control for a member, loader sign-in and member-only loading.
