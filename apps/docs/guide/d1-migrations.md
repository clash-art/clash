# D1 Migrations: Lineage and the Predeploy Check

The hosted D1 schema lives in `apps/web/drizzle/*.sql`; both Workers bind the
same database. `wrangler d1 migrations apply` records each applied file by
name in the database's `d1_migrations` table and never reruns a recorded
file.

## Never edit an applied migration

Because recorded files never rerun, editing one in place only changes
databases created afterwards. Every existing database silently keeps the old
shape. Commit `40a4812c` did this: it added `project.deleted_at` to `0000` and
`chat_session.archived_at` to `0005`. A fresh database (such as staging
`clash-staging`) has both columns, but a database that applied the earlier
files can never get them from `migrations apply`, and the routes that read
them fail there.

Add a new migration for every schema change. SQLite has no
`ADD COLUMN IF NOT EXISTS`, so a forward migration cannot add a column that
some databases already have. The historic files therefore stay as they are,
and older databases are repaired with the explicit step below.

## Predeploy check

```bash
node scripts/d1-migration-check.ts --remote                 # production config
node scripts/d1-migration-check.ts --remote --env staging   # clash-staging
node scripts/d1-migration-check.ts --local --persist-to <dir>
```

`make predeploy-check`, and with it every `make deploy*` target, runs this
check against the D1 the deploy binds (`--env staging` for the staging
targets). `SKIP_CHECKS=1` skips lint but not this check; the only opt-out is
an explicit `SKIP_D1_CHECK=1`. A hosted overlay passes its own wrangler config
with `D1_CHECK_ARGS="--config <path>"`.

The check is read-only. It queries `d1_migrations` and the table columns
(`pragma_table_info`) through `wrangler d1 execute --json`, replays the
repository migrations that database has recorded into an empty SQLite
database, and compares:

| Result                     | Exit | Meaning                                                                                       |
| -------------------------- | ---- | --------------------------------------------------------------------------------------------- |
| up to date                 | 0    | Every repository migration is recorded and every table/column they define exists.            |
| `warning:` retired         | 0    | A recorded migration file left the repository (e.g. the deleted `0011_room_message.sql`).     |
| `D1_PENDING_MIGRATIONS`    | 1    | The repository has migrations this database has not applied.                                  |
| `D1_SCHEMA_DRIFT`          | 1    | A recorded migration defines a table or column the database lacks: an in-place edit.          |
| `D1_TARGET_UNREADABLE`     | 2    | wrangler could not read the database (auth, wrong config, no `d1_migrations` table).         |
| `D1_REPLAY_FAILED`         | 2    | The recorded migrations do not replay on their own (renamed files); reconcile by hand.        |
| `D1_REMOTE_REPAIR_REFUSED` | 2    | `--apply-repair` was combined with `--remote`; the tool never writes to a deployed database. |

For missing columns the check prints `ALTER TABLE … ADD COLUMN …` repair SQL
generated from the replayed definition. A column `ADD COLUMN` cannot express
(primary key, expression default, `NOT NULL` without default) and a missing
table are listed as `manual:` items instead. Applying the printed SQL once is
safe: it is generated only for columns verified missing, and a rerun of the
check prints none.

On a local database `--apply-repair` applies that SQL and checks again, which
repairs a developer's `.wrangler` state that applied the old `0000`/`0005`.

## Production repair runbook (human, owner approval required)

Production (`master-clash-frontend`, configured by the hosted overlay) is
believed to be behind master: `0019_provider_oauth`, `0020_cli_oauth_code`,
`0025_cloud_durable_run_journal`, `0026_project_cloud_admission` and
`project.deleted_at` are inferred missing, and `chat_session.archived_at` has
the same cause. Automation never applies any of this. An operator with the
owner's explicit approval:

1. Confirms the state read-only, using the overlay's config:

   ```bash
   node scripts/d1-migration-check.ts --remote --config <overlay>/wrangler.toml
   pnpm --dir apps/web exec wrangler d1 migrations list master-clash-frontend --remote --config <overlay>/wrangler.toml
   ```

2. Records a restore point before writing:
   `wrangler d1 time-travel info master-clash-frontend` (note the bookmark),
   and optionally `wrangler d1 export master-clash-frontend --remote --output prod-before-78.sql`.
3. Reviews and applies the printed repair SQL once, for example:

   ```bash
   pnpm --dir apps/web exec wrangler d1 execute master-clash-frontend --remote --config <overlay>/wrangler.toml \
     --command "ALTER TABLE \`project\` ADD COLUMN \`deleted_at\` INTEGER; ALTER TABLE \`chat_session\` ADD COLUMN \`archived_at\` INTEGER;"
   ```

   No repository migration reads these columns, so the order relative to
   step 4 does not matter. Both are nullable, so existing rows read as not
   deleted and not archived.

4. Applies the pending migrations:
   `pnpm --dir apps/web exec wrangler d1 migrations apply master-clash-frontend --remote --config <overlay>/wrangler.toml`.
5. Reruns step 1's check; it must print `up to date` before the next deploy.

If step 1 reports `D1_REPLAY_FAILED` or `manual:` items, stop: the recorded
names diverge from the repository (old renamed files) and need a reviewed,
database-specific plan. If a step fails mid-way, restore with
`wrangler d1 time-travel restore master-clash-frontend --bookmark <bookmark>`.
