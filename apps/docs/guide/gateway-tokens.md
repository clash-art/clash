# Gateway Tokens

Short-lived `sk_gw_…` tokens let a Desktop/Host, Web or CLI caller hand a
model gateway credential to an agent runtime without handing over the user's
session or a non-expiring `clsh_` token (#346). Implementation:
`apps/api-cf/src/services/gateway-tokens.ts`; routes:
`apps/api-cf/src/routes/v1/gateway-tokens.ts` and `apps/api-cf/src/routes/gateway.ts`.

## Lifecycle

| Call                                   | Credential                    | Result                                                                                       |
| -------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| `POST /api/v1/gateway/tokens`          | Better Auth session or `clsh_` | `201 { token, tokenType, expiresAt, baseUrl, keyId, tenantId, scopes, modelAllowlist }`      |
| `POST /api/v1/gateway/tokens/:id/renew` | the same parent credential    | `200 { keyId, expiresAt }`; the token string is unchanged                                    |
| `DELETE /api/v1/gateway/tokens/:id`    | session or `clsh_` of the owner | `204`, idempotent                                                                           |
| `GET /gateway/me`                      | `Authorization: Bearer sk_gw_…` | `{ userId, tenantId, keyId, scopes, modelAllowlist, credentialScope, expiresAt }`            |

- **TTL** is 15 minutes. Renewal extends a live, unrevoked token by one TTL and
  only for its own parent (the same session, or the same `clsh_` token). An
  expired token is not renewed; mint a new one.
- **Mint body** (all optional): `tenantId` (default `personal:<userId>`, created
  on first use; any other tenant requires `tenant_member`), `scopes`
  (`models:invoke` by default; `usage:read`), `modelAllowlist` (omitted means the
  whole published catalog). Tokens are always `official` credential scope; BYOK
  selection is a later product decision.
- **An `sk_gw_` token is never a parent**: it cannot mint, renew or revoke.
- `baseUrl` is the gateway surface the token is presented to
  (`<public origin>/gateway`). The web Worker forwards `/gateway/*` to api-cf.

## Storage

`gateway_token` (0032) plus `parent_kind`/`parent_id` (0033). Only the SHA-256
of the whole token is stored, with scopes, allowlist, tenant, user and the
parent reference: `session` → `sessions.id`, `api_token` → `api_token.id`.
Rows minted from a virtual key use `key_id` and leave the parent NULL.
Gateway columns are unix seconds; Better Auth's `sessions.expires_at` is epoch
milliseconds; `gateway-core` is epoch milliseconds. The service converts.

## Verification

`createGatewayTokenStore(db).verify(request, { tenantId?, scope?, model? })`
and `createD1GatewayIdentityPort(db)` (the `gateway-core` identity port) run
one D1 query: token row, parent liveness, tenant membership and budget ids.
Identity comes from that row only. `/gateway/*` sits outside the `/api/*`
session middleware, and no header, `x-user-id` included, is read as identity.

| Condition                                                     | Code                         |
| ------------------------------------------------------------- | ---------------------------- |
| No bearer, not an `sk_gw_` token, unknown token               | `GATEWAY_AUTH_REQUIRED` 401  |
| Revoked, or the parent session/`clsh_`/key is gone            | `GATEWAY_TOKEN_REVOKED` 401  |
| Past `expires_at`                                             | `GATEWAY_TOKEN_EXPIRED` 401  |
| Not a member of the token's tenant, or a route of another tenant | `GATEWAY_FORBIDDEN` 403    |
| Missing scope                                                 | `GATEWAY_FORBIDDEN` 403      |
| Model outside the allowlist                                   | `GATEWAY_MODEL_NOT_ALLOWED` 403 |

Errors use the OpenAI error shape with `x-clash-error-code`; `details` carry a
reason and non-secret ids only. Neither responses nor logs contain the token.

## Desktop Host handoff (Clash official provider)

The Local Host (`apps/local-api/src/official-gateway.ts`, #357/#358) is the only
desktop caller. It mints with the `clsh_` token saved by the cloud sign-in and
passes the `sk_gw_` token to an ACP agent's gateway auth method when one exists
(the `fields` method with `baseUrl` and `api-key`; `providerName` is `clash`).
When the harness has no gateway method, #358 runtime adapters inject the same
base URL + key through Clash-owned Codex `CODEX_HOME`, Pi `PI_CODING_AGENT_DIR`
(fallback), or dsh session env (`DEEPSEEK_*`, Flash-only). Spike:
`docs/spikes/gateway-runtime-adapters-358.md`. The renderer never sees the
token. ACP and Codex/dsh adapters keep it out of durable Host state; Pi's
fallback may write it into the Clash-owned `models.json` and scrubs it on
sign-out. User `~/.codex` / `~/.pi` are never opened. The Host persists only
the key id, expiry and service per agent, plus the user's priority.

| Host route                                                     | Purpose                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /api/v1/local/official-gateway`                           | Sign-in, key state/expiry, agents on the official key, last coded error |
| `PATCH /api/v1/local/official-gateway` `{ priority }`          | `byok-first` (default) or `official-first`                              |
| `POST /api/v1/local/harnesses/:id/authenticate` `{ credential_source: "clash-official" }` | Mint and hand off to this agent           |

- **Priority is the user's.** `byok-first` keeps an agent's own sign-in or key
  and uses Clash official only for agents with none; `official-first` hands
  off whenever the user is signed in. Authenticating an agent with its own
  credential removes its official handoff.
- **Lifecycle.** A token is minted at sign-in for the first handoff. Before a
  session starts, a handoff within two minutes of expiry is renewed; an expired
  or revoked one is re-minted. A session 401 (`GATEWAY_TOKEN_EXPIRED`,
  `GATEWAY_TOKEN_REVOKED`, or a bare 401 on an official handoff) re-mints once
  per 30 s and restarts the agent after the turn. Sign-out revokes every token
  the Host minted before the credential is deleted.
- **No fallback.** Signed out, offline, or with a rejected sign-in, the official
  path fails with `GATEWAY_AUTH_REQUIRED`; there is no platform key.
- **Coded errors.** Session errors carry `gateway_code` and read
  `CODE: message` for `GATEWAY_AUTH_REQUIRED`, `GATEWAY_TOKEN_EXPIRED`,
  `GATEWAY_TOKEN_REVOKED`, `GATEWAY_MODEL_NOT_ALLOWED` and
  `GATEWAY_BUDGET_EXCEEDED` (not re-minted). The table lives in
  `packages/shared-types/src/official-gateway.ts`.

## Sign-out cascade

Both Better Auth instances (web Worker and api-cf) install
`gatewaySessionDatabaseHooks` from `@clash/shared-cloud-schema/gateway`. A
deleted session row (sign-out, revoke-session(s), user deletion) sets
`revoked_at` on its child tokens. Verification also requires the parent row,
so a failed cascade write cannot keep a token alive; deleting a `clsh_` token
ends its children the same way.
