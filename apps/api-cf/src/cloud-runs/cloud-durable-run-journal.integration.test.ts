import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import {
  createDurableRunRecord,
  type DurableRunRecord,
} from "@clash/shared-runtime/durable-run-engine";

import { createD1CloudDurableRunJournal } from "./cloud-durable-run-journal";

const journal = () => createD1CloudDurableRunJournal(env.DB);

function run(id = "itest-cloud-run"): DurableRunRecord {
  return createDurableRunRecord({
    actionRunId: id,
    outputSlot: "media",
    owner: { realm: "cloud", id: "itest-worker" },
    executorInput: { projectId: "itest-project", prompt: "chaos" },
    createdAt: 100,
    deadlineAt: 1_000,
  });
}

describe("D1 cloud durable run journal", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      "DELETE FROM cloud_durable_run_journal WHERE action_run_id LIKE 'itest-cloud-%'",
    ).run();
  });

  it("persists frozen runs and elects one CAS winner", async () => {
    const d1 = journal();
    const initial = run();
    await d1.create(initial);
    expect(
      await d1.load({
        actionRunId: initial.actionRunId,
        outputSlot: initial.outputSlot,
      }),
    ).toEqual(initial);

    const next = {
      ...initial,
      revision: 1,
      phase: "submitting" as const,
      updatedAt: 101,
    };
    const [first, second] = await Promise.all([
      d1.compareAndSet(
        { actionRunId: initial.actionRunId, outputSlot: initial.outputSlot },
        0,
        next,
      ),
      d1.compareAndSet(
        { actionRunId: initial.actionRunId, outputSlot: initial.outputSlot },
        0,
        next,
      ),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(
      (
        await d1.load({
          actionRunId: initial.actionRunId,
          outputSlot: initial.outputSlot,
        })
      )?.revision,
    ).toBe(1);
  });

  it("returns only due cloud rows for restart recovery", async () => {
    const d1 = journal();
    const due = run("itest-cloud-due");
    const later = run("itest-cloud-later");
    await d1.create(due);
    await d1.create({ ...later, nextAttemptAt: 10_000 });

    const ids = await d1.listRecoverable("itest-worker", 100);
    expect(ids.map((item) => item.actionRunId)).toEqual(["itest-cloud-due"]);
  });
});
