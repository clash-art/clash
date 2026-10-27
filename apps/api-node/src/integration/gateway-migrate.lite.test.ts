/**
 * `gateway migrate` / `gateway seed` (#377) as real one-shot processes on real
 * Postgres, under the #379 lite harness (scripts/test-gateway-lite.ts): a
 * disposable loopback database, several migrate processes racing on the
 * advisory lock (PGlite has one session, so it cannot show the race), a lock
 * timeout while another session holds the lock, then the Flash-only seed.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_SEED_DEEPSEEK_FLASH } from "../gateway-seed.ts";
import { loadMigrations } from "../migrations.ts";

const ADMIN_URL = process.env.GATEWAY_LITE_DATABASE_URL;
const CLI = fileURLToPath(new URL("../gateway-cli.ts", import.meta.url));

function gateway(args: string[], databaseUrl: string) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      DATABASE_URL: databaseUrl,
      OTEL_SDK_DISABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => accept({ code: code ?? 1, stdout, stderr }));
    },
  );
}

const describeLite = ADMIN_URL ? describe : describe.skip;

describeLite("gateway migrate/seed one-shot on real Postgres (#377)", () => {
  let admin: Pool;
  let db: Pool;
  let dbName: string;
  let dbUrl: string;

  beforeAll(async () => {
    const url = new URL(ADMIN_URL!);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw Error("gateway-lite requires a disposable loopback Postgres");
    admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
    dbName = `clash_gwmig_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    url.pathname = `/${dbName}`;
    dbUrl = url.href;
    db = new Pool({ connectionString: dbUrl, max: 3 });
  });

  afterAll(async () => {
    await db?.end();
    if (admin && dbName) {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("seed refuses before migrate; racing migrate processes apply each migration exactly once", async () => {
    const early = await gateway(["seed"], dbUrl);
    expect(early.code).toBe(1);
    expect(early.stderr).toMatch(/^GATEWAY_SEED_SCHEMA_PENDING: /);

    const plan = await gateway(["migrate", "--plan"], dbUrl);
    expect(plan.code).toBe(0);
    const release = (await loadMigrations()).map((migration) => migration.id);
    expect(JSON.parse(plan.stdout)).toMatchObject({
      command: "plan",
      bootstrap: true,
      appliedNow: [],
    });

    const runs = await Promise.all(
      Array.from({ length: 4 }, () => gateway(["migrate"], dbUrl)),
    );
    for (const run of runs) expect(run.code, run.stderr).toBe(0);
    const applied = runs.map(
      (run) => (JSON.parse(run.stdout) as { appliedNow: string[] }).appliedNow,
    );
    // One winner applied the release; the others waited on the lock and found nothing pending.
    expect(applied.filter((ids) => ids.length > 0)).toEqual([release]);
    const recorded = await db.query<{ id: string }>(
      "SELECT id FROM cloud_schema_migration",
    );
    expect(recorded.rows.map((row) => row.id).sort()).toEqual(
      [...release].sort(),
    );
  });

  it("times out with MIGRATION_LOCK_TIMEOUT while another session holds the lock", async () => {
    const holder = await db.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtext('clash:cloud:migrations'))",
      );
      const blocked = await gateway(
        ["migrate", "--lock-timeout-ms", "300"],
        dbUrl,
      );
      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toMatch(/^MIGRATION_LOCK_TIMEOUT: /);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const after = await gateway(["migrate"], dbUrl);
    expect(after.code, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({ appliedNow: [] });
  });

  it("seeds the Flash-only catalog once the schema is current", async () => {
    const seeded = await gateway(["seed"], dbUrl);
    expect(seeded.code, seeded.stderr).toBe(0);
    expect(JSON.parse(seeded.stdout)).toMatchObject({
      command: "seed",
      deepseek: "flash-only",
    });
    const models = await db.query<{ model_code: string }>(
      "SELECT model_code FROM gateway_model WHERE model_code ILIKE '%deepseek%'",
    );
    expect(models.rows).toEqual([{ model_code: GATEWAY_SEED_DEEPSEEK_FLASH }]);
  });
});
