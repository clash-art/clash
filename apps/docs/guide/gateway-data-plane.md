# Gateway Data Plane

The Clash official model gateway serves model calls at `/gateway/v1/*` (#347).
The HTTP handler is `createGatewayApp` in `@clash/gateway-core`
(`packages/gateway-core/src/app.ts`), a plain fetch handler built only on
`GatewayPorts`. The Workers/D1 adapter (`apps/api-cf/src/gateway/`) supplies
the ports and is mounted in `apps/api-cf/src/routes/gateway.ts`, next to
`GET /gateway/me`. The web Worker forwards `/gateway/*` to api-cf.

## Endpoint

`POST /gateway/v1/chat/completions` takes an OpenAI-compatible, **non-streaming**
chat request with `Authorization: Bearer sk_gw_…` ([gateway tokens](gateway-tokens.md)).
It returns the upstream completion with `model` set to the requested public model
code, plus `x-clash-request-id`. An optional `Idempotency-Key` header admits a
request once per tenant.

`stream: true` is rejected with `GATEWAY_CAPABILITY_UNAVAILABLE` (501,
`param: "stream"`) until SSE support lands. Any other path under `/gateway/v1`
also answers 501.

## Request flow

1. **Identity** comes only from the `sk_gw_` token row, which must carry the
   `models:invoke` scope. Headers such as `x-user-id` are never read.
2. **Normalize** the body. It must be valid JSON within the size limit.
3. **Admission** (`admitGatewayRequest`):
   - check the model allowlist;
   - apply the catalog policy;
   - plan routes over the published catalog and official accounts;
   - price the first route;
   - compute the hold;
   - check rate and concurrency limits;
   - reserve the hold on every budget.
4. **Upstream** calls go through the `upstream.fetch` port and follow the plan's
   failover order. Only `openai-compatible` text routes without an executor
   plugin can serve this protocol. The upstream receives the gateway's
   `Authorization` header and nothing from the caller. Upstream error bodies
   are discarded because they can echo key fragments.
5. **Settlement** runs exactly once: a completion is charged its reported usage,
   or an estimate when no usage is reported. A failure is charged zero.

**DeepSeek is Flash only:** `applyGatewayCatalogPolicy` drops a DeepSeek card
that is not a Flash card, and drops every non-Flash upstream implementation of
a Flash card.

## Error codes

Errors use the OpenAI error shape plus `x-clash-error-code`:

| Condition                                          | Code                                    |
| -------------------------------------------------- | --------------------------------------- |
| No, unknown, expired or revoked token              | `GATEWAY_AUTH_REQUIRED` / `_EXPIRED` / `_REVOKED` 401 |
| Missing `models:invoke` scope, tenant mismatch     | `GATEWAY_FORBIDDEN` 403                 |
| Model outside the token allowlist                  | `GATEWAY_MODEL_NOT_ALLOWED` 403         |
| Model not in the published catalog                 | `GATEWAY_MODEL_NOT_FOUND` 404           |
| No budget row, or the budget is exhausted or suspended | `GATEWAY_BUDGET_EXCEEDED` 402      |
| Rate or concurrency limit                          | `GATEWAY_RATE_LIMITED` / `GATEWAY_CONCURRENCY_LIMITED` 429 |
| Upstream 5xx/429, network error or invalid body    | `GATEWAY_UPSTREAM_ERROR` / `GATEWAY_ROUTES_EXHAUSTED` 502 |
| Upstream deadline                                  | `GATEWAY_UPSTREAM_TIMEOUT` 504          |
| Upstream 4xx                                       | `GATEWAY_UPSTREAM_REJECTED` 400         |
| No usable official key or route                    | `GATEWAY_KEY_UNAVAILABLE` / `GATEWAY_NO_ROUTE` 503 |

## D1 ports

| Port          | Store                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------- |
| `identity`    | `gateway_token` (`services/gateway-tokens.ts`)                                              |
| `routes`      | Catalog: published `gateway_model.card_json` at the newest started `published_at`. Price book: `gateway_price` (exact upstream rows win over `''` rows; credits only). Accounts: `gateway_upstream_account` (official only; tenant BYOK returns no accounts). |
| `credentials` | `gateway_upstream_account`: `secret_ref` names a `GATEWAY_UPSTREAM_*` Worker secret (an API key or `{apiKey, baseUrl}` JSON). Alternatively, `encrypted_credentials` is sealed with the shared secret envelope under `GATEWAY_ENCRYPTION_KEY`, which is distinct from `ACTION_SECRET_KEY`. Failures are `GATEWAY_KEY_UNAVAILABLE`. |
| `budgets`     | `gateway_budget` + `gateway_usage_ledger`: an all-or-nothing reserve in one D1 batch, and settle in one batch. A caller with no budget row is refused. |
| `ledger`      | Reads `settle` rows of one tenant.                                                          |
| `limits`      | `rate_limit_json` from the virtual key (per key), the published model (per user and model) and the active subscription (per tenant). Counted in `gateway_rate_window` and `gateway_inflight` (0034). |
| `blobs`, `scheduler`, `audit` | `unavailablePort` (501) until their issues land.                                 |

D1 columns are unix seconds; the core is epoch milliseconds. Conversion
happens in `apps/api-cf/src/gateway/d1-common.ts`.

**Not yet implemented:**

- reset of periodic (`daily`/`monthly`) budgets, so they keep counting;
- the hold sweeper (a hold whose settlement failed stays open);
- streaming;
- the Anthropic Messages protocol.

## Tests

The gateway-core contract suite (`describeGatewayContract`) includes
non-stream chat cases that drive `createGatewayApp` with a fetch-stub
upstream. It runs against:

- the in-memory stub (`packages/gateway-core`);
- the D1 ports on node:sqlite (`apps/api-cf/src/gateway/d1-gateway.test.ts`);
- the D1 ports in miniflare/workerd
  (`apps/api-cf/src/integration/gateway-data-plane.integration.test.ts`).
