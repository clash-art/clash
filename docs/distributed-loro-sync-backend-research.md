# Distributed Loro Sync Backend Architecture Research

Last updated: 2026-09-03

Status: architecture research plus the first Clash implementation slice. The
portable engine and Loro Protocol path described under "Implemented Clash
shape" now exist; the Postgres/Kafka alternatives remain selection guidance.
This document does not replace the local-first contract in
`local-loro-host-architecture.md`.

## Node implementation update — 2026-09-15

The initial Node deployment now chooses PostgreSQL for the durable event log,
transactional outbox queue and `LISTEN/NOTIFY` wake-up transport. A separate Redis
service is deferred; the notification publisher remains replaceable. The older
Redis diagrams below describe the original alternative, not a deployment dependency.

`apps/api-node` now exposes the product's snapshot/log HTTP and SSE profile to
`@loro-dev/streams-client@0.7.0`. Gateways hold no LoroDoc. The SDK reads snapshots,
appends and catches up by opaque offset, and receives actual log batches over SSE.
Clash persists the entire batch before saving its offset. This replaces the first
`eventsource-client` hint-only iteration. Separate outbox and full-Loro-checkpoint
workers retain the PG design. Only the SDK operations the product uses are
implemented; producer epochs, stream lifecycle, multipart bootstrap and long-poll
are not advertised. See the current cloud-sync guide for that boundary.
The earlier materializing WebSocket gateway was removed after profiling showed
whole-document fork/import growth. Cloudflare's existing protocol remains separate.

Local TCP PostgreSQL multi-process tests and fault injection are recorded in the
launch roadmap. Event retention/GC, poisoned-log repair, large offline-history upload,
browser auth/resources and real deployment acceptance remain unfinished. No claim
of PG HA or production capacity follows from loopback tests.

## Scope

This document studies a traditional distributed backend for Loro/CRDT sync:

- WebSocket gateways run as horizontally scalable Kubernetes Deployments.
- The backend stores opaque Loro update bytes for replay.
- A background worker periodically builds binary checkpoints.
- Online updates must be fanned out to clients connected through different
  gateway pods.
- The design should not require Cloudflare Durable Objects or a general actor
  control plane unless product semantics actually require a unique owner.

Single-process room managers are intentionally out of scope.

## Executive conclusion

The architecture is best understood as three decisions, not four mutually
exclusive backend categories:

```text
Layer 1: write coordination
  - multi-writer, stateless CRDT relay
  - single-owner, FIFO command processor / actor

Layer 2: durable event path
  - database event log + transactional outbox
  - durable broker log
  - owner state + event store

Layer 3: realtime fan-out
  - Redis PubSub
  - NATS subjects
  - dedicated fan-out dispatcher
  - direct broadcast by a document owner
```

Checkpointing and indexing are consumers of the durable event path. They are
not additional coordination models.

A Figma-like product history introduces another distinction: a user-visible
revision is a logical, durable version point, but it does not have to be a new
full binary snapshot. A practical implementation retains sparse binary
checkpoints, a bounded event tail, and small revision markers that reference a
Loro frontier and durable transport cursor. This avoids copying the whole
document for every row in the history UI while preserving preview, diff,
attribution, named-version, and non-destructive restore behavior.

## Implemented Clash shape

Clash now keeps local-api as the machine's durable Project replica and treats
cloud collaboration as a replica link, not as a second mutation authority:

```text
Desktop renderer (official protocol)
CLI / local agents (legacy compatibility during migration)
                 |
                 | official Loro room protocol + product JSON sideband
                 v
        local-api Project replica
        - live LoroDoc
        - file event WAL
        - binary checkpoint
                 |
                 | reconnecting server-to-server Loro replica link
                 | VersionVector catch-up in both directions
                 v
         hosted ProjectRoom
         - Durable Object WebSocket shell
         - Durable Object event WAL
         - binary checkpoint
```

`packages/shared-replica` is the runtime-independent core. Its
`ReplicaEngine` depends only on ports for event append/replay, checkpoints,
fan-out, work scheduling and projections. Loro validation/checkpoint encoding
and the official protocol client/server sessions are adapters beside the core.
There are no Cloudflare, Node, WebSocket, filesystem or Redis types in the
engine contract.

The concrete runtime composition is:

| Runtime            | Event/checkpoint ports                                   | Transport shell                                        |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------ |
| local-api          | framed file update log plus atomic snapshot/cursor files | Node `ws`; Desktop connects only here                  |
| hosted cloud       | Durable Object Storage                                   | ProjectRoom WebSocket/hibernation lifecycle            |
| local-api to cloud | the same local WAL remains the admission boundary        | reconnecting official-protocol client with bearer auth |

The durability order is deliberate:

```text
Desktop update
  -> local append
  -> local apply/broadcast/ACK
  -> best-effort cloud link publish

Cloud update
  -> local append
  -> local apply/broadcast
  -> ACK cloud
```

If the cloud link is unavailable, the local replica continues normally. On
reconnect there is no volatile outbound queue to recover: the protocol compares
the local and cloud Loro VersionVectors and transfers the missing CRDT history.
Legacy raw-binary CLI/agent clients remain accepted temporarily, while the
renderer and the local-to-cloud link use `?protocol=loro-v1`.

Checkpoint and index work remain separate consumers. The portable core already
supports checkpoint scheduling and independently cursor-tracked projection
ports; the current cloud slice schedules checkpoints, while a product search
index is intentionally not materialized until an actual query contract exists.
Both adapters currently emit full Loro snapshots. Switching to shallow
snapshots is a later GC policy decision because admitted offline replicas may
still depend on history before the chosen shallow frontier.

### Deterministic chaos coverage

The local-to-cloud path has a loopback end-to-end chaos suite with two
file-durable local replicas, real Node WebSockets, and a restartable cloud core.
It injects a dropped update followed by disconnect, an ACK lost after durable
commit, duplicate delivery, reversed delivery, a full network partition,
checkpoint/write overlap, cloud recovery from checkpoint plus event tail, and
local-api recovery from its file WAL. The fixed seed and ordered fault trace are
included in timeout/assertion failures, so a CI failure is reproducible rather
than probabilistic.

```bash
pnpm --filter @clash/local-api test:sync-chaos
```

The suite waits for the official Loro JoinResponse before injecting the next
fault. TCP connection state alone is not treated as replication readiness.
Cloudflare-specific behavior is covered separately by a real Miniflare/workerd
suite. It loads the production `ProjectRoom` and Loro WASM, verifies durable
append-before-ACK and two-client broadcast, evicts the live Durable Object while
hibernating its WebSockets, resumes over the same connections, and runs the real
alarm to turn 100 persisted updates into a binary checkpoint before truncation.
Its long-sequence case sends 1,000 distinct Loro increments in 100 protocol
batches, evicts the Durable Object three times in flight, checkpoints the full
cursor, then evicts once more and verifies a fresh client can reconstruct the
entire document from durable state.
The integration config deliberately omits remote AI and other production-only
bindings.

```bash
pnpm --filter @clash/api-cf test:integration
```

The deterministic chaos harness still targets the portable core/port contract;
Miniflare targets the Cloudflare adapter and lifecycle boundary.

For a backend that only stores and relays Loro updates, the recommended initial
shape is:

```text
Clients
   |
Load balancer
   |
Stateless WebSocket gateways x N
   |
   +--> Postgres event log + transactional outbox
   |                  |
   |                  +--> outbox dispatcher --> Redis PubSub
   |                                             |
   +<--------------------------------------------+
   |
   +--> local WebSocket clients

Checkpoint worker --> full Loro snapshot + included event cursor
```

This shape needs neither sticky sessions nor a unique owner for a document.
Move to a durable broker when event streaming, independent consumers, backlog,
or replay becomes the dominant workload. Introduce an owner/actor only when the
server must serialize commands against current document state.

## Evidence boundary: Loro versus Yjs

The distributed-gateway recommendations in this document are an architecture
proposal, not a claimed Loro community consensus.

As of 2026-09-03, the Loro project has two relevant public surfaces:

1. The open transport-agnostic
   [`loro-protocol`](https://github.com/loro-dev/protocol), WebSocket client,
   adaptors, and minimal TypeScript/Rust servers.
2. Published Loro Streams client/CLI packages and a hosted service contract
   based on durable append-only streams, opaque offsets, bootstrap reads, and
   SSE/long-poll live tails.

The Loro Protocol README describes its bundled servers as suitable for local
testing or self-hosting, and the Loro blog calls the TypeScript implementation
a `SimpleServer` for testing.

The reference TypeScript server is process-local:

- rooms are stored in an in-memory `Map`;
- a room document is loaded and updated inside that process;
- broadcasting iterates the WebSocket clients owned by that process;
- persistence is exposed through load/save snapshot hooks;
- no Redis, NATS, Kafka, cluster membership, cross-pod subscription directory,
  or distributed fan-out adapter is provided by this reference server.

The protocol itself provides useful distributed building blocks--room IDs,
binary update envelopes, join/version reconciliation, acknowledgements,
reconnect/rejoin behavior, and update fragmentation--but it does not specify
how several gateway pods discover one another or multicast a room update.

The historical community trail explains how the open protocol arrived. In
[`loro#615`](https://github.com/loro-dev/loro/discussions/615), the answer to a
request for a Hocuspocus/Y-Sweet-like server was that one was being developed.
In [`loro#572`](https://github.com/loro-dev/loro/discussions/572), users asked
for WebSocket synchronization guidance; the thread later linked an explicitly
experimental Hocuspocus adaptation. The subsequently released Loro Protocol
fills the wire-protocol and minimal-server gap.

Loro Streams goes further at the service-contract level. Its published clients
define one durable stream per collaborative unit, HTTP append/CAS writes,
opaque replay offsets, bootstrap from snapshot plus retained tail, and live
delivery through SSE with long-poll fallback. However, the public package does
not expose the hosted server implementation. It therefore demonstrates a
broker-centered distributed API, but does not reveal whether cross-gateway
wake-up is implemented with Redis, a broker, an actor, database notifications,
or another internal mechanism.

Therefore:

- Loro is the primary source for update, version, wire-protocol, and binary
  document semantics.
- Loro Streams is direct Loro ecosystem evidence for the durable-stream and
  live-tail service contract.
- The concrete Redis PubSub, consistent-hash owner, and stateless multi-gateway
  internals remain cross-CRDT distributed-systems designs unless their server
  implementation is published.
- Yjs/y-websocket and y/hub are cited because they are public implementations
  of those production topology choices, not because Loro mandates their
  architecture.
- A Loro implementation must validate these choices against Loro Protocol's
  join, acknowledgement, backfill, and reconnect semantics rather than copying
  a Yjs server blindly.

## Existing projects and reuse boundary

There are now several public projects close to this design. None is a mature,
drop-in implementation of all four desired properties at once: Loro support,
Cloudflare and ordinary Node deployment, a durable event log with checkpoint
and projection workers, and replaceable infrastructure ports.

| Project                                                                                         | What is already solved                                                                                                                                                                                                               | Important boundary                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`loro-dev/protocol`](https://github.com/loro-dev/protocol)                                     | Official binary protocol, ACKs, fragmentation, reconnect/rejoin, multi-room multiplexing, and CRDT adaptors for Loro and Yjs                                                                                                         | The TypeScript `SimpleServer` is a process-local Node server. It acknowledges after applying in memory and saves dirty full snapshots periodically through load/save hooks; it does not provide a durable event log, cross-pod fan-out, checkpoint worker, or production Durable Object server.        |
| [`@delightstack/crdt`](https://github.com/brianschwabauer/delightstack/tree/main/packages/crdt) | One SQLite-backed Durable Object per Loro document, idempotent op IDs, append-only updates, named checkpoints, edit sessions, time travel, peer-aware compaction, large snapshots in R2, and an explicitly scheduled projection hook | It is intentionally Loro- and Cloudflare-specific, owns the Durable Object superclass, and supplies no transport. Version `0.4.0` was first published in August 2026, so it is a strong implementation reference but still a young dependency requiring migration and failure testing before adoption. |
| [`Automerge Repo`](https://automerge.org/docs/reference/repositories/)                          | The cleanest mature split between pluggable `StorageAdapter`s and one or more `NetworkAdapter`s                                                                                                                                      | The repository and sync protocol are built around Automerge rather than being a CRDT-independent event/checkpoint runtime.                                                                                                                                                                             |
| [`Kyneta`](https://github.com/halecraft/kyneta)                                                 | A substrate-independent exchange supporting Loro, Yjs, plain JSON and ephemeral state, with pluggable transports, LevelDB persistence and experimental indexes                                                                       | It has a small adoption base, only one published server storage backend, no production Cloudflare Durable Object adapter, and labels indexing/observability work experimental.                                                                                                                         |
| [`PartyServer`](https://github.com/cloudflare/partykit/tree/main/packages/partyserver)          | Durable Object WebSocket lifecycle, hibernation-friendly connections, routing and broadcast                                                                                                                                          | It is a transport/room shell, not an event store, CRDT engine, checkpoint system or projection runner.                                                                                                                                                                                                 |
| [`Rivet Actors`](https://rivet.dev/actors/)                                                     | Portable TypeScript actors with durable state, connections, scheduling and Node/Cloudflare runners                                                                                                                                   | Cloudflare execution still talks to a Rivet control plane. Full self-hosting adds that control plane and its storage/messaging dependencies, which is deliberately heavier than a direct Durable Object deployment.                                                                                    |

The practical reuse decision for Clash is therefore:

```text
official loro-protocol
  owns wire frames, ACK, fragmentation, reconnect and CRDT-type identifiers

Clash ProjectRoom transport shell
  owns authentication, WebSocket hibernation, presence and product sideband

durable document engine
  owns idempotent append, recovery, checkpoints, compaction and projections
```

`@delightstack/crdt` is the closest implementation of the third box and should
be evaluated before building another Loro document engine. Adopting it is not a
package swap in the current codebase: Clash's existing raw-update wire messages
do not carry the required stable `op_id` and actor metadata, and existing
`loro:*` storage must be migrated into its SQLite schema. Its inheritance model
also means `ProjectRoom` would extend `CrdtDocumentServer` rather than compose a
generic port.

If the long-term goal is a truly CRDT-independent library, the abstraction
should be narrower than either product server. Reuse Loro Protocol for the wire
contract, and define only these application-owned ports around the durable
engine:

```text
DocumentAdapter       validate/apply/diff/checkpoint for Loro, Yjs, or a reducer
EventLogPort          append/dedupe/replay/truncate
CheckpointPort        load/publish immutable binary state
ProjectionPort[]      idempotently materialize search, previews, or analytics
FanoutPort            deliver committed events to current subscribers
WorkSchedulerPort     run checkpoint/projection work at least once
```

Do not abstract Loro frontiers, Yjs state vectors and ordinary FIFO versions
into one fake scalar version. Those remain values owned by each
`DocumentAdapter`; the generic runtime owns only its durable transport cursor.

## Why CRDT sync usually does not require an actor runtime

Loro updates are designed to converge despite different delivery order and
duplicate delivery. Consequently, pure sync does not require every update for
a document to pass through one in-memory process.

The sync data plane can therefore accept writes through many gateways:

```text
Gateway A --+
Gateway B --+--> durable update log --> fan-out
Gateway C --+
```

An actor runtime solves a different problem:

```text
all commands for one document
       |
       v
one owner + one mailbox + sequential execution
```

That is useful for non-commutative server-side operations, but it adds
placement, ownership leases, fencing, failover, and hot-owner constraints that
an opaque CRDT event relay does not otherwise need.

This distinction also explains common Yjs deployments. An in-process
`roomId -> Y.Doc` map is actor-shaped, but it is not a distributed actor
runtime. At distributed scale, the official y-websocket material describes
both PubSub fan-out and consistent-hash document ownership. The newer y/hub
project demonstrates the stateless relay direction with Redis-backed update
transport and background persistence/compaction. These are comparison systems,
not evidence that the Loro community has standardized the same topology.

## Deployment shapes

### A. Database-centered stateless relay

```text
Gateway
   |
   | one database transaction
   v
Postgres
   - document_events
   - document_outbox
        |
        v
Outbox dispatcher --> Redis PubSub --> subscribed gateways

Checkpoint worker --> snapshot storage
```

Properties:

- Any gateway can accept an update for any document.
- The database is the durable source of truth.
- Redis PubSub is a low-latency notification path, not durable storage.
- An outbox avoids the unsafe dual write of committing Postgres and publishing
  Redis independently.
- A gateway that misses PubSub messages catches up from the durable log.

This is usually the best starting point because it has clear transactional
semantics and few components. Postgres can support substantial workloads;
adopting a broker should be based on observed event-stream pressure rather than
an assumed traffic threshold.

### B. Broker-centered stateless relay

```text
Gateway --> durable broker log
               |
               +--> realtime delivery
               +--> checkpoint consumer
               +--> optional index consumer
               +--> optional audit/analytics consumers
```

The broker is both the ingestion boundary and replay source. Each durable
consumer maintains its own cursor or offset.

This is attractive when:

- event traffic is sustained and bursty;
- several independent downstream consumers exist;
- backpressure and long-running backlog are normal;
- replay is frequent or retained for a long time;
- database WAL, indexes, connections, or outbox lag have become bottlenecks.

It is not automatically better for a single hot document. If all of that
document's events must remain in one ordered partition, the partition remains
a hot spot. Loro itself does not require a global total order, although the
transport still needs a safe replay cursor and compaction frontier.

#### Case study: Lody and Loro Streams

[`LodyAI/Lody`](https://github.com/LodyAI/Lody) is a concrete Loro application
that uses `loro-repo`, Loro/Flock documents, and the published
`@loro-dev/streams-crdt` transport. Its public architecture is:

```text
local Loro/Flock replica
        |
StreamsTransportAdapter
        |
        +--> POST/CAS opaque update bytes
        +--> GET bootstrap/catch-up from an opaque offset
        +--> GET live SSE, with long-poll fallback
        |
Loro Streams gateway
        |
one durable stream per document/room
```

This is not the `loro-websocket` SimpleServer architecture:

- live delivery uses SSE/long-poll rather than a WebSocket room process;
- the server API is an append-only log, and each replica tracks its own remote
  cursor;
- reconnect performs catch-up from that cursor instead of requiring the same
  gateway process to remember the room;
- stream IDs map from workspace/document identities;
- document metadata and bodies are opened on demand rather than joining every
  historical room at startup.

Lody also receives a deployment topology from its token service and builds
separate origin pools by traffic class:

```text
control shards  --> bootstrap and catch-up
write shards    --> large update POSTs
API shards      --> live SSE and ordinary operations
presence shards --> ephemeral presence streams
```

Clients rotate through each configured origin pool with a randomized starting
point. This is request-class sharding, not publicly documented consistent
hashing by document. Because each origin can address the same stream path, the
front gateways appear interchangeable from the client contract, but the
private hosted backend owns the actual routing and storage topology.

For durable collaboration, every connected replica independently tails the
same logical stream:

```text
writer --> append stream S at offset N
                         |
                         +--> SSE reader A advances to N
                         +--> SSE reader B advances to N
                         +--> SSE reader C advances to N
```

Thus application-level broadcast is expressed as multiple live tails over one
durable log. There is no visible Redis hop in Lody. The service must still wake
subscribers attached through different gateways, but how it does so is outside
the public repository.

The repository explicitly excludes hosted backends and operator configuration.
It is therefore evidence for the client/service boundary, not evidence that the
server is actor-based or stateless internally.

##### Open-source boundary

The Loro Streams packages published to npm are MIT-licensed and publicly
inspectable:

- `@loro-dev/streams-client`: the byte-stream HTTP client and protocol docs;
- `@loro-dev/streams-crdt`: the Loro/Flock transport runtime;
- `@loro-dev/loro-cli`: platform CLI and bundled API specification;
- `@loro-dev/sqlite-riverrun`: a single-node SQLite/WAL development server.

Their package metadata points to `github.com/loro-dev/loro-streams`, but that
repository is not publicly accessible as of this document's update. Lody's own
public repository explicitly excludes hosted backends and operator/billing
configuration. Therefore, the managed Loro Streams server must be treated as a
closed implementation even though its clients, protocol surface, and local dev
server are published.

The underlying generic
[`durable-streams/durable-streams`](https://github.com/durable-streams/durable-streams)
protocol, clients, Node reference server, and Caddy implementation are open
source. Those projects are valid implementation references, but they do not
prove which components the managed Loro Streams service runs internally.

##### What the client contract proves

The public contract proves these server responsibilities:

```text
PUT    /ds/<bucket>/<stream>              create
POST   /ds/<bucket>/<stream>              atomic append / CAS append
GET    /ds/<bucket>/<stream>?offset=...   catch up
GET    /ds/<bucket>/<stream>?live=sse     live tail
GET    /ds/<bucket>/<stream>/bootstrap    snapshot + retained tail
PUT    /ds/<bucket>/<stream>/snapshot/N   publish snapshot at offset N
```

The server assigns opaque monotonically increasing offsets. Optional producer
ID, epoch, and sequence headers provide retry deduplication and zombie-producer
fencing. Those rules require append and producer metadata to be coordinated
atomically per stream, but they do not require an application-level Loro actor.

The gateway can treat document updates as opaque bytes. Loro import/export,
pending-dependency handling, local persistence barriers, and remote cursor
management live in `streams-crdt` on the replica side. This makes the externally
visible service a durable log rather than a server-side `LoroDoc` room manager.

The Durable Streams protocol also deliberately supports CDN/proxy request
collapsing. Catch-up chunks can be cached, long-poll clients echo a server cursor
so equivalent waits can collapse, and SSE connections are periodically renewed
so later readers can share edge/origin work. This can reduce origin fan-out even
though every replica logically tails the same stream.

##### What remains an inference

Multiple request origins plus resumable offsets strongly suggest disposable
HTTP gateway instances in front of shared or consistently routed stream state:

```text
clients
   |
CDN / traffic-class gateway shards
   |
durable stream append/read service
   |
per-stream log + tail offset + producer state
```

An append must wake SSE/long-poll readers that may terminate on other gateway
instances. At least three internal implementations satisfy the public contract:

1. a shared PubSub notification bus keyed by stream ID;
2. consistent routing to a unique stream/partition owner that holds waiters;
3. gateways independently tailing a storage or broker change feed.

The public clients cannot distinguish these designs. The presence of offsets,
CAS, producer epochs, request shards, or SSE does not prove Redis, Kafka, NATS,
or an actor runtime. Likewise, the `Riverrun` name and SQLite dev server reveal
one local implementation, not the managed production storage engine.

#### NATS JetStream

NATS can combine the durable and realtime roles:

```text
Gateway --> subject doc.<document-id>
              |             |
              |             +--> live gateway subscribers
              |
              +--> JetStream retention
                         |
                         +--> checkpoint durable consumer
```

This avoids a second Redis service. The same subject namespace supports live
subscriptions while JetStream provides retained messages and durable consumer
state.

#### Kafka

Kafka is a strong durable partitioned log, but its consumer-group semantics do
not directly implement dynamic WebSocket fan-out.

If all gateway pods share a consumer group, one record is delivered to only one
gateway in that group. That is wrong when clients for the same document are
connected to several gateways. Giving every gateway a unique consumer group
makes every gateway consume the entire stream and filter almost all of it,
which is usually wasteful.

A common Kafka topology therefore adds a fan-out adapter:

```text
Kafka --> realtime dispatcher --> Redis/NATS PubSub --> gateways
      +-> checkpoint consumer
      +-> index consumer
```

Kafka is most justified when the retained event stream and its downstream
processing are already first-class infrastructure concerns.

#### Redis Streams

Redis Streams can provide a lighter durable log, while Redis PubSub provides
live multicast:

```text
Redis Streams --> durable replay and checkpoint consumption
Redis PubSub  --> live gateway multicast
```

These are two different delivery mechanisms even when they run in the same
Redis deployment. Stream consumer groups distribute work among consumers; they
do not broadcast each entry to every gateway. Persistence, eviction policy,
memory limits, and disaster recovery must be configured explicitly if Streams
hold updates that have not yet reached another durable store.

### C. Unique document owner / actor

```text
Clients
   |
Gateway pods
   |
router / placement directory
   |
document owner
   - mailbox
   - in-memory LoroDoc or ordinary state
   - sequential command handler
   - event store / snapshot
   |
fan-out
```

This model supports more than CRDT relay. It can run FIFO command processing,
state machines, synchronous validation against current state, reliable timers,
and non-commutative operations.

The ordering guarantee must be stated precisely:

- Commands are processed one at a time in the order they arrive at the owner.
- The owner cannot infer a universal real-world send order across networks.
- Per-client order needs `clientId` and `clientSeq` when that distinction
  matters.
- Exactly-once execution is not automatic. A practical design uses at-least-
  once delivery plus a stable `commandId` for deduplication.

Failover requires more than an in-memory mailbox:

```text
durable mailbox/event log
+ command-id deduplication
+ owner lease
+ monotonically increasing owner epoch
+ fenced writes
```

On takeover, a new owner loads a snapshot, replays the tail, obtains a newer
epoch, and resumes processing. Storage rejects commits from an older epoch so
that a paused former owner cannot write after recovery.

This model scales well across many documents but a single very hot document is
bounded by its owner unless fan-out or command processing is split further.

### D. Hybrid command and CRDT data plane

Some systems need strict sequencing for a small set of business commands but
not for ordinary collaborative edits:

```text
ordinary Loro updates --> stateless relay

publish / settle / allocate-id command
             |
             v
       unique owner / workflow
             |
             v
      resulting durable event
             |
             v
       stateless fan-out
```

This prevents all cursor movement, text edits, and canvas updates from paying
the cost of actor placement merely because a few product operations require
serialization.

## Realtime fan-out

PubSub is scoped multicast:

```text
publish channel doc.123
       |
       +--> gateway A, subscribed because it has local doc.123 clients
       +--> gateway B, subscribed because it has local doc.123 clients
       +--> gateway C, no subscription and no delivery
```

A gateway subscribes when its first local client joins a document and
unsubscribes after its last local client leaves.

Ordinary Redis PubSub has at-most-once delivery. A subscriber disconnected at
the wrong moment loses the message, so PubSub cannot be the source of truth.
Every broadcast envelope should carry enough information for deduplication and
catch-up:

```ts
type UpdateEnvelope = {
  documentId: string;
  updateId: string;
  cursor: string | number;
  payload: Uint8Array;
};
```

On subscription recovery, reconnect, or a detected cursor gap, the gateway
reads missing updates from the durable event path. Loro tolerates duplicate
imports, but `updateId` remains useful for transport-level observability,
idempotent ingestion, and avoiding needless work.

The safe acknowledgement boundary is durable append, not PubSub delivery:

```text
receive update
  -> authenticate and authorize
  -> durably append event and outbox record
  -> commit
  -> acknowledge persisted update
  -> asynchronously fan out, with retry
```

A protocol may additionally expose delivery status, but a transient PubSub
failure must not turn an already committed update into an ambiguous new write.

## Durable event log

Both Loro updates and checkpoints are opaque binary values:

```text
incremental update = Uint8Array
full snapshot      = Uint8Array
```

Infrastructure does not need to decode them. WebSocket binary frames, Postgres
`BYTEA`, Kafka record values, NATS payloads, and Redis values can all carry the
bytes directly.

A conceptual database schema is:

```text
document_streams
  document_id
  next_seq

document_events
  document_id
  seq
  update_id
  payload
  created_at
  UNIQUE(document_id, seq)
  UNIQUE(document_id, update_id)

document_outbox
  outbox_id
  document_id
  seq
  update_id
  payload
  published_at

document_checkpoints
  document_id
  through_seq
  object_key or snapshot_bytes
  checksum
  encoding_version
  created_at
```

No foreign-key relationship is required for this shape.

`seq` is a transport and retention cursor, not part of CRDT conflict
resolution. If it is used as a checkpoint frontier, it must represent a stable
committed prefix. A naive database sequence plus `MAX(seq)` is unsafe because
transactions can allocate sequence values and commit out of order.

Safe choices include:

- allocate a per-document sequence while holding its stream-row lock until the
  event transaction commits;
- use the committed offset of a durable broker partition;
- use a richer inclusion frontier instead of a scalar sequence and retain
  events until inclusion is proven.

The short database row lock used to allocate a replay cursor is not an actor
owner: gateways remain stateless and do not load or execute the document's
business state. It does, however, set the maximum serialized append rate for a
single document and should be measured for unusually hot rooms.

## Binary checkpoint construction

Loro's persistence guidance recommends frequent incremental update storage and
periodic snapshot encoding. A checkpoint combines the previous snapshot with a
stable prefix of later events:

```text
checkpoint throughSeq=1000
       +
events 1001..1800
       |
       v
LoroDoc.import(snapshot)
LoroDoc.import(each update)
       |
       v
LoroDoc.export(snapshot mode)
       |
       v
checkpoint throughSeq=1800
```

The worker algorithm is:

1. Read the newest published checkpoint.
2. Choose a stable, committed high-water mark `H`.
3. Import the old snapshot, if present.
4. Import events after the old frontier through `H`.
5. Export a new full Loro snapshot.
6. Write the immutable snapshot bytes and checksum.
7. Publish the checkpoint metadata with compare-and-set, only if it advances
   the current frontier.
8. Prune or archive covered events only after the snapshot and metadata are
   durable and recoverable.

Concurrent checkpoint workers do not necessarily require a distributed lock.
They may compute redundantly and use `through_seq` compare-and-set so an older
result cannot replace a newer one. A per-document work lease is still useful
when duplicate computation is expensive.

Checkpoint triggers may combine:

- elapsed time;
- number of tail events;
- total tail bytes;
- observed rebuild latency;
- document activity or idle transition.

New replicas recover with:

```text
latest full snapshot
+ events after checkpoint frontier
= current document
```

Full snapshots improve replay time but do not necessarily bound CRDT-history
size because they retain history needed for synchronization. Loro shallow
snapshots truncate older history, but impose restrictions on merging updates
that are concurrent with the shallow-history boundary. Use full snapshots
until offline-client retention and history truncation have an explicit product
policy.

If covered event rows are deleted, the source of truth becomes
`checkpoint + tail events`. If all events are retained elsewhere, a checkpoint
is a derived recovery cache.

## Product version history, garbage collection, and storage growth

Undo, operational recovery, and product-visible version history are separate
features even when they are all described informally as "history":

| Feature                 | Typical state                                          | Purpose                                                                 |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Local undo/redo         | Per-peer undo manager and local operation ranges       | Reverse the current user's recent actions without undoing collaborators |
| Operational recovery    | Latest verified checkpoint plus durable event tail     | Restart a room, gateway, or materializer after failure                  |
| Product version history | Revision metadata plus materializable historical state | Preview, diff, attribute, name, share, and restore old versions         |
| Audit history           | Immutable semantic actions or attributed operations    | Explain who performed a business action and satisfy retention policy    |

Keeping all transport events forever solves all four poorly. It preserves raw
bytes but does not automatically provide good undo grouping, human-readable
activity, efficient historical loading, or bounded document size.

### Public implementation patterns

Figma publicly describes two checkpoint cadences with different product
purposes. Its multiplayer infrastructure serializes and compresses the entire
in-memory file to S3 every 30 to 60 seconds for operational recovery, while a
durable DynamoDB journal records batched changes with file-local sequence
numbers. Separately, the product-visible Version History adds an autosave
checkpoint every 30 minutes and supports manually named versions. Restoring an
old version is non-destructive: Figma records both the pre-restore state and
the restored state as new history points. The public material does not say
whether every visible history row owns a physically independent full blob or
references shared internal checkpoint/journal data.

Penpot is the closest fully open Figma-like snapshot example. Manually saved
versions are retained indefinitely by default. Automatic file snapshots are
optional for self-hosted installations and can be triggered by a count of save
operations plus a maximum elapsed time. File and snapshot data can live in the
database or object storage. Its documentation explicitly warns that enabling
aggressive automatic versioning can grow the database significantly.

Etherpad uses the classic log-plus-keyframe model. Every revision stores a
changeset with author and timestamp, while a complete attributed-text state is
stored periodically--the project records a full `aText` every 100 revisions.
Its time slider reconstructs an intermediate revision from a key revision plus
the following changesets. This gives fine-grained playback without storing a
full document for every revision.

The open Yjs y/hub takes a CRDT-history approach. It maintains both a
garbage-collected current document and a non-garbage-collected document whose
deleted content remains available for history. Attribution metadata maps
content ranges to users and timestamps. Activity rows can be grouped by time
and author, and historical states or changesets are rendered from the shared
non-GC document. Pruning churned history is explicit and irreversible rather
than an incidental side effect of writing a newer snapshot.

Automerge Repo persists content-addressed incremental changes and periodically
compacts all changes a process has observed into a snapshot identified by the
document heads. A compactor only removes incremental chunks it has already
loaded and incorporated, so concurrent writers cannot lose unseen changes.
Historical points are DAG head hashes rather than necessarily separate copies
of the whole document.

These examples reduce to three storage families:

```text
multiple full snapshots
  Figma product checkpoints, Penpot versions

event log + sparse keyframes
  Figma recovery journal, Etherpad revisions

history-preserving CRDT + logical version pointers
  y/hub non-GC documents, Automerge heads, Loro frontiers
```

### Loro-specific growth boundary

A normal Loro snapshot is not a state-only compaction. It includes both the
current state and the operation history. Exporting another full snapshot
reduces `snapshot + update tail` load work, but it does not remove historical
operations from the Loro document.

A Loro shallow snapshot establishes a history floor:

```text
full history
  A -- B -- C -- D -- E -- F

shallow snapshot starting at D
  state-at-D + D -- E -- F
                 ^
                 history before this floor is absent from the active replica
```

This bounds active storage and load cost, but it is a product-semantic choice:

- versions older than the floor cannot be checked out from the active shallow
  replica;
- an update concurrent with the shallow snapshot's starting version cannot be
  imported into that replica;
- a peer whose usable history predates the floor cannot simply resume normal
  incremental synchronization;
- deleted content retained only in the old operation history is no longer
  available for diff, attribution, or restore;
- removing historical content from the active document does not satisfy a
  deletion requirement if full-history archives still retain that content.

Therefore the garbage-collection frontier must be derived from a declared
offline and history policy. It must never advance merely because a checkpoint
job happened to run.

### Recommended product sweet spot

Use four retention tiers instead of treating every visible version as a full
checkpoint:

```text
Tier 1: durable transport tail
  High-frequency Loro updates after the active recovery checkpoint.
  Retained long enough for replay, checkpoint validation, and broker failure
  recovery; not necessarily permanent product history.

Tier 2: operational recovery checkpoints
  Frequent immutable binary snapshots used to bound restart work.
  Keep the newest verified generations and a short fallback window.

Tier 3: product revision markers and history anchors
  Small user-visible markers for edit sessions, named versions, publish,
  branch/merge, restore, and other semantic milestones. Most markers refer to
  a frontier and transport cursor. Selected markers are promoted to retained
  binary anchor checkpoints.

Tier 4: pre-GC archive and active shallow baseline
  Before advancing the active history floor, write and verify an immutable
  full-history archive when policy requires old versions to remain available.
  Then publish a shallow snapshot for active loading and collaboration.
```

The physical model is:

```text
revision marker R17 --------------------+
  frontier = F17                        |
  transport cursor = C17                |
                                        v
anchor checkpoint A --------> retained events --------> current head
  frontier = FA                 FA..F17                  FCURRENT

after the retention window:
  cold full-history archive + active shallow baseline + recent full history
```

A conceptual metadata shape is:

```text
document_revisions
  revision_id
  document_id
  kind                 auto | named | publish | branch | restore
  frontier_bytes
  transport_cursor
  anchor_checkpoint_id nullable
  primary_actor_id
  title                nullable
  description          nullable
  created_at

document_checkpoints
  checkpoint_id
  document_id
  encoding_mode        full | shallow
  frontier_bytes
  through_cursor
  history_floor_bytes  nullable
  object_key
  checksum
  retention_class      recovery | history-anchor | pre-gc-archive
  created_at
```

No foreign-key relationship is required for this conceptual shape. Checkpoint
blobs should be immutable; the current pointer advances with compare-and-set.
Content addressing by checksum can deduplicate identical materializations.

Revision creation should be product-driven:

- keep recovery checkpoints frequent enough to satisfy restart-latency and
  event-tail limits;
- coalesce autosave history rows so continuous pointer movement or typing does
  not flood the history panel;
- create explicit markers for user-named versions and semantic milestones;
- preserve the current head before a restore, then publish the restored state
  as a new head instead of deleting later history;
- retain enough attribution or semantic action metadata to explain a revision,
  because opaque Loro update bytes alone do not provide product labels such as
  "published component library" or "restored deleted scene".

The active full-history window should cover the maximum offline duration the
product promises. A client older than the GC floor needs an explicit recovery
path: rebootstrap from the shallow baseline, or submit its offline work to a
bridge that still has the archived common history. Without such a bridge, the
product cannot simultaneously promise indefinite offline edits and aggressive
history truncation.

The result preserves the high-value product behavior:

```text
fast current-document load
+ reliable crash recovery
+ collaborative local undo
+ browsable and attributable version history
+ non-destructive restore
+ durable named milestones
```

while bounding the main growth vectors:

```text
raw transport-event retention
+ duplicated full checkpoint blobs
+ tombstones and deleted CRDT content
+ per-operation history UI metadata
```

There is no universal time or operation-count constant for this balance.
Measure snapshot bytes, tail bytes, replay latency, number of historical peers,
offline return age, and history-preview frequency. Advance the GC floor only
when those measurements and the product retention contract justify dropping
the corresponding merge and history capabilities.

## Background consumers

### Checkpoint consumer

The checkpoint consumer understands the Loro binary encoding. It imports a
snapshot and incremental updates, then exports the next snapshot. Its purpose
is to bound recovery work and enable safe event archival.

It is required for the design in scope once replay time or tail size exceeds
the chosen operational limit.

### Realtime dispatcher

The realtime dispatcher converts committed events into live PubSub messages.
In the database-centered shape it reads the transactional outbox. In a Kafka
shape it consumes partitions and republishes by document subject/channel.

NATS JetStream can collapse this role into the broker because live subject
subscriptions and retained streams coexist in the same system.

### Index consumer

An index consumer is optional. Raw Loro bytes are not directly useful for SQL
search, project-list summaries, analytics, or search engines. This consumer
loads the binary document state and writes a queryable projection such as:

```text
document_id
title
updated_at
node_count
search_text
```

A pure sync backend that never searches or interprets document content does
not need an index consumer.

### Presence

Presence, cursors, selections, and typing indicators are ephemeral. They should
use PubSub plus TTL-based state if a roster is required. They do not belong in
the durable Loro event log or snapshots unless the product explicitly models
them as durable document facts.

## Kubernetes deployment

### Minimal database-centered installation

```text
Ingress / external load balancer
  |
Service/sync-gateway
  |
Deployment/sync-gateway, replicas >= 2

Deployment/outbox-dispatcher
Deployment/checkpoint-worker

External or in-cluster Postgres
External or in-cluster Redis
Optional object storage for snapshots
```

The application Helm chart only needs ordinary Deployments and Services:

```text
templates/
  sync-gateway-deployment.yaml
  sync-gateway-service.yaml
  outbox-dispatcher-deployment.yaml
  checkpoint-worker-deployment.yaml
  configmap.yaml
  secret-references.yaml
  pdb.yaml
```

Representative values:

```yaml
syncGateway:
  replicaCount: 3
  autoscaling:
    enabled: true

outboxDispatcher:
  replicaCount: 2

checkpointWorker:
  replicaCount: 2

postgres:
  external: true

redis:
  external: true

snapshotStorage:
  type: object-store
```

No StatefulSet, actor placement service, sticky session, or per-document
Kubernetes object is required. Connection draining, readiness probes, a Pod
Disruption Budget, and reconnect backoff remain important because WebSocket
connections are long-lived even though gateway state is disposable.

For a low update rate, checkpointing may start as a CronJob. A continuously
running Deployment consuming queued compaction work is preferable once backlog,
per-document coalescing, retries, and lag metrics matter.

### Actor installation

An actor topology additionally needs:

- a placement/directory mechanism or consistent-hash membership view;
- document-owner workers;
- leases and epoch fencing;
- durable state/mailbox storage;
- gateway-to-owner routing;
- takeover and rebalancing behavior.

A framework such as Dapr Actors can supply parts of placement and activation,
but the storage, fencing, delivery, and application semantics still need to be
specified. A custom lightweight owner service can use database leases, but it
is still a control plane even if it is not deployed as a separately named
service.

## Correctness invariants

Regardless of the selected infrastructure:

1. An acknowledged update has been durably appended.
2. `updateId` makes ingestion retries idempotent.
3. PubSub delivery is never the only copy of an update.
4. A replay cursor used for pruning represents a stable committed prefix.
5. A checkpoint records exactly which prefix it includes.
6. Checkpoint publication is atomic from readers' perspective.
7. Covered events are pruned only after the checkpoint is durable and verified.
8. New gateways recover without contacting a previous gateway.
9. Gateway and worker crashes may cause duplicate delivery but not event loss.
10. Presence and authorization state are not inferred from opaque CRDT bytes.

The final point is important: a backend that does not interpret the document
cannot enforce arbitrary semantic rules inside it. Authentication and
document-level admission can happen at the gateway, but field-level validation,
server-side invariants, and derived authorization require a materializer,
command owner, or another trusted stateful component.

## Selection guide

Choose database-centered stateless relay when:

- the server stores opaque Loro updates;
- realtime fan-out and checkpointing are the only consumers;
- operational simplicity matters;
- Postgres and Redis are already available.

Choose NATS JetStream-centered relay when:

- one system should provide retained updates and live subject fan-out;
- independent durable consumers and replay are important;
- the team is comfortable operating or buying managed NATS.

Choose Kafka plus a fan-out layer when:

- the event log is a major platform primitive;
- many downstream consumers and large retained backlogs already justify it;
- partitioning, consumer groups, and a separate realtime multicast path are
  acceptable operationally.

Choose a unique owner/actor when:

- commands must execute FIFO against current server state;
- operations are non-commutative;
- the server owns timers or a state machine;
- a single authoritative decision per document is required.

Choose a hybrid when only a minority of commands need those guarantees.

For the scoped requirement in this document, start with:

```text
Postgres event log + transactional outbox
+ Redis PubSub
+ stateless WebSocket gateways
+ binary full-snapshot checkpoint worker
```

Do not introduce actor placement until a concrete serialized business command
requires it. Do not introduce Kafka only because the service is distributed;
introduce it when the durable stream itself has become the workload.

## Sources and community implementations

- [Lody](https://github.com/LodyAI/Lody) is a production-oriented Loro/Flock
  application using the Loro Streams transport.
- [Lody public repository boundary](https://github.com/LodyAI/Lody/blob/main/AGENTS.md)
  explicitly excludes hosted backend and operator implementation.
- [Lody Streams transport wiring](https://github.com/LodyAI/Lody/blob/main/apps/cli/src/lib/loro/streams-transport.ts)
  maps Loro/Flock documents onto the `StreamsTransportAdapter`.
- [Lody request shard construction](https://github.com/LodyAI/Lody/blob/main/packages/shared/src/index.ts)
  separates bootstrap/catch-up, large writes, other API traffic, and presence
  across injected origin pools.
- [`@loro-dev/streams-crdt`](https://www.npmjs.com/package/@loro-dev/streams-crdt)
  defines initial sync, append, catch-up, SSE/long-poll live mode, remote cursor
  persistence, and snapshot upload for Loro/Flock replicas.
- [`@loro-dev/streams-client`](https://www.npmjs.com/package/@loro-dev/streams-client)
  defines the underlying single-stream HTTP API, opaque offsets, live tails,
  idempotent producers, and bootstrap protocol.
- [`@loro-dev/loro-cli`](https://www.npmjs.com/package/@loro-dev/loro-cli)
  publishes the Gateway OpenAPI surface and a local SQLite/WAL development
  server command.
- [Durable Streams](https://github.com/durable-streams/durable-streams) is the
  open generic protocol and reference implementation family underlying the
  HTTP append/catch-up/live-tail model.
- [Loro Protocol](https://github.com/loro-dev/protocol) defines the
  transport-agnostic room protocol and ships minimal TypeScript and Rust
  WebSocket servers.
- [Loro Protocol announcement](https://loro.dev/blog/loro-protocol) describes
  the protocol, multiplexed rooms, adaptors, and the testing-oriented
  `SimpleServer`.
- [Loro TypeScript SimpleServer](https://github.com/loro-dev/protocol/blob/main/packages/loro-websocket/src/server/simple-server.ts)
  shows the process-local room map and in-process WebSocket broadcast loop.
- [Loro server-side implementation discussion](https://github.com/loro-dev/loro/discussions/615)
  records the earlier request for a Hocuspocus/Y-Sweet-like server.
- [Loro WebSocket synchronization discussion](https://github.com/loro-dev/loro/discussions/572)
  records the request for server guidance and an experimental community
  Hocuspocus adaptation.
- [Loro persistence](https://loro.dev/docs/tutorial/persistence) describes
  periodic snapshot encoding, frequent update encoding, and loading a snapshot
  followed by later updates.
- [Loro encoding](https://loro.dev/docs/tutorial/encoding) distinguishes full
  snapshots, updates, and shallow snapshots, including shallow-history merge
  constraints.
- [Figma multiplayer reliability](https://www.figma.com/blog/making-multiplayer-more-reliable/)
  describes its in-memory authoritative file process, 30-to-60-second S3
  checkpoints, sequenced DynamoDB journal, batched journal writes, and recovery
  from checkpoint plus journal tail.
- [Figma Version History](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)
  documents 30-minute product-visible autosave checkpoints, named versions,
  and non-destructive restore behavior.
- [Penpot configuration](https://github.com/penpot/penpot/blob/develop/docs/technical-guide/configuration.md)
  documents indefinite manual versions, optional count/time-triggered automatic
  file snapshots, and database or object-storage file-data backends.
- [Penpot file changes](https://github.com/penpot/penpot-docs/blob/main/technical-guide/developer/data-guide.md)
  documents serialized change objects with redo and undo payloads, separately
  from its file snapshot history.
- [Etherpad database structure](https://docs.etherpad.org/database.html)
  documents per-revision changesets with author and timestamp.
- [Etherpad changelog](https://github.com/ether/etherpad/blob/develop/CHANGELOG.md)
  records the periodic full attributed-text state stored every 100 revisions
  for recovery and time-slider reconstruction.
- [Yjs y-websocket documentation](https://github.com/yjs/docs/blob/main/ecosystem/connection-provider/y-websocket.md)
  describes distributed scaling with PubSub or consistent hashing by document.
- [Yjs y/hub](https://github.com/yjs/yhub) is a compatible backend whose
  WebSocket tier avoids retaining a complete Y.Doc after initial sync and uses
  background workers for persistence/compaction.
- [y/hub API](https://github.com/yjs/yhub/blob/master/API.md) documents its
  garbage-collected and full-history document variants, attribution-aware
  activity grouping, historical rendering, rollback, and irreversible pruning.
- [y/hub deployment guidance](https://github.com/yjs/yhub/blob/master/DEPLOYMENT.md)
  explains the durability role of Redis Streams for updates not yet persisted.
- [Automerge Repo storage](https://automerge.org/docs/reference/under-the-hood/storage/)
  describes content-addressed incremental chunks, head-addressed snapshots,
  and concurrency-safe compaction that only removes incorporated changes.
- [Redis Pub/Sub delivery semantics](https://redis.io/docs/latest/develop/pubsub/)
  document at-most-once delivery and the lack of replay for ordinary PubSub.
- [NATS JetStream concepts](https://docs.nats.io/nats-concepts/jetstream)
  cover retained streams, consumers, acknowledgement, and replay.
- [Apache Kafka consumer documentation](https://kafka.apache.org/documentation/#intro_consumers)
  explains consumer groups and partition assignment.
- [Dapr actors on Kubernetes](https://docs.dapr.io/developing-applications/sdks/js/js-actors/)
  is an example of an actor runtime option when unique activation and
  serialized object behavior are actually required.


## Implemented client checkpoint delegation (2026-09-15)

The Node path now follows remote-compaction separation: PG assigns an immutable
log range, admitted Local Hosts compute a candidate snapshot, and PG publishes
bytes plus covered cursor. Official Loro Streams SDK handles snapshot/read/upload
transport; application code retains leases, authorization and publication ordering.
The worker reconstructs a separate document rather than exporting mutable local
state. Cloud remains opaque and trusts admitted snapshot producers; retained logs
support independent reconstruction. No automatic truncation is introduced.
See `apps/api-node/README.md` for the active protocol, limits and maintenance tool.


### Superseded by autonomous producers

The latest implementation removes task dispatch and leases. Hosts periodically
produce snapshots of fully imported remote log prefixes with randomized intervals;
cloud accepts only committed offsets and monotonically publishes the newest one.
Equal/older results are no-ops. The isolated document, trust boundary and retained
logs remain. Migration 0007 removes the historical task table.


### Final decision: backend asynchronous checkpoints

To simplify coordination, routine snapshot maintenance now runs in a separate Node
worker. Dirty heads are the work set; full snapshot plus captured log prefix yields
a candidate that is published monotonically. Multiple workers may compute redundantly.
Client snapshot scheduling, jitter, pre-upload checks and public upload were removed.
Local Host remains the local working replica authority. Background maintenance needs
no online client, task table or lease. See the current api-node README for deployment.


### Durable scheduling integration (2026-09-16)

The separate checkpoint polling process is retired. Node append transactions now
register/coalesce a delayed checkpoint in the existing PostgreSQL outbox. The
existing executor owns claims, retries and lease-fenced acknowledgement; the
handler returns the actual covered offset so concurrent tails remain scheduled.
Migration 0008 upgrades/backfills existing data. This is Node durable delayed work,
not a generic cron API or the CF-only scheduled entrypoint.
