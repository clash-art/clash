# Node cloud service

Node/PostgreSQL is an optional hosted backend, separate from the machine's local
Host. It serves token-authenticated admission and an opaque snapshot/log relay.
The durable outbox hands checkpoint tasks to BullMQ on PostgreSQL. Worker threads
compute checkpoints from durable logs. The gateway
holds connections and notification subscriptions, not project CRDT state.

## Run

Use Node 24 and installed workspace dependencies:

```sh
# Set DATABASE_URL and CLOUD_PUBLIC_URL first. HOST defaults to loopback.
pnpm --filter @clash/api-node migrate
pnpm --filter @clash/api-node start
pnpm --filter @clash/api-node worker:outbox
```

`PORT` defaults to 8080; containers can set `HOST=0.0.0.0`. Startup never applies
migrations. The migration runner uses checksums and a transaction advisory lock.
Application migrations add no foreign keys. BullMQ owns its separate queue schema
in the same database. The explicit migrate command applies both sets of migrations.
The PG pool is reused per process; gateways use one additional
LISTEN connection. TLS is configured through the connection settings without
turning off certificate validation.

API routes accept `Authorization: Bearer clsh_...` tokens. User/internal headers
are never authority. Set `BETTER_AUTH_SECRET` (at least 32 characters) to enable
Better Auth email/password endpoints at `/api/better-auth/*`. Without that setting,
the existing token-only relay remains available and login routes are not mounted.
The public origin is `CLOUD_PUBLIC_URL`; cross-origin session writes are rejected.
Database-backed sessions and auth rate limits are shared across Node instances.
No schema changes occur during startup; deploy migration 0010 explicitly first.

Signed-in sessions can create/list/revoke tokens through `/api/settings/tokens`
and `/api/settings/tokens/:id`, matching the existing settings client contract.
Only SHA-256 hashes are stored; a new token is returned once. Bearer tokens cannot
mint other tokens. Google/OTP login, browser collaboration, resource delivery and
production generation wiring remain unfinished. API authentication passing does
not establish complete browser-product readiness.

## Shared Web frontend in local development

Run the existing Vite/React Web frontend against Node without the Cloudflare
plugin. Keep browser API requests on the Web origin so cookies and origin checks
work together:

```sh
# After configuring DATABASE_URL, BETTER_AUTH_SECRET and applying migrations:
CLOUD_PUBLIC_URL=http://localhost:3002 PORT=8081 pnpm --filter @clash/api-node start
# In a second terminal:
CLASH_NODE_API_URL=http://127.0.0.1:8081 pnpm --filter @clash/web dev --host 127.0.0.1 --port 3002 --strictPort
# In a third terminal, using the same DATABASE_URL:
pnpm --filter @clash/api-node worker:outbox
```

Open http://localhost:3002/login. Web discovers enabled methods through
`GET /api/better-auth/options`; Node currently advertises password auth only.
Browser sessions authenticate Project listing, while bearer tokens retain the
existing admission/relay contracts. Session mutations require the public Web
origin. API, worker and Web are separate processes in one repository, with shared
business contracts; PostgreSQL persists account, admission and task data.

This enables real registration/login and owned Project listing through the Web
frontend. It does not establish full Node editor, Asset or generation parity.

## Snapshot + append log

Under `/api/v1/projects/:id/replica`:

- `GET /`: discovery (`loro-streams-v1`) and committed head.
- `HEAD /`: stream metadata, including latest snapshot offset when available.
- `GET /snapshot`: redirect to `/snapshot/:offset`; 404 before the first snapshot.
- `GET /?offset=...`: ordered JSON records containing IDs and base64 updates.
- `POST /`: JSON record with a matching `Idempotency-Key`; returns its durable offset.
- `GET /?offset=...&live=sse`: actual log batches and SDK control frames.
  Snapshot upload is not a public API. Only the backend worker publishes checkpoints.

Cold start loads the snapshot, applies it locally, then pulls logs strictly after
its covered cursor. Reconnect continues from the last locally persisted cursor.
A log gap returns 410 so the client reloads a snapshot; a cursor beyond the head
returns 409. Snapshot bytes and covered cursor are stored together. History is
currently retained, so GC/retention is not yet activated.

`@clash/replica/replica-stream-client` uses `@loro-dev/streams-client` for
append/read, SSE reconnection and snapshot download/upload. Application progress
advances only after its `apply()` persistence callback succeeds. Cursor storage
must be scoped to the endpoint and Project.

The Local Host discovers this profile and selects the cursor transport. Existing
Cloudflare Loro WebSocket servers retain their protocol. The Host re-exports local
history on a new connection to recover edits made offline; stable content-derived
append IDs protect retries. Local cursor progress survives connection replacement,
while a full Host restart currently bootstraps snapshot + tail again. Initial local
history upload is bounded by the 8 MiB append limit; chunked offline-history upload
is still a follow-up before large-project acceptance.

The Node experimental `/sync?...protocol=loro-v1` WebSocket gateway has been removed.
There is no gateway Loro import, fork, VersionVector exchange or merged-document cache.
Authorization, binary body limits, durable append and replay ordering remain enforced.
An append ACK means bytes were durably stored, not that a CRDT merge succeeded.
Invalid bytes can be appended by an authorized writer; consumers fail without
advancing their local cursor, and the backend checkpoint worker refuses to publish beyond
invalid bytes or unresolved causal dependencies. Recovery/repair for such a log is
not implemented. No server silently drops a bad update or claims a later checkpoint.

## Workers

Append commits update bytes, Project cursor and outbox together. Two workers can
claim with `SKIP LOCKED`; lease IDs and expiry fence acknowledgement. NOTIFY contains
only Project/cursor. Crashes can cause repeated notifications, not missing durable
updates. Failed work is retried after lease expiry.

## Backend checkpoint computation

Each log append atomically writes a notification and registers checkpoint work in
`project_replica_outbox`. Notification and checkpoint are separate queue kinds.
There is at most one pending checkpoint per Project: later appends advance its
target cursor without postponing its original due time or replacing an active
lease. The first append schedules it ten minutes later. Migration 0008 also
backfills pending work for existing dirty heads.

`worker:outbox` runs independent notification and checkpoint handoff loops.
Notifications retain the existing publisher. Checkpoint intents become BullMQ
PostgreSQL jobs with deterministic Project/cursor IDs. The fenced outbox ACK now
means durable queue handoff, not snapshot coverage. Newer appends remain pending
through the cursor fence; the first pending append still anchors the ten-minute
window. This does not provide a generic application cron registration API.

BullMQ workers execute checkpoint computation in worker threads so CPU-heavy Loro
merges do not block queue lock renewal. Computation captures a committed prefix,
imports bounded log pages, and checks gaps and missing causal dependencies.
Snapshot bytes and covered cursor publish atomically with a monotonic guard.
Concurrent appends remain in the tail. Failed jobs retry with exponential backoff
(up to 20 attempts); exhausted jobs remain available for operational inspection.
No automatic failed-job repair or job/history retention policy is implemented.
Completed jobs are retained to preserve handoff deduplication.

Local Hosts only persist and exchange updates. The gateway serves opaque bytes
and rejects public snapshot uploads. Background computation does not depend on
any client staying online. Raw invalid log updates can still be appended by an
admitted writer; validation fails during replay and no checkpoint advances past
them. Repair and log GC remain unimplemented. No event or idempotency history is
deleted by checkpoint publication.

Migration 0007 removes the abandoned client-task table. Migration 0008 extends the
existing outbox with queue kind and checkpoint coalescing; historical checksums
remain unchanged. Deploy migrations before starting the updated producers/workers.

## Node generation execution adapter

`createNodeGenerationService` binds PostgreSQL persistence and dispatch to the
shared hosted generation admission/lifecycle policy. It returns the coordinator
and journal accepted by `createNodeTaskRuntime`; product IO ports are required. Its BullMQ Flow executes provider → stage → publish. The shared
`DurableRunEngine` remains the business state machine, including submit ambiguity,
delayed polling, attempt fencing and failure projection. Cloudflare keeps its
Workflow driver; Local keeps its local coordinator. Business ports and durable
record semantics are shared; scheduling adapters remain platform-specific.

Migration 0009 atomically records a new run and its dispatch intent. A dispatcher
hands it to BullMQ using stable IDs, then acknowledges the intent. Replaying after
a crash between enqueue and acknowledgement is safe. Subsequent journal changes
are protected by CAS, while the active queue job remains responsible until its
queue transition completes. External effects still require the shared engine's
idempotency and reconciliation contracts; this does not promise exactly-once HTTP
requests. A projected business failure may complete the Flow normally: read the
business journal for product status. Infrastructure failures exhaust into retained
failed queue jobs and need operational intervention.

`start()` starts consumers and the dispatch loop; `close()` stops acquisition and
worker threads. The shipped `worker:outbox` CLI currently supplies only checkpoint
ports. Actual Node generation admission routes, credential resolution, durable
object-storage staging and Project publication are **not wired into that CLI**.
The generation adapter is validated with fixture ports and real PostgreSQL,
including a killed worker process. It is not a complete Node generation product.

BullMQ is pinned to 6.3.6 and uses its PostgreSQL backend without Redis or DBOS.
Queue migrations run only through the explicit migrate command, never startup.

## Validation

```sh
pnpm --filter @clash/api-node test
PG_BIN=/opt/homebrew/opt/postgresql@17/bin pnpm --filter @clash/api-node test:cluster
PG_BIN=/opt/homebrew/opt/postgresql@17/bin CLUSTER_WRITES=1000 CLUSTER_REPORT_PATH=/tmp/relay.json pnpm --filter @clash/api-node test:cluster
```

`PG_BIN` is optional when PostgreSQL tools are on PATH. `test:cluster` creates its
own temporary loopback PG cluster and independent gateway/worker processes, then
stops and removes them. It does not register services. This is one PG server with
multiple application processes, not PG HA. Durability settings stay enabled; local
trust authentication does not verify deployment TLS.

The suite runs three gateway processes, two durable outbox executors during
load, and four writer sessions (separate replicas in the test process). It checks
fan-out, LISTEN outage, SIGKILL gateway and durable-executor recovery, snapshot +
tail, idempotent retries and outbox lease recovery. Snapshots are compared to the
converged clients at committed head. PostgreSQL is a single loopback server.
The SSE SDK is exercised over real HTTP/TCP. Fixture notification/replay polling is
60 seconds so the 15-second recovery assertions cannot pass solely through polling.
`CLUSTER_WRITES` is per writer/scenario; four closed-loop writers compare one hot
Project to four Projects. `CLUSTER_PAYLOAD_BYTES` defaults to 1024 random text bytes.
Default `CLUSTER_PEER_MODE=fresh` deliberately grows a new Loro peer per write;
`persistent` reuses each writer's peer. Client CRDT merge cost and same-host contention
are included in workload time. These are acceptance samples, not production capacity.

SDK: [Loro Streams client](https://www.npmjs.com/package/@loro-dev/streams-client).
Protocol alternative evaluated: [Durable Streams](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md).
PG: [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html),
[LISTEN startup reconciliation](https://www.postgresql.org/docs/current/sql-listen.html).

## Personal asset library

Migration `0011_personal_assets.sql` adds owner-scoped Resource facts, library
entries and deletion operation IDs. The existing Asset SDK HTTP contract now
supports list, read, multipart import, trash, restore and authenticated media
reads under `/api/v1/libraries/personal/assets`. Session writes require the public
origin; bearer tokens use the same account boundary. Media supports byte ranges.

Set `CLOUD_ASSET_DIR` to a persistent writable volume (default `data/assets`,
relative to the server working directory). Files use SHA-256 storage names and
atomic publication before database admission. Back up this volume together with
PostgreSQL. Multiple API instances must share the same volume. Database rows do
not contain media bytes, paths or public storage credentials. Imports are bounded
to 64 MiB including multipart overhead; unsupported MIME types are rejected.

Trash is logical and removes media projections. Restore checks the observed
delete operation; stale delete retries cannot re-trash a restored entry. The
30-day purge eligibility timestamp does not schedule physical deletion: a GC
worker, orphan-upload reclamation, quotas and generated video thumbnails are
not implemented. Files remain recoverable until a future purge actually runs.
Project-to-library publication is not part of this route implementation.

## Timeline editing

When browser authentication is configured, the Node server loads the bundled
Remotion Timeline projection definition. Keep `plugins/remotion/manifest.json`
and `plugins/remotion/generators/timeline.json` with the source deployment.
`POST /api/v1/projects/:id/host-command` supports Timeline list, create, state
apply, attach, detach and delete, using the same Generator implementation as the
Local Host. Read observations are signed with the configured Better Auth secret,
scoped to account and Project; all instances must share that secret.

Each command hydrates the checkpoint and retained log inside a transaction,
checks ownership and the observed revision, then appends through the relay and
outbox. Project-row and log-head locks serialize competing mutations. Rejected
commands roll back without partial Generator or Canvas changes. This is an
on-demand replica, not a second Project storage model. It currently replays the
captured tail on each request, so large uncheckpointed projects cost more.

The projection definition does not start the Remotion executor: Timeline render
submission, Project Asset publication, Director Stage commands and hosted agent
runtime endpoints still need their actual adapters. Unsupported commands return
an explicit error; they are not acknowledged as successful work.

## Project media

Migration `0012_project_resources.sql` stores admitted immutable Resource facts
by Project. Asset identity and lifecycle remain in the Project Loro document.
The Asset SDK routes support list, batch, individual reads, reference reads,
file import and authenticated byte-range media delivery. File import reuses the
personal library's MIME validation and content-addressed files, but does not add
a personal library entry. Resource admission and the Project update/outbox are
one database transaction; bytes are published before admission, so a rejected
write can leave an unreferenced file for future reclamation.

Personal-library admission, Project trash/restore and generated media inspection
are still outstanding. Read receipts use the browser-auth secret when configured;
the bare `createNodeCloudApp` embedding fallback is instance-local and is not a
cross-instance observation authority. Hosted replicated Assets without an
admitted Resource are reported unavailable; knowing a Resource ID grants no
access to another Project's files.
