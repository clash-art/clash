// The bound database is simulated with node:sqlite: the repository's own
// migrations plus wrangler's ledger, so the expectations below come from the
// staging failures recorded in #64 rather than from the checker itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  checkD1Schema,
  D1SchemaCheckError,
  DEFAULT_MIGRATIONS_DIR,
  listMigrationFiles,
  main,
  parseArgs,
  type D1Query,
  type D1SchemaIssue,
  type WranglerTarget,
} from "./check-d1-schema.ts";

const migrations = listMigrationFiles(DEFAULT_MIGRATIONS_DIR);
const read = (file: string) => readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, file), "utf8");

// #64: commit 40a4812c added `deleted_at` to 0000's CREATE TABLE project after
// databases had applied it. This is 0000 as those databases ran it.
function initialMigrationBeforeEdit(): string {
  const current = read("0000_lazy_yellowjacket.sql");
  const original = current.replace(/,\s*`deleted_at` integer/, "");
  assert.notEqual(original, current, "0000 no longer declares project.deleted_at");
  return original;
}

function boundDatabase(options: { apply: string[]; record?: string[]; source?: (file: string) => string }) {
  const db = new DatabaseSync(":memory:");
  // D1's own bookkeeping table, present on every database.
  db.exec("CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)");
  // wrangler's ledger DDL (getMigrationsTableCreationQuery).
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`);
  for (const file of options.apply) db.exec(options.source?.(file) ?? read(file));
  const insert = db.prepare("INSERT INTO d1_migrations (name) VALUES (?)");
  for (const file of options.record ?? options.apply) insert.run(file);
  return db;
}

const queryOf =
  (db: DatabaseSync): D1Query =>
  (sql) =>
    db.prepare(sql).all() as Array<Record<string, unknown>>;

const has = (issues: D1SchemaIssue[], code: D1SchemaIssue["code"], text: string) =>
  issues.some((issue) => issue.code === code && issue.message.includes(text));

test("a database that applied every repository migration passes", () => {
  assert.deepEqual(checkD1Schema(queryOf(boundDatabase({ apply: migrations }))), []);
});

test("the #64 staging database reports every object its 500s named", () => {
  const firstMissing = migrations.indexOf("0019_provider_oauth.sql");
  const db = boundDatabase({
    apply: migrations.slice(0, firstMissing),
    source: (file) => (file === "0000_lazy_yellowjacket.sql" ? initialMigrationBeforeEdit() : read(file)),
  });
  const issues = checkD1Schema(queryOf(db));

  for (const file of [
    "0019_provider_oauth.sql",
    "0020_cli_oauth_code.sql",
    "0025_cloud_durable_run_journal.sql",
    "0026_project_cloud_admission.sql",
  ]) {
    assert.ok(has(issues, "D1_MIGRATION_UNAPPLIED", file), `${file} not reported unapplied`);
  }
  // The worker log lines from the issue, one per failing route.
  assert.ok(has(issues, "D1_SCHEMA_OBJECT_MISSING", "column project.tenant_id "));
  assert.ok(has(issues, "D1_SCHEMA_OBJECT_MISSING", "table cli_oauth_code "));
  assert.ok(has(issues, "D1_SCHEMA_OBJECT_MISSING", "table provider_oauth "));
  assert.ok(has(issues, "D1_SCHEMA_OBJECT_MISSING", "table cloud_durable_run_journal "));
  assert.ok(has(issues, "D1_SCHEMA_DRIFT", "column project.deleted_at is missing although 0000_lazy_yellowjacket.sql"));
  // Columns of a missing table are implied by the table, not listed again.
  assert.ok(!issues.some((issue) => issue.message.includes("column cli_oauth_code.")));
});

test("an applied migration edited in place is drift even when the ledger is complete", () => {
  const db = boundDatabase({
    apply: migrations,
    source: (file) => (file === "0000_lazy_yellowjacket.sql" ? initialMigrationBeforeEdit() : read(file)),
  });
  const issues = checkD1Schema(queryOf(db));
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["D1_SCHEMA_DRIFT"],
  );
  assert.ok(has(issues, "D1_SCHEMA_DRIFT", "column project.deleted_at"));
});

test("a missing index from an applied migration is drift", () => {
  const db = boundDatabase({ apply: migrations });
  db.exec("DROP INDEX project_tenant_idx");
  const issues = checkD1Schema(queryOf(db));
  assert.ok(has(issues, "D1_SCHEMA_DRIFT", "index project_tenant_idx is missing although 0026_project_cloud_admission.sql"));
});

test("a database without wrangler's ledger has every migration unapplied and no drift", () => {
  const issues = checkD1Schema(queryOf(new DatabaseSync(":memory:")));
  for (const file of migrations) assert.ok(has(issues, "D1_MIGRATION_UNAPPLIED", file), `${file} not reported`);
  assert.ok(!issues.some((issue) => issue.code === "D1_SCHEMA_DRIFT"));
});

test("a ledger entry the repository no longer has is reported", () => {
  const db = boundDatabase({ apply: migrations, record: [...migrations, "0011_removed.sql"] });
  const issues = checkD1Schema(queryOf(db));
  assert.ok(has(issues, "D1_MIGRATION_UNKNOWN", "0011_removed.sql"));
});

test("arguments require an explicit side and keep the deploy target", () => {
  assert.throws(() => parseArgs(["--config", "apps/api-cf/wrangler.toml"]), D1SchemaCheckError);
  assert.throws(() => parseArgs(["--config", "x.toml", "--remote", "--local"]), D1SchemaCheckError);
  assert.throws(() => parseArgs(["--remote"]), D1SchemaCheckError);
  const { target } = parseArgs(["--config", "apps/api-cf/wrangler.toml", "--env", "staging", "--remote"]);
  assert.equal(target.location, "remote");
  assert.equal(target.env, "staging");
  assert.ok(path.isAbsolute(target.config));
});

test("main exits 0 for a matching database, 1 for drift, 2 when the query fails", (t) => {
  t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const args = ["--config", "apps/api-cf/wrangler.toml", "--env", "staging", "--remote"];
  let seen: WranglerTarget | undefined;

  assert.equal(
    main(args, (target) => {
      seen = target;
      return queryOf(boundDatabase({ apply: migrations }));
    }),
    0,
  );
  assert.equal(seen?.env, "staging");

  const drifted = boundDatabase({ apply: migrations.slice(0, -1) });
  assert.equal(main(args, () => queryOf(drifted)), 1);

  const failing: D1Query = () => {
    throw new D1SchemaCheckError("wrangler d1 execute failed: Authentication error [code: 10000]");
  };
  assert.equal(main(args, () => failing), 2);
  assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]).startsWith("D1_SCHEMA_QUERY_FAILED")));
});
