// The databases here are real SQLite databases built from the repository
// migrations the same way `wrangler d1 migrations apply` builds a D1: each file
// runs once and its name is recorded in `d1_migrations`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sourceMatches } from "../packages/gui/test-support/source-match.ts";
import {
  checkTarget,
  D1CheckError,
  DEFAULT_MIGRATIONS_DIR,
  main,
  parseArgs,
  parseWranglerJson,
  readTarget,
  repairPlan,
  replaySchema,
  repoMigrations,
  type DriftReport,
  type QueryRunner,
} from "./d1-migration-check.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = DEFAULT_MIGRATIONS_DIR;
const migrations = repoMigrations(dir);

/** Applies `names` like wrangler: run each file once, record its name. */
function migratedDatabase(names: string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const record = db.prepare("INSERT INTO d1_migrations (name) VALUES (?)");
  for (const name of names) {
    db.exec(readFileSync(path.join(dir, name), "utf8"));
    record.run(name);
  }
  return db;
}

/**
 * A database that applied 0000 and 0005 before 40a4812c edited them in place:
 * the edit added `project.deleted_at` and `chat_session.archived_at`, which such
 * a database never received.
 */
function preEditLineageDatabase(names = migrations): DatabaseSync {
  const db = migratedDatabase(names);
  db.exec("ALTER TABLE project DROP COLUMN deleted_at; ALTER TABLE chat_session DROP COLUMN archived_at;");
  return db;
}

/** node:sqlite rows have a null prototype; spread them into plain objects. */
function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all().map((row) => ({ ...row }));
}

function runner(db: DatabaseSync): QueryRunner {
  return (sql) => rows(db, sql);
}

function runCli(argv: string[], db: DatabaseSync) {
  const lines: string[] = [];
  const code = main(argv, {
    run: runner(db),
    apply: (statements) => db.exec(statements.join("\n")),
    log: (line) => lines.push(line),
  });
  return { code, output: lines.join("\n") };
}

const missing = (report: DriftReport) => report.missingColumns.map(({ table, column }) => `${table}.${column}`);

test("a database built from the current repository migrations has no drift", () => {
  const db = migratedDatabase(migrations);
  const report = checkTarget(dir, readTarget(runner(db)));
  assert.deepEqual(report, { pending: [], retired: [], missingTables: [], missingColumns: [] });
  const { code, output } = runCli(["--local"], db);
  assert.equal(code, 0);
  assert.match(output, /up to date/);
});

test("a database that applied 0000/0005 before the in-place edit reports the columns it never received", () => {
  const db = preEditLineageDatabase();
  const report = checkTarget(dir, readTarget(runner(db)));
  assert.deepEqual(report.pending, []);
  assert.deepEqual(missing(report).sort(), ["chat_session.archived_at", "project.deleted_at"]);

  const { code, output } = runCli(["--local"], db);
  assert.equal(code, 1);
  assert.match(output, /D1_SCHEMA_DRIFT/);
  assert.match(output, /ALTER TABLE `project` ADD COLUMN `deleted_at`/);
  assert.match(output, /ALTER TABLE `chat_session` ADD COLUMN `archived_at`/);
});

test("the repair restores the replayed schema without touching rows, and a second run has nothing to do", () => {
  const db = preEditLineageDatabase();
  db.exec("INSERT INTO project (id, owner_id, name) VALUES ('p1', 'u1', 'kept')");

  const repaired = runCli(["--local", "--apply-repair"], db);
  assert.equal(repaired.code, 0, repaired.output);
  assert.deepEqual(readTarget(runner(db)).schema, replaySchema(dir, migrations));
  assert.deepEqual(rows(db, "SELECT id, name, deleted_at FROM project"), [
    { id: "p1", name: "kept", deleted_at: null },
  ]);

  const again = runCli(["--local", "--apply-repair"], db);
  assert.equal(again.code, 0);
  assert.doesNotMatch(again.output, /ALTER TABLE/);
});

test("unapplied repository migrations fail the check and are not mistaken for missing columns", () => {
  const applied = migrations.slice(0, -3);
  const db = migratedDatabase(applied);
  const report = checkTarget(dir, readTarget(runner(db)));
  assert.deepEqual(report.pending, migrations.slice(-3));
  assert.deepEqual(report.missingColumns, []);
  assert.deepEqual(report.missingTables, []);

  const { code, output } = runCli(["--local"], db);
  assert.equal(code, 1);
  assert.match(output, /D1_PENDING_MIGRATIONS/);
  for (const name of migrations.slice(-3)) assert.match(output, new RegExp(name));
});

test("pending migrations and the lineage edit are both reported in one run", () => {
  const db = preEditLineageDatabase(migrations.slice(0, -1));
  const report = checkTarget(dir, readTarget(runner(db)));
  assert.deepEqual(report.pending, migrations.slice(-1));
  assert.deepEqual(missing(report).sort(), ["chat_session.archived_at", "project.deleted_at"]);
});

test("a table a recorded migration creates but the database lacks is drift that needs a manual step", () => {
  const db = migratedDatabase(migrations);
  db.exec("DROP TABLE chat_session");
  const report = checkTarget(dir, readTarget(runner(db)));
  assert.deepEqual(report.missingTables, ["chat_session"]);
  const plan = repairPlan(report);
  assert.deepEqual(plan.statements, []);
  assert.match(plan.manual.join("\n"), /chat_session/);
  assert.equal(runCli(["--local", "--apply-repair"], db).code, 1);
});

test("a recorded migration that left the repository is a warning, not a failure", () => {
  const db = migratedDatabase(migrations);
  // 40a4812c deleted 0011_room_message.sql after databases had applied it.
  db.exec("INSERT INTO d1_migrations (name) VALUES ('0011_room_message.sql')");
  const report = checkTarget(dir, readTarget(runner(db)));
  assert.deepEqual(report.retired, ["0011_room_message.sql"]);
  const { code, output } = runCli(["--local"], db);
  assert.equal(code, 0);
  assert.match(output, /warning: .*0011_room_message\.sql/);
});

test("columns ADD COLUMN cannot express are left to a manual step", () => {
  const report: DriftReport = {
    pending: [],
    retired: [],
    missingTables: [],
    missingColumns: [
      { table: "t", column: "expr", definition: { type: "INTEGER", notnull: false, dflt: "strftime('%s', 'now')", pk: false } },
      { table: "t", column: "required", definition: { type: "TEXT", notnull: true, dflt: null, pk: false } },
      { table: "t", column: "key", definition: { type: "TEXT", notnull: false, dflt: null, pk: true } },
      { table: "t", column: "status", definition: { type: "TEXT", notnull: true, dflt: "'ok'", pk: false } },
    ],
  };
  const plan = repairPlan(report);
  assert.deepEqual(plan.statements, ["ALTER TABLE `t` ADD COLUMN `status` TEXT DEFAULT 'ok' NOT NULL;"]);
  assert.equal(plan.manual.length, 3);
  // Whatever the plan emits must be accepted by SQLite's ADD COLUMN.
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('a');");
  db.exec(plan.statements.join("\n"));
  assert.deepEqual(rows(db, "SELECT status FROM t"), [{ status: "ok" }]);
});

test("the tool refuses to write to a deployed D1 before reading anything", () => {
  let queried = false;
  const lines: string[] = [];
  const code = main(["--remote", "--apply-repair"], {
    run: () => {
      queried = true;
      return [];
    },
    log: (line) => lines.push(line),
  });
  assert.equal(code, 2);
  assert.equal(queried, false);
  assert.match(lines.join("\n"), /D1_REMOTE_REPAIR_REFUSED/);
  assert.throws(() => parseArgs(["--remote", "--local"]), (error: unknown) => (error as D1CheckError).code === "D1_USAGE");
  assert.throws(() => parseArgs([]), (error: unknown) => (error as D1CheckError).code === "D1_USAGE");
});

test("wrangler output that is not a successful JSON result is an unreadable target", () => {
  // Shape captured from `wrangler d1 execute DB --local --json` (wrangler 4.151.0).
  const ok = '[{"results":[{"name":"0052_gateway_usage_reconciliation.sql"}],"success":true,"meta":{"duration":0}}]';
  assert.deepEqual(parseWranglerJson("q", ok), [{ name: "0052_gateway_usage_reconciliation.sql" }]);
  for (const stdout of ["✘ [ERROR] no such table: d1_migrations", '[{"results":[],"success":false}]', "{}"])
    assert.throws(
      () => parseWranglerJson("q", stdout),
      (error: unknown) => (error as D1CheckError).code === "D1_TARGET_UNREADABLE",
    );
});

test("every deploy path runs the remote D1 check, staging against the staging env", () => {
  const makefile = readFileSync(path.join(repoRoot, "Makefile"), "utf8");
  assert.ok(sourceMatches(makefile, /node scripts\/d1-migration-check\.ts --remote \$\(if \$\(D1_CHECK_ENV\),--env \$\(D1_CHECK_ENV\)\)/));
  assert.ok(sourceMatches(makefile, /deploy-staging deploy-api-staging deploy-web-staging: D1_CHECK_ENV = staging/));
  for (const target of ["deploy", "deploy-api", "deploy-web", "deploy-staging", "deploy-api-staging", "deploy-web-staging"])
    assert.ok(sourceMatches(makefile, new RegExp(`(?:^|\\s)${target}: predeploy-check `)), `${target} skips predeploy-check`);
  // SKIP_CHECKS only skips lint; the D1 check has its own explicit opt-out.
  const recipe = makefile.slice(makefile.indexOf("predeploy-check: ##"), makefile.indexOf("deploy-api: predeploy-check"));
  assert.ok(sourceMatches(recipe, /if \[ "\$\(SKIP_D1_CHECK\)" = "1" \]/));
  assert.ok(!sourceMatches(recipe, /SKIP_CHECKS[^;]{0,80}d1-migration-check/));
});
