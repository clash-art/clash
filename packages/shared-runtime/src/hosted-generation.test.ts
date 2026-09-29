import { expect, it } from "vitest";
import {
  createGenerationPipeline,
  enqueueGeneration,
} from "./hosted-generation.ts";
import type { DurableRunRecord } from "./durable-run-engine.ts";
it("journals before scheduling, freezes routing and resumes through platform ports", async () => {
  let row: DurableRunRecord | undefined;
  const journal = {
    create: async (r: DurableRunRecord) => {
      row = structuredClone(r);
    },
    load: async () => row && structuredClone(row),
    compareAndSet: async (
      _id: unknown,
      rev: number,
      next: DurableRunRecord,
    ) => {
      if (row?.revision !== rev) return false;
      row = structuredClone(next);
      return true;
    },
    listRecoverable: async () => (row ? [row] : []),
  };
  const effects: string[] = [];
  const params = {
    taskId: "task",
    projectId: "project",
    nodeId: "node",
    type: "text_gen" as const,
    actorType: "user" as const,
    actorUserId: "owner",
    prompt: "hello",
  };
  const ports = {
    ownerId: "node:generation",
    journal,
    assertAccess: async () => {},
    claim: async () => {},
    resolveRoute: async () => undefined,
    beforeStart: async () => {},
    schedule: async () => {
      expect(row?.executorInput).toMatchObject({ params: { prompt: "hello" } });
    },
    checkpoint: async (
      _run: DurableRunRecord,
      _name: string,
      action: () => Promise<void>,
    ) => action(),
    provider: {
      submit: async () => {
        effects.push("submit");
        return {
          status: "completed" as const,
          outputs: [
            { slot: "output", kind: "value" as const, value: "result" },
          ],
        };
      },
      poll: async () => {
        throw Error("unexpected poll");
      },
    },
    stage: async () => {
      effects.push("stage");
      return { result: "stored" };
    },
    publish: async () => {
      effects.push("publish");
    },
    publishFailure: async () => {
      throw Error("unexpected failure");
    },
  };
  await enqueueGeneration(ports, "task", params);
  await expect(
    enqueueGeneration(ports, "task", { ...params, prompt: "changed" }),
  ).rejects.toThrow(/different/);
  for (let n = 0; n < 8 && row?.phase !== "succeeded"; n++)
    await createGenerationPipeline(ports).coordinate({
      type: "advance",
      identity: { actionRunId: "task", outputSlot: "output" },
    });
  expect(row?.phase).toBe("succeeded");
  expect(effects).toEqual(["submit", "stage", "publish"]);
});
