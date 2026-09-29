# Project-scoped cloud sync

Clash remains local-first. A local-only Project can be edited without an
account. `auth login` only stores an identity credential; it never uploads all
local Projects and never changes the process-wide sync switch.

## Desktop sign-in and project upgrade

Settings → Sync offers Official cloud (`https://clash.art`) and a
self-hosted service origin. The Host checks `GET /api/v1/cloud`, then opens
the existing browser `/auth/cli` PKCE flow with a loopback callback. The
renderer never receives the access token. Credentials are stored in the
Host-private credential file by exact origin; HTTP is accepted only for
loopback development servers.

Signing in selects an account; it neither enables global sync nor uploads any
Project. In a Project, choose **Cloud sync → Enable cloud sync** to admit that
Project and start the existing canvas, metadata and immutable-resource
synchronizer. Pending, failure and retry states come from Host records.
**Open in Web** appears only after all required planes are ready and the
matching service/account credential is available.

An admitted Project remains bound to its original service, tenant and user.
Changing the default service does not migrate Projects. Failed admission retries
preserve that binding; overlapping admission requests are rejected until the
current request finishes. Sign out clears the local service credential and
stops new authenticated sync operations; it does not delete remote data or
revoke every token/session on the server.

### Compatible self-hosted deployments

This journey requires the hosted Web login page, CLI authorization/token routes,
and the new cloud discovery/account endpoints on the same public origin.
Configure the admission sync URL to use that public gateway origin as well.
Redirects and cross-origin admission responses are rejected rather than
forwarding credentials elsewhere. The current Node-only API does not implement
this browser PKCE surface, so it is not yet a compatible login target.
Deploy the matching Web/api-cf version before using the entry point; selecting
Official cloud does not itself establish that the live deployment is ready.

## Identity and ownership

Better Auth owns the User identity. The current MVP uses the User as an
implicit personal Tenant (`project.owner_id` and `assets.user_id`). Project
admission creates the corresponding personal Tenant and owner membership in
the cloud. Team support can later add `tenant` and `tenant_member` rows without
changing the Project Loro protocol. These rows are control-plane state, not
Loro updates.

### Hosted transport authorization

The public API authenticates Project ownership before forwarding `/sync` or
Supervisor HTTP/WebSocket traffic. Public sync exposes only the project-root
WebSocket endpoint; room maintenance paths are not forwarded. Client-supplied
internal identity and PartyKit routing/props headers cannot grant authority.
Direct Supervisor requests also authenticate before the framework reads history
or processes a connection.

Public connections retain non-secret authorization evidence across hibernation.
Before accepting another message or delivering private data, the server rechecks
Project ownership/deletion and the current API-token or Better Auth session row.
A revoked connection closes on its next guarded operation; an idle connection is
not promised an immediate close notification. Old connections without evidence
must reconnect. JWT connections require an expiration and current ownership;
there is no individual-JWT revocation registry. Development fallback applies only
to explicitly configured development environments and is not a production identity.

These checks protect new transport operations. Cancellation and settlement of
already-admitted generation work remain part of the durable-run lifecycle, not a
claim that revoking a credential reverses work already executed.

## Admission

Admission is explicit and Project-scoped:

```text
local-only
  └─ auth login (identity only)
       └─ enable cloud for this Project
            └─ POST /api/v1/projects/:id/cloud-admission
                 ├─ create/claim cloud Project
                 ├─ bind User → personal Tenant
                 ├─ record local replica identity
                 └─ return the cloud sync base URL
```

The local Host stores the returned admission in its SQLite product state. It
does not write admission, permissions, or credentials into `.clash/project.toml`.
The admission record is keyed by `(projectId, localReplicaId)` so multiple
machines can join the same Project.

## Three independent data planes

```text
Control plane: User / Tenant / membership / admission / capabilities
Project plane: Loro snapshot + incremental updates (WebSocket protocol)
Resource plane: Resource identity + signed upload/download (HTTP)
```

The local Host resolves a remote Loro transport per admitted Project. A
`local-only` Project therefore remains local even when another Project on the
same machine is syncing. Loro reconnects by version vector, so replaying an
update after a lost acknowledgement is safe.

Resource bytes are never placed in a Loro update. The Resource SDK uploads the
referenced immutable bytes through a signed URL and verifies byte length and
SHA-256 digest. The delivery port is storage-neutral: Cloudflare deployments
can use R2, while Node/SaaS deployments can supply an S3 or filesystem adapter.
Document bodies remain distinct immutable JSON payloads. All retained Document
revisions are enumerated from Project Loro, including historical revisions.
A receiving Host can fetch required cloud bytes after the source Host stops;
new media is staged and locally inspected before its Resource identity is
installed. Opaque remote Resource ids remain unchanged.

The cloud issues delivery capabilities through
`POST /api/v1/projects/:id/resources/:resourceId/delivery`. Issuance and capability
use both check the exact machine admission, owner/tenant, Project deletion, and
current Project Loro reference. A caller-supplied Resource list or storage key
cannot grant access. Immutable Resource descriptors are tenant-scoped private
registry records in R2; byte objects use private digest locators. The registry
is infrastructure, not another Asset authority. A registry entry without its
verified byte object is not reported available. Referenced Document bodies use
`/api/v1/projects/:id/document-bodies/:digest` with the same admission checks.

## State and retry

Cloud admission starts at `pending`; the local synchronizer transitions through
`syncing` and reaches `ready` only after its Loro, metadata, and Resource
steps complete. A transient error records `failed` with a message. Retrying a
failed Project reruns only idempotent operations: Loro version-vector replay
and content-addressed Resource PUTs are safe to repeat. Periodic reconciliation
checks cloud availability before uploading: unchanged Resources and Document
bodies do not produce repeated byte PUTs. Each attempt has a ten-minute network
budget by default (configurable through the Host adapter); shutdown cancels
outstanding requests. Cloud synchronization has a **512 MiB hard limit per Resource or
Document body**. Local Asset publication and local reads are unaffected. The
shared transport policy permits adapters to choose a smaller cap. Oversized
content leaves Project readiness failed with a `maxBytes` diagnostic; cloud
routes return HTTP 413 with `code: CLOUD_CONTENT_TOO_LARGE` and `maxBytes`.
The Host checks registry/reference sizes before opening byte files. Objects
above 8 MiB use authenticated multipart requests, each at most 8 MiB; smaller
objects retain direct PUT. Resource capabilities and Document admission are
revalidated on every request. Upload session IDs, part receipts and temporary
objects are transport state, never additional mutation authority.

R2 multipart staging is private. Completion verifies the whole object's length
and SHA-256 incrementally and rechecks admission/references before publishing
the checksum-verified canonical object. Sessions expire after 24 hours; scheduled
cleanup processes bounded pages to remove their private staging state. A digest
mismatch requires a new session. During completion or publication, abort returns
409; after completion it is idempotent. Completion can be retried without changing
immutable Resource or Document identity, including an uncertain publication result.

An interruption before session metadata is persisted can leave an incomplete R2
multipart upload. Deployment must retain R2's default lifecycle rule that aborts
these uploads after seven days ([R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)).

Downloads retain exact-length checks while streaming, including Resource range
responses. Overflow or truncation fails the stream; a successful response header
alone does not prove that a full transfer succeeded. The Host verifies bytes
before installing a Resource through its existing staging/inspection boundary,
or atomically installing an exact Document body. Document replication does not
parse and reserialize the revision. Generic preview delivery remains outside
the Project object-size policy.

This split avoids buffering an entire 512 MiB object inside a Worker and keeps
requests beneath the platform's request-size ceiling. See
[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

The Settings connection is unset by default. It supplies endpoint and credential
configuration for new admissions; it does not authorize any Project or revoke
an existing admission. Explicit per-Project admission is the cloud opt-in.
Legacy global mode/capability fields remain wire-compatible diagnostics.

## Readiness reporting

`GET /api/v1/projects/:id/status` reads the local Host's admission for that exact
Project and local replica. Missing or revoked admission remains local-only;
pending, syncing, and failed admission never enables Web/Share gates. Global
transport capability flags do not prove readiness. A successful remote admission
is stored locally as pending even if the remote response says ready: only the
local synchronization coordinator can confirm that all required planes completed.
The production Host runs the shared coordinator at startup, after admission,
and after durable Project or metadata changes. A committed change advances the
SQLite admission version before acknowledging the mutation; an older in-flight
sync cannot mark that changed Project ready. A failed or interrupted attempt
retries from persisted admission after restart. Re-admission and revocation also
advance that version, including when timestamps tie.

The machine's replica identity is a race-safe SQLite singleton in the Host data
directory, distinct from its process discovery id. Admissions recorded with old
process UUIDs are not adopted automatically; those Projects require explicit
re-admission. Ordinary status reads never reset readiness.

CLI status uses that same Host response when the Host is available, while
preserving working-tree paths and offline diagnostics. Offline transport config
cannot authorize cloud actions. Settings configures the remote URL and credential; it exposes no manual
readiness or metadata-completion switches. Metadata is a required admitted
Project plane. The former Web/Share helper
and status hook had no product callers and were removed; this is a status-contract
fix, not evidence of a shipped sharing interface.

## Node and multi-container deployment

### Implemented authorization boundary

Project authentication and connection revalidation now share
`@clash/shared-runtime/project-authorization`. The policy consumes normalized
Project, API-token and session records; it imports neither Cloudflare bindings
nor Node storage. JWT signature verification and Better Auth session resolution
are trusted injected adapters. API tokens are hashed before storage lookup;
connection evidence never retains the raw credential.

Cloudflare's existing auth entry uses a D1 adapter. The narrow
`@clash/shared-runtime/project-authorization-postgres` entry provides a PostgreSQL
adapter through an injected query port compatible with a host-owned client/pool.
Node cloud persistence targets PostgreSQL; Desktop Host SQLite remains local.
The PostgreSQL adapter expects `project`, `api_token`, and `sessions` authority
records with native `timestamptz` date columns. It normalizes dates to the shared
policy milliseconds; D1 retains its backend schema units. PostgreSQL schema
migrations and connection-pool lifecycle belong to the deployment host; the
SQLite/D1 Drizzle schema is not a PostgreSQL migration.

Project admission now uses `@clash/shared-runtime/project-cloud-admission` for
request validation, personal-tenant identity, capabilities and response consistency.
D1 implements the atomic persistence port with guarded batch SQL; PostgreSQL
uses `project-cloud-admission-postgres` with a host-owned transaction callback.
That callback must reserve one connection and commit or roll back the whole unit;
issuing BEGIN/COMMIT through an unpinned pool is not an implementation of the port.
Repeated admission preserves the persisted sync endpoint, readiness and admitted time.
Both adapters reject other owners, deleted projects and mismatched project tenants.

The initial PostgreSQL admission migration lives in
`packages/shared-cloud-schema/postgres/0001_project_admission.sql`; it does not
migrate Better Auth, billing or resource data and is not a D1 data conversion.
PGlite and Miniflare verify SQL behavior and rollback locally. TCP/TLS, connection
pooling and multiple server processes still need deployment acceptance.

These are implemented authorization and admission slices, not a complete Node cloud deploy.
`apps/api-node` now provides an API-token-authenticated HTTP admission service,
pg connection-pool transactions and an explicit checksum-checked migration runner.
It also provides API-token snapshot/log HTTP relay with SSE notification hints; resources, Better Auth login and token issuance remain pending.
Its pending admissions do not grant sync readiness.

The Node replication target keeps the stateless relay design in
`docs/distributed-loro-sync-backend-research.md`. The initial deployment choice
is PostgreSQL for the event log, durable outbox queue and LISTEN/NOTIFY wake-ups;
a separate Redis service is not required. The notification publisher is a port.
The internal PG log/queue and outbox dispatcher now exist. Event + queue writes
commit together; leases and fenced acknowledgements allow retry after failure.
Notifications contain only Project/cursor, not binary document contents.

Stateless gateways must independently replay missed events from PG;
claiming a queue job does not deliver an update to every connected gateway.
Node checkpoint work is registered in the existing durable outbox in the same
transaction as append. One pending checkpoint per Project coalesces new offsets;
its initial ten-minute due time is not extended by later appends. The existing
outbox executor handles checkpoint and notification queues separately. It restores
the prior snapshot, imports through a captured target, checks gaps/dependencies,
and publishes bytes/cursor monotonically. Fenced acknowledgement only clears work
covered by that snapshot; a concurrent tail remains scheduled. Failed or crashed
work is reclaimed after the execution lease expires. No standalone checkpoint
polling process or client snapshot scheduler remains.

Migration 0008 extends and backfills the outbox. Run migrations, then
`pnpm --filter @clash/api-node worker:outbox`. This uses Node's existing durable
queue; CF cron remains separate, and this change adds no generic Node cron API.
The shared `replica-relay` port provides PG log/checkpoint storage; the
`replica-stream-client` adapter uses `@loro-dev/streams-client` for HTTP append,
snapshot reads, offset catch-up, SSE parsing and reconnect. The Node gateway relays opaque
CRDT bytes and holds no LoroDoc. A cold client
loads the latest full snapshot and its covered cursor, then reads logs after that
cursor. Reconnection uses the last locally persisted cursor. Snapshot bytes and
cursor are atomic; log pages capture a committed head. SSE carries actual log
batches followed by SDK control frames. An entire batch must be locally persisted
before its offset is saved. Transport receipt alone cannot advance applied progress.
Client offsets are opaque strings, independent of Loro VersionVectors and PG's
internal numeric cursor. A 410 catch-up response reloads the latest checkpoint.

The Node experimental Loro WebSocket gateway has been retired. The Local Host
discovers the `loro-streams-v1` transport, while Cloudflare ProjectRoom keeps its
existing Loro protocol. Local mutation state remains client-owned; cloud checkpoint computation runs in the Node worker.
An append ACK confirms durable bytes, not successful CRDT validation. Invalid logs
stop checkpoint publication and client apply; repair/GC policy remains pending.
The initial local-history upload is limited to 8 MiB; larger offline projects need
chunked upload acceptance. The Node adapter retains complete log and idempotency
history. Local real-PG multi-process evidence is recorded in the launch roadmap;
TLS, multi-host networking, Fly and release capacity are not yet certified.
The local Host is not that multi-user cloud service.

The Node endpoint implements the SDK operations used by this product, not the
whole Durable Streams service: HEAD, JSON record append/catch-up, latest/specific
snapshot reads, and SSE live reads. Records contain an id and base64 CRDT bytes;
snapshot bodies remain binary. Existing content-checked `Idempotency-Key` writes
remain the retry boundary. Producer epochs, stream provisioning/deletion/closing,
multipart bootstrap and long-poll are not implemented or advertised. Checkpoint
publication remains internal to the worker. The obsolete private `/log` and
`/events` transport endpoints have been removed; no released Node migration is
claimed. SDK protocol references ship in its `docs/ds-protocol.md` and
`docs/ds-extensions.md`.

The cloud contract does not require Durable Objects. A Node deployment can put
the same HTTP/WebSocket routes behind several containers and provide these
ports:

```text
AdmissionStore       → SQL transaction (User / Tenant / Project admission)
LoroPersistence      → append-only event log + checkpoint store
ProjectMetadataStore → SQL row with timestamp tie-breaker
AssetDeliveryPort    → signed URL issuer + object-store adapter (S3, R2, or filesystem)
RunJournal/Scheduler  → SQL CAS journal + queue/cron/workflow adapter
```

The event log is the fan-out source; each gateway keeps its own WebSocket
connections and resumes from a Loro version vector. Checkpoint and index
workers are ordinary consumers with independent offsets. Delivery only sees an
opaque `resourceId`, so changing R2 to S3 does not change Project state or the
client protocol.

The default Cloudflare entrypoint supplies D1/ProjectRoom/R2 adapters and the
capability resolver. Deployments must configure those bindings, a signing secret
(`JWT_SECRET`), and an externally reachable API origin; unsupported transport or
missing configuration leaves readiness failed with a diagnostic. Injected
`ProjectContentPorts` and `AssetDeliveryStore` preserve Node/SaaS deployments.
Local Miniflare and Host integration tests exercise these boundaries; they do
not establish deployed-service or paid-provider availability.
