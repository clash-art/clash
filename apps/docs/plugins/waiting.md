# Waiting for a Provider

A plugin at this level translates shapes. It turns Clash's request into the provider's
request and the provider's answer into Clash's answer. It does not wait, retry, or
remember anything between calls — those belong to the host, which is the only party that
survives its own restart.

## Three ways a provider answers

Providers answer in one of three ways. The protocol holds all three, and you implement
whichever ones your provider actually offers.

|                       | Provider behaviour                     | You return               | Host does                                                                            |
| --------------------- | -------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| **Synchronous**       | Answers within the call                | `completed`              | Nothing more                                                                         |
| **Polled**            | Takes the work, exposes a status check | `accepted` + `pollState` | Asks you again on a timer                                                            |
| **Callback (future)** | Takes the work, calls back when done   | `accepted` + `pollState` | Current Host keeps polling; a future callback adapter may deliver the signed message |

### Synchronous

The call carries the result. Return `completed` and you are finished — no state to keep, no
second round trip.

Use this only when the provider genuinely answers within the call. The test is not a
duration you tune: it is whether losing the host mid-call would lose the work. A fast image
model qualifies. A video model that takes four minutes does not, even though waiting for it
would technically work.

### Polled

The provider takes the work and gives you something to ask about later. Return that
something as `pollState`; the host records it in its owner-private durable operation journal and
calls you back with it. Local owners use Local SQLite; a future cloud owner may use a Cloud
Workflow. Neither path writes provider run state into Project Loro or a canvas node.

This is the default for anything slow, and the one to implement first. It needs nothing from
the host beyond durable scheduling and poll-state persistence, works on a laptop with no public
address, and authenticates in the safe direction. The plugin reads the selected account's state
through the Host-injected scoped store and opens the outbound connection to the provider itself,
so there is no public inbound message to be fooled by.

### Callback

> Future protocol: the current Host does not issue callback URLs or accept
> callback delivery. Providers must retain a working poll path today.

The provider calls a URL when it finishes. This is not polling with a different alarm clock;
it needs two things polling does not.

It needs an address, and you cannot supply one — a `local` plugin listens on nothing, and a
translator that exists for the length of one call has nowhere to keep a listener. A future Host
callback adapter would issue it as `callbackUrl` on the submit invocation.

And it needs the arriving message to be translated and believed, because a POST from the
open internet is a stranger until proven otherwise. Both are covered under
[Callbacks](#callbacks) below.

Clash does not receive callbacks yet. A plugin that implements only polling keeps working
unchanged when it does, and a plugin that implements both should still implement polling —
it is the fallback when a callback never arrives, which happens.

## Accepting work

```ts
return {
  protocol: "clash.plugin.result/v1",
  invocationId,
  status: "accepted",
  pollState: { job: created.id, region: created.region },
  retryAfterMs: 5_000,
};
```

Return `accepted` only after the provider has explicitly accepted the submission and given you
durable state with which to find it again. A timeout, closed connection, or transient polling
failure is not acceptance: the provider may or may not have taken the work, and saying `accepted`
without evidence can turn an uncertain submission into a task the host can never collect.

`pollState` is any JSON, stored verbatim in that private journal and handed back untouched. The
host reads none of it.

It is deliberately not called `taskId`. Plenty of providers have no id: one returns a
status URL, another needs a region alongside a job name, a third hands back a cursor. A
field named for an id forces every provider without one to invent one, and inventing
identity to satisfy a schema is how a protocol stops describing the world.

`retryAfterMs` is the one field the host reads, because the host does the scheduling and
cannot act on advice it cannot see. Everything the plugin alone understands goes inside
`pollState`. That is the whole rule for where a fact belongs: outside if the host acts on
it, inside otherwise.

## Being asked again

The same export is called with `operation: "poll"` and the `pollState` you returned.

```ts
export default async function generate(invocation) {
  if (invocation.operation === "poll") {
    const status = await checkUpstream(invocation.pollState);
    if (status.pending) {
      return { ...ack, status: "accepted", pollState: invocation.pollState };
    }
    return { ...ack, status: "completed", outputs: [...] };
  }

  const created = await submitUpstream(invocation.input);
  return { ...ack, status: "accepted", pollState: { job: created.id } };
}
```

A poll returns `accepted` again while the work is unfinished, and may return different
`pollState` — a provider that hands out a fresh cursor each time is supported by saying so,
not by keeping a variable somewhere.

`operation` is an explicit field rather than something inferred from a missing one. A
plugin that mistakes a status query for a submission submits twice, and the user pays
twice. That failure is silent, arrives on a bill, and cannot be undone — worth a field.

## What not to write

Do not loop inside the plugin.

```ts
// Wrong: the upstream id lives only in this call's stack.
while (!done) {
  await sleep(5_000);
  done = await checkUpstream(id);
}
```

A blocking wait can last fifteen minutes for video. If the host stops during it — a crash,
an upgrade, a laptop lid — the work cannot be found again. The node stays pending forever
and the generation has already been billed. The loop also has to be written once per
plugin, and every copy gets the retry budget and the backoff slightly differently.

Hand the state back instead. The owner stores it in a durable private operation journal: Local
SQLite for a local owner, and potentially a Cloud Workflow for a future cloud owner. Acceptance,
poll state, callback receipts, retry counters, and deadlines never enter Project Loro or node data.

The transaction boundary is terminal publication. The owner first settles the run and durably
persists its output; only then may a separate finalization step publish the resulting product fact
to the project. A crash resumes the private journal. It does not replay half-written provider state
through Loro sync.

## Callbacks

This section defines a future Host extension. The v1 wire schema and Action SDK
already reserve `callbackUrl`, callback payload/headers, and a `callback`
operation so a later Host adapter does not require a second plugin ABI. The
current Host does not issue or deliver them, however. Today every asynchronous
Provider must return `accepted` with poll state and remain collectable through
polling.

In the future design, the Host issues the address; the plugin never invents one.
A `local` plugin listens on nothing, and a translator that exists for one call
has nowhere to keep a listener. The submit invocation may then carry a
Host-issued `callbackUrl`; its absence means the plugin submits for polling only.

On delivery, the Host authenticates the one-run address and routes the raw body
and headers to the matching Provider translator. The plugin verifies the
Provider signature before translating the payload. Signature rejection is a
callback-channel result, not a Provider step result: it leaves the original run
`accepted` and polling continues. A future callback contract must model that
distinction explicitly before this path is implemented.

### Believing a callback

Anyone can send a POST. Two things stand between that and a forged completion, and the
plugin owns the important one.

The host makes the address unguessable, scoped to one task, expiring, and single-use, and
it will only settle the task the address was issued for. That last point matters more than
it looks: without it a valid callback for cheap work could complete expensive work.

But an address is a secret that travels. It goes through the provider's logs, every proxy
in between, and anything that forwards a referrer. So the address is not the defence — the
signature is. Providers sign callbacks in headers: an HMAC over the raw body, a timestamp,
a key id. Only you know which scheme this provider uses, so only you can check it, which is
why `callbackHeaders` is handed to you alongside the body.

Verify before you translate. Check the timestamp too, or a captured message can be replayed
later.

If a future callback adapter cannot verify a message, it must reject that
callback channel without converting the Provider run into terminal `failed`.
The Host keeps the original `accepted` state and its poll schedule. Polling
authenticates in the other direction — the Host invokes the plugin on a timer;
the plugin reads its account-scoped state and calls the provider over an
outbound authenticated connection, which a forger cannot stand in the middle
of. Refusing an unverified message costs one round trip. Believing one costs
whatever the forger wanted.

## Sizing the choice

Return `completed` when the provider genuinely answers within the call. Return `accepted`
when it does not. The threshold is not a duration to tune: it is whether losing the host
mid-call would lose the work. If it would, the work needs a name the host can keep.

## Saying what the provider said

Whether a generation is still alive is your plugin's answer, written in code, next to the response
it read. It cannot be a table of words somewhere else, because a status is rarely one word: Hub
reports `message="success"` on the envelope while the task underneath has failed, MiniMax carries a
second verdict in `base_resp.status_code`, and some providers bury application failures inside HTTP 200. A mapping from a flat string cannot describe any of those, and a plugin forced to fill one in
would be answering a different question than the one being asked.

What the protocol fixes is the shape of your answer -- `completed`, `accepted`, `failed` -- and one
rule about the last of them:

**A status you do not recognise is a failure, not a wait.**

A failure keeps the host's decision facts separate from the provider's diagnostics:

```ts
return {
  ...ack,
  status: "failed",
  error: {
    code: "execution_failed", // stable Clash category
    message: "The provider refused the request.",
    retryable: true,
    requestState: "rejected",
    providerCode: "quota_exceeded", // optional provider spelling
    details: { limit: 10 }, // optional JSON diagnostics
  },
};
```

`code` is a stable canonical category used by Clash policy. Do not copy a provider's changing
error spelling into it; preserve that spelling as `providerCode`. `retryable` says whether the
condition may succeed later. It does not by itself authorize resubmission: the host also needs
`requestState` to know what happened at the submission boundary.

| `requestState` | Meaning                                                    | Submission consequence                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rejected`     | The provider definitely did not accept the request         | Host policy may submit again when `retryable` permits                                                                                                                                                |
| `unknown`      | The boundary was ambiguous; the provider may have accepted | Reuse the same `actionRunId`, output slot, and idempotency key; reconcile when the provider supports it, otherwise Host policy may resubmit and must accept that duplicate upstream work is possible |
| `accepted`     | The provider accepted the task and it later failed         | Never resubmit as though the original request was rejected                                                                                                                                           |

`retryable` is an input to Host policy, not the policy itself. In particular, it cannot make an
`accepted` request safe to submit again. For `unknown`, a durable owner first uses the same stable
run identity to reconcile or deduplicate; only when the provider offers no reconciliation path may
Host policy choose a fresh attempt with the explicit trade-off that upstream work may be duplicated.

Use one of these canonical `code` values. Put a provider's own code in `providerCode`.

| `code`                      | Use when                                                                  |
| --------------------------- | ------------------------------------------------------------------------- |
| `invalid_request`           | The submitted values or operation are invalid                             |
| `authentication_failed`     | Provider credentials are missing, expired, or rejected                    |
| `permission_denied`         | Identity is known but not allowed to perform the operation                |
| `content_rejected`          | Provider safety or content policy rejected the input                      |
| `rate_limited`              | A request-rate limit was reached                                          |
| `quota_exhausted`           | A credit, balance, or usage quota was exhausted                           |
| `provider_unavailable`      | The provider service is temporarily unavailable                           |
| `provider_failed`           | The provider reported a terminal task failure without a narrower category |
| `task_not_found`            | Previously accepted provider work no longer exists                        |
| `task_expired`              | Previously accepted provider work expired                                 |
| `transport_timeout`         | A provider network operation timed out                                    |
| `transport_error`           | Another provider network or protocol transport failed                     |
| `invalid_response`          | The provider response could not be validated or interpreted               |
| `execution_failed`          | Plugin execution failed without a narrower category                       |
| `contract_violation`        | A plugin or Host boundary violated the executable-plugin contract         |
| `cancelled`                 | The operation was cancelled                                               |
| `plugin_unavailable`        | The Host could not start or reach the plugin process                      |
| `deadline_exceeded`         | The Host's overall run deadline expired                                   |
| `output_persistence_failed` | Finished output could not be stored durably                               |
| `publication_failed`        | Stored output could not be published or attached to its destination       |
| `reference_unavailable`     | Host-only: a pinned Asset reference is missing, trashed or not committed  |

A polling error does not erase known acceptance. Report a transient transport problem as a
retryable failure with `requestState: "accepted"`; the host may retry the poll, but must not submit
the work again. A terminal provider verdict is also `failed` with `requestState: "accepted"`.
In particular, never turn an unrecognised provider status into `accepted` just to keep waiting.

The tempting default runs the other way. Listing the words you know and letting everything else mean
"not finished yet" reads as cautious, and it is the one mistake here with no symptom: a state added
upstream next month, a spelling off by a letter, a terminal failure phrased unfamiliarly, and the
host keeps asking about work that has already died while the node sits at generating and nothing
ever happens.

```ts
if (!RUNNING_STATUSES.has(status)) {
  return {
    ...ack,
    status: "failed",
    error: {
      code: "invalid_response",
      message: `Task ${id} reported status "${status}", which this plugin does not recognise.`,
      retryable: false,
      requestState: "accepted",
      providerCode: status,
    },
  };
}
return { status: "accepted", pollState: { taskId: id } };
```

Being wrong in this direction costs one surfaced error naming the word you did not handle, on a run
someone can fix. Being wrong in the other costs an indefinite wait that names nothing. Those are not
comparable.

The Host also bounds the **whole run**, including synchronous work, polling,
retry scheduling, output staging, and publication. The default deadline is 30
minutes and products may configure it. That is a recovery and product-policy
backstop for work that stops making progress, not a per-HTTP-call timeout and
not a substitute for reading the provider's terminal state.
