# Asset + Generator Model

> Status: native Model media, Provider-backed text, and mapped Action Card drafts, Canvas placements, and execution
> use Project Generator revisions, Action Runs, and Output Commits on the Local
> Host. Timeline and Director Stage are specialized projections over these facts.
> Legacy/unmapped Cards and inline Actions, legacy ASR consumers,
> and cloud execution still have migration gaps. The delivery table and remaining
> work below distinguish these gaps from delivered native Model behavior.

Clash has two first-class semantic concepts:

- an **Asset** is a durable product fact that another object can reference;
- a **Generator** is versioned state plus one or more named **Actions** that
  can materialize new Assets from exact inputs.

Asset is an umbrella term. Immutable media is represented by Project Assets
and content-addressed Resources. Structured, revisioned content is represented
by [Document Assets](/guide/document-assets). A Generator Action may currently
materialize either one Media Asset or one Document Asset.

## Vocabulary

| Concept              | Identity and mutability                                                                 | Delivered meaning                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Generator Definition | Immutable plugin artifact, pinned by plugin id, definition id, version, and schema hash | Declares state, edit policy, persistent input ports, and one or more Actions                                                    |
| Project Generator    | Stable mutable Project identity                                                         | Points at one immutable head revision                                                                                           |
| Generator Revision   | Immutable                                                                               | Pins the Definition, state, persistent input references, parent lineage, and optional COW fork source                           |
| Action               | Named method inside a Definition                                                        | Declares invocation-only inputs, parameters, one executor export, and an output contract; it is not a standalone mutable entity |
| Action Run           | Immutable request plus coarse public state                                              | Pins one Generator Revision, Action, executor, parameters, invocation references, fingerprint, and output contract              |
| Output Commit        | Immutable insert-or-compare fact                                                        | Pins one declared output slot to the winning Project Media Asset or exact Document revision                                     |
| Durable Task         | Owner-private execution record                                                          | Carries attempts, deadlines, Provider tokens, staging receipts, failures, and restart state                                     |

A Definition may register multiple Actions. The same Generator Revision can run
different Actions and produce different downstream Assets without rewriting
its state. The native `clash.codex-imagegen` definition delivered today has one
`generate` Action; multiple Actions are supported by the contract and authority,
not demonstrated by that particular artifact.

Director Stage now demonstrates the single-Action subset of that shape: its
native `clash.director` Definition exposes `capture-frame`, with each frame
materialized by a separate Action Run and output. A future Definition may expose
several Actions from the same frozen revision, but Director Stage does not yet
demonstrate that broader supported-model capability.

## Action means materialization

An Action is pure at the **domain boundary**: its observable semantic result is
the Asset committed to its declared output slot. It does not mutate the source
Generator Revision, rewrite an input Asset, advance a downstream head, or make
execution placement part of Project identity.

That does not mean executor code is side-effect-free or deterministic. An
executor may use Host-scoped capabilities, call a Provider, launch a renderer,
read account state, and upload bytes. Those controlled side effects belong to
the Host-owned Durable Task. At-least-once execution may produce different
candidate bytes; insert-or-compare publication chooses one output winner for
`(actionRunId, outputSlot)`.

An apparently in-place product operation, such as crop settings or frame
sampling controls rendered beside an output, should therefore be modeled as
editing Generator state and materializing a new Asset. Whether the product
advances the same Generator head or forks it is governed by the Definition's
edit policy. This model does not introduce a special mutating Action kind.

## State and inputs

A Generator Revision contains two kinds of semantic input:

- **persistent inputs** live with the revision and can be reused by every
  Action in the Definition;
- **invocation inputs** are selected for one Action Run only.

Both use named slots and declared cardinality. A reference pins one of:

- a Project Media Asset;
- an exact Document Asset revision;
- an exact Generator Revision from a declared Generator family.

The Run also freezes its Action parameters and semantic executor identity. The
executor reference contains the plugin id, version, export id, and schema hash.
Account selection, runtime process ids, retries, and execution realm are not
semantic inputs.

The delivered Local HTTP compiler resolves Media and exact Document references.
Although the domain contract can reference another Generator family, executable
Generator-family reference resolution is not supported by that Host surface
yet and fails closed.

The current Generator v2 profile requires exactly one output port with
`minItems: 1` and `maxItems: 1`. The types retain slot and item-key structure so
the contract can be extended deliberately later, but current code must not
claim multi-output execution.

## Versioning and copy-on-write

Every Generator Revision is immutable. Editing creates a new revision and then
performs an observed-head compare-and-set. The Definition chooses one of two
policies:

- `advance-head`: a successful edit advances the same Project Generator head;
- `fork-when-materialized`: once the observed revision is referenced by another
  Generator or by an Action Run, editing must create a new Project Generator
  with explicit `forkedFrom` lineage.

The policy belongs to the Definition, not to individual Actions. Existing
references remain pinned to their exact revision. Copy-on-write never silently
rewires downstream consumers.

The delivered Local HTTP surface advances an `advance-head` Generator with an
observed-head CAS. If a `fork-when-materialized` revision has already been
materialized, the same request fails with a copy-on-write hint; the caller uses
the existing create route with explicit `forkedFrom` lineage. There is no
separate fork endpoint.

Media outputs remain immutable facts. Document revisions are always immutable;
their Document head may either be `versioned` or `immutable` as described in
[Document Assets](/guide/document-assets).

## Public Run and private Task

Native Generator execution has two deliberately different state machines.

The Project-visible Action Run has exactly four states:

```text
pending -> running -> succeeded
   \          \----> failed
    \--------------> failed
```

`pending` exists after the immutable request is admitted. `running` is a
grow-only public fact written only after the owner-private Task exists.
Submission checkpoints those boundaries through the live Project room.
Replaying the **same stable submission command** can idempotently create a
missing private Task after a crash at that boundary; no automatic orphan scan
from arbitrary pending Project facts is claimed. Terminal success is valid only
after every required output commit exists.

The owner-private Durable Task has exactly six phases:

```text
queued -> submitting -> polling -> finalizing -> succeeded
                    \                 \-------> failed
                     \------------------------> failed
```

The private record owns the execution realm and owner, attempt counters,
deadlines, retry schedule, Provider poll state, staged output, and raw failure
details. None of those facts belong in Project Loro. The Local adapter is
delivered with SQLite, Local CAS, restart scheduling, and replay-safe Project
publication. A Cloud adapter is not delivered.

Legacy Canvas and provider flows still project status through their existing
nodes, bindings, or endpoint records. Timeline and Director Stage compatibility
surfaces instead project native Project Generator, Generator Revision, Action
Run, and Output Commit facts into their specialized CLI/MCP contracts; those
projections are not a second execution authority. Native outputs from these
migrated paths do not create legacy `ActionAssetBinding` records.

See [Durable Run Protocol](/guide/durable-run-protocol) for retry, deadline,
staging, and publication behavior.

## One ABI, two Local Host realms

Executable plugins expose one transport-neutral `PluginModule` invocation and
result ABI. The Local Host can place that same module in either of two realms:

| Host-selected realm | Current use                              | Boundary                                                         |
| ------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| `bundled-module`    | Closed, trusted first-party registry     | Imported and invoked inside the Local Host process               |
| `process-stdio`     | Explicitly activated third-party package | Supervised child process using the same invocation/result schema |

Realm is deployment and diagnostics data, not Generator, Action, Run, or
executor identity. A first-party package may retain a local/stdio manifest
entrypoint as its distributable compatibility entrypoint while the closed Host
registry selects its bundled module at startup.

The process realm is fault isolation, not a security sandbox. Installing either
form installs trusted user code with ordinary runtime I/O. Host-scoped store,
reference, upload, Asset, and named tool capabilities still enforce the Clash
product boundary.

This lets built-in Generator families ship in the same first-party plugin shape
without a dedicated service process. Codex ImageGen, ASR, Timeline, and Director
Stage contribute native Definitions and Action executors from bundled
first-party modules. Timeline uses the Remotion executable plugin Definition
with the `clash.timeline` projection surface; Director Stage uses the
`clash.director` executable plugin with the `clash.director-stage` projection
surface. The specialized Timeline and Stage contracts remain compatibility
projections over those native facts.

## Delivery and migration status

The native Durable Task adapter can execute a Host-frozen Provider plan while
retaining the Generator Action's public Run and output contract. Submit and poll
use the same private task identity and pinned Provider binding across restarts;
the existing media staging and Output Commit publisher verify that binding and
account. The bundled `clash.model-generation` Definitions admit image, video,
audio, and model generation through the same native Generator API. Revisions
store the Model, prompt, and parameters; the Host resolves the Provider and
freezes its binding for the Run. An explicit `providerAccountId` belongs to the
submission's private execution plan, not the public revision or Run. Replaying
an admitted request reuses its frozen plan. The production Local Host now
adapts Canvas pending media requests to this native service: it checkpoints a
Generator Revision and public Run before Provider execution and derives the
Canvas result from the committed Asset. Native Model cards directly edit the
Generator head through acknowledged Host CAS revisions. Legacy media drafts are
converted at Host admission before they become visible or execute. Batch outputs
share an immutable Generator Revision when their source Action, Definition,
and authored inputs agree; each output still owns a distinct Run. Identical
inputs from independent source Actions are not merged. Recovery checks a
persisted Run against its Host-private Canvas target guard before reusing it,
so a changed adapter identifier or a caller-written Run pointer cannot cause
another paid submission or transfer a result between nodes.

A Model Revision may supply authored
`contentParts`: text parts (`type: "text", text`) and input placements
(`type: "input", slot, itemKey?, label?`). Placements resolve exact immutable
Revision inputs, never mutable Canvas nodes. Repeated placements remain
distinct positions, all inputs must be placed, and concatenating text and
input labels must equal `prompt`. The Model Card reference binding determines
execution lowering: mixed-content models receive ordered placements; other
models receive the combined prompt and the original input slots once each,
so repeated labels cannot duplicate a Start/End frame. The Host validates reference media against
the selected Model's constraints before admitting execution. Provider routing
fields such as `provider_id` are forbidden inside public model parameters.

Rewiring a Canvas input to another Asset of the same kind replaces the target
of the existing input occurrence. It preserves the input slot, item key, prompt
position and keyframe time, including when the replacement Asset is already
used elsewhere in the revision. Image reorder changes the images assigned to
ordered time positions; custom time values remain authored state. Actual input
addition/removal still uses the shared Model/Card authoring transformations.

The bundled and standalone Clash skills carry the same product instructions;
the marketplace check compares their instruction bodies. Both direct Model
requests through Definition, Generator Revision, Action Run and Output Commit.
An existing Canvas card reuses its Generator identity; groups do not supply
implicit prompts. The CLI command references use implicit observations and
normal Host bootstrap, without a connection lifecycle or version-token ritual.

| Area                                            | Status now                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generator v2 schemas and Project Loro authority | Delivered: heads, immutable revisions, COW rules, public Runs, output commits, peer-write guards                                                                                                                                                                                                                                                                                                                                                                           |
| Local Run bridge                                | Delivered for native Generator requests: public request before private Task, public running after Task creation, replay-safe Media and Document publication, and coherent batch admission/running checkpoint boundaries with replay repair of missing private tasks                                                                                                                                                                                                        |
| Plugin artifact and ABI                         | Delivered: Generator manifest contribution, Definition validation, semantic executor pinning, one module ABI across both Local realms                                                                                                                                                                                                                                                                                                                                      |
| Codex ImageGen | Its Action Card creates a native Generator placement through GUI and CLI. Compatible legacy drafts migrate at room load and peer/command admission. Prompt/parameter/reference edits, copy, and execution use the same Revision/Run authority as the generic HTTP surface. |
| Local Host HTTP product surface                 | Delivered: list/read Definitions; create/read a Project Generator; observed-head revision advance; explicit create with optional fork lineage; submit/read a Run; and read an Output Commit. Host derives edit policy, provenance, executor, fingerprint, deadline, and realm-private Task facts. Project Generator collection listing, delete, and a standalone fork route are absent.                                                                                    |
| Generic Generator CLI and MCP | Delivered: Definition list/read; Project Generator create/read/advance; Action Run submit/read; Output Commit read; live request schemas. Model cards and Timeline have native specialized GUIs. A generic Generator browser, collection list/delete, standalone fork route, and generic working-tree projection remain absent. |
| v1 compatibility adapters                       | Delivered as fail-closed conversion helpers and tests; they do not by themselves migrate live product data or routes                                                                                                                                                                                                                                                                                                                                                       |
| Canvas Models | Native media and Provider-backed text drafts, legacy draft admission, and Run/output projection share the Local Generator authority. GUI and Host Canvas creation return the Generator identity immediately. Media reference editing/copy, exact Document mentions, and Document picker/graph add/read/remove/copy are migrated. Mapped Actions also accept exact text Documents through declared input ports; specialized graph cases remain below. |
| Timeline | Delivered as the native `clash.timeline` projection: legacy state import, CRUD/CAS, acknowledged editor saves, CLI/MCP, and Remotion Runs/Output Commits. Editor export waits for queued edits. The real Hilo output was opened, played, and edited through this frontend with Host readback. |
| Director Stage                                  | Migrated as a specialized projection using the `clash.director` executable plugin and `clash.director-stage` surface. Stage CRUD, owner semantics, and observed-head CAS are native. `capture-frame` creates one Action Run and output per frame; multi-frame public intent admission and running checkpoints are atomic, with replay repair. The renderer Host tool is reserved and bound to the frozen invocation. Native outputs create no legacy `ActionAssetBinding`. |
| Inline crop/frame/edit Actions                  | Not migrated; current paths retain their existing synchronous/CAS semantics                                                                                                                                                                                                                                                                                                                                                                                                |
| ASR native Generator path                       | Delivered: the strict `speech.transcribe` Broker/SDK ABI, reserved Local broker path, `clash.asr` bundled module and `speech-analysis` Definition, runtime model mapping, and an end-to-end native Run that publishes a timed `media.transcript@1` Document                                                                                                                                                                                                                |
| ASR legacy consumer migration                   | Not delivered: the legacy transcription route, Timeline transcript cache/editor, and other existing consumers have not been rewired to native Generator Runs and Document revisions                                                                                                                                                                                                                                                                                        |
| Human or agent Document authoring | The Local HTTP API can create/read/list/version/attach typed Documents with Host-derived actor provenance. CLI/MCP read exact revisions, and Canvas displays plain-text Document results. CLI/MCP authoring, native file projection, and remaining consumer migration are not delivered. |
| Cloud Generator execution                       | Not delivered; only the Local durable adapter exists                                                                                                                                                                                                                                                                                                                                                                                                                       |

“Supported by the model” and “available in the product” are intentionally
separate claims. A product surface is migrated only when it creates native
Generator revisions and Runs, uses their output commits, and preserves its
existing user behavior through that authority.

Action Cards can declare `generator: { definitionId, actionId, inputSlots }`
to project a Definition from the same immutable plugin package. The legacy
form's prompt and parameters become top-level Revision state. Media modalities
and `text` map to explicitly declared persistent input slots; `text` requires a
`text.plain@1` Document port. Collection
items retain their order through stable item keys. Activation checks the
selected Action's executor, singular output type, and input contract. The
Host validates actual state and exact Asset references again at admission.
The mapping cannot supply additional required invocation parameters or inputs.
One function can implement several Actions, so its export id never determines
which Action a card represents.

Codex ImageGen now declares this mapping. Newly created GUI cards store only
`generatorId`, `actionCardId`, and Canvas presentation data. The shared native
draft editor creates acknowledged CAS revisions for prompt, parameter, and
media-reference changes; it keeps plugin state flat and does not interpret
plugin-owned fields as Model prompt parts or keyframe parameters. Copy creates
a new Generator with source revision provenance, preserves the Action Card
identity and retained media inputs, and leaves the source unchanged.

The normal Generator create/advance APIs atomically commit Canvas placement
and input edges. New revisions validate against the installed Definition;
historical revisions and admitted Runs retain their frozen contract. Blank
prompts are allowed as drafts; the Codex executor still rejects empty prompts
before generation. Native Canvas execution pins the Revision and selected
Action, publishes through the declared
Output Commit, and retires the pending output node's old draft input bindings.
Already admitted tasks recover using their frozen ownership guard without
requiring the current Card catalogue. Changed package identities and missing
references fail before execution. Compatible legacy Card drafts migrate during
room loading, incoming peer admission, and normal Canvas commands. CLI add,
update, copy, reference connections and execute adapt to the same native state;
Canvas REST edits and edge mutations use the same Host transactions. The active
Host registry owns Card identity; the replica's legacy `customActions` map
cannot override it. A stale bound Card or unavailable Definition fails migration
without changing the saved project; explicit recovery of such historical Cards
still needs a product workflow.
Unmapped third-party Cards retain compatibility execution, and the v1
conversion helpers refuse to synthesize another Definition for mapped Cards.

### Agent entry and verification boundary

The application supplies project/session scope in a separate ACP content block;
the original user text is preserved. SessionManager sends that block on the first
conversational turn, retries after failed delivery, and refreshes it after a
successful explicit `/compact`. Ordinary turns do not repeat the policy. ACP has
no portable automatic-compaction completion event in this implementation, so
automatic-compaction refresh is not claimed. This host scope is not a live screen
snapshot or additional user authorization.

The Clash Skill routes project media through the native Generator dispatcher or
its peer CLI. Model Cards determine capabilities and authored parameters;
Provider accounts are selected only at Run submission. An existing Canvas card's
`generatorId` identifies the draft to edit. A missing transport may use its peer;
a missing product capability must be reported rather than replaced by global
generation or a lookalike Canvas card.

The recorded real evaluation used the formal Clash agent session REST/WebSocket
API and Hilo execution route. `sunny-orange-cat-hilo-run-1` reached a committed
video Asset with one Provider submit. Its output was assembled into
`sunny-orange-cat-3s`, opened and played in the frontend, and edited with Host
readback. The local evidence is in
`artifacts/hilo-native-generator-e2e-20260910/RESULT.md`; this proves that scenario,
not completion of every migration below. Current lifecycle and MCP adapter tests
cover transport behavior; they are not substitutes for that real agent run.

### Remaining migration and acceptance work

Native Model Definitions accept generated text directly through the `text` input
slot as an exact `documentAssetId` / `revisionId` reference. Host planning reads
that revision's verified body rather than its current Document head or a Canvas
text copy. Provider execution receives the pinned text, while the resulting
Document retains the exact source reference. The generation-chain regression
advances the source Document head before submission and verifies that the next
Run still uses the originally selected text.

Agents read a committed Document through the existing Assets surface:
`clash_assets` operation `document_revision_get`, or
`clash assets documents get <documentAssetId> --revision <revisionId>`.
Both use the existing Project Document REST authority and return the exact body
with its revision provenance. A live Host fixture was read through the production
MCP server's Assets dispatcher and the CLI; both matched the stored revision and
multiline body. This verifies readback, not a new paid generation.

Provider-backed Canvas text drafts now use the same native creation and migration
boundary as media Models. The Host returns the Generator and Revision in the
initial Canvas add response, and old pending Provider text requests enter native
Run admission. Text publication stores a `text.plain` Document revision and
projects its exact reference onto the result node; it does not write a second
editable `content` or legacy `textRevision`. Deleted or rewired result placements
cannot prevent the immutable output from committing and are not overwritten.
Replaying a completed request restores its terminal projection from the existing
Run and Output Commit without executing the Provider again.

The Canvas card, read dialog, and sidebar read the selected Document revision
through the existing Host API. They reject mismatched revisions, ignore late
responses for an earlier selection, and do not fall back to a node's stale text
body. Model cards now accept these exact Document revisions through Canvas
mentions and the reference picker. The input stores Asset/revision identity,
and the Host resolves the verified body at execution. The reference list reads
that same revision and can remove it in one draft update. Ordinary authored
Canvas text still enters as a captured text section. Document drag connections,
picker edges, and Model copy now retain the exact Document revision. Document
editing/copy as an independent Asset workflow still needs migration; `local-acp`
remains an agent executor and is not registered as a Model Provider.

The bundled `clash.agent-text` / `text` Definition now exposes local-agent text
execution as a native `generate` Action. It uses the same Generator create,
Revision, Run, Document and Output Commit APIs. Its authored state selects the
prompt, optional local harness and harness model, and optional system
instructions. The invocation-scoped `agent.text` Host capability calls the
existing ACP text-task adapter; plugins cannot override the invocation's Project
scope, and sessions remain Host-private. No Model Provider is invoked.

Production Canvas `local-acp` pending text requests now enter that native Action
and publish a Document result. Frozen old local-executor tasks retain their
recovery path. The shipped Agent Text Action Card now uses native creation,
placement, editing and copy through the common Card/Generator path. Legacy
local-acp drafts preserve prompt, attached text snapshots, selected harness,
harness model and instructions in a Revision; historical outputs retain their
existing identities. Blank drafts are valid and blank optional settings use the
configured agent defaults at execution. The executor still requires a nonblank
prompt. Its optional `text` collection now accepts exact `text.plain@1` Document
revisions. Mentions, the reference picker, graph connections, copy, and legacy
Agent draft migration retain those references rather than a Canvas text shadow.
Other mapped Actions can use the same explicit text-port mapping.

At execution, Agent Text resolves each input through the existing SDK/Broker
Document reader. It checks the plain-text body contract and presents the texts
as labeled source material, keeping embedded instructions distinct from the
request. The output Document records the original input references. A regression
advances the source head before execution and verifies the saved revision is
still used. A real local Run read an existing generated Document, correctly
returned its requested second Chinese character, and committed a new Document
with the exact input provenance. No Model Provider is involved in this Action.

| Requirement | Current boundary and evidence needed |
| --- | --- |
| One generation authority across existing product entry points | Native media, Provider-backed text, mapped Action Cards (including compatible legacy drafts and Canvas commands) and production local-ACP text execution use Generator admission and Output Commit. Local-agent drafts use the shipped Agent Text Action Card. A stale legacy Card can recover through the existing explicit plugin rollback API when the original package is retained; an absent original artifact cannot be synthesized. Migration failures preserve the checkpoint and reach the frontend with an explicit retry. |
| Equivalent native reference editing | Media add/remove, ordered/keyframe state, exact Document mention/picker inputs, and Document graph add/rewire/remove/copy are covered for Models and mapped Agent Text Actions. Behavior checks cover fixed Start/End slots, keyframe image reorder, same-edge replacement at Start/Middle/End, custom timing, and replacement with an already used Asset. REST rewiring retains input occurrence and prompt order rather than deleting and re-appending the reference. |
| Reliable admission and immutable history | Native creation/migration, archived Definitions, frozen Run replay, immutable placement metadata and copy-on-write are covered by Host regressions and recorded live readbacks. A rejected peer edit keeps the local draft for explicit recovery; expected room-load migration failures disclose their cause and offer retry after dependency restoration. |
| Agent scope after context lifecycle changes | First turn, failed delivery and explicit compact are covered. Automatic compaction needs a supported harness signal before the same guarantee can be made. |
| Complete acceptance | The recorded real product session generated Hilo video and edited the same Asset into a three-second Timeline. Fresh public readback confirms the original Run, Output Commit, Asset and restored Timeline are unchanged. Native generation, migration, reference editing and recovery have Host/UI regression coverage. This verifies local Model generation; the distinct product features listed as not delivered above remain separate work. |

Generic Generator browsing/file projections and cloud execution in the delivery
table are separate product gaps; their absence must not be confused with a second
local generation authority.

## Invariants

1. Actions are methods of a Generator Definition, never mutable first-class
   Project entities.
2. A Run pins one immutable Generator Revision and one exact semantic executor.
3. Runtime realm, account, process, attempts, and Provider tokens never affect
   semantic identity.
4. The current Action output contract is exactly one Asset.
5. Public Run state is four-state; private Task state is six-phase.
6. A successful Run has every required immutable Output Commit.
7. Copy-on-write preserves existing downstream references until an explicit
   rewire.
8. A plugin process is not a sandbox, and a bundled module is not a second ABI.


### Legacy Canvas draft cutover

Normal Host Canvas list/get/edges/search/execute commands now atomically import
legacy built-in media and Provider-backed text drafts, plus Action Cards with
an installed same-package Generator mapping.
Placement IDs, positions, groups and downstream edges remain unchanged. The
import freezes media Asset identities and text/mention content in a native
Revision, then removes authoring shadows and legacy draft Asset bindings. Empty
prompts remain editable drafts; this migration never submits a Run. Missing
Models, Definitions or Assets reject the batch without a partial import.
Mapped Action Cards preserve flat parameters and declared input order; they
never acquire Model prompt-part or keyframe semantics. A supplied legacy
plugin binding must match the active immutable package.

Direct Generator revision writes honor the same immutable Canvas placement
rule, including historical downstream edges that predate native Output Commits.
Callers must copy the source before editing. A real Host-route test reopens the
persisted replica and verifies that the migrated Generator identity survives.

The local room loader now upgrades legacy Model/Action Card drafts and Timelines before
publishing the first WebSocket snapshot or processing pending work. Failed upgrades
preserve the original checkpoint and close the socket with code 1011. Expected
Asset, Generator and Timeline migration errors first send a typed
`project.load-error` sideband on that same connection. The frontend displays the
cause, pauses reconnection and retains its local draft. After resolving the
dependency, **Retry opening project** reconnects the same document. A late event
from the failed socket cannot disconnect its replacement. Normal
Canvas Host add also creates and returns a native Model or mapped Action draft in one transaction
when Definitions are installed; migration failure leaves no new placement.
The loader and normal Canvas command/REST adapters archive resolved Definitions
in the existing Host-private journal before native revisions can be persisted
or broadcast. This retains their exact contracts across later package updates.

Incoming legacy Model and mapped Action graphs, including Provider-backed text
and local-agent text, are upgraded at peer admission. Native semantic peer writes
are guarded as described below.
Music drafts now retain separate Prompt and Lyrics in the native Revision and
round-trip through the native card editor. Model Card musicInput mapping happens
only when planning execution, preserving authored values during migration and editing.


Audio Model revisions may carry a `lyrics` string alongside `prompt`. Native
Lyrics edits use the same acknowledged CAS queue, and Run/Copy preserve the latest
edit. Planning maps Lyrics to the Model's declared parameter or prompt location,
without rewriting the Revision. Existing compiled revisions without authored
Lyrics continue to use their frozen parameter representation.

A new Model draft edit validates against and pins the installed Definition.
Historical revisions are unchanged; accepted plain-edit retries return their
original acknowledgement even after another installation. Submitting an old
revision still requires its matching Definition. Canvas Run preparation resolves the installed Definition inside the draft edit
queue. A changed contract creates a new acknowledged CAS revision even when
authored state and inputs are unchanged; a matching contract reuses the head.
Lookup, CAS, or concurrent contract changes prevent output submission. Historical
Definitions retained in the Host archive are available for reconstruction; a
missing contract that was never archived cannot be synthesized. Submitting an
explicitly selected old revision never rewrites it.

For a legacy Card bound to an older package, the migration error identifies the
required plugin version and contract hash. The existing `clash plugin rollback <id>`
command and Local plugin rollback API restore the newest retained package;
reactivation can restore an available original artifact instead. These are
explicit dependency changes, never automatic draft rebinding. An integration
test activates two package versions, observes the rejected project load, invokes
the real rollback route, then reopens the same Host room and persisted replica.
The original contract, prompt, historical output and edges are preserved. This
does not recover a missing artifact or synthesize a never-archived contract.


The formal `clash canvas copy` operation forks native Model Generators rather
than duplicating a placement's Generator pointer. The copy retains the exact
source contract, authored state and persistent inputs and records `forkedFrom`.
Generator, initial Revision, placement and copy lineage commit atomically;
existing downstream edges remain on the source. Duplicate placement IDs reject
the transaction without orphan Generators. Editing the copy follows the normal
Generator revision contract; Run preparation can bind a newer installed contract.


The normal `clash canvas update` command adapts native Model prompt/content,
model/modelId, modelParams and lyrics edits to the same Host revision mutation
used by the Generator API. It retains Canvas read evidence and commits placement
metadata together with the validated revision. Prompt mention compilation is
shared with the GUI, freezing referenced text and media inputs. Stale reads,
invalid parameters and unsupported semantic fields reject without partial label
updates. Input pruning preserves copy-on-write lineage. Formal media and exact
Document edge adapters and peer admission are covered below.


Canvas REST node/edge reads, delete planning and all six mutation handlers now
use the injected Project replica shared with Host commands. They do not recover
or mutate a sibling file snapshot beside a connected local room. The existing
file-backed adapter remains the fallback for hosts without an injected replica.
A real-room regression verifies node update/delete, edge add/rewire/delete and
batch deletion against live state and after reopening the room. This fixes the storage-authority split. Generic Asset edge endpoints now also
update native Model inputs atomically. Raw peer admission upgrades legacy media
graphs and rejects unauthorized native semantic changes.


Generic Canvas REST media and Document edge add, rewire and delete derive native Model inputs
in the same transaction as the graph change. The adapter uses effective Model
Cards for input roles and the shared Generator revision mutation for contract,
CAS and immutable-placement validation. Unplaced inputs are retained; deleting
one of multiple connections to the same Asset retains that input until the last
connection disappears. Ordered content retains text and removes only the deleted
input identities. Invalid Assets or rejected revisions roll the entire graph
change back. Explicit frame-handle role changes remain to be audited; this
adapter does not submit a Run. Incoming legacy graph batches are admitted through
the upgrade boundary described below.


Raw local peer updates cannot introduce/rewire a native Model placement's
Generator pointer, change its semantic shadow fields, or change connected media
Asset identities or exact Document revisions. Those operations use Host commands or Generator APIs. Normal
presentation edits remain supported for unreferenced drafts. Once a native Model
placement has any downstream edge, raw peer changes to the whole node, including
label and position, reject with `IMMUTABLE_NODE`; the Host copy workflow is required.
Pending-output projection remains supported without rewriting that placement. Node deletion
uses the existing batch-delete rule: a referenced source cannot be deleted alone,
while a complete selected chain can be removed without changing its historical
Generator facts. Rejected updates never enter the journal; candidate Loro docs
are freed on success and failure. Legacy media draft creation is upgraded before
admission. Text-reference edge semantics still require migration, and cloud replication is a separate trusted
transport from this local peer admission boundary.

On an official-protocol rejection, the client stops publishing dependent local
updates and refuses to rejoin that session. The frontend reports a rejected
`project_sync` mutation, clears connected state and disables automatic reconnect
for the affected mount. Its local document remains intact for recovery. The
recovery dialog saves that draft before reloading a fresh Host-backed replica;
intended edits must be compared and reapplied manually.
Simply importing another Host snapshot cannot erase rejected CRDT operations.

The recovery storage helper can atomically archive a rejected Loro snapshot and
remove that project's automatic-sync cache in the same IndexedDB transaction.
It retains a latest-backup pointer and does not alter other project caches.
Aborted transactions preserve the cache and prior backup. Recovery waits for
queued snapshot writes and prevents autosave, including unmount flush, from
restoring the rejected cache. The shared dialog reloads only after archival
succeeds and displays storage errors without reloading. The next mount offers
the retained `.loro` copy for download; it never automatically reapplies it.
Component and hook tests cover this flow. A real browser run triggered rejection
through Auto Layout, saved the recovery copy, reloaded and displayed the retained
backup entry, then returned to the project. Auto Layout had already committed two
editable node moves before rejection; those test positions were restored through
the CLI and Host readback matched the pre-test draft state. Layout patches now
validate together on a detached Project mutation and publish as one complete
Canvas update. Referenced nodes reject the entire batch, and the hook restores
the accepted projection. A repeat browser Auto Layout run retained the exact Host
Canvas baseline without triggering sync recovery. The download button was exercised, but downloaded bytes
were not independently retrieved in that browser run.

The Host `move` command now applies the same any-downstream immutability rule as
node updates and peer admission. Referenced nodes reject with `IMMUTABLE_NODE`
without changing the replica; unreferenced moves retain normal read/CAS behavior.


Canvas REST node PATCH and the CLI Host update now share the native Model
Canvas authoring adapter. Neither writes authored state into placement shadow
fields; both validate and advance a Generator Revision and commit metadata
atomically. Metadata-only edits avoid registry lookups. The `ensure_edge` Host
command uses the same Asset-edge transaction as REST, including input mapping,
rollback and idempotent repeated calls. Models accept media and exact Document
revisions. Model prompt updates can pin a Document mention through the same shared
compiler as the GUI. Legacy raw media draft creation passes
through the graph upgrade boundary below.

### Incoming copied graph admission

The local Host validates peer updates before upgrading legacy Model graphs on a detached candidate. It journals and broadcasts the admitted update with native Generator facts before pending work runs, including returning the conversion to its origin. Failed upgrades leave the replica untouched. GUI trajectory copying publishes nodes and input edges in one local mutation so migration observes the complete graph. The upgrade includes Provider-backed text and mapped Action drafts, including Agent Text. Applied text connections and mentions migrate to exact Document inputs for Models and Actions with a declared text port; ordinary authored text remains a captured prompt section.

Model draft migration uses the same reference editor as native authoring. A
Document mention and connection to the same revision share one input; a newer
Document head never changes that selection. Missing revisions reject the entire
upgrade instead of falling back to Canvas text. A mention of ordinary authored
text captures its body once, including when the source also has a graph edge.
Migration preserves source nodes, historical outputs and edges and is idempotent.

### Native copy placement projection

GUI copies identify their source through `placement.sourceNodeId` on the existing Generator creation request. The Host checks that this placement still points to the forked Generator head, then projects retained media and exact Document connections and copy-on-write lineage in the same mutation. CLI copies use the same projection helper. Removed or unplaced inputs do not create new edges; frozen text inputs stay pinned to their revision facts. Replayed creation acknowledges its existing placement without adding connections again.

### Exact Document graph inputs

Model drag-connect and reference-picker edits submit `canvasInputConnections`
with an `asset` reference: media uses `projectAssetId`; Documents use
`documentAssetId` plus `revisionId`. The Host verifies the selected Canvas source
still identifies that exact Asset and commits the input and graph together. A
changed or missing revision rejects the whole edit. Copying a Model preserves its
retained Document connections without following the current Document head.

Canvas edge deletion uses the existing Host DELETE route. It removes only the
selected edge and retains the native input while another connection references
the same Asset revision. Removing the last connection also removes its ordered
prompt occurrences. Removing the input from the card prunes its connections in
the same Revision transaction. Raw peer graph edits cannot bypass this boundary.

A live local project verification attached an existing generated Document through
the Generator Revision API, added a duplicate edge through Canvas REST, and
removed the edges one at a time. The first deletion retained the input; the last
removed it. The draft and original edges were restored through CAS without a Run.
This is formal Host/CLI evidence; the new source handle and picker/delete UI have
component tests, while live GUI click-through is still pending.

### Agent contract discovery across transports

The CLI exposes `generators contract create|advance|submit`, deriving JSON Schema from the same shared request validators used by Host HTTP and MCP. It runs without project discovery or a Host request. Use the Definition and Model Card for state/model-specific details. Existing Model cards expose their Generator identity; editing them must reuse that identity rather than inventing an alternate Canvas generation state.

### Frozen Run replay after plugin changes

Single and batch submission retries first compare the existing public Run request and every Host-private output task. If private admission is complete, recovery reuses those frozen commands and does not re-resolve the currently installed Definition or choose another Provider. Changed parameters, revision, Action, invocation inputs, explicit Provider account, owner, or Canvas projection reject. A crash before private tasks exist still requires the exact Definition for reconstruction; the Host archive described below retains admitted contracts for that case.

### Definition retention for incomplete admission

The production SQLite journal now retains validated Definition contracts by plugin id, definition id, version, and schema hash. Generator create/advance and new Run admission persist the contract before Project persistence; Run reconstruction resolves that exact archived identity first. A crash after public intent and before private task creation can therefore recover after the active Definition changes or disappears. The archive is Host-private and never overrides pinned executor/plugin availability checks. Historical Definitions that disappeared before being archived cannot be reconstructed; source snapshots and custom injected journals without retention retain this limitation.

### Authored media order

Reference reordering now edits `contentParts` rather than permuting identity-normalized `persistentInputRefs`. Native card projection reads this authored order. Positional Model execution lowers the first occurrence of each input in that order while preserving named roles and assigning indexes within each role. Mixed-content execution retains repeated occurrences and text placement. Reordering preserves unrelated inputs and text positions, with labels moving with their media occurrence. Native keyframe insertion/removal uses the shared transaction described below.

Appending references from drag-connect, the media picker, or Host Canvas edge commands materializes existing input order into `contentParts` before appending. This also covers plain-text drafts and inputs omitted from existing content. The stored identity array may be normalized without changing authored order; existing repeated occurrences, labels and text positions remain intact.

### Native keyframe draft transactions

Keyframe Model cards now add/replace/remove ordered image inputs, contentParts and timing parameters in one serial draft transaction. Start/End are positions in the image sequence for keyframe presentations, not singleton Model input ports. Added media connections are submitted with the same revision; removed inputs let the Host prune their connections atomically. Timing-only edits merge into the acknowledged parameter state. Unplaced keyframes are verified below; explicit reordering and custom-time correspondence remain audit items.

Native drag-connect and Host Canvas edge mutations also use the shared keyframe transformation for image additions and removals. They preserve the picker insertion policy and update the timing array in the same revision. Host edge removal continues to retain an input while another placement connection references the same Asset; removing the last connection updates the keyframe sequence and timing together.

Unplaced media references are now displayed in authored input order. Removing an unplaced keyframe uses the same atomic keyframe transformation as its placed counterpart, updating timing and contentParts together. Removal is keyed by slot/itemKey as well as Asset identity, preserving other occurrences of the same Asset. The unplaced timing editor and its verification are described below.

The native keyframe strip and timing dialog now enumerate exact Revision input identities, including Assets without Canvas placements. Thumbnails resolve from Project Assets, repeated Asset identities remain separate frame occurrences, and count validation uses native inputs. Unplaced image keyframes no longer appear twice in the generic reference list. Timing edits preserve the complete sequence and refuse to overwrite a sequence changed while the edit was queued. Component coverage includes changing an unplaced middle keyframe at 24 fps through one revision request. Real browser verification changed the middle frame from 1s to 2s and restored it to 1s; formal Host readback retained the three distinct input identities throughout (see the Hilo E2E artifact report).
