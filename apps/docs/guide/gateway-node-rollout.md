# Gateway Node Rollout: Migrate, Seed, Canary (Staging)

Schema migration, seeding and the canary/rollback procedure for the
**self-host gateway-node** (`apps/api-node`, Epic B #342, issue #377).
**Staging only.** Never point these commands at a production database.

Related: [gateway-node-backup.md](gateway-node-backup.md) (backup, restore,
drain, incident SQL), [gateway-ops-runbook.md](gateway-ops-runbook.md) (cloud
Workers procedures), [gateway-data-plane.md](gateway-data-plane.md#node-self-host-adapter-367).

Postgres is the only migrate path (decision 12). The server never migrates on
startup, and the seed never migrates either: schema changes happen only through
`gateway migrate`.

## Commands

```bash
# Staging DSN only.
export DATABASE_URL=postgresql://…/clash_staging

pnpm --filter @clash/api-node gateway migrate --plan   # report, write nothing
pnpm --filter @clash/api-node gateway migrate          # apply (one-shot)
pnpm --filter @clash/api-node gateway seed             # Flash-only staging catalog
```

`pnpm migrate` and `pnpm seed:gateway` are the same commands. Each prints one
JSON line on stdout and exits `0`. A failure prints `CODE: message` on stderr
and exits `1` (`2` for a usage error). A driver failure that carries no
code prints only the error class and SQLSTATE, never the message, which may
contain the connection string.

### `gateway migrate`

- **One transaction, advisory-locked.** The run takes
  `pg_advisory_xact_lock(hashtext('clash:cloud:migrations'))` first. It checks
  checksums, then the expand/contract gate, then applies every pending
  migration in order. Any failure rolls the whole run back. The lock is held by
  the transaction, so a killed runner never leaves it held. BullMQ's queue
  schema is migrated afterwards under BullMQ's own advisory lock.
- **One-shot and safe to race.** Start it as a one-off job or an init step on
  every replica. Concurrent runs wait on the lock. The first one applies the
  release, and the others find nothing pending (`appliedNow: []`).
- **Bounded wait.** `--lock-timeout-ms` (default `60000`) sets `lock_timeout`
  for the transaction. It bounds the wait for another runner's lock and the wait
  for each DDL table lock, so a migration never queues live traffic behind it
  indefinitely. When it expires, the run exits with `MIGRATION_LOCK_TIMEOUT` and
  nothing is applied. Retry when traffic or the other runner allows.
- **Expand/contract gate.** On a database that already has migrations, a pending
  **contract** migration is refused with `MIGRATION_CONTRACT_REFUSED` unless
  `--allow-contract` is passed (see the checklist). A bootstrap database (no
  migrations recorded) applies every phase, because no older release is
  running against it.
- **`--plan`** takes the same lock and reports without writing anything (not
  even the bookkeeping table).

Report fields:

| Field | Meaning |
| --- | --- |
| `bootstrap` | No migration was recorded before this run. |
| `applied` | Recorded migrations this release knows. |
| `pending` | `{ id, phase, reasons }` in apply order; `phase` is `expand` or `contract`. |
| `ahead` | Recorded migrations this release does **not** know: the database is ahead of the image (normal after a code rollback). |
| `appliedNow` | Applied by this run (`[]` for a plan or a no-op). |

Error codes: `MIGRATION_CHECKSUM_MISMATCH` (an applied migration file was
edited; never edit one, add a new migration), `MIGRATION_CONTRACT_REFUSED`,
`MIGRATION_LOCK_TIMEOUT`, `GATEWAY_CLI_CONFIG` (`DATABASE_URL` missing or not
PostgreSQL), `GATEWAY_CLI_USAGE`, `GATEWAY_MIGRATE_FAILED`.

### `gateway seed`

Publishes the staging catalog and credits price rows (`seed-1`) in one
transaction. The upsert is idempotent, so a rerun changes nothing but
`published_at`.

- **DeepSeek is Flash only** (locked 2026-10-20). The seed refuses
  (`GATEWAY_SEED_MODEL_BLOCKED`) any model whose code, price upstream or card
  implementation names DeepSeek unless the model code is Flash and every
  DeepSeek implementation routes to a Flash upstream model. The default
  seed is `deepseek-v4-flash` only.
- Refuses with `GATEWAY_SEED_SCHEMA_PENDING` while any migration is pending. Run
  `gateway migrate` first.
- Staging/test catalogs only. Production catalogs and prices are published
  through the admin price book ([gateway-price-book.md](gateway-price-book.md)),
  not this seed.

## Expand/contract migration checklist

Every release must run against the schema of the release before it. During a
canary, and after a code rollback, old and new nodes share one database. So
each schema change is split into phases:

1. **Expand** (release N). Only add: new tables, nullable columns or columns
   with a `DEFAULT`, new indexes (prefer `CREATE INDEX` on small tables; large
   tables need a separate non-transactional plan, see below), and widened
   `CHECK` constraints (drop and re-add with more allowed values in one
   migration). The release N−1 code must keep working unchanged.
2. **Migrate before deploy.** Run `gateway migrate` before any release N node
   starts. New code may rely on the expanded schema; old code ignores it.
3. **Dual write / backfill** (release N or N+1). New code writes both shapes.
   Backfill in bounded batches from a job, not inside the migration
   transaction (`statement_timeout` is 30 s).
4. **Switch reads** (release N+1) once the backfill is verified.
5. **Contract** (release N+2 or later). Drop, rename, narrow or retype only
   when **no node of a release that uses the old shape remains**, including
   the rollback target. Run `gateway migrate --plan` and confirm the contract
   step is the only surprise, then `gateway migrate --allow-contract`.

Before merging a migration (`packages/shared-cloud-schema/postgres/NNNN_*.sql`,
listed in `apps/api-node/src/migrations.ts`):

- [ ] New file with the next number. Never edit an applied file (the checksum
      guard refuses it).
- [ ] No foreign keys (`REFERENCES`, `FOREIGN KEY`).
- [ ] Expand-only, **or** a comment line declares `-- migration-phase: contract`
      and the PR names the release whose nodes must be gone first.
- [ ] Release N−1 code was checked against the new schema: inserts that omit a
      new column still succeed, and no `ON CONFLICT` target or query column it
      uses was removed.
- [ ] A `NOT NULL` column has a `DEFAULT`. A narrowed `CHECK`/`UNIQUE` is a
      contract step.
- [ ] Rollback note: what the previous image does against this schema (`ahead`
      in its plan).
- [ ] PGlite test in `apps/api-node`, plus the lite harness if the change
      touches concurrency.

The runner flags statements the previous release cannot survive as contract even
without the marker: `DROP TABLE|VIEW|TYPE|SCHEMA|SEQUENCE`, `TRUNCATE`, column
drop, `RENAME`, column type change, `SET NOT NULL`, and `ADD COLUMN … NOT NULL`
without a default. It ignores comments, string literals and function bodies.
That scanner is a safety net. The checklist is the rule. Mark anything it
cannot see (a narrowed constraint, a semantic change) with the marker.

## Canary / rollback runbook (stub, staging)

**Stub.** Traffic weighting belongs to the deployer: we ship no load balancer
config. Compose and environment names come with #374, and health/drain with
#375. Automated canary analysis is not built. Every step below is manual and
targets **staging**.

### Preconditions

- Staging `DATABASE_URL` only. Confirm the host before every command.
- A fresh staging backup (base backup + WAL, [gateway-node-backup.md](gateway-node-backup.md)).
- Release N−1 image tag recorded as the rollback target.

### Roll out release N

1. **Plan** with the release N image: `gateway migrate --plan`. Expect only
   `expand` entries in `pending`. A `contract` entry means stop, unless this
   is the planned contract release (checklist step 5).
2. **Migrate once**: `gateway migrate`. Racing replicas are safe. On
   `MIGRATION_LOCK_TIMEOUT`, retry when traffic or the other runner allows.
3. **Seed** (fresh staging databases only): `gateway seed`.
4. **Canary**: start one release N node beside the N−1 nodes and give it a
   small share of traffic at your load balancer. Check:
   - `/healthz` and `/readyz` are 200;
   - one low-value chat completion on a Flash-allowed model succeeds and
     settles one ledger row;
   - incident SQL from [gateway-node-backup.md](gateway-node-backup.md#incident-sql-stubs)
     returns zero drift rows;
   - error rate and latency (OTel metrics) match the N−1 nodes.
5. **Promote**: replace the N−1 nodes one at a time. `SIGTERM` drains each node
   (`/readyz` 503, open streams finish or end `GATEWAY_DRAINING`, settlement
   completes).

### Roll back

1. Drain the release N nodes (`SIGTERM`) and start release N−1 nodes in their
   place.
2. Leave the schema alone. Release N's migrations were expand-only, so N−1
   runs on them. There are **no down migrations**. `gateway migrate --plan`
   from the N−1 image shows release N's migrations under `ahead` and nothing
   pending. That is expected and is not an error.
3. Re-run the canary checks against the N−1 fleet.
4. If the schema itself is wrong, roll **forward** with a new expand migration.
   Restoring a backup is a data-loss decision ([restore drill](gateway-node-backup.md#restore-drill-staging)),
   not a code rollback.

### Contract later

Only after no node older than the contract's target release remains, including
any rollback target you still intend to use, run the contract release with
`gateway migrate --allow-contract`.
