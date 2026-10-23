# Gateway Data Plane

The Clash official model gateway serves model calls at `/gateway/v1/*` (#347).
The HTTP handler is `createGatewayApp` in `@clash/gateway-core`
(`packages/gateway-core/src/app.ts`), a plain fetch handler built only on
`GatewayPorts`. The Workers/D1 adapter (`apps/api-cf/src/gateway/`) supplies
the ports and is mounted in `apps/api-cf/src/routes/gateway.ts`, next to
`GET /gateway/me`. The web Worker forwards `/gateway/*` to api-cf.

## Endpoint

`POST /gateway/v1/chat/completions` takes an OpenAI-compatible chat request
with `Authorization: Bearer sk_gw_…` ([gateway tokens](gateway-tokens.md)).
Without `stream`, it returns the upstream completion with `model` set to the
requested public model code, plus `x-clash-request-id`. With `stream: true` it
streams Server-Sent Events (see [Streaming](#streaming)). An optional
`Idempotency-Key` header admits a request once per tenant: one upstream call
and one ledger row, whatever the caller retries.

Any other path under `/gateway/v1` answers `GATEWAY_CAPABILITY_UNAVAILABLE` (501).

## Anthropic Messages

`POST /gateway/anthropic/v1/messages` (#349) serves the Anthropic Messages
API to Anthropic clients such as Claude Code through `claude-agent-acp`
(`ANTHROPIC_BASE_URL=<origin>/gateway/anthropic`). It runs the same flow as
chat completions: identity, admission, hold, limits, failover, exactly-once
settlement and retention. Only the protocol differs (`ANTHROPIC_MESSAGES` in
`app.ts`, pieces in `packages/gateway-core/src/anthropic.ts`):

- **Credential.** The same `sk_gw_` token, as `Authorization: Bearer` or as
  `x-api-key` (the Anthropic SDK default). A Bearer header with no token
  (`claude-agent-acp` gateway auth sets a blank `ANTHROPIC_AUTH_TOKEN`) falls
  back to `x-api-key`. Only the token reaches the identity port.
- **Model.** Agents send Anthropic model ids, so `resolveAnthropicModelCode`
  maps the id onto a catalog public code before the allowlist: an exact card
  id, then a card alias, then the card whose `anthropic-compatible`
  implementation has that upstream model. Each rule is tried for the id and
  for its undated form (a `-YYYYMMDD` suffix removed). An id several cards
  match is `GATEWAY_MODEL_NOT_FOUND`, so a call is never billed to a model the
  caller did not pick. The ledger, limits and answers all see the public code.
- **Routes.** Only `anthropic-compatible` text routes without an executor
  plugin, and never a DeepSeek route; an OpenAI-compatible route never
  receives the Anthropic wire format.
- **Upstream headers.** The gateway's own `x-api-key`, the caller's
  `anthropic-version` (default `2023-06-01`) and `anthropic-beta`, and nothing
  else. The body (`system`, `tools`, `tool_use`/`tool_result` blocks,
  `cache_control`, `thinking`) is forwarded as sent, with `model` replaced by
  the route's upstream model.
- **Answers.** A plain answer has `model` set to the public code. A stream is
  relayed event by event (`message_start`, `content_block_*`, `ping`,
  `message_delta`, `message_stop`), with `model` and `message.model` set to the
  public code. Usage comes from `message_start` (input, cache read, cache
  write) and `message_delta` (output); a stream that ends without
  `message_delta` settles `partial` and ends with an Anthropic `error` event.
  Errors use the Anthropic error body (`{"type":"error","error":{…}}`) with
  the same codes and `x-clash-error-code`.

`POST /gateway/anthropic/v1/messages/count_tokens` is authenticated,
model-mapped, allowlisted and rate-limited the same way, then proxied to the
planned routes in failover order. It generates nothing, so it reserves no hold
and writes no ledger row. Any other path under `/gateway/anthropic/v1` answers
`GATEWAY_CAPABILITY_UNAVAILABLE` (501) in the Anthropic shape.

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
   - check rate and concurrency limits (tenant-scoped counters; media jobs for
     a media generation);
   - reserve the hold on every budget: the wallet, the member's and the key's.
     A `hard` budget the hold does not fit refuses (402); a `soft` or `alert`
     budget admits and records a flag, reported as the `x-gateway-budget`
     header ([gateway-teams.md](gateway-teams.md)).
4. **Upstream** calls go through the `upstream.fetch` port and follow the plan's
   failover order. Only `openai-compatible` text routes without an executor
   plugin can serve chat completions (see [Anthropic Messages](#anthropic-messages)
   for that protocol). The upstream receives the gateway's `Authorization`
   header and nothing from the caller. Upstream error bodies
   are discarded because they can echo key fragments.
5. **Settlement** runs exactly once: a completion is charged its reported usage,
   or an estimate when no usage is reported. A failure is charged zero.
6. **Retention** (hosted only, `GATEWAY_STAFF_PROMPT_ACCESS=enabled`): after
   settlement, the normalized request body and the exact answer bytes go to R2
   for 30 days, with a metadata row in `gateway_request_retention`. The answer
   bytes are the completion, the coded error after an upstream failure, or
   the stream as the caller received it. Headers are never stored, so neither
   the caller's credential nor the upstream key can be.
   See [gateway-admin.md](gateway-admin.md#staff-prompt-access-and-body-retention).

## Streaming

`stream: true` (#348) uses the same admission, so the hold is reserved before
any byte is sent. A refusal (`402 GATEWAY_BUDGET_EXCEEDED` and every other
admission error) is a plain coded JSON answer, never a cut stream.

1. **Upstream.** One `fetch` with `accept: text/event-stream`.
   `stream_options.include_usage` is always set upstream. The route's
   first-byte deadline covers only the response headers. Failover happens only
   before the first byte: an upstream error, a deadline, or a 2xx that is not
   an event stream still fails over or answers coded JSON.
2. **Relay** (`relayGatewayStream`, `packages/gateway-core/src/stream.ts`).
   The upstream body is `tee()`d and never read whole. One branch goes to the
   caller event by event, byte for byte, except two things
   (`createSseEventTransform`):
   - each event's `model` is set to the public model code the caller asked
     for, as in a plain answer, so an upstream model name never reaches the
     caller (`sseModelRewrite`). Only the bytes of the model's JSON string
     value change; spacing, key order, other fields, comments and line endings
     stay as the upstream sent them. A JSON payload split over several
     `data:` lines (no known upstream sends one) is re-encoded instead;
   - if the caller did not ask for `include_usage`, the usage chunk the
     gateway asked for is removed, so that caller gets the stream it asked
     for.

   The other branch runs through the SSE usage tap
   (`createUsageCaptureStream`) over the upstream's own bytes and is then
   discarded.
3. **Settlement** runs once, when the stream ends:

   | Ending | Ledger status | Charged | In-stream |
   | --- | --- | --- | --- |
   | `[DONE]` after the body | `settled` | reported usage | none |
   | Body closed without `[DONE]` | `partial` | observed usage | `GATEWAY_UPSTREAM_ERROR` error frame |
   | Body failed mid-stream | `partial` | observed usage | `GATEWAY_UPSTREAM_ERROR` error frame |
   | Stream exceeded `streamMaxDurationMs` (10 min), upstream aborted | `partial` | observed usage | `GATEWAY_UPSTREAM_TIMEOUT` error frame |
   | Caller disconnected | `client_aborted` | observed usage | (caller gone) |

   **Observed usage** is the upstream's final usage report when one arrived.
   Otherwise it is the reported input (or the admission estimate) plus an
   estimate from the generated content bytes delivered (text, reasoning,
   tool-call arguments; never the SSE framing). The estimate is capped at the
   output ceiling and marked `estimated`, so a cut stream is never charged
   zero for content it delivered, and never the full hold. Anthropic usage
   (`message_start` input, `message_delta` output) is parsed by the same tap
   for the [Messages route](#anthropic-messages).

4. **Disconnect.** When the caller goes away, both tee branches are cancelled,
   which releases the upstream body. The upstream fetch is then aborted
   through its `AbortController`, and the request settles `client_aborted` in
   the background (the Worker's `ctx.waitUntil`).
5. **Coded state after the headers.** The status line and headers are already
   sent, so a failed settlement or retention cannot become a header. It is
   reported at the end of the stream instead, after `[DONE]`, as:
   - an SSE comment carrying the exact header line, for example
     `: x-gateway-settlement: failed; code=GATEWAY_SETTLEMENT_FAILED; request_id=<id>`;
   - an `event: gateway_error` event with
     `{"type":"gateway_error","header","state":"failed","code","request_id"}`.
     The event has no `error` field, so OpenAI clients do not treat it as a
     failed completion.

   The durable `settle_failed` holds and the retention `failed` row are
   written exactly as for a plain request, with the same coded logs.

A stream's hold lives `holdTtlMs + streamMaxDurationMs`, so the
[sweeper](#stale-hold-sweeper) never expires a stream that can still settle.
A settlement that finds its request already closed is logged as
`gateway.settle_duplicate` with the recorded cost.

## Media and AIGC

`settleMediaGeneration` (`packages/gateway-core/src/admission.ts`) is the hook
a media route calls when an accepted job ends. A success is charged its
delivered units at the price book. A failure after acceptance settles
`upstream_failed` at cost zero, with the failure's code, whatever was
requested.

## Stale-hold sweeper

`sweepExpiredGatewayHolds` (`packages/gateway-core/src/holds.ts`) closes
abandoned reservations: requests with an `open` hold past its `expires_at`
whose request never settled, for example because the isolate died mid-stream.
For each one, in one batch:

- every open hold moves to `expired` and its amount leaves `reserved`;
- one zero-cost `settle` row with status `expired` is written, only if a hold
  actually moved.

A late settlement for that request is a duplicate and charges nothing.
`settle_failed` holds are never swept: they stay reserved until
reconciliation. The sweep is idempotent. It runs:

- from the `scheduled` handler every minute (`sweepGatewayHolds` in
  `apps/api-cf/src/gateway/d1-budgets.ts`), up to 200 requests per run;
- on demand through `POST /api/v1/admin/gateway/holds/sweep {limit?}`
  (`holds.sweep`, admin accounts only), audited as `holds.sweep` when it
  expired something.

## Budget refusals

`GATEWAY_BUDGET_EXCEEDED` (402) names the budget that refused and when that
budget resets. In the OpenAI body:

```json
{
  "error": {
    "message": "…",
    "type": "insufficient_quota",
    "param": null,
    "code": "GATEWAY_BUDGET_EXCEEDED",
    "budget_id": "gwb_…",
    "reset_at": "2026-11-01T00:00:00.000Z"
  }
}
```

The Anthropic body carries the same fields. `budget_id` is `null` when the
caller has no budget row, and `reset_at` is `null` for a budget that never
resets.

## Retention failure

Retention follows the settlement-failure pattern, and it never changes the
answer or its billing:

- the answer carries
  `x-gateway-retention: failed; code=GATEWAY_RETENTION_FAILED; request_id=<id>`
  (only in this case);
- objects already written are deleted, and the metadata row is recorded as
  `status = 'failed'` with `error_code`;
- the `gateway.retention_failed` error log carries `requestId`, `code`,
  `cause` and `marker` (`failed`, or `unrecorded` with `markCause`).

For a stream, the header line is sent at the end of the stream instead (see
[Streaming](#streaming)).

## Settlement failure

If settlement fails after the request ran, the gateway does not hide the
failure, and it does not discard work the upstream already did:

- The caller still gets the real answer: the completion, or the coded error for
  a failed request. The answer carries
  `x-gateway-settlement: failed; code=GATEWAY_SETTLEMENT_FAILED; request_id=<id>`.
  The header appears only in this case. A stream carries the same line at its
  end (see [Streaming](#streaming)).
- `budgets.markSettleFailed` moves each still-`open` hold of the request to
  `settle_failed`, and sets `error_code` to the code of the settlement failure.
  The amount stays reserved and no money moves, so the budget fails closed until
  reconciliation. Repeating the mark is a no-op. If a settlement was in fact
  recorded (the failure was spurious), the mark answers `settled` and the
  header is omitted.
- The `gateway.settle_failed` error log carries `requestId`,
  `code: GATEWAY_SETTLEMENT_FAILED`, the failure's `cause` code and `marker`.
  `marker` is `settle_failed`, or `unrecorded` with `markCause` if the mark
  could not be written either. The log holds only metadata, never keys or
  content.
- Reconciliation is a later `budgets.settle` for the same request id. It
  closes `settle_failed` holds the same way it closes `open` ones, under the
  same once-per-request guards, so a retry never charges twice.
- While a request is `settle_failed`, its `Idempotency-Key` still answers
  `GATEWAY_IDEMPOTENCY_IN_PROGRESS`.

`GATEWAY_SETTLEMENT_FAILED` (500) is in the gateway error table like every
other code. The data plane does not send it as an error body today: the
caller's answer is always the outcome of the request itself.

**DeepSeek is Flash only:** `applyGatewayCatalogPolicy` drops a DeepSeek card
that is not a Flash card, and drops every non-Flash upstream implementation of
a Flash card.

## Error codes

Errors use the OpenAI error shape (the Anthropic error shape under
`/gateway/anthropic/v1`) plus `x-clash-error-code`:

| Condition                                          | Code                                    |
| -------------------------------------------------- | --------------------------------------- |
| No, unknown, expired or revoked token              | `GATEWAY_AUTH_REQUIRED` / `_EXPIRED` / `_REVOKED` 401 |
| Missing `models:invoke` scope, tenant mismatch     | `GATEWAY_FORBIDDEN` 403                 |
| Model outside the token allowlist                  | `GATEWAY_MODEL_NOT_ALLOWED` 403         |
| Model not in the published catalog                 | `GATEWAY_MODEL_NOT_FOUND` 404           |
| No budget row, or a hard budget is exhausted, or one is suspended | `GATEWAY_BUDGET_EXCEEDED` 402 |
| Rate or concurrency limit                          | `GATEWAY_RATE_LIMITED` / `GATEWAY_CONCURRENCY_LIMITED` 429 |
| Upstream 5xx/429, network error or invalid body    | `GATEWAY_UPSTREAM_ERROR` / `GATEWAY_ROUTES_EXHAUSTED` 502 |
| Upstream deadline                                  | `GATEWAY_UPSTREAM_TIMEOUT` 504          |
| Upstream 4xx                                       | `GATEWAY_UPSTREAM_REJECTED` 400         |
| No usable official key or route                    | `GATEWAY_KEY_UNAVAILABLE` / `GATEWAY_NO_ROUTE` 503 |

## D1 ports

| Port          | Store                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------- |
| `identity`    | `gateway_token` (`services/gateway-tokens.ts`)                                              |
| `routes`      | Catalog: published `gateway_model.card_json` at the newest started `published_at`. Price book: published `gateway_price` rows effective at the request's admission instant; the newest version wins, and within it exact upstream rows win over `''` rows; credits only; drafts are never charged ([gateway-price-book.md](gateway-price-book.md)). Accounts: `gateway_upstream_account` (official only; tenant BYOK returns no accounts). |
| `credentials` | `gateway_upstream_account`: `secret_ref` names a `GATEWAY_UPSTREAM_*` Worker secret (an API key or `{apiKey, baseUrl}` JSON). Alternatively, `encrypted_credentials` is sealed with the shared secret envelope under `GATEWAY_ENCRYPTION_KEY`, which is distinct from `ACTION_SECRET_KEY`. Failures are `GATEWAY_KEY_UNAVAILABLE`. |
| `budgets`     | `gateway_budget` + `gateway_usage_ledger`: an all-or-nothing reserve in one D1 batch (only `hard` budgets refuse; the same batch writes `gateway_budget_event` flags for `soft`/`alert` budgets, 0041), and settle in one batch. `markSettleFailed` sets hold rows to status `settle_failed`. `status` has no CHECK constraint, so no migration is needed. A caller with no budget row is refused. `expiredHolds` / `expire` back the sweeper (open holds by `expires_at`, index 0039). |
| `ledger`      | Reads `settle` rows of one tenant.                                                          |
| `limits`      | `rate_limit_json` from the virtual key (per key), the member (`tenant_member`, per member), the published model (per member and model) and the tenant (the tightest of the active subscription's and `tenant.rate_limit_json`). Every subject starts with its tenant (`tenant:<t>…`). `mediaJobs` bounds media generations in flight. Counted in `gateway_rate_window` and `gateway_inflight` (0034). |
| `blobs`       | R2 `R2_BUCKET` (`r2-blobs.ts`); retained bodies live under `gateway-retention/`. Without a bucket, `unavailablePort` (501), and retention records `failed`. |
| `retention`   | `gateway_request_retention` (0037, `d1-retention.ts`): first write per request id wins; `expired` lists unpurged rows past `expires_at`; `markPurged` is idempotent. A truncated stream copy is `response_truncated = 1` with `response_observed_bytes` (0039). |
| `scheduler`, `audit` | `unavailablePort` (501) until their issues land.                                      |

D1 columns are unix seconds; the core is epoch milliseconds. Conversion
happens in `apps/api-cf/src/gateway/d1-common.ts`.

**Not yet implemented:**

- reset of periodic (`daily`/`monthly`) budgets, so they keep counting;
- the reconciliation job for `settle_failed` holds. Until it lands, they are
  found by hold `status = 'settle_failed'` (or by the log when the mark itself
  failed) and settled manually;
- media/AIGC routes (their settlement hook is in place).

## Tests

The gateway-core contract suite (`describeGatewayContract`) includes
non-stream chat cases that drive `createGatewayApp` with a fetch-stub
upstream. It runs against:

- the in-memory stub (`packages/gateway-core`);
- the D1 ports on node:sqlite (`apps/api-cf/src/gateway/d1-gateway.test.ts`),
  with an in-memory bucket for `blobs`;
- the D1 ports in miniflare/workerd
  (`apps/api-cf/src/integration/gateway-data-plane.integration.test.ts`),
  with the real R2 binding.

Its `retention` and data-plane retention cases cover storage on success and on
upstream error, no credential in storage, the coded failure with unchanged
billing, expiry and idempotent purge.

The streaming cases run on the same three adapters, so the workerd run is the
end-to-end check against a fetch-stub upstream with no network. They cover:

- byte-exact pass-through but for the public model code, with the hold
  reserved before the upstream answers;
- no upstream model name in any chunk, whatever its spacing or line endings;
- member budgets enforced hard, soft and alert on plain and streamed requests;
- `include_usage` injection, and removal of the usage chunk for a caller that
  did not ask for it;
- partial settlement of a truncated and of a failed stream;
- a caller disconnect aborting the upstream;
- idempotency: one upstream call and one ledger row;
- the 402 body;
- the in-stream coded state when settlement or retention fails;
- stream retention, and its truncated marker past the cap.

The budgets capability covers the sweeper: it expires a stale hold once,
leaves `settle_failed` and live holds alone, and turns a late settlement into
a duplicate. The composed cases cover the media hook. The duration limit, failover
before the first byte, and a stream's hold outliving the sweeper are memory
cases in `app.test.ts`.

The `anthropic:` contract cases run on the same three adapters: Bearer and
`x-api-key` callers, model mapping, forwarded `anthropic-*` headers and
`cache_control`/`tool_use`/`tool_result` bodies, the stream with the public
model and settled `message_delta` usage, a cut stream, the 402 and 429 bodies,
and `count_tokens` without a charge.

`pnpm --filter @clash/gateway-core test:e2e` (excluded from `pnpm test`) runs
the real `claude-agent-acp` adapter and its Claude Code binary against
`createGatewayApp` on a loopback port with a mock Anthropic upstream, once per
token handoff (ACP gateway auth with `x-api-key`, and
`ANTHROPIC_AUTH_TOKEN` as Bearer). One prompt drives a full tool turn
(`tool_use` of Read, then `tool_result`), and the run checks headers, bodies,
public model codes and one settled ledger row per call. The agent's
environment is built from scratch and no network endpoint is called.
