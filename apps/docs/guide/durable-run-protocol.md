# Durable Run Protocol

> Status: shared durability protocol. The Local adapter and the Cloud
> coordination adapter are delivered. Cloudflare-specific provider, OSS
> staging, and ProjectPublisher ports remain deployment wiring; this document
> does not claim that every hosted Provider route has been migrated.

Native Generator v2 execution creates a standalone Project Loro Action Run
today. Its immutable request pins a Generator Revision, Action, semantic
executor, inputs, parameters, and output contract. Its public state is exactly
`pending | running | succeeded | failed`, and success requires every declared
Output Commit. See [Asset + Generator Model](/guide/asset-generator-model).

That native Run is distinct from the owner-private Durable Task described in
this document. The Local Task journal is SQLite and uses the six phases
`queued | submitting | polling | finalizing | succeeded | failed`. Provider
tokens, attempts, deadlines, staging receipts, realm/owner, and raw failures
remain private.

Legacy Canvas, Timeline, Director, and Provider execution does **not** gain a
native Generator Run merely because it uses the same Durable Run Engine. Those
surfaces still project through their existing nodes, endpoint records, and
`ActionAssetBinding` lineage until explicitly migrated.

The current Local implementation is not a second, local-only state machine.
`@clash/shared-runtime` owns the executable graph, phases, compare-and-set
transitions, retry decisions, and `(actionRunId, outputSlot)` publication key.
`local-api` supplies the SQLite journal, local Resource CAS, Project publisher,
owner guard, and restart scheduler. First-party Google, MiniMax, fal, Pika, and
Volcengine executors, plus the installed Hilo peer, implement the Provider step
contract below. A future Cloud adapter must reuse this engine and replace only
those durability ports. Checked-in upstream replay is narrower than executor
delivery; the evidence-by-cassette matrix is maintained in
[Traffic Record & Replay](/plugins/traffic-replay).

Timeline render and the built-in `local-acp` / `local-tts` executors use the
same journal and graph without pretending to be Provider plugins. Their
Host-local submit adapter performs one renderer or local-model invocation for
an engine attempt, installs media in CAS under `(actionRunId, outputSlot)`, and
returns a completed step to the graph. The old in-process
render/generate/publish loops have been removed. A process restart discovers
these runs from SQLite exactly like a Provider-backed run; Project Loro is not
the scheduler.

All media branches call the same Asset metadata-preparation port before
consumer publication. Current Local `stage` resolves an unsealed receipt,
requires `asset-inspection/v4`, validates frozen kind/media-type assertions,
seals the canonical Resource, and prepares Host-owned L1 facts. Caller media
hints never fill or override those facts. Missing inspection, failed decode, or
incomplete display/orientation/audio-layout facts leaves the run in
finalization with no Project entry or binding; retry resumes from the same
staged bytes and never re-enters Provider/local-model work.

Pika's bundled Local executor is covered by contract tests derived from the
public catalog schemas and deterministic HTTP fixtures. There is currently no
credentialed Pika live cassette, so this delivery does not claim that a real
paid upstream Pika generation was recorded and replayed. The older hosted
`apps/api-cf/src/services/pika-media.ts` path still waits in-process through
`waitForPikaMediaJob`; it is migration debt outside the Cloud design below,
not an implementation of the shared Durable Run Engine. A future Cloud port
must split that call into the same journaled one-submit/one-poll steps instead
of preserving the wait loop.

The retired ClashAgent path is not a Cloud adapter. `/api/v1/actions` no
longer distributes Python handlers, `/api/custom-action/upload` returns `410`,
and Local/hosted ProjectRoom sideband rejects
`register_custom_actions`, `unregister_custom_actions`, and
`complete_custom_task`. Cloud executable-plugin execution remains unavailable
until it can provide the same journal, staging, ownership, and publisher ports
defined below. `api-cf` therefore has no `custom_action` generation adapter;
pending hosted Action nodes fail closed instead of calling or retrying a Worker.

This delivery covers durable generation Tasks and native Generator Action Runs,
not every request that may call a Provider. The voice-input endpoint
`/api/v1/local/audio/transcriptions` is currently a non-Action synchronous
utility boundary: it performs one Provider executor invocation, accepts only a
completed text result, and has no internal retry or poll loop. It does not
create a Project output. If voice input later accepts asynchronous work, needs
restart recovery, or publishes a Project Asset or Document, it must be migrated
to a native Generator Run and use this protocol. Until then, the implementation
must not be described as
making every Local Provider call durable.

Director Hunyuan3D generation is part of the durable path. The official
`clash.fal/fal-execute` contribution translates exactly one fal queue submit or
poll step and returns its GLB through the Host-injected Asset upload capability.
`POST /api/v1/director-model-generations` freezes the Host-selected account and
returns a durable `actionRunId` plus status URL with HTTP `202`; it does not read
the API key or wait on fal. The GUI polls
`GET /api/v1/director-model-generations/:actionRunId`, which reads the journal
and may wake the owner scheduler but never polls the Provider itself. Completion
publishes a node-less Project Asset output and Action Asset binding through the
same staging and publication steps used by Canvas generation.

The Durable Run Engine gives every accepted execution identity one private,
single-owner Task and one step graph. A native Generator request supplies the
public Run identity and pins an exact Generator Revision and Action. Legacy
products supply their existing frozen Action/Timeline/endpoint identity and
`actionRunId`; that compatibility identity is not a native Generator entity.
Local and future Cloud execution are adapters for the same private graph, not
separate workflows with approximately equivalent behaviour. The initiating
surface selects the owner, and ownership does not move during execution.

### Revision-scoped Canvas run identity

Every newly created Local Canvas run is identified by the finalized frozen
execution revision, not by the mutable node alone:

```text
project:<projectId>:node:<nodeId>:revision:<ActionRevision sha256 hex>
```

The same rule covers executable Provider plans, built-in Host-local generation
(`local-acp`, `local-tts`, and mock media), and custom executable plugin
Actions. The revision is computed only after the Host has selected the exact
executor and frozen its plugin binding, action/model endpoint, output kind,
model parameters, execution prompt, and ordered resolved Asset handles with
their slots, indexes, kinds, and Project Asset IDs. A custom Action's declared
parameters are part of the same frozen input. Host-private account selection,
actor attribution, attempt/task routing, mutable coarse status, display name,
and derived/presentation metadata do not create a different Action revision.
When a label is the execution-prompt fallback, its resulting prompt value is
execution semantics and therefore does participate.

The mutable Canvas projection has a separate optimistic revision fingerprint.
Before writing `generating`, `completed`, or `failed`, the publisher compares
the frozen fingerprint with the node's current authored semantics and resolved
mention targets. Thus an old run continues through staging and consumer-CAS
publication of its immutable Asset/output binding, but cannot overwrite a node
that has since been rewired or edited. The current revision may create and
advance its own run immediately; an older polling run does not reserve the
node. Timeline render is the deliberate special case: its already-frozen
Timeline Action owner and revision are the projection guard.

Journal rows created before revision-scoped identity used the compatibility
base key `project:<projectId>:node:<nodeId>` (and custom Actions used
`local-custom-*`). Restart recovery still advances those rows so a known
Provider task or staged result is not abandoned. Because those records did not
freeze all resolved execution semantics, they are fail-closed for mutable
Canvas projection. They may publish only their immutable consumer-CAS output
and lineage; they neither block nor masquerade as the current revision. This
migration deliberately permits bounded at-least-once duplicate computation in
preference to stale projection or starvation.

```mermaid
flowchart LR
  localClients["Desktop / CLI / MCP"] --> localOwner["Local owner<br/>current"]
  web["Web"] --> cloudOwner["Cloud owner<br/>future"]
  localOwner --> graph["One shared step graph"]
  cloudOwner --> graph
  graph --> provider["Provider submit / poll"]
  provider --> broker["Host Asset broker<br/>media: taskId + slot"]
  broker --> receipt["Immutable Resource + receipt<br/>Local CAS / future OSS"]
  receipt --> graph
  graph --> localPort["Local adapter<br/>SQLite journal + local CAS"]
  graph -. future .-> cloudPort["Cloud adapter<br/>Workflow journal + OSS staging"]
  localPort --> localPublisher["Local ProjectPublisher"]
  localPublisher --> localLoro["Local Project Loro<br/>native Run + Output Commit<br/>or legacy node + ActionAssetBinding"]
  localLoro -. "optional CRDT replication" .-> room["ProjectRoom<br/>remote sequencer + fan-out"]
  cloudPort -. future .-> cloudPublisher["Hosted ProjectPublisher"]
  cloudPublisher -. future .-> room
```

The two owner arrows are exclusive for a particular `actionRunId`. The diagram
does not describe fallback from one owner to the other. Only the Local owner
and Local durability ports are implemented; every Cloud owner/Workflow/OSS
arrow is target design for a future adapter.

## One graph, realm-specific durability ports

Every owner advances the following logical steps:

1. Admit the native Generator Run request, or freeze the legacy product's
   execution identity, inputs, output slots, and selected Provider route. Put
   the owner realm only in the private Task.
2. Resolve and stage immutable inputs.
3. Submit at most one Provider request for the current attempt.
4. Checkpoint the Provider task token, or checkpoint an immediate result.
5. Poll a checkpointed task with one Provider status request per poll step.
6. Complete each output through its one defined ordering:
   - for media, the invocation's Host Asset broker first installs bytes and a
     durable receipt under the stable `taskId + plugin output slot`, returns an
     Asset delivery `v0` handle, and only then may the completed result frame be
     checkpointed;
   - for text, the completed result frame is checkpointed first, and the
     finalization stage then installs the immutable legacy text revision;
   - for a native Document, the completed typed body is checkpointed first,
     and finalization validates its declared kind/schema, installs the body,
     and prepares the immutable Document revision.
7. Run the shared finalization stage. It resolves and verifies a media receipt
   or installs the checkpointed text/Document, then prepares the Project output.
8. Publish the declared Asset through `ProjectPublisher`: a native Generator
   gets its Media ProjectAsset or Document revision plus Output Commit; a
   legacy product gets its existing ProjectAsset/output binding projection.
9. Publish the public outcome. A native Generator Run becomes `succeeded` only
   after its required Output Commit; a legacy adapter updates its existing
   Canvas/Timeline/endpoint projection and stable `ActionAssetBinding` lineage.

The media ordering is intentionally different from text and Document output. A media result frame
contains only the Host-issued handle; it never carries an object key, local
path, or unpersisted vendor URL. The engine's later `stage` operation does not
write those media bytes again. It verifies the receipt, resolves the immutable
Resource, and constructs the pending Project Asset. This is also why a broker
receipt by itself is not a completed Provider result and cannot be published.

```mermaid
flowchart LR
  media["Provider media bytes / vendor URL"] --> brokerWrite["Host broker CAS write<br/>stable taskId + slot"]
  brokerWrite --> mediaReceipt["Asset delivery v0 handle<br/>durable Resource receipt"]
  mediaReceipt --> completedFrame["completed frame"]
  text["Provider text"] --> completedFrame
  document["Typed Document body"] --> completedFrame
  completedFrame --> resultCheckpoint["result checkpoint"]
  resultCheckpoint --> finalStage["shared stage<br/>media: verify receipt<br/>text/Document: validate + install"]
  finalStage --> projectOutput["native Asset + Output Commit<br/>or legacy Asset + binding"]
```

The graph owns transition rules, checkpoint meaning, idempotency keys, and
recovery decisions. An adapter owns persistence and byte staging only:

| Realm | Journal                 | Byte staging                    | Project publication                           | Delivery status |
| ----- | ----------------------- | ------------------------------- | --------------------------------------------- | --------------- |
| Local | SQLite run/step journal | Local content-addressed storage | Native Run/Output Commit or legacy projection | Current work    |
| Cloud | Workflow journal        | OSS staging                     | `ProjectPublisher`                            | Future port     |

Cloud must implement these three ports together: **Workflow journal + OSS
staging + ProjectPublisher**. A Workflow that bypasses the shared graph, writes
Loro directly, or invents a second output lifecycle is not this protocol.

### Future Cloud adapter port contract (design only)

This subsection is an implementation contract for a later Cloud adapter. None
of the components or transitions below are claimed as delivered in the current
work.

The Cloud adapter must bind one `actionRunId` to one Workflow owner and provide
the same atomic journal operations used by the Local engine:

- `WorkflowRunJournal` stores the frozen Action revision, input and output
  slots, cloud owner, selected hosted account grant, absolute deadlines,
  private phase, attempt generation, retry schedule, opaque `pollState`, result
  checkpoint, staged Resource facts, and publication receipts. Provider
  credentials remain in the hosted account store and are resolved only for an
  active invocation; they are not copied into the journal.
- Every engine `advance()` reads a journal generation and compare-and-set
  claims exactly one next side effect. Workflow replay, alarm delivery, and a
  concurrent status wake may all call `advance()`, but only one claim wins.
  The adapter must not rely on Project Loro status as this compare-and-set
  record.
- `OssOutputStager` backs the Host Asset broker during a plugin invocation.
  For media, it writes or ingests bytes into an owner-private unsealed staging
  object, verifies byte length and digest, persists a receipt under the stable
  invocation `taskId + plugin output slot`, and returns only an Asset delivery
  `v0` handle. Kind and media type remain frozen assertions, not staging-object
  authority. The completed frame containing that handle is checkpointed
  afterwards. During the shared `stage` step the same port resolves and
  verifies the receipt, runs the same versioned byte-derived media probe
  required by Local, and only then seals the immutable `Resource` and prepares
  canonical metadata for Project publication; it does not upload the media
  again. Probe state is keyed by Resource and recipe, not by a Workflow
  attempt, so Workflow replay can reuse a verified winner.
  For text or a typed Document, the result checkpoint comes first and `stage`
  validates/installs the body and immutable revision. Object keys and upload
  sessions stay private;
  `actionRunId + outputSlot` remains the Project publication idempotency key,
  not the public Resource identity.
- `HostedProjectPublisher` submits the native Asset/Output Commit or legacy
  Asset/binding plus the coarse outcome through `ProjectRoom` admission. `ProjectRoom` sequences the
  Project mutation but does not execute Provider steps or store the attempt
  journal. The Resource Registry derives the Project claim from the admitted
  Project Asset; a staging lease protects verified bytes until reconciliation
  completes.

There is deliberately no distributed transaction across Workflow state, OSS,
the Registry, and Project Loro. The checkpoint order makes each split outcome
recoverable:

| Last Cloud durable fact                                                       | Required recovery                                                                            | Forbidden recovery                                            |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Journal row exists; no submit result                                          | Re-enter the shared submit policy with the same run and idempotency identity                 | Reconstruct execution from Loro or let a Local Host take over |
| Opaque Provider task state is checkpointed                                    | Issue one poll step for that exact state                                                     | Submit replacement work                                       |
| Media broker receipt exists; no completed result checkpoint                   | Resume the journaled Provider boundary and reuse the same `taskId + slot` receipt            | Treat the receipt alone as Provider completion or publish it  |
| Completed media handle, text, or Document result is checkpointed              | Verify media or validate/install the text/Document revision, then prepare the Project output | Call the Provider again or upload the media a second time     |
| Verified Project output is checkpointed                                       | Retry idempotent Project publication                                                         | Regenerate or expose the staging object key                   |
| Project Asset/commit or legacy binding is admitted; Registry claim is pending | Reconcile the claim and retain the staging lease                                             | Publish a second Asset or remove the admitted Project fact    |
| No Project publication ever occurred                                          | Allow staging TTL cleanup after the recovery/retention lease expires                         | Infer deletion of any published Asset                         |

Future Cloud public-Run admission and private-Task creation happen only after
hosted Project membership, Action execute permission, declared output slots,
and the selected hosted Provider account grant are checked. Publication
rechecks the Task owner and current Project admission. Resource download is
authorized through the Project claim, not through possession of a `resourceId`
or object key. A permission failure is a structured non-retryable failure; a
transient Workflow, OSS, Registry, or room failure follows the existing
stage/publish retry rules and never re-enters Provider work after a result
checkpoint.

## Executable step contract

A Provider executor or Generator Action executor invocation performs exactly
one logical submit/poll step. It does not own a retry loop, Task lifetime,
persistence, account selection, or Project publication.

| Host operation | Plugin work in one invocation                                                     | Valid result                                           |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `submit`       | At most one upstream submission                                                   | `completed`, `accepted`, or `failed`                   |
| `poll`         | At most one upstream status request for the supplied opaque `pollState`           | `completed`, `accepted`, or `failed`                   |
| `stage`        | None; Host probes/seals media or validates/installs checkpointed text or Document | a prepared canonical output or structured Host failure |
| `publish`      | None; Host idempotently publishes the declared native output or legacy projection | success or structured Host failure                     |

Asset delivery is permanently the single `v0` handle/resolve contract. Media
outputs are `{ assetId, uri, kind, mediaType? }`; input resolution yields one
of `bytes`, `provider-url`, `text`, or exact `document`. A typed Document output
uses its explicit kind/schema/body result rather than a Media handle.
Compatible additions extend `v0`. There is no version negotiation, `v1` alias,
or retired `url + reach` compatibility
dialect.

`accepted.pollState` is deliberately opaque. The Host persists and returns it
unchanged; it may be a task ID, status URL, cursor, region tuple, or any other
JSON value. `retryAfterMs` is Provider scheduling advice, not permission for
the plugin to wait or poll internally.

Account identity is also opaque to the plugin contribution. The Host selects
the account within the current Project/user scope, injects its SDK
implementation and credentials at invocation time, and freezes only
owner-private routing state in the journal. Contributions and Project Loro do
not declare or synchronize `accountId`.

Every failure has this mandatory contract:

```ts
type ProviderFailure = Readonly<{
  code:
    | "invalid_request"
    | "authentication_failed"
    | "permission_denied"
    | "content_rejected"
    | "rate_limited"
    | "quota_exhausted"
    | "provider_unavailable"
    | "provider_failed"
    | "task_not_found"
    | "task_expired"
    | "transport_timeout"
    | "transport_error"
    | "invalid_response"
    | "execution_failed"
    | "contract_violation"
    | "cancelled"
    | "plugin_unavailable"
    | "deadline_exceeded"
    | "output_persistence_failed"
    | "publication_failed";
  message: string;
  retryable: boolean;
  requestState: "rejected" | "unknown" | "accepted";
  providerCode?: string;
  details?: JsonValue;
}>;
```

`code` and `requestState` are Clash policy facts, not raw Provider spellings.
Provider adapters classify explicit upstream verdicts through the shared SDK;
the Host validates that result, classifies transport/process failures it owns,
and normalizes an invalid poll boundary to `accepted`. `providerCode` retains
the raw upstream spelling for diagnostics. A plugin must not call a terminal
Provider verdict retryable merely because another submission could be made.

The engine applies the following decision matrix. `retryable` is an input to
bounded Host policy, never a command to retry on its own:

| Failed boundary                       | `requestState` | Host consequence                                                                                             |
| ------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| Submit was definitely rejected        | `rejected`     | Host may retry the submit when policy allows                                                                 |
| Submit transport outcome is ambiguous | `unknown`      | Host may retry with the same idempotency key; duplicate upstream work is the explicit availability trade-off |
| Submit was accepted but later failed  | `accepted`     | Never turn it into another submit; fail unless a checkpointed poll path remains                              |
| Poll failed transiently               | `accepted`     | Retry only the poll for the same `pollState`                                                                 |
| Stage failed transiently              | `accepted`     | Retry staging from checkpointed outputs; never call the Provider again                                       |
| Publish failed transiently            | `accepted`     | Retry the idempotent publication; never regenerate or restage known output                                   |
| Any non-retryable failure             | as reported    | Persist failure, publish only sanitized coarse state, and stop advancing Provider work                       |

The Action SDK supplies the common HTTP/transport classifier so first-party
plugins do not each invent a different meaning for HTTP 408, 429, 5xx, socket
loss, or timeout. The full author-facing explanation is in
[Waiting and asynchronous Provider work](/plugins/waiting).

## Deadline and recovery semantics

The default normal lifetime of a generation run is 30 minutes. This is one
absolute deadline shared from durable run creation through ordinary Provider,
staging, and publication attempts; it is not a 30-minute sleep, a per-step
retry budget, or a promise that an individual HTTP stack receives a fresh 30
minutes. Every invocation receives only the remaining budget. A Host may
configure the lifetime, while the Provider remains responsible only for one
invocation. The Local adapter exposes `providerGenerationDeadlineMs`; the
live/replay suite uses the separate
`CLASH_PROVIDER_E2E_TIMEOUT_MS` environment or config-file value. Both default
to 30 minutes.

When a checkpointed asynchronous task reaches the deadline, the owner performs
one final reconciliation poll, including after process restart. That poll may
still recover a just-completed result. If the Provider still reports pending,
the run becomes `deadline_exceeded`. A terminal Provider verdict retains its
structured failure code; a thrown final-poll error retains the Host-classified
transport/plugin code. Neither case retries that final poll. A run that never
crossed the submit boundary fails at the deadline without inventing a Provider
call.

When a poll first reports `completed` at or after the normal deadline, the
journal writes `recoveryFinalizationDeadlineAt` exactly once. This is normally
the final reconciliation poll; the clock-race case is defined below. Stage,
publish, and all of their retries share this persisted recovery deadline;
restart and changed Host defaults cannot extend it. The Host-configurable
`recoveryFinalizationTimeoutMs` defaults to 30 minutes. This is a bounded window
for idempotently installing and publishing bytes the Provider has already
finished, not a second Provider lifetime: only `stage` and `publish` may run.
Their attempt leases clamp to the same timestamp. If the window expires before
staging, the run fails with `output_persistence_failed`; if it expires while
publication remains, it fails with `publication_failed`. Provider submit or
poll can never resume from recovery finalization.

A poll claimed before the normal deadline can race the clock and return
`completed` just after it. That terminal response opens the same single
recovery-finalization window and consumes the need for a separate reconciliation
poll; discarding a known completed output only to issue another status request
would create a clock-scheduling-dependent result. This rule does not make the
poll lease longer: the invocation still receives only the budget remaining when
it was called.

Late finalizer results have an explicit asymmetric boundary because publication
is a product fact, while staging alone is not:

- if `stage` returns only after the normal or recovery deadline, that same
  `advance()` records `deadline_exceeded` or `output_persistence_failed`; bytes
  left in CAS remain unreferenced and may be reclaimed, and no publish attempt
  starts;
- if an already-claimed `publish` returns success after its lease, the Project
  mutation has happened and cannot honestly be relabelled failed. If its journal
  CAS still wins, the run checkpoints `succeeded` immediately. The deadline
  prevents another publication attempt from starting; it does not reverse an
  observed successful Project mutation.

Thus terminal outcome never depends on a later `advance()` noticing that the
clock moved between an external success and its checkpoint.

The native Generator Action Run uses only these four public product states:

```text
pending -> running -> succeeded
   \          \----> failed
    \--------------> failed
```

The owner-private Durable Task phases are exactly:

```text
queued -> submitting -> polling -> finalizing -> succeeded
                    \                 \-------> failed
                     \------------------------> failed
```

Each external side effect is bracketed by journal CAS checkpoints. One
`advance()` call performs at most one Provider, staging, or publication side
effect. Concurrent schedulers therefore either acquire the next attempt by CAS
or return `contended`; they do not both execute it. On restart the scheduler
scans recoverable journal rows, including overdue polling rows that still need
their final reconciliation poll.

That claim prevents ordinary duplicate work; it does not pretend to provide
exactly-once execution across a crash after a side effect and before its next
checkpoint. The protocol is at-least-once at every replaceable task boundary.
Consumers make the result stable with compare-and-set publication keys:
Provider submit reuses its journaled task identity, Resource probing uses
`(sourceResourceId, probeRecipeVersion)`, and Project output uses
`(actionRunId, outputSlot)`. A repeated producer may waste bounded work, but a
consumer inserts one winner, rereads and verifies that winner after contention,
and never publishes two logical facts. Probe verification means complete fact
equality, not merely accepting whichever row won; a differing candidate is a
contract conflict.

The same engine also owns Local Asset representation work under a separate
`local-api:representations` owner. Image thumbnails, video first-frame posters,
and bounded audio waveforms use a stable `(sourceResourceId, recipe)` identity,
stage or compute their derived result, and CAS-publish one Host-private mapping.
They retry and recover after restart without re-entering the source generation
Run. The mapping, recipe, paths, and peaks never enter Project Loro or Action
bindings, and representation availability cannot delay or change source Asset
publication. Timeline filmstrips remain disposable frontend caches outside the
protocol.

## Provider and Loro boundary

Provider execution and Project Loro publication deliberately do not form a
distributed transaction. The bounded ambiguity lies between an external HTTP
request and the owner's durable checkpoint:

- A Provider submit may succeed upstream while its response is lost. If no task
  token or result was checkpointed, the same owner may retry according to the
  shared policy and can create duplicate upstream work. A media broker receipt
  that was written during the lost invocation does not prove that the Provider
  step completed; the retry reuses that receipt through the same stable
  `taskId + plugin output slot`.
- Once a task token is checkpointed, recovery polls that exact task. It must not
  submit replacement work.
- A media invocation must persist bytes and a Host receipt before it can return
  a completed frame. The owner then checkpoints the frame's Asset delivery
  `v0` handle. The shared `stage` step only resolves and verifies that receipt
  and prepares the Project Asset; it does not write the media again. Preparing
  a new media Asset requires the v4 Host byte probe over unsealed bytes,
  canonical Resource sealing, and Host-owned metadata validation. Probe failure
  keeps the run in retryable finalization with the staged receipt intact,
  creates no entry or binding, and never re-enters Provider work.
- A text or typed Document completed frame is checkpointed before `stage`
  validates/installs its immutable revision. The prepared Project output is
  checkpointed separately before any Output Commit or legacy binding is
  published.
- Project publication happens only through `ProjectPublisher`; no Provider
  request holds a Loro transaction open.

Loro is therefore the collaboration projection, not the attempt journal. A
native Generator Run uses exactly `pending`, `running`, `succeeded`, or
`failed` and carries immutable Output Commits separately. Legacy Local products
instead synchronize Canvas/Timeline/endpoint status and
`ActionAssetBinding` lineage. Neither projection can authorize a Provider
request or prove that one did or did not happen. `queued`, `submitting`,
`polling`, and `finalizing` remain owner-private Task phases, not additional
Project states.

## Checkpoints and idempotent publication

The owner journals a token checkpoint immediately after an accepted Provider
submit response. For media, the Host broker first writes a durable Resource
receipt and the owner then checkpoints the completed frame containing its
Asset delivery `v0` handle. For text, the owner checkpoints the completed value
before installing the immutable revision. A typed Document follows that same
checkpoint-first ordering with kind/schema validation. In every case, the
shared stage checkpoints the prepared Project output before publication.
Checkpoints are monotonic: recovery may advance them but must not erase a known
task token, replace a verified result with a fresh attempt, or replace the first
durable media receipt for the same `taskId + plugin output slot`.

Every declared output has the idempotency key
`(actionRunId, outputSlot)`.

For Host-local media execution, this tuple is also the consumer-CAS receipt
identity. An attempt may be repeated after an expired or ambiguous submit. The
first installed receipt wins even when a non-deterministic retry returns
different bytes; every loser re-reads that winner, and finalization can publish
only its one Project Asset. Timeline fixes `outputSlot = "render:output"` and
uses the already-frozen Timeline Action owner/revision. Built-in image, video,
audio, and text generation use their normal `media` / `text` slots. A completed
Timeline node is therefore evidence that Project Asset + output binding
publication was checkpointed, not merely that Remotion returned bytes.

The serialized form has one canonical, reversible tuple encoding:
`${actionRunId}:${encodeURIComponent(outputSlot)}`. The output slot is the
escaped terminal segment, so the last literal `:` is always the tuple boundary;
the Action run id stays verbatim to preserve keys of existing journaled runs
whose slots need no escaping. Thus `(a:b, c)` is `a:b:c`, while `(a, b:c)` is
`a:b%3Ac`. Provider `taskId`, CAS staging identity, and the published Output
Commit or legacy binding must all derive from this encoder. Callers must never
reconstruct the key by joining the two raw values.

`ProjectPublisher` treats publication as an upsert of that one logical output:

- replaying publication cannot create a second Project Asset, Output Commit,
  or legacy binding;
- an existing commit/binding to the same verified Resource or Document
  revision is success;
- a conflicting Resource for the same key is a protocol conflict, not another
  valid output; and
- terminal-state replay cannot make a completed run execute again.

This key is shared across realms even though each private Task has only one
owner. It makes crash recovery safe; it is not permission for another realm to
execute the Task.

Project publication is the public consumer commit. Native Generator media
publication writes the verified `ProjectAssetEntry`, its compatibility
`ActionAssetBinding`, the Output Commit, and terminal outcome through one
replay-safe Project mutation. Native Document publication writes the immutable
revision, Output Commit, and terminal outcome through the corresponding
replay-safe mutation. A legacy media adapter writes its existing Project Asset
and binding projection. If the process dies around publication, replay performs
the same CAS, accepts the existing identical winner, and records success. A
different Resource, Document revision, commit, or binding for that output key
is a protocol conflict rather than a second winner.

The synchronous Local edit adapter reaches this same consumer boundary without
claiming to be a Durable Provider run. One Apply carries a stable
`actionRunId`, declares `outputSlot = "output"`, and derives an opaque Project
Asset id from the encoded tuple. Client image/frame rendering and server ffmpeg
crop work may repeat after an unknown HTTP result. Atomic Project publication
accepts the existing identical entry and bindings, while different output bytes
or a different frozen invocation returns structured HTTP `409`. Thus edits use
at-least-once compute plus consumer CAS; they do not introduce an edit-specific
retry loop or a second journal.

## Collaboration and the remote sequencer

The current Local `ProjectPublisher` commits to the Host-owned local Project
Loro replica first. Optional collaboration then replicates that CRDT state to
the hosted `ProjectRoom`; a Local mutation does not synchronously call through
the room and the room is never a prerequisite for local work. `ProjectRoom` is
the remote sequencer and fan-out point for admitted synchronized state. A
future Cloud `ProjectPublisher` will publish through the room because the cloud
realm has no local Project authority. The room never runs Provider steps and
does not become the owner of Local runs.

Native Generator collaboration synchronizes the immutable Run request, its
four-state public projection, and Output Commits. Legacy Local collaboration
synchronizes its public Canvas/Timeline/endpoint outcome, sanitized failure
information, and stable `ActionAssetBinding` lineage. Neither synchronizes the
owner realm. Realm and owner remain private Task facts even in a future Cloud
adapter because execution placement is not semantic identity.

Provider account identity and credentials, API/session tokens, Provider task
tokens, attempt numbers, backoff state, raw responses, local paths, staging
keys, and execution logs remain private to the owner. They never enter Project
Loro. Another device can observe the current node/binding projection and consume
its published outputs, but cannot poll, retry, cancel, or resume it using
replicated state.

## Crash recovery

Recovery occurs only in the original owner realm and resumes from the latest
durable checkpoint:

| Last durable fact                                              | Recovery action                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Run exists, no submit token/result                             | Resume submit under the shared ambiguous-submit policy; reuse any broker receipt with the same key    |
| Provider task token exists                                     | Poll that token; never resubmit                                                                       |
| Media receipt exists, completed frame is absent                | Resume the journaled Provider boundary; never publish the receipt as if it were a result              |
| Completed media handle checkpoint exists                       | Resolve and verify its receipt, prepare the Project Asset, and never regenerate or upload media again |
| Completed text checkpoint exists                               | Install/reuse the immutable text revision, prepare the Project output, and never regenerate           |
| Completed Document checkpoint exists                           | Validate kind/schema, install/reuse the immutable Document revision, and never regenerate             |
| Prepared Project output checkpoint exists                      | Retry idempotent publication; never re-enter Provider work or stage known media again                 |
| Final poll completed after normal deadline                     | Resume only stage/publish until the persisted recovery deadline                                       |
| Output Commit or legacy binding exists, terminal state missing | Reconcile the same publication idempotency key, then publish terminal state                           |
| Private journal and owner-private receipts unavailable         | Report owner-side recovery failure; do not reconstruct attempts from Loro                             |

Workflow replay in the future Cloud adapter and process restart in the Local
adapter must produce these same decisions. Differences in storage technology
must not change the state machine.

Local recovery is daemon-driven: after binding its HTTP endpoint, local-api
enumerates every Project with non-terminal journal work, opens those Project
rooms, advances due checkpoints, and installs their next wake timers. No
Desktop reconnect, status request, CLI command, or Project mutation is required
to resume an accepted Provider task.

## Permission and ownership boundary

Run admission checks permission in the initiating realm. A native public
request records the Project-semantic Generator Revision, Action, executor,
inputs, parameters, and output contract. The private Task records the owner,
Provider account scope, deadlines, and execution details.

The Local owner may use only locally available accounts authorized for that
Project operation. A future Cloud owner must use hosted membership and
account-grant checks. Credentials stay inside the selected realm.

`ProjectPublisher` rechecks that the caller owns the Task, may publish to its
Project, and is writing a declared output slot. The Local publisher applies the
mutation to the canonical local replica; optional replication separately
enforces hosted admission at `ProjectRoom`. A future Cloud publisher must have
the room enforce hosted admission and sequencing before publication. Being able
to read synchronized run state or possessing a Resource identifier grants
neither execution ownership nor publish permission.

Cloud never automatically takes over a Local run when a device disconnects,
and a Local Host never takes over a Cloud run when Cloud is delayed. Reconnect
resumes the same owner; other clients remain observers. Moving work between
realms requires an explicit product operation that creates a new native Run or
legacy execution identity and makes any reuse of prior immutable inputs
visible. It is not failover and must never result in two owners for one Task.
