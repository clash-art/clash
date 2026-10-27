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
chat completions: identity, admission, limits, the credit-floor check,
failover, one journaled settlement and retention. Only the protocol differs (`ANTHROPIC_MESSAGES` in
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
planned routes in failover order. It generates nothing, so it has no money
check and writes no ledger row. Any other path under `/gateway/anthropic/v1` answers
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
   - check rate and concurrency limits (tenant-scoped counters; media jobs for
     a media generation);
   - check or take the money on every budget: the wallet, the member's and the
     key's ([Settlement](#settlement)). Text is postpaid: admitted while every
     `hard` budget is above `-floor`, with no money write. Media is prepaid:
     its exact price is debited at once. A `hard` budget that refuses answers
     402; a `soft` or `alert` budget admits and records a flag, reported as
     the `x-gateway-budget` header ([gateway-teams.md](gateway-teams.md)).
4. **Upstream** calls go through the `upstream.fetch` port and follow the plan's
   failover order. Only `openai-compatible` text routes without an executor
   plugin can serve chat completions (see [Anthropic Messages](#anthropic-messages)
   for that protocol). The upstream receives the gateway's `Authorization`
   header and nothing from the caller. Upstream error bodies
   are discarded because they can echo key fragments.
5. **Settlement** runs once: a completion owes its reported usage, or an
   estimate when no usage is reported, and that charge is journaled as a
   settle run before the answer is sent. A failure owes nothing and writes
   nothing.
6. **Retention** (hosted only, `GATEWAY_STAFF_PROMPT_ACCESS=enabled`): after
   settlement, the normalized request body and the exact answer bytes go to R2
   for 30 days, with a metadata row in `gateway_request_retention`. The answer
   bytes are the completion, the coded error after an upstream failure, or
   the stream as the caller received it. Headers are never stored, so neither
   the caller's credential nor the upstream key can be.
   See [gateway-admin.md](gateway-admin.md#staff-prompt-access-and-body-retention).

## Upstream keys and failover

(#350.) Each route is called with its official account's **active** key
version (`credentials.resolve`). Rotation and revocation are admin
operations ([gateway-admin.md](gateway-admin.md#upstream-key-rotation)).

- **Refused key.** If the upstream answers 401/403, the same route is retried
  with the account's **draining** version (`excludeKeyVersions` names the
  refused ones), still before the first byte. Once every version is refused,
  the route fails as `GATEWAY_KEY_UNAVAILABLE` and the plan fails over.
- **Fail closed.** A version that cannot be read or decrypted (a missing
  Worker secret or Secrets Store binding, a store error, a bad envelope, a
  missing or shared KEK) is `GATEWAY_KEY_UNAVAILABLE` for that route. It is
  never replaced by the account's other version, and nothing is sent to that
  upstream; the next route may serve.
- **Before the first byte only.** A connect failure, 408, 429 or 5xx fails
  over to the next route, and so does a deadline on an idempotent route.
  After the first byte reaches the caller nothing is retried: a retry would
  duplicate output and billing. A caller-caused 4xx is not retried.
- **Circuit breaker** (`circuit.ts`; counters in `gateway_upstream_health`,
  0043). Official accounts only. Each failure above, and a 2xx that is not an
  answer, counts. A caller's 4xx and anything after the first byte do not.
  After `failureThreshold` consecutive failures (default 5), the account is
  skipped without contact for `cooldownMs` (default 30 s). Then it is
  half-open: one success closes it and one failure reopens it. When every
  planned route is open, the answer is 503 `GATEWAY_NO_ROUTE` with
  `Retry-After` (the soonest reopening). The counters are advisory: if they
  cannot be read or written, the request routes as if every circuit were
  closed and the answer is unchanged.
- **No key material leaves the vault.** Logs (`gateway.upstream_key_refused`,
  `gateway.key_unavailable`, `gateway.circuit_open`, the completion log) name
  the account and the key version, never the key. Errors carry the account
  id and a reason. Ledger rows and retained bodies hold neither.

Tenant BYOK keys stay in `provider_account` under `ACTION_SECRET_KEY`. The
official vault's KEK is `GATEWAY_ENCRYPTION_KEY` with its own salt, and a
deployment that configures the same value for both has no official KEK:
sealed official keys fail closed (`encryption_key_shared_with_byok`) and the
console refuses to seal new ones (`GATEWAY_ENCRYPTION_KEY_SHARED`).

## Streaming

`stream: true` (#348) uses the same admission, so the money check is done
before any byte is sent. A refusal (`402 GATEWAY_BUDGET_EXCEEDED` and every other
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
   zero for content it delivered, and never more than the output ceiling. Anthropic usage
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

   The retention `failed` row is written exactly as for a plain request, with
   the same coded logs.

A stream's `Idempotency-Key` claim lives `idempotencyTtlMs +
streamMaxDurationMs`, so it never expires under a stream that can still end.

## Media and AIGC

`settleMediaGeneration` (`packages/gateway-core/src/admission.ts`) is the hook
a media route calls when an accepted job ends. The exact price was debited at
admission, so a success writes nothing more. A failure after acceptance,
whatever was requested or partly produced, dispatches a full refund as
`upstream_failed` with the failure's code.

### Official media jobs (#359)

Hosted image, video and audio generation runs through the same core and
ledger as chat. A media run is official when none of the user's own provider
accounts serves its model and the published gateway catalog does. Its job
outlives one HTTP request, so `packages/gateway-core/src/media.ts` splits
admission into steps:

| Hosted pipeline step     | Gateway (`apps/api-cf/src/generation/official-media.ts`)                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `resolveRoute` (enqueue) | `planGatewayMediaJob`: allowlist, catalog policy, `planGatewayRoutes` over official accounts, price as of now. One `gateway_media_job` row (0049) per task freezes the first attempt and the price instant. |
| `beforeGenerate`         | `admitGatewayMediaJob`: limits (`mediaJobs` in flight) and the prepaid debit of the exact price on every budget, before the provider is called. |
| provider credentials     | The official key of the frozen route, only for the admitted run that planned it (same task, actor and account).            |
| `afterGenerate`          | `settleMediaGeneration` succeeded: no money write; the debit was exact.                                                    |
| `onFailure`              | `settleMediaGeneration` failed: a full `refund` settle run, once.                                                          |

- **Identity.** The product user acting in the Project's tenant: a member of
  that tenant, or the owner of their own personal workspace. The budgets are
  the tenant wallet and the member's budget. No header is identity.
- **Units.** A job measures one `request`, one `image` per image run, the
  requested duration in whole `video_second`/`audio_second`, and the prompt's
  `character`s. Only the units the published price has a rate for are debited,
  in credits. A rated unit the job cannot measure (a per-second price for a run
  with no duration) refuses with `GATEWAY_PRICE_UNAVAILABLE` before anything
  is debited. The delivered units are recorded on the job's outcome; the debit
  stands.
- **AIGC failures are refunded in full.** Any failure, including one after the
  provider accepted the job, dispatches one `refund` settle run for the whole
  debit. Every step is idempotent: the job row only moves forward, the debit
  and the refund are each charge-once by request id and ledger kind, and a late
  success after a failure writes nothing.
- **Refusals.** At enqueue, a served model the caller may not use refuses
  before the run exists: `GATEWAY_FORBIDDEN` (not a member),
  `GATEWAY_BUDGET_EXCEEDED` (no budget), `GATEWAY_PRICE_UNAVAILABLE`.
  `/api/generate/*` answers them with their status and `{ error, code }`. At
  admission, a refusal fails the run with the matching provider failure code
  (`quota_exhausted`, `rate_limited`, `permission_denied`), debiting nothing;
  rate and concurrency refusals are retried.
- **A refund that cannot be journaled** is the [accepted edge](#settlement)
  (logged, the user overpaid until an operator refunds). It never fails or
  republishes the run.
- **No platform key outside the ledger.** An adapter's key is the run's own
  (`credentialsForRoute`): the user's account, or the official key of an
  admitted job. Gemini Omni no longer falls back to the Worker's
  `GOOGLE_API_KEY`; official Gemini Omni runs need a `gateway_upstream_account`.
- **BYOK usage.** A run on the user's own provider account is not charged
  credits. The lifecycle writes one `provider_usage_audit` row when it ends
  (`generation/media-usage.ts`), with what was delivered or the failure code,
  for every adapter. Before #359 only Pika wrote usage. Adapters that record
  the provider's own usage events (`recordsProviderUsage`, Pika) get no second
  row.

## Settlement

Money follows one hybrid model (#399):

| Workload | Admission | Follow-up |
| --- | --- | --- |
| Media/AIGC (fixed price-book price) | **Prepay**: `budgets.debit` of the exact price on every budget or none, with the request's `settle` row per budget | full `refund` settle run on failure only; a success writes nothing |
| Text/LLM (length unknown) | **Postpay**: `budgets.check`, admitted while every `hard` budget is above `-floor`; no money write | `charge` settle run for the actual cost after the request ends; a request that owes nothing writes nothing |

**Credit floor.** `GATEWAY_CREDIT_FLOOR` (`apps/api-cf/src/gateway/index.ts`,
default one credit, `GATEWAY_SETTLEMENT_DEFAULTS.creditFloorMicroCredits`) is
the product knob on Workers. On Node the knob is the `gateway_config` key
`settlement.floor_micro_credits` (`readGatewaySettlementFloor`,
`apps/api-node/src/gateway-budget.ts`, 0 when unset); `server.ts` passes it as
`creditFloor`, so admission and the settle run's charge cap use one floor.
`GatewayAppOptions.creditFloor` also takes a function of the
caller's identity, for a tenant-level floor. A charge is never refused, so a
budget may run below zero. The exposure is bounded by the floor plus what the
requests in flight at admission go on to cost. A hard budget at its limit
therefore still admits text until its balance is at `-floor`.

**Settle runs (delivery N2).** A follow-up is a dedicated Durable Run of the
one shared `gateway-settle` run (`packages/gateway-core/src/settle-run.ts`:
identity, journal command, executor and retry policy), built on the shared
Durable Run coordinator like hosted generation. Each host wires it to its own journal
and scheduler: the Workers host as owner `api-cf:gateway-settle`
(`apps/api-cf/src/gateway/settle-runs.ts`, D1 journal + Workflow + minute
cron), the Node host as owner `api-node:gateway-settle`
(`apps/api-node/src/gateway-settle.ts`, Postgres journal + the
`cloud_run_dispatch` outbox drained into BullMQ). A settle run is not nested in
a generation run, and there is no Queue and no reconcile job:

1. **Journal first.** `settlement.dispatch` writes the frozen intent
   (`GatewaySettlementIntentSchema`, `packages/gateway-core/src/settlement.ts`)
   to the host's run journal as run `gateway-settle:<request id>`, slot
   `charge` or `refund`. Dispatching the same intent again is a no-op; a
   different intent under the same key is refused.
2. **Scheduler second.** On Workers the run is started on the shared Durable
   Run Workflow (`GENERATION_WORKFLOW`; `agents/generation.ts` selects the
   coordinator by the journal row's owner); if the start fails, the row stays
   due. On Node the journal insert and its `cloud_run_dispatch` outbox row
   commit together, and the runtime's outbox driver enqueues the BullMQ Flow.
3. **Apply.** The provider `submit` step parses the journaled intent and
   applies it with `applyGatewaySettlement`. The step is idempotent through the
   ledger's unique `(request_id, budget_id, kind)`, so a duplicate Workflow
   step, a restart or a second dispatch moves no money. Stage and publish are
   no-ops: a settle run touches no Project state.
4. **Retry and recovery.** A storage failure retries with capped backoff until
   seven days after the request ended. A coded `GatewayError`, such as a
   refund of a request that recorded no money, fails the run at once and is
   logged as `gateway.settle_run_failed`. Recovery (the Workers minute cron,
   `recoverCloudDurableRuns` over every owner in `cloud-runs/owners.ts`; the
   Node outbox driver and journal recovery) only re-schedules journaled runs
   that are due. It never rebuilds an intent.

**Accepted edge.** A crash before the journal write loses the follow-up: a
text charge that is never billed, or a media debit that is not refunded (an
overpayment until an operator refunds it). Once a run is journaled, it
converges.

**With the billing port.** Settlement moves a wallet's spend; the shared
billing port (`GatewayBillingPort`, #425) moves its limit (grants, top-ups,
expiries, admin credits and debits, payment refunds as `adjust` rows). Both
backends' period expiry nets the spend settlement writes (D1 `settle` minus
`refund`; Postgres `debit` + `charge` minus `refund`), so neither side
duplicates the other. Settle runs never touch the limit, and the billing port
never writes a request's money row.

**Idempotency-Key** claims live in `gateway_idempotency_claim` (0042), taken in
the admission batch. While a claim is open, a second request under the key is
`GATEWAY_IDEMPOTENCY_IN_PROGRESS`. After the follow-up is journaled (or once
the claim expires), it is `GATEWAY_IDEMPOTENCY_ALREADY_SETTLED`.

**Retired path.** Holds, `settle_failed`, `markSettleFailed`, the stale-hold
sweeper and `POST /api/v1/admin/gateway/holds/sweep` are gone. Migration 0042
closes every `open` and `settle_failed` hold at zero (a zero `settle` row of
status `expired`, the hold row `expired`, `reserved_micro_credits` back to
zero) and keeps the keys those holds claimed as ended claims. A
`settle_failed` hold's lost charge is part of the accepted edge (#396 stays
closed).

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

Settlement fails only when the follow-up cannot be journaled (the
[accepted edge](#settlement)). The gateway does not hide that failure, and it
does not discard work the upstream already did:

- The caller still gets the real answer: the completion, or the coded error for
  a failed request. The answer carries
  `x-gateway-settlement: failed; code=GATEWAY_SETTLEMENT_FAILED; request_id=<id>`.
  The header appears only in this case. A stream carries the same line at its
  end (see [Streaming](#streaming)).
- The `gateway.settle_dispatch_failed` error log carries `requestId`,
  `code: GATEWAY_SETTLEMENT_FAILED`, the failure's `cause` code, `payment`
  (`prepaid` or `postpaid`) and `outcome`. The log holds only metadata, never
  keys or content.
- A journaled run whose Workflow start failed is not a settlement failure.
  The answer is normal, `gateway.settle_deferred` is logged, and cron recovery
  applies the run.

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
| Tenant, key or token suspended ([abuse](gateway-admin.md#abuse)) | `GATEWAY_SUSPENDED` 403   |
| Model outside the token allowlist                  | `GATEWAY_MODEL_NOT_ALLOWED` 403         |
| Model not in the published catalog                 | `GATEWAY_MODEL_NOT_FOUND` 404           |
| No budget row, a suspended budget, a hard budget at or below `-floor` (text) or one that does not cover the debit (media) | `GATEWAY_BUDGET_EXCEEDED` 402 |
| Rate or concurrency limit                          | `GATEWAY_RATE_LIMITED` / `GATEWAY_CONCURRENCY_LIMITED` 429 |
| Upstream 5xx/429, network error or invalid body    | `GATEWAY_UPSTREAM_ERROR` / `GATEWAY_ROUTES_EXHAUSTED` 502 |
| Upstream deadline                                  | `GATEWAY_UPSTREAM_TIMEOUT` 504          |
| Upstream 4xx                                       | `GATEWAY_UPSTREAM_REJECTED` 400         |
| No usable official key or route                    | `GATEWAY_KEY_UNAVAILABLE` / `GATEWAY_NO_ROUTE` 503 |
| Every planned account's circuit open               | `GATEWAY_NO_ROUTE` 503 with `Retry-After` |

## D1 ports

| Port          | Store                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------- |
| `identity`    | `gateway_token` (`services/gateway-tokens.ts`)                                              |
| `routes`      | Catalog: published `gateway_model.card_json` at the newest started `published_at`. Price book: published `gateway_price` rows effective at the request's admission instant; the newest version wins, and within it exact upstream rows win over `''` rows; credits only; drafts are never charged ([gateway-price-book.md](gateway-price-book.md)). Accounts: `gateway_upstream_account` (official only; tenant BYOK returns no accounts). |
| `credentials` | `gateway_upstream_account`: `secret_ref` names a `GATEWAY_UPSTREAM_*` Worker secret or Cloudflare Secrets Store binding (an API key or `{apiKey, baseUrl}` JSON). Alternatively, `encrypted_credentials` is sealed with the shared secret envelope under `GATEWAY_ENCRYPTION_KEY`, which must differ from `ACTION_SECRET_KEY`. The active version first, then the `draining_*` version (0043) when the active one was refused. Failures are `GATEWAY_KEY_UNAVAILABLE`. |
| `upstreamHealth` | `gateway_upstream_health` (0043, `d1-upstream-health.ts`): circuit counters per official account, a failure counted in one upsert so concurrent failures never lose a count; times in epoch ms. |
| `budgets`     | `gateway_budget` + `gateway_usage_ledger` + `gateway_idempotency_claim` (0042). `check` reads the budgets (planCheck) and writes only the claim and flags. `debit` is all-or-nothing in one D1 batch (only `hard` budgets refuse, through a CHECK-violation guard). `charge` (never refused) and `refund` (exactly the `settle` row's amount, `ref_kind = 'settle'`) are one batch each. Every write is idempotent through the unique `(request_id, budget_id, kind)` and writes `gateway_budget_event` flags in its batch (0041). A caller with no budget row is refused, except a tenant-scope (BYOK, #369) request, admitted with no money write and owing no follow-up. |
| `ledger`      | Reads `settle` rows of one tenant, net of their `refund` rows (a refunded debit reads as its refund's status at cost zero). |
| `settlement`  | `settle-runs.ts`: the shared `gateway-settle` owner as `api-cf:gateway-settle` on `cloud_durable_run_journal`, run on `GENERATION_WORKFLOW`; without the binding, intents are journaled and left to cron recovery. |
| `limits`      | `rate_limit_json` from the virtual key (per key), the member (`tenant_member`, per member), the published model (per member and model) and the tenant (the tightest of the active subscription's and `tenant.rate_limit_json`). Every subject starts with its tenant (`tenant:<t>…`). `mediaJobs` bounds media generations in flight. Counted in `gateway_rate_window` and `gateway_inflight` (0034). |
| `blobs`       | R2 `R2_BUCKET` (`r2-blobs.ts`); retained bodies live under `gateway-retention/`. Without a bucket, `unavailablePort` (501), and retention records `failed`. |
| `retention`   | `gateway_request_retention` (0037, `d1-retention.ts`): first write per request id wins; `expired` lists unpurged rows past `expires_at`; `markPurged` is idempotent. A truncated stream copy is `response_truncated = 1` with `response_observed_bytes` (0039). |
| `abuse`       | `d1-abuse.ts` (0046, #356): per-minute observations, signals (`spend` from the ledger's settle rows), thresholds, alerts and suspensions, each mutation audited in its batch. See [gateway-admin.md](gateway-admin.md#abuse). |
| `scheduler`, `audit` | `unavailablePort` (501) until their issues land.                                      |

D1 columns are unix seconds; the core is epoch milliseconds. Conversion
happens in `apps/api-cf/src/gateway/d1-common.ts`.

**Not yet implemented:**

- reset of periodic (`daily`/`monthly`) budgets, so they keep counting;
- official media for routes whose credentials are more than an API key and
  base URL (Vertex service accounts): the sealed envelope holds only those,
  so such routes stay BYOK;
- pruning of finished settle-run journal rows (one per charge or refund).

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

- byte-exact pass-through but for the public model code, with no money
  written before the stream ends;
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

The budgets capability covers the prepaid debit and its single refund, the
text check at and above the floor, a charge below zero applied once, and the
idempotency claims. The settlement capability covers a charge applied once
however often it is dispatched, recovered or re-applied, a conflicting intent,
recovery of a run the scheduler did not take, and a refund run. The composed
cases cover postpay, the floor knob, and media prepay and refund.
`d1-gateway.test.ts` adds the Worker-level cases: a charge that cannot be
journaled, cron recovery after a lost Workflow start, a storage failure
retried, a coded refusal that fails at once, and migration 0042 on retired
holds. `packages/gateway-core/src/media.test.ts` covers media jobs on the
memory ports. `apps/api-cf/src/generation/official-media.test.ts` drives the
real hosted generation pipeline over migrated D1 with a stub provider: the
official fallback, the debit before the provider call, a success that writes
nothing more, a failure after acceptance refunded once (replayed and late
settlements are duplicates), refusals, credential custody, and the BYOK usage
row. On Node, `apps/api-node/src/integration/gateway-lite.lite.test.ts` runs
the same settle owner over real Postgres and BullMQ, including a process
killed (SIGKILL) after the charge was journaled and charged once by recovery.
The duration limit, failover before the first byte, and a stream's
idempotency claim outliving the plain claim TTL are memory cases in
`app.test.ts`.

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

## Node self-host adapter (#367)

`apps/api-node/src/gateway-node.ts` mounts the same `createGatewayApp` over
Postgres ports on the **api** role (`GATEWAY_ROLE`, default `api`; the full
role matrix is #373). Surfaces: `/v1/*` and `/api/v1/gateway/*`
(`/api/v1/gateway/chat/completions` is `/v1/chat/completions`), plus
`GET /v1/models` / `GET /api/v1/gateway/models` (published catalog after the
DeepSeek Flash-only policy, filtered by the key's allowlist). The admin API
is never on this listener (404 for `/api/v1/admin/*`); it has its own
(`GATEWAY_ADMIN_PORT`, [gateway-admin.md](gateway-admin.md#node-admin-listener), #371).

- Identity: `sk_gw_` virtual key (`gateway_virtual_key`, migration 0018;
  tenant, user, allowlist and credential scope come from the row), a `clsh_`
  API token, or a Better Auth session cookie (both the personal tenant
  `personal:<userId>`, official scope). No header is read as identity.
- Budgets follow the hybrid model above (`gateway-budget-port.ts` over the
  #363 store): text admission is the read-only credit-floor check, media is
  debited at admission, and each follow-up (`charge`, `refund`) is an
  `api-node:gateway-settle` run journaled by the api role and applied by the
  outbox worker (`src/outbox-worker.ts`, BullMQ). Run the outbox worker
  wherever the api role serves the gateway. Limits are #364, credentials #366
  (one scope per request; tenant traffic never resolves an official key).
- Official vs tenant (BYOK) resolution (#369, decision N12): the scope order
  is **user-configurable** in `gateway_credential_priority` (migration
  0019): one row per tenant (`user_id = ''`) and optionally per member (the
  member row wins). Values: `official_only`, `tenant_only`, `official_first`,
  `tenant_first`. No row: the credential's own scope only (no cross-scope
  fallback). The core (`planForIdentity`) plans the request in the first
  listed scope that has a route; every attempt, retry and failover stays in
  that scope, so an official key never serves a BYOK request or vice versa,
  and a plan mixing scopes is refused before the budget is touched.
- Budget by resolved scope: `reserve` receives the request's
  `credentialScope`. A `tenant` (BYOK) request with no budget row is
  admitted (the tenant pays its own upstream) and settles with no platform
  charge; with a budget row it is held to that budget. An `official` request
  with no budget row is always 402 `GATEWAY_BUDGET_EXCEEDED` with no upstream
  call. A fallback from BYOK to official happens only at planning, before
  `reserve`, so it is budget-checked as official. The D1 adapter applies the
  same rule.
- The #365 maintenance tick (rollover + limits sweep) starts in-process on
  the api role. Nothing is kept in process memory between requests.
- Not yet on Node: shared circuit store (circuits read closed), body
  retention, blobs, scheduler, audit (explicit `GATEWAY_CAPABILITY_UNAVAILABLE`).
