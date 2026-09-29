import { createHash, randomUUID, randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { appendFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { LoroDoc } from "loro-crdt";
import { createReplicaStreamClient } from "@clash/replica/replica-stream-client";
import { expect, it } from "vitest";
import { openPostgres } from "../postgres.ts";
import { migrateTaskQueue } from "../task-runtime.ts";
import { migrateDatabase } from "../migrations.ts";
import { loadProjectCheckpoint } from "../checkpoint-store.ts";
import {
  createPostgresOutbox,
  createPostgresReplicaLog,
} from "../replica-log.ts";

async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 15000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw Error(`Timed out: ${label}`);
}

it("validates independent gateways and workers against an isolated network PostgreSQL database", async () => {
  const input = process.env.CLUSTER_POSTGRES_URL;
  if (!input)
    throw Error(
      "Set CLUSTER_POSTGRES_URL to a disposable loopback PostgreSQL admin endpoint",
    );
  const url = new URL(input);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw Error("Cluster test requires loopback PostgreSQL");
  const admin = new Pool({ connectionString: input });
  const name = `clash_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const database = openPostgres({ connectionString: url.href });
  const db = database.db;
  const children: ChildProcess[] = [];
  let checkpointClock: ReturnType<typeof setInterval> | undefined;
  let advancing: Promise<unknown> | undefined;
  const childOutputs: Array<() => string> = [];
  const links: ReturnType<typeof createReplicaStreamClient>[] = [];
  const reports: Record<string, unknown> = {};
  async function progress(stage: string) {
    console.log(stage);
    if (process.env.CLUSTER_REPORT_PATH)
      await appendFile(
        process.env.CLUSTER_REPORT_PATH + ".progress",
        new Date().toISOString() + " " + stage + "\n",
      );
  }
  const token = `clsh_${"a".repeat(40)}`;
  let sequence = 0;
  function launch(
    file: string,
    extra: Record<string, string> = {},
    tsx = false,
  ) {
    const child = fork(new URL(file, import.meta.url), [], {
      execArgv: tsx ? ["--import", "tsx"] : [],
      env: {
        ...process.env,
        DATABASE_URL: url.href,
        TSX_TSCONFIG_PATH: new URL("../../tsconfig.check.json", import.meta.url)
          .pathname,
        ...extra,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    const messages: Array<{
      type: string;
      port?: number;
      leases?: Array<{ projectId: string; cursor: number; leaseId: string }>;
    }> = [];
    let output = "";
    child.stdout?.on("data", (d) => {
      output += String(d);
    });
    child.stderr?.on("data", (d) => {
      output += String(d);
    });
    child.on("message", (message) =>
      messages.push(message as (typeof messages)[number]),
    );
    childOutputs.push(() => `${file}: ${output}`);
    return { child, messages, output: () => output };
  }
  async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill(signal);
    await Promise.race([
      exited,
      delay(5000).then(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }),
    ]);
  }
  async function gateway(label: string) {
    const running = launch(
      "./gateway-process.ts",
      { CLUSTER_NAME: label },
      true,
    );
    await until(() => {
      if (running.child.exitCode !== null) throw Error(running.output());
      return (
        running.messages.some((m) => m.type === "ready") &&
        running.messages.some((m) => m.type === "listen")
      );
    }, `gateway ${label}`);
    return {
      ...running,
      port: running.messages.find((m) => m.type === "ready")!.port!,
    };
  }
  async function admit(port: number, projectId: string) {
    const now = new Date().toISOString();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/projects/${projectId}/cloud-admission`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          projectId,
          localReplicaId: "test-replica",
          resourceIds: [],
          metadata: {
            projectId,
            name: projectId,
            description: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        }),
      },
    );
    if (!response.ok)
      throw Error(`Admission ${response.status}: ${await response.text()}`);
  }
  async function connect(port: number, projectId: string) {
    const doc = new LoroDoc(),
      writerDoc = new LoroDoc();
    docs.push(writerDoc);
    let saved: string | null = null;
    const link = createReplicaStreamClient({
      url: `http://127.0.0.1:${port}/api/v1/projects/${projectId}/replica`,
      headers: { authorization: `Bearer ${token}` },
      loadCursor: async () => saved,
      apply: async (record) => {
        if (record.data.length) doc.importBatch(record.data);
        saved = record.cursor;
      },
      onError: (error) => {
        console.error(error.message);
      },
    });
    links.push(link);
    await link.start();
    return { doc, writerDoc, link, projectId };
  }
  async function write(
    client: Awaited<ReturnType<typeof connect>>,
    key: string,
    value: string,
  ) {
    const persistent = process.env.CLUSTER_PEER_MODE === "persistent";
    const source = persistent ? client.writerDoc : new LoroDoc();
    const from = source.version();
    source.getMap("entries").set(key, value);
    source.commit();
    const bytes = source.export({ mode: "update", from });
    from.free();
    if (!persistent) source.free();
    const id = String(++sequence);
    const start = performance.now();
    const cursor = await client.link.append(id, bytes);
    return { ms: performance.now() - start, bytes, id, cursor };
  }
  const docs: LoroDoc[] = [];
  try {
    await progress("migrate");
    await migrateDatabase(db);
    await migrateTaskQueue(url.href);
    // Advance only pending checkpoint due times in this disposable test database.
    // Active leases retain their real deadlines and fencing semantics.
    checkpointClock = setInterval(() => {
      if (!advancing)
        advancing = db
          .query(
            "UPDATE project_replica_outbox SET lease_until=CURRENT_TIMESTAMP WHERE kind='checkpoint' AND lease_id IS NULL AND lease_until>CURRENT_TIMESTAMP",
          )
          .finally(() => {
            advancing = undefined;
          });
    }, 100);

    reports.postgres = (await db.query("SELECT version()")).rows[0];
    reports.durability = (
      await db.query(
        "SELECT name,setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes')",
      )
    ).rows;
    await db.query(
      "INSERT INTO api_token(id,user_id,name,token_hash,token_prefix) VALUES ($1,$2,$3,$4,$5)",
      [
        "t",
        "u",
        "cluster",
        createHash("sha256").update(token).digest("hex"),
        "clsh_aaaa",
      ],
    );
    let a = await gateway("cluster-a");
    const b = await gateway("cluster-b");
    const c = await gateway("cluster-c");
    const workers = [
      launch("../outbox-worker.ts"),
      launch("../outbox-worker.ts"),
    ];
    const checkpoint = workers[0]!;
    await admit(a.port, "recovery");
    const writer = await connect(a.port, "recovery");
    const reader = await connect(b.port, "recovery");
    docs.push(writer.doc, reader.doc);
    await write(writer, "first", "durable");
    await until(
      () => reader.doc.getMap("entries").get("first") === "durable",
      "cross-process notification",
    );
    reports.crossProcessFanout =
      "passed (gateway periodic poll is 60s; deadline 15s)";

    // Suspend only the owned gateway, remove its LISTEN backend, publish while it is absent.
    b.child.kill("SIGSTOP");
    const listeners = await db.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE application_name='cluster-b'",
    );
    expect(listeners.rows.length).toBeGreaterThan(0);
    for (const row of listeners.rows)
      await db.query("SELECT pg_terminate_backend($1)", [row.pid]);
    const heard = b.messages.filter((m) => m.type === "listen").length;
    await write(writer, "missed", "replayed");
    await until(
      async () =>
        Number(
          (
            await db.query(
              "SELECT count(*) AS n FROM project_replica_outbox WHERE kind='notification'",
            )
          ).rows[0]!.n,
        ) === 0,
      "outbox drained during listener outage",
    );
    b.child.kill("SIGCONT");
    await until(
      () => b.messages.filter((m) => m.type === "listen").length > heard,
      "real LISTEN reconnect",
    );
    await until(
      () => reader.doc.getMap("entries").get("missed") === "replayed",
      "reconnect cursor replay",
    );
    reports.listenerOutage = "passed";
    await progress("listener recovery passed");

    await until(
      async () => {
        const r = await db.query(
          "SELECT c.cursor=h.cursor AS caught_up FROM project_replica_checkpoint c JOIN project_replica_head h USING(project_id) WHERE c.project_id=$1",
          ["recovery"],
        );
        return r.rows[0]?.caught_up === true;
      },
      "checkpoint worker",
      20000,
    );
    await stop(checkpoint.child, "SIGKILL");
    const retry = await write(writer, "after-checkpoint", "tail");
    await stop(a.child, "SIGKILL");
    a = await gateway("cluster-a-restarted");
    const restored = await connect(a.port, "recovery");
    docs.push(restored.doc);
    await until(
      () =>
        restored.doc.getMap("entries").get("after-checkpoint") === "tail" &&
        restored.doc.getMap("entries").get("first") === "durable",
      "process crash checkpoint+tail restore",
    );
    const before = (
      await db.query(
        "SELECT cursor FROM project_replica_head WHERE project_id=$1",
        ["recovery"],
      )
    ).rows[0]!.cursor;
    expect(await restored.link.append(retry.id, retry.bytes)).toBe(
      retry.cursor,
    );
    expect(
      (
        await db.query(
          "SELECT cursor FROM project_replica_head WHERE project_id=$1",
          ["recovery"],
        )
      ).rows[0]!.cursor,
    ).toBe(before);
    reports.gatewayCrashAndRetry = "passed";
    await progress("gateway crash recovery passed");

    await until(
      async () =>
        Number(
          (
            await db.query(
              "SELECT count(*) AS n FROM project_replica_outbox WHERE kind='notification'",
            )
          ).rows[0]!.n,
        ) === 0,
      "queue drained",
    );
    for (const worker of workers) await stop(worker.child);
    await createPostgresReplicaLog(db, "lease-recovery").append({
      id: "lease-event",
      update: new Uint8Array(),
    });
    const claimant = launch(
      "./gateway-process.ts",
      { CLUSTER_ROLE: "lease" },
      true,
    );
    await until(
      () => claimant.messages.some((m) => m.type === "lease"),
      "worker lease",
    );
    const old = claimant.messages.find((m) => m.type === "lease")!.leases![0]!;
    await stop(claimant.child, "SIGKILL");
    await delay(1100);
    const outbox = createPostgresOutbox(db);
    const leases = await outbox.claim({ limit: 1, leaseMs: 10000 });
    expect(leases[0]).toMatchObject({
      projectId: old.projectId,
      cursor: old.cursor,
    });
    expect(await outbox.ack(old)).toBe(false);
    expect(await outbox.ack(leases[0]!)).toBe(true);
    reports.workerCrashLeaseRecovery = "passed";
    await progress("worker lease recovery passed");
    launch("../outbox-worker.ts");
    launch("../outbox-worker.ts");
    reports.topology = {
      gatewayProcesses: 3,
      durableOutboxWorkers: 2,
      concurrentWriterSessions: 4,
      postgresServers: 1,
    };
    reports.checkpointWorkerMode =
      "outbox hands checkpoint intents to BullMQ PostgreSQL; worker threads compute snapshots";
    reports.checkpointClock =
      "test advances pending due times; production delay is ten minutes";

    for (const hot of [true, false]) {
      await progress(`load start hot=${hot}`);
      const clients: Awaited<ReturnType<typeof connect>>[] = [];
      for (let i = 0; i < 4; i++) {
        const projectId = hot ? "load-hot" : `load-${i}`;
        await admit(a.port, projectId);
        const client = await connect([a, b, c][i % 3]!.port, projectId);
        docs.push(client.doc);
        clients.push(client);
      }
      const latencies: number[] = [];
      const started = performance.now();
      const perWriter = Number(process.env.CLUSTER_WRITES ?? 100);
      const payloadBytes = Number(process.env.CLUSTER_PAYLOAD_BYTES ?? 1024);
      await Promise.all(
        clients.map(async (client, index) => {
          for (let n = 0; n < perWriter; n++) {
            const result = await write(
              client,
              `writer-${index}-${n}`,
              randomBytes(payloadBytes)
                .toString("base64")
                .slice(0, payloadBytes),
            );
            latencies.push(result.ms);
            if (index === 0 && n % 100 === 0)
              await progress(`load hot=${hot} writer0=${n}`);
          }
        }),
      );
      const elapsed = (performance.now() - started) / 1000;
      for (const client of clients) {
        await until(
          () =>
            clients.every(
              (peer) =>
                peer.projectId !== client.projectId ||
                Object.keys(peer.doc.getMap("entries").toJSON()).length ===
                  (hot ? clients.length : 1) * perWriter,
            ),
          "load convergence",
        );
      }
      const checkpointStarted = performance.now();
      for (const projectId of new Set(
        clients.map((client) => client.projectId),
      )) {
        await until(
          async () => {
            const result = await db.query(
              "SELECT c.cursor=h.cursor AS caught_up FROM project_replica_checkpoint c JOIN project_replica_head h USING(project_id) WHERE c.project_id=$1",
              [projectId],
            );
            return result.rows[0]?.caught_up === true;
          },
          "checkpoint catches up with load",
          30000,
        );
        const saved = await loadProjectCheckpoint(db, projectId);
        const snapshotDoc = new LoroDoc();
        try {
          snapshotDoc.import(saved!.data);
          expect(snapshotDoc.getMap("entries").toJSON()).toEqual(
            clients
              .find((client) => client.projectId === projectId)!
              .doc.getMap("entries")
              .toJSON(),
          );
        } finally {
          snapshotDoc.free();
        }
      }
      const checkpointCatchupMs = performance.now() - checkpointStarted;
      latencies.sort((a, b) => a - b);
      reports[hot ? "hotProject" : "manyProjects"] = {
        writers: clients.length,
        writes: latencies.length,
        payloadBytes,
        payloadKind: "independent random base64 text per write",
        peerMode: process.env.CLUSTER_PEER_MODE ?? "fresh",
        checkpointContents: "matched converged clients at committed head",
        checkpointCatchupMs,
        seconds: elapsed,
        ackedPerSecond: latencies.length / elapsed,
        p50: latencies[Math.floor(latencies.length * 0.5)],
        p95: latencies[Math.floor(latencies.length * 0.95)],
        p99: latencies[Math.floor(latencies.length * 0.99)],
      };
      for (const client of clients) await client.link.close();
    }
    await until(
      async () =>
        Number(
          (
            await db.query(
              "SELECT count(*) AS n FROM project_replica_outbox WHERE kind='notification'",
            )
          ).rows[0]!.n,
        ) === 0,
      "final queue drain",
    );
    reports.databaseBytes = (
      await db.query("SELECT pg_database_size(current_database()) AS bytes")
    ).rows[0]!.bytes;
    reports.result = "passed";
    console.log(JSON.stringify(reports, null, 2));
    if (process.env.CLUSTER_REPORT_PATH)
      await writeFile(
        process.env.CLUSTER_REPORT_PATH,
        JSON.stringify(reports, null, 2) + "\n",
      );
  } catch (error) {
    console.error(childOutputs.map((read) => read()).join("\n"));

    throw error;
  } finally {
    clearInterval(checkpointClock);
    await advancing;
    await progress("cleanup");
    await Promise.all(links.map((link) => link.close()));
    for (const child of children) {
      child.kill("SIGCONT");
      await stop(child);
    }
    docs.forEach((doc) => doc.free());
    await database.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
