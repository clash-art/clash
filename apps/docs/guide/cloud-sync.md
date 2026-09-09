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

## State and retry

Cloud admission starts at `pending`; the local synchronizer transitions through
`syncing` and reaches `ready` only after its Loro, metadata, and Resource
steps complete. A transient error records `failed` with a message. Retrying a
failed Project reruns only idempotent operations: Loro version-vector replay
and content-addressed Resource PUTs are safe to repeat.

The current global Settings sync capability remains disabled by default. A
Project admission is the per-Project opt-in; it does not silently enable the
global cloud switch.

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
