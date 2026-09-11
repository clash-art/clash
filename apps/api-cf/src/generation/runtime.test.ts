import { describe, expect, it, vi } from "vitest";
import {
  createHostedGenerationRuntime,
  enqueueHostedGeneration,
} from "./runtime";
import type { DurableRunRecord } from "@clash/shared-runtime/durable-run-engine";
import type { GenerationParams } from "./params";

function journal() {
  const rows = new Map<string, DurableRunRecord>();
  return {
    rows,
    async create(run: DurableRunRecord) {
      if (!rows.has(run.actionRunId))
        rows.set(run.actionRunId, structuredClone(run));
    },
    async load(id: { actionRunId: string }) {
      const row = rows.get(id.actionRunId);
      return row && structuredClone(row);
    },
    async compareAndSet(
      id: { actionRunId: string },
      revision: number,
      next: DurableRunRecord,
    ) {
      if (rows.get(id.actionRunId)?.revision !== revision) return false;
      rows.set(id.actionRunId, structuredClone(next));
      return true;
    },
    async listRecoverable() {
      return [...rows.values()];
    },
  };
}
const params: GenerationParams = {
  taskId: "task",
  projectId: "project",
  nodeId: "node",
  type: "text_gen",
  actorType: "user",
  actorUserId: "user",
  modelName: "text-model",
  prompt: "hello",
};
const route: import("@clash/shared-types").ModelUpstreamRoute = {
  modelCode: "text-model",
  kind: "text",
  accountId: "frozen-account",
  upstreamId: "openai",
  upstreamModel: "upstream-text",
  apiShape: "openai-compatible",
  priority: 1,
  requiredCredentials: ["apiKey"],
};

it("freezes the selected account and journals before scheduling; repeated enqueue cannot replace input", async () => {
  const state = journal();
  const workflow = {
    create: vi.fn(async () => {
      expect(state.rows.get("task")?.executorInput).toMatchObject({
        params: { selectedRoute: { accountId: route.accountId } },
      });
    }),
  };
  const resolveRoute = vi.fn(async () => route);
  const options = {
    journal: state,
    resolveRoute,
    assertAccess: async () => undefined,
    claim: async () => undefined,
    hooks: {},
  };
  await enqueueHostedGeneration(
    { GENERATION_WORKFLOW: workflow } as never,
    "task",
    params,
    options,
  );
  resolveRoute.mockRejectedValue(new Error("account config changed"));
  await enqueueHostedGeneration(
    { GENERATION_WORKFLOW: workflow } as never,
    "task",
    params,
    options,
  );
  expect(resolveRoute).toHaveBeenCalledTimes(1);
  await expect(
    enqueueHostedGeneration(
      { GENERATION_WORKFLOW: workflow } as never,
      "task",
      { ...params, prompt: "different" },
      options,
    ),
  ).rejects.toThrow(/different|conflict/i);
});

describe("hosted durable execution", () => {
  it("restarts after acceptance, retries the same poll, and retries publication without another submit or stage", async () => {
    const state = journal();
    let now = 1000;
    const submit = vi.fn(async (ctx: any) =>
      ctx.accepted({ id: "vendor-task" }, 1),
    );
    const poll = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" }),
      )
      .mockImplementation(async (ctx: any, token: any) => {
        expect(token).toEqual({ id: "vendor-task" });
        return ctx.completedValue({ content: "answer" });
      });
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("ProjectRoom unavailable"))
      .mockResolvedValue(undefined);
    const hooks = {
      beforeGenerate: vi.fn(),
      afterGenerate: vi.fn(),
      onFailure: vi.fn(),
    };
    const checkpoints = new Set<string>();
    const options = {
      journal: state,
      resolveRoute: async () => route,
      assertAccess: async () => undefined,
      claim: async () => undefined,
      hooks,
      clock: { now: () => now },
      adapter: () => ({ name: "test", submit, poll }),
      publish,
      hookCheckpoint: async (name: string, action: () => Promise<void>) => {
        if (!checkpoints.has(name)) {
          await action();
          checkpoints.add(name);
        }
      },
    };
    await enqueueHostedGeneration(
      { GENERATION_WORKFLOW: { create: async () => {} } } as never,
      "task",
      params,
      options,
    );
    const identity = { actionRunId: "task", outputSlot: "output" };
    await createHostedGenerationRuntime({} as never, options).coordinate({
      type: "advance",
      identity,
    });
    await createHostedGenerationRuntime({} as never, options).coordinate({
      type: "advance",
      identity,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    for (
      let i = 0;
      i < 12 && state.rows.get("task")?.phase !== "succeeded";
      i++
    ) {
      now += 60000;
      await createHostedGenerationRuntime({} as never, options).coordinate({
        type: "advance",
        identity,
      });
    }
    expect(state.rows.get("task")?.phase).toBe("succeeded");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(state.rows.get("task")?.attemptCounts.stage).toBe(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(hooks.beforeGenerate).toHaveBeenCalledTimes(1);
    expect(hooks.afterGenerate).toHaveBeenCalledTimes(1);
    expect(hooks.onFailure).not.toHaveBeenCalled();
  });
});

it("does not resubmit completed synchronous work when receipt persistence fails", async () => {
  const state = journal();
  let now = 1000;
  const submit = vi.fn(async (ctx: any) =>
    ctx.completedMedia(
      await ctx.uploadBytes(new Uint8Array([1, 2]), "image/png"),
    ),
  );
  const publish = vi.fn().mockResolvedValue(undefined);
  const onFailure = vi.fn();
  const options = {
    journal: state,
    resolveRoute: async () => route,
    assertAccess: async () => undefined,
    claim: async () => undefined,
    hooks: { onFailure },
    clock: { now: () => now },
    adapter: () => ({ name: "sync", submit }),
    publish,
    hookCheckpoint: async (_name: string, action: () => Promise<void>) =>
      action(),
  };
  const env = {
    GENERATION_WORKFLOW: { create: async () => {} },
    R2_BUCKET: {
      put: async () => {
        throw new Error("receipt storage unavailable");
      },
    },
  } as never;
  await enqueueHostedGeneration(env, "task", params, options);
  for (
    let attempt = 0;
    attempt < 8 && state.rows.get("task")?.projectedAt === undefined;
    attempt++
  ) {
    await createHostedGenerationRuntime(env, options).coordinate({
      type: "advance",
      identity: { actionRunId: "task", outputSlot: "output" },
    });
    now += 60000;
  }
  expect(state.rows.get("task")).toMatchObject({
    phase: "failed",
    failure: { requestState: "accepted", code: "output_persistence_failed" },
  });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(onFailure).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining(params),
    expect.objectContaining({
      failure: expect.objectContaining({ code: "output_persistence_failed" }),
    }),
  );
});

it("rejects an explicit changed account on replay while accepting omitted automatic selection", async () => {
  const state = journal();
  const options = {
    journal: state,
    resolveRoute: async () => route,
    assertAccess: async () => undefined,
    claim: async () => undefined,
    hooks: {},
  };
  const env = { GENERATION_WORKFLOW: { create: async () => {} } } as never;
  await enqueueHostedGeneration(env, "task", params, options);
  await expect(
    enqueueHostedGeneration(
      env,
      "task",
      { ...params, selectedRoute: { ...route, accountId: "other-account" } },
      options,
    ),
  ).rejects.toThrow(/different/);
});

it("revalidates admission before a recovered queued run can call its provider", async () => {
  const state = journal();
  const submit = vi.fn();
  const claim = vi
    .fn()
    .mockRejectedValue(new Error("node belongs to a newer task"));
  const options = {
    journal: state,
    resolveRoute: async () => route,
    assertAccess: async () => undefined,
    claim,
    hooks: {},
    adapter: () => ({ name: "test", submit }),
    publish: async () => undefined,
    hookCheckpoint: async (_name: string, action: () => Promise<void>) =>
      action(),
  };
  const env = { GENERATION_WORKFLOW: { create: vi.fn() } } as never;
  await expect(
    enqueueHostedGeneration(env, "task", params, options),
  ).rejects.toThrow(/newer task/);
  expect(state.rows.get("task")?.phase).toBe("queued");
  const identity = { actionRunId: "task", outputSlot: "output" };
  await createHostedGenerationRuntime(env, options).coordinate({
    type: "advance",
    identity,
  });
  await createHostedGenerationRuntime(env, options).coordinate({
    type: "advance",
    identity,
  });
  expect(submit).not.toHaveBeenCalled();
  expect(state.rows.get("task")?.phase).toBe("failed");
});

it("elects one frozen run for concurrent identical enqueue even across different clock ticks", async () => {
  const state = journal();
  const create = state.create.bind(state);
  state.create = async (run) => {
    if (state.rows.has(run.actionRunId)) throw new Error("duplicate insert");
    await create(run);
  };
  let now = 1000;
  const options = {
    journal: state,
    resolveRoute: async () => route,
    assertAccess: async () => undefined,
    claim: async () => undefined,
    hooks: {},
    clock: { now: () => now++ },
  };
  const env = {
    GENERATION_WORKFLOW: { create: vi.fn().mockResolvedValue(undefined) },
  } as never;
  const [first, second] = await Promise.all([
    enqueueHostedGeneration(env, "task", params, options),
    enqueueHostedGeneration(env, "task", params, options),
  ]);
  expect(first).toEqual(second);
  expect(state.rows.get("task")).toEqual(first);
});
