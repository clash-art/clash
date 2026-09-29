import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { createDurableRunRecord } from "@clash/shared-runtime/durable-run-engine";
import { migrateDatabase } from "./migrations.ts";
import { createPostgresRunJournal } from "./durable-run-journal.ts";

it("rolls back creation if scheduling intent fails and preserves frozen input on retries", async () => {
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    const journal = createPostgresRunJournal(db);
    const run = createDurableRunRecord({
      actionRunId: "r",
      outputSlot: "video",
      owner: { realm: "cloud", id: "node" },
      executorInput: { prompt: "original" },
      createdAt: 1000,
      deadlineAt: 9000,
    });
    await db.exec(
      "ALTER TABLE cloud_run_dispatch ADD CONSTRAINT reject_run CHECK (action_run_id <> 'r')",
    );
    await expect(journal.create(run)).rejects.toThrow();
    expect(await journal.load(run)).toBeUndefined();
    await db.exec("ALTER TABLE cloud_run_dispatch DROP CONSTRAINT reject_run");
    await journal.create(run);
    await journal.create(run);
    await expect(
      journal.create({ ...run, executorInput: { prompt: "different" } }),
    ).rejects.toThrow();
    expect((await journal.load(run))?.executorInput).toEqual({
      prompt: "original",
    });
    const next = { ...run, revision: run.revision + 1, updatedAt: 2000 };
    expect(await journal.compareAndSet(run, run.revision, next)).toBe(true);
    expect(
      await journal.compareAndSet(run, run.revision, {
        ...next,
        updatedAt: 3000,
      }),
    ).toBe(false);
    expect((await journal.load(run))?.updatedAt).toBe(2000);
    expect(
      await journal.compareAndSet(run, next.revision, {
        ...next,
        revision: next.revision + 1,
        owner: { realm: "cloud", id: "other" },
      }),
    ).toBe(false);
  } finally {
    await db.close();
  }
});
