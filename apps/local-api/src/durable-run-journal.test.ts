import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDurableRunRecord,
  type DurableRunIdentity,
  type DurableRunRecord,
} from "@clash/shared-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDurableRunJournal } from "./durable-run-journal";

const require = createRequire(import.meta.url);
const temporaryDirectories: string[] = [];

async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clash-durable-run-journal-"));
  temporaryDirectories.push(directory);
  return directory;
}

function run(
  actionRunId: string,
  overrides: Partial<DurableRunRecord> = {},
): DurableRunRecord {
  return {
    ...createDurableRunRecord({
      actionRunId,
      outputSlot: "video",
      owner: { realm: "local", id: "host-1" },
      executorInput: {
        projectId: "project-1",
        providerId: "provider-private",
        accountId: "account-private",
        values: { prompt: "frozen input" },
      },
      createdAt: 10,
      deadlineAt: 10_000,
    }),
    ...overrides,
  };
}

function identity(record: DurableRunRecord): DurableRunIdentity {
  return {
    actionRunId: record.actionRunId,
    outputSlot: record.outputSlot,
  };
}

function openRawDatabase(dataDir: string) {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { timeout?: number }) => {
      prepare(sql: string): {
        run(...params: unknown[]): unknown;
        all(...params: unknown[]): Record<string, unknown>[];
        get(...params: unknown[]): Record<string, unknown> | undefined;
      };
      close(): void;
    };
  };
  return new DatabaseSync(join(dataDir, "local.sqlite"), { timeout: 5_000 });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite DurableRunJournal", () => {
  it("persists the complete owner-private record across a reopened journal", async () => {
    const dataDir = await temporaryDataDir();
    const stored = run("run-persisted", {
      revision: 4,
      phase: "polling",
      updatedAt: 40,
      nextAttemptAt: 90,
      pollState: { taskId: "provider-secret-task" },
      attemptCounts: { submit: 1, poll: 2, stage: 0, publish: 0 },
      failureCounts: { submit: 0, poll: 1, stage: 0, publish: 0 },
    });

    const sibling = { ...stored, outputSlot: "thumbnail" };
    await createSqliteDurableRunJournal(dataDir).create(stored);
    const reopened = createSqliteDurableRunJournal(dataDir);

    await reopened.create(sibling);
    await expect(reopened.load(identity(stored))).resolves.toEqual(stored);
    await expect(reopened.load(identity(sibling))).resolves.toEqual(sibling);
    await expect(
      reopened.create(structuredClone(stored)),
    ).resolves.toBeUndefined();
    await expect(
      reopened.create({
        ...stored,
        executorInput: { providerId: "different" },
      }),
    ).rejects.toThrow(/already exists with different content/i);
  });

  it("allows only one CAS winner and atomically preserves owner realm and id", async () => {
    const dataDir = await temporaryDataDir();
    const first = createSqliteDurableRunJournal(dataDir);
    const second = createSqliteDurableRunJournal(dataDir);
    const initial = run("run-cas");
    await first.create(initial);
    const runIdentity = identity(initial);

    const left = {
      ...initial,
      revision: 1,
      phase: "submitting" as const,
      updatedAt: 20,
    };
    const right = {
      ...initial,
      revision: 1,
      phase: "failed" as const,
      updatedAt: 21,
    };
    const results = await Promise.all([
      first.compareAndSet(runIdentity, 0, left),
      second.compareAndSet(runIdentity, 0, right),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = await first.load(runIdentity);
    expect(winner?.revision).toBe(1);

    await expect(
      first.compareAndSet(runIdentity, 1, {
        ...winner!,
        revision: 2,
        owner: { realm: "local", id: "host-2" },
      }),
    ).resolves.toBe(false);
    await expect(
      first.compareAndSet(runIdentity, 1, {
        ...winner!,
        revision: 2,
        owner: { realm: "cloud", id: "host-1" },
      }),
    ).resolves.toBe(false);
    await expect(first.load(runIdentity)).resolves.toEqual(winner);
  });

  it("does not let CAS mutate frozen input or extend a persisted recovery deadline", async () => {
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const initial = run("run-frozen");
    await journal.create(initial);
    const runIdentity = identity(initial);

    await expect(
      journal.compareAndSet(runIdentity, 0, {
        ...initial,
        revision: 1,
        executorInput: {
          projectId: "project-1",
          values: { prompt: "changed" },
        },
        updatedAt: 20,
      }),
    ).resolves.toBe(false);
    await expect(
      journal.compareAndSet(runIdentity, 0, {
        ...initial,
        revision: 1,
        deadlineAt: initial.deadlineAt + 1,
        updatedAt: 20,
      }),
    ).resolves.toBe(false);
    await expect(journal.load(runIdentity)).resolves.toEqual(initial);

    const recovering = run("run-recovery-frozen", {
      phase: "finalizing",
      providerOutputs: [{ slot: "text", kind: "value", value: "done" }],
      recoveryFinalizationDeadlineAt: 10_500,
    });
    await journal.create(recovering);
    await expect(
      journal.compareAndSet(identity(recovering), 0, {
        ...recovering,
        revision: 1,
        updatedAt: 20,
        recoveryFinalizationDeadlineAt: 10_600,
      }),
    ).resolves.toBe(false);
  });

  it("lists only due non-terminal Local runs for the requested owner", async () => {
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const records = [
      run("queued-due", { updatedAt: 20 }),
      run("poll-due", { phase: "polling", nextAttemptAt: 80, updatedAt: 30 }),
      run("attempt-expired", {
        phase: "submitting",
        updatedAt: 40,
        activeAttempt: {
          operation: "submit",
          number: 1,
          startedAt: 40,
          expiresAt: 90,
        },
      }),
      run("poll-later", {
        phase: "polling",
        nextAttemptAt: 110,
        updatedAt: 30,
      }),
      run("attempt-live", {
        phase: "polling",
        updatedAt: 40,
        activeAttempt: {
          operation: "poll",
          number: 1,
          startedAt: 40,
          expiresAt: 120,
        },
      }),
      run("succeeded", { phase: "succeeded", succeededAt: 50, updatedAt: 50 }),
      run("failed-projected", {
        phase: "failed",
        failedAt: 50,
        projectedAt: 50,
        updatedAt: 50,
      }),
      run("failed-unprojected", {
        phase: "failed",
        failedAt: 50,
        updatedAt: 50,
      }),
      run("other-owner", { owner: { realm: "local", id: "host-2" } }),
      run("cloud-owner", { owner: { realm: "cloud", id: "host-1" } }),
    ];
    for (const record of records) await journal.create(record);

    await expect(journal.listRecoverable("host-1", 100)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionRunId: "queued-due" }),
        expect.objectContaining({ actionRunId: "poll-due" }),
        expect.objectContaining({ actionRunId: "attempt-expired" }),
        expect.objectContaining({ actionRunId: "failed-unprojected" }),
      ]),
    );
    const recoverable = await journal.listRecoverable("host-1", 100);
    expect(recoverable.map((record) => record.actionRunId).sort()).toEqual([
      "attempt-expired",
      "failed-unprojected",
      "poll-due",
      "queued-due",
    ]);
  });

  it("lists every project with owned work so restart recovery does not need a client visit", async () => {
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const records = [
      run("project-1-now", { updatedAt: 20 }),
      run("project-1-later", {
        phase: "polling",
        nextAttemptAt: 10_000,
        updatedAt: 30,
      }),
      run("project-2", {
        executorInput: { projectId: "project-2" },
        phase: "finalizing",
        providerOutputs: [{ slot: "video", kind: "value", value: "done" }],
      }),
      run("project-3-failure-projection", {
        executorInput: { projectId: "project-3" },
        phase: "failed",
        failedAt: 40,
        failure: {
          code: "provider_failed",
          message: "The Provider task failed.",
          retryable: false,
          requestState: "accepted",
        },
      }),
      run("project-4-complete", {
        executorInput: { projectId: "project-4" },
        phase: "succeeded",
        succeededAt: 50,
      }),
      run("other-owner", {
        executorInput: { projectId: "project-5" },
        owner: { realm: "local", id: "host-2" },
      }),
    ];
    for (const record of records) await journal.create(record);

    await expect(journal.listOwnedProjectIds("host-1")).resolves.toEqual([
      "project-1",
      "project-2",
      "project-3",
    ]);
  });

  it("wakes ordinary finalization at the whole-run deadline instead of granting a fresh retry window", async () => {
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    await journal.create(
      run("late-finalization", {
        phase: "finalizing",
        deadlineAt: 100,
        nextAttemptAt: 200,
        updatedAt: 90,
        providerOutputs: [{ slot: "text", kind: "value", value: "done" }],
      }),
    );

    await expect(journal.listRecoverable("host-1", 100)).resolves.toEqual([
      expect.objectContaining({ actionRunId: "late-finalization" }),
    ]);
  });

  it("wakes recovery finalization at its one persisted shared deadline", async () => {
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    await journal.create(
      run("recovery-finalization", {
        phase: "finalizing",
        deadlineAt: 100,
        recoveryFinalizationDeadlineAt: 250,
        nextAttemptAt: 300,
        updatedAt: 200,
        providerOutputs: [{ slot: "text", kind: "value", value: "done" }],
      }),
    );

    await expect(journal.listRecoverable("host-1", 249)).resolves.toEqual([]);
    await expect(journal.nextWakeAt("host-1")).resolves.toBe(250);
    await expect(journal.listRecoverable("host-1", 250)).resolves.toEqual([
      expect.objectContaining({ actionRunId: "recovery-finalization" }),
    ]);
  });

  it("does not busy-loop an exhausted terminal-failure projection after restart", async () => {
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    await journal.create(
      run("projection-exhausted", {
        phase: "failed",
        failedAt: 40,
        updatedAt: 50,
        failure: {
          code: "provider_failed",
          message: "The Provider task failed.",
          retryable: false,
          requestState: "accepted",
        },
        projectionFailure: {
          code: "publication_failed",
          message: "The Project replica rejected the failure projection.",
          retryable: false,
          requestState: "accepted",
        },
        projectionFailureCount: 1,
      }),
    );

    await expect(journal.listRecoverable("host-1", 100)).resolves.toEqual([]);
    await expect(journal.nextWakeAt("host-1")).resolves.toBeUndefined();
  });

  it("reschedules an in-flight terminal-failure projection at its attempt expiry", async () => {
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    await journal.create(
      run("projection-in-flight", {
        phase: "failed",
        failedAt: 40,
        updatedAt: 50,
        failure: {
          code: "provider_failed",
          message: "The Provider task failed.",
          retryable: false,
          requestState: "accepted",
        },
        activeAttempt: {
          operation: "publish",
          number: 1,
          startedAt: 50,
          expiresAt: 150,
        },
        attemptCounts: { submit: 1, poll: 1, stage: 0, publish: 1 },
      }),
    );

    await expect(journal.listRecoverable("host-1", 100)).resolves.toEqual([]);
    await expect(journal.nextWakeAt("host-1")).resolves.toBe(150);
  });

  it("returns the earliest journal wake time without scanning Project state", async () => {
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    await journal.create(
      run("later", {
        phase: "polling",
        nextAttemptAt: 210,
        updatedAt: 20,
      }),
    );
    await journal.create(
      run("earlier", {
        phase: "polling",
        nextAttemptAt: 170,
        updatedAt: 30,
      }),
    );
    await journal.create(
      run("other-owner", {
        owner: { realm: "local", id: "host-2" },
        phase: "polling",
        nextAttemptAt: 100,
        updatedAt: 40,
      }),
    );
    await journal.create(
      run("other-project", {
        executorInput: { projectId: "project-2" },
        phase: "polling",
        nextAttemptAt: 50,
        updatedAt: 40,
      }),
    );

    await expect(journal.nextWakeAt("host-1", "project-1")).resolves.toBe(170);
    await expect(journal.nextWakeAt("host-1", "project-2")).resolves.toBe(50);
    await expect(journal.nextWakeAt("missing-owner")).resolves.toBeUndefined();
  });

  it("uses WAL and waits for a competing writer without adding a foreign key", async () => {
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const initial = run("run-schema");
    await journal.create(initial);
    const db = openRawDatabase(dataDir);
    try {
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(
        db.prepare("PRAGMA foreign_key_list(durable_run_journal)").all(),
      ).toEqual([]);
    } finally {
      db.close();
    }

    const locker = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[1]);
       db.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
       process.stdout.write("locked\\n");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, 75);`,
        join(dataDir, "local.sqlite"),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = once(locker, "exit");
    await once(locker.stdout, "data");

    await expect(
      journal.compareAndSet(identity(initial), 0, {
        ...initial,
        revision: 1,
        phase: "submitting",
        updatedAt: 20,
      }),
    ).resolves.toBe(true);
    await exited;
  });

  it("reports corrupted JSON and invalid minimum record fields explicitly", async () => {
    const dataDir = await temporaryDataDir();
    const journal = createSqliteDurableRunJournal(dataDir);
    const initial = run("run-corrupt");
    await journal.create(initial);
    const db = openRawDatabase(dataDir);
    const update = db.prepare(
      "UPDATE durable_run_journal SET record_json = ? WHERE action_run_id = ? AND output_slot = ?",
    );
    const { executorInput: _executorInput, ...withoutExecutorInput } = initial;
    try {
      for (const [value, field] of [
        ["{", "JSON"],
        [JSON.stringify({ ...initial, schemaVersion: 2 }), "schemaVersion"],
        [JSON.stringify({ ...initial, actionRunId: "" }), "actionRunId"],
        [JSON.stringify({ ...initial, revision: -1 }), "revision"],
        [JSON.stringify({ ...initial, phase: "mystery" }), "phase"],
        [
          JSON.stringify({
            ...initial,
            recoveryFinalizationDeadlineAt: "later",
          }),
          "recoveryFinalizationDeadlineAt",
        ],
        [JSON.stringify(withoutExecutorInput), "executorInput"],
      ] as const) {
        update.run(value, initial.actionRunId, initial.outputSlot);
        await expect(journal.load(identity(initial))).rejects.toThrow(
          new RegExp(`corrupt.*${field}`, "i"),
        );
      }
    } finally {
      db.close();
    }
  });
});
