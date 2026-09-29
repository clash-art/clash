import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { migrateDatabase } from "./migrations.ts";
import { createNodeGenerationService } from "./generation.ts";
it("admits through the shared generation policy and atomically queues the frozen run", async () => {
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    const effects: string[] = [];
    const service = createNodeGenerationService(db, {
      assertAccess: async (params) => {
        if (params.actorUserId !== "owner") throw Error("Forbidden");
      },
      resolveRoute: async () => undefined,
      claim: async () => {},
      beforeStart: async () => {},
      checkpoint: async (_run, _name, action) => action(),
      provider: {
        submit: async () => {
          effects.push("submit");
          return {
            status: "completed",
            outputs: [{ slot: "output", kind: "value", value: "result" }],
          };
        },
        poll: async () => {
          throw Error("unexpected poll");
        },
      },
      stage: async ({ outputs }) => ({ outputs }),
      publish: async () => {
        effects.push("publish");
      },
      publishFailure: async () => {
        throw Error("unexpected failure");
      },
    });
    const params = {
      taskId: "task",
      projectId: "project",
      nodeId: "node",
      type: "text_gen" as const,
      actorType: "user" as const,
      actorUserId: "owner",
      prompt: "hello",
    };
    await expect(
      service.enqueue({ ...params, actorUserId: "other" }),
    ).rejects.toThrow("Forbidden");
    expect((await db.query("SELECT * FROM cloud_run_dispatch")).rows).toEqual(
      [],
    );
    const run = await service.enqueue(params);
    expect(
      (await db.query("SELECT action_run_id FROM cloud_run_dispatch")).rows,
    ).toEqual([{ action_run_id: run.actionRunId }]);
    await expect(
      service.enqueue({ ...params, prompt: "changed" }),
    ).rejects.toThrow(/different/);
    const identity = {
      actionRunId: run.actionRunId,
      outputSlot: run.outputSlot,
    };
    for (
      let n = 0;
      n < 8 && (await service.journal.load(identity))?.phase !== "succeeded";
      n++
    )
      await service.coordinator.coordinate({ type: "advance", identity });
    expect((await service.journal.load(identity))?.phase).toBe("succeeded");
    expect(effects).toEqual(["submit", "publish"]);
  } finally {
    await db.close();
  }
});
