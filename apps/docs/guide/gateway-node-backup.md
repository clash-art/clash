# Gateway Node Backup, Restore & Ops Runbook

Postgres + object-store backup/restore for Clash **self-host gateway-node**
(Epic B). Staging drills only — never production.

**Postgres-only ops (decision 12).** There is **no supported SQLite backup
path** as a product procedure. Do not document or run `VACUUM INTO`, copy a
live `.sqlite`+WAL pair, or treat single-file SQLite as a restore target.
NODES historical notes about SQLite `VACUUM INTO` are obsolete for product
ops.

Related: cloud Workers ops runbook (#361 /
[gateway-ops-runbook.md](gateway-ops-runbook.md)). Compose / health / drain
land in #374 / #375. Load balancing is the deployer's choice; nodes are
stateless and expose health endpoints (`/healthz`, `/readyz`).
 Security review: [gateway-node-threat-model.md](gateway-node-threat-model.md) (#385).

## What to back up

| Store | Contents | Retention alignment |
| --- | --- | --- |
| **PostgreSQL** | Catalog, prices, keys metadata, budgets, **ledger**, admin audit, rate windows, etc. | Ledger + admin audit kept **13 months** (decision 8) — backup retention must cover at least that window for point-in-time recovery of money rows. |
| **Object store** (S3 / MinIO) | Blobs (retained bodies when enabled, media locators' bytes, etc.) | Body objects follow the 30-day retention policy when staff body retention is on; metadata jobs may NULL/delete sooner. Backup quiesce must include in-flight puts. |

Redis (optional cache profile) is **not** authoritative — do not require it
for restore.

## PostgreSQL: base backup + WAL

Use continuous archiving so staging can restore to a consistent instant.

### Continuous setup (staging sketch)

```bash
# On the Postgres primary (staging). Paths and users are illustrative.
# postgresql.conf (or ALTER SYSTEM):
#   wal_level = replica
#   archive_mode = on
#   archive_command = 'test ! -f /var/lib/postgresql/wal_archive/%f && cp %p /var/lib/postgresql/wal_archive/%f'
#   max_wal_senders = 4
#   archive_timeout = 60
```

Base backup (example with `pg_basebackup`; prefer your managed provider's
snapshot API when Postgres is RDS/Cloud SQL/etc.):

```bash
# Staging only. Never point these at production connection strings.
export PGHOST=… PGPORT=5432 PGUSER=gateway PGDATABASE=gateway
pg_basebackup -D /backup/gateway-pg-$(date -u +%Y%m%dT%H%M%SZ) \
  -Fp -Xs -P -R
# Ship /backup/gateway-pg-… and the WAL archive to durable object storage.
```

Managed alternatives (pick one; do not invent a second source of truth):

- Provider automated backups + PITR (RDS, Cloud SQL, Neon, …)
- `pg_dump --format=custom` for logical exports **in addition to**, not
  instead of, base+WAL when you need PITR

### Object store quiesce

Before cutting a restore-consistent pair:

1. Prefer a **brief write pause** on gateway `api`/`worker` (drain / stop
   accepting new billable work; see drain notes in #375 when landed) so no
   new blob PUTs race the snapshot.
2. Snapshot or version-copy the bucket (MinIO `mc mirror`, S3 versioning +
   inventory, or filesystem snapshot if using a volume).
3. Record the Postgres backup LSN / backup label time next to the object
   snapshot id so restore uses a matching pair.

```bash
# Example MinIO mirror to a backup bucket (staging credentials only)
mc mirror --overwrite minio/gateway-blobs backup/gateway-blobs-$(date -u +%Y%m%dT%H%M%SZ)
```

### Optional ledger export

Ledger and budget tables are small relative to blobs. A periodic logical
export is a useful second copy (NODES §2.9), not a replacement for base+WAL:

```bash
# TODO(#362): confirm final PG table list after the gateway-node migration.
pg_dump "$DATABASE_URL" --format=custom --file="ledger-$(date -u +%Y%m%d).dump" \
  --table=gateway_usage_ledger --table=gateway_budget \
  --table=gateway_admin_audit
```

## Restore drill (staging)

Practice on staging until the steps are boring. Do **not** run against
production.

1. **Provision** an empty Postgres (or restore onto a scratch instance) and an
   empty/scratch object bucket.
2. **Restore Postgres** from the base backup, then replay WAL to the chosen
   recovery target time (or latest).
3. **Restore object store** from the snapshot taken at (or before) that
   recovery target.
4. Point a **staging** gateway compose stack at the restored DSN + bucket
   (`GATEWAY_STORE=postgres`, `GATEWAY_BLOB=s3`, … — exact env from #374).
5. Run migrate only if the backup predates a required expand migration; prefer
   restoring a backup that already includes schema.
6. **Smoke:** `/healthz`, `/readyz`, admin session, one non-billable or
   low-value chat completion on a Flash-allowed model, then incident SQL
   below (expect zero drift rows after quiescence).
7. Record the drill: backup id, recovery target, duration, who ran it, pass/fail.

Rollback of a bad **code** deploy (not data loss) is redeploy previous image
with expand/contract-compatible schema
([gateway-node-rollout.md](gateway-node-rollout.md#roll-back)) — that is
separate from this data restore drill.

## Key rotation, drain, rollback (self-host)

| Procedure | Outline |
| --- | --- |
| **Upstream key rotation** | Same product rules as cloud: dual-key window, bump `key_version`, never log plaintext. Self-host stores sealed envelopes / secret refs via the Node credential port (#366). Rotate on staging first. |
| **Drain a node** | `SIGTERM` → `/readyz` 503 → LB ejects → finish streams up to grace → settle in `finally` (#375). |
| **Rollback code** | Previous image tag; schema backward-compatible for one release. |

Cloud Workers-specific rotate / suspend / drain steps:
[gateway-ops-runbook.md](gateway-ops-runbook.md) (#361).

## Incident SQL stubs

Checked-in copy: `apps/api-node/deploy/ops/incident-queries.sql`.

Under N2 (#399) there are **no open holds and no sweeper**. Prefer Durable Run /
settle-journal recovery, then audited `wallet/adjust`. Never rewrite historical
`settle` / `charge` / `debit` rows. Expect `reserved_micro_credits = 0`.

Primary checks (see the SQL file for the full text):

- `reserved_micro_credits <> 0` (should be empty)
- spent vs `debit`+`charge`−`refund` ledger sum (Node kinds)

Hold-era queries (reserved vs open holds, stuck holds, “overspend under hard
limit”) remain in that file marked **HISTORICAL** for old backups only — text
postpay may legally push `spent` past the limit after a full actual charge, so
the overspend query is not a live N2 alert.

If spend drift is confirmed after journal recovery: append audited `adjust` /
`refund` rows — never rewrite historical money rows.

## Explicitly unsupported

- **SQLite `VACUUM INTO` / file copy backup** — not a supported product
  procedure (decision 12; acceptance for #384).
- Restoring production from staging backups.
- Using Redis dumps as ledger recovery.

## DeepSeek

Any seed or smoke model that names DeepSeek must be **Flash only**.
