import { expect, it, vi } from "vitest";
import { hostedGenerationStatus } from "./status";
import { createDurableRunRecord } from "@clash/shared-runtime/durable-run-engine";
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../cloud-runs/cloud-durable-run-journal", () => ({
  createD1CloudDurableRunJournal: () => ({ load }),
}));
const run = createDurableRunRecord({
  actionRunId: "task",
  outputSlot: "output",
  owner: { realm: "cloud", id: "api-cf:generation" },
  createdAt: 1,
  deadlineAt: 100,
  executorInput: {
    workflowId: "task",
    params: { taskId: "task", actorUserId: "owner", projectId: "project" },
  },
});
it("requires publication acknowledgment for success and supports completed text without a media row", async () => {
  load.mockResolvedValueOnce({
    ...run,
    phase: "publishing",
    stagedOutput: { updates: { assetId: "prepared-asset" } },
  });
  expect(
    await hostedGenerationStatus({ DB: {} as D1Database }, "task"),
  ).toMatchObject({ status: "generating" });
  load.mockResolvedValueOnce({
    ...run,
    phase: "succeeded",
    projectedAt: 20,
    stagedOutput: { updates: { content: "answer" } },
  });
  expect(
    await hostedGenerationStatus({ DB: {} as D1Database }, "task"),
  ).toMatchObject({ status: "completed", updates: { content: "answer" } });
});
it("reports terminal failure even when an obsolete node cannot receive its projection", async () => {
  load.mockResolvedValueOnce({
    ...run,
    phase: "failed",
    failure: {
      code: "publication_failed",
      message: "private node/task conflict",
      retryable: false,
      requestState: "accepted",
    },
  });
  const status = await hostedGenerationStatus({ DB: {} as D1Database }, "task");
  expect(status?.status).toBe("failed");
  expect(status?.error).not.toContain("private node/task conflict");
});
