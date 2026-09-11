# Project-scoped cloud sync

Clash remains local-first. A local-only Project can be edited without an
account. `auth login` only stores an identity credential; it never uploads all
local Projects and never changes the process-wide sync switch.

## Identity and ownership

Better Auth owns the User identity. The current MVP uses the User as an
implicit personal Tenant (`project.owner_id` and `assets.user_id`). Project
admission creates the corresponding personal Tenant and owner membership in
the cloud. Team support can later add `tenant` and `tenant_member` rows without
changing the Project Loro protocol. These rows are control-plane state, not
Loro updates.

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
outstanding requests. Whole-object cloud synchronization has a **32 MiB hard limit per Resource or
Document body**. Local Asset publication and local reads are unaffected. The
shared transport policy permits adapters to choose a smaller cap. Oversized
content leaves Project readiness failed with a `maxBytes` diagnostic; cloud
routes return HTTP 413 with `code: CLOUD_CONTENT_TOO_LARGE` and `maxBytes`.
The Host checks registry/reference sizes before opening byte files, and Host
pulls plus cloud Project PUT/GET routes bound actual streamed bytes instead of
trusting Content-Length. Project cloud GET responses are buffered within that
cap to reject overflow before delivering a successful response. Generic
capability preview/range delivery retains streaming and is outside this
whole-object Project policy. Multipart or larger-object cloud replication is
not implemented.

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
