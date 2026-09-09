import { describe, expect, it } from "vitest";

import {
  createBoundedRetryPolicy,
  createDurableRunRecord,
  type DurableOutputStore,
  type DurableProjectPublisher,
  type DurableProviderExecutor,
  type DurableRunIdentity,
  type DurableRunJournal,
  type DurableRunRecord,
} from "@clash/shared-runtime/durable-run-engine";

import {
  createCloudDurableRun,
  createCloudDurableRunCoordinator,
  type CloudDurableRunCreateCommand,
} from "./cloud-durable-run-coordinator";
import {
  dispatchCloudDurableRun,
  cloudDurableWorkflowId,
  recoverCloudDurableRuns,
} from "./cloud-durable-dispatcher";
import { runCloudDurableWorkflow } from "./cloud-durable-workflow";

class MemoryCloudJournal implements DurableRunJournal {
  readonly records = new Map<string, DurableRunRecord>();

  private key(identity: DurableRunIdentity): string {
    return `${identity.actionRunId}:${identity.outputSlot}`;
  }

  async create(run: DurableRunRecord): Promise<void> {
    const key = this.key(run);
    const existing = this.records.get(key);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(run)) {
        throw new Error(
          "cloud durable run already exists with different content",
        );
      }
      return;
    }
    this.records.set(key, structuredClone(run));
  }

  async load(
    identity: DurableRunIdentity,
  ): Promise<DurableRunRecord | undefined> {
    const run = this.records.get(this.key(identity));
    return run ? structuredClone(run) : undefined;
  }

  async compareAndSet(
    identity: DurableRunIdentity,
    expectedRevision: number,
    next: DurableRunRecord,
  ): Promise<boolean> {
    const key = this.key(identity);
    const current = this.records.get(key);
    if (!current || current.revision !== expectedRevision) return false;
    this.records.set(key, structuredClone(next));
    return true;
  }

  async listRecoverable(
    ownerId: string,
    now: number,
  ): Promise<DurableRunRecord[]> {
    return [...this.records.values()]
      .filter(
        (run) =>
          run.owner.realm === "cloud" &&
          run.owner.id === ownerId &&
          run.phase !== "succeeded" &&
          (run.nextAttemptAt ?? run.updatedAt) <= now,
      )
      .map((run) => structuredClone(run));
  }
}

function command(now = 1): CloudDurableRunCreateCommand {
  return {
    actionRunId: "cloud-run-1",
    outputSlot: "media",
    deadlineAt: now + 100_000,
    executorInput: { projectId: "project-1", prompt: "draw" },
  };
}

describe("cloud durable run coordinator", () => {
  it("creates one frozen run for duplicate enqueue requests", async () => {
    const journal = new MemoryCloudJournal();
    const requests = await Promise.all(
      Array.from({ length: 12 }, () =>
        createCloudDurableRun({
          ownerId: "cloud-worker-1",
          journal,
          command: command(),
          clock: { now: () => 1 },
        }),
      ),
    );

    expect(new Set(requests.map((run) => run.revision))).toEqual(new Set([0]));
    expect(
      (await journal.load({ actionRunId: "cloud-run-1", outputSlot: "media" }))
        ?.owner,
    ).toEqual({
      realm: "cloud",
      id: "cloud-worker-1",
    });
  });

  it("survives ambiguous submit, stage, and publish crashes without duplicate output", async () => {
    const journal = new MemoryCloudJournal();
    let now = 1;
    let submitCalls = 0;
    let pollCalls = 0;
    let stageCalls = 0;
    let publishCalls = 0;
    let published = false;
    let staged: Record<string, string> | undefined;

    const provider: DurableProviderExecutor = {
      async submit({ idempotencyKey }) {
        submitCalls += 1;
        expect(idempotencyKey).toBe("cloud-run-1:media");
        if (submitCalls === 1) throw new Error("worker crashed after request");
        return {
          status: "accepted",
          pollState: { providerTaskId: "provider-task-1" },
          retryAfterMs: 0,
        };
      },
      async poll() {
        pollCalls += 1;
        return {
          status: "completed",
          outputs: [{ slot: "media", kind: "value", value: "provider-result" }],
        };
      },
    };

    const outputStore: DurableOutputStore = {
      async stage({ idempotencyKey }) {
        stageCalls += 1;
        expect(idempotencyKey).toBe("cloud-run-1:media");
        staged ??= { resourceId: "resource-1" };
        if (stageCalls === 1) throw new Error("worker crashed after staging");
        return staged;
      },
    };

    const publisher: DurableProjectPublisher = {
      async publish({ idempotencyKey }) {
        publishCalls += 1;
        expect(idempotencyKey).toBe("cloud-run-1:media");
        if (published) return;
        published = true;
        if (publishCalls === 1) throw new Error("worker crashed after publish");
      },
      async publishFailure() {
        throw new Error("not expected");
      },
    };

    const coordinator = createCloudDurableRunCoordinator({
      ownerId: "cloud-worker-1",
      journal,
      provider,
      outputStore,
      publisher,
      retryPolicy: createBoundedRetryPolicy({
        maxFailures: { submit: 3, poll: 3, stage: 3, publish: 3 },
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
      clock: { now: () => now },
      attemptTimeoutMs: { submit: 100, poll: 100, stage: 100, publish: 100 },
    });

    await coordinator.coordinate({ type: "create", ...command(now) });
    const identity = {
      actionRunId: "cloud-run-1",
      outputSlot: "media",
    } as const;
    const advance = async () =>
      coordinator.coordinate({ type: "advance", identity });

    await advance(); // queued -> submitting
    await advance(); // ambiguous submit
    await advance(); // retry submit
    await advance(); // accepted -> polling
    await advance(); // completed -> finalizing
    await advance(); // stage crashes after side effect
    await advance(); // stage retry
    await advance(); // publish crashes after side effect
    await advance(); // publish retry

    const run = await journal.load(identity);
    expect(run?.phase).toBe("succeeded");
    expect(submitCalls).toBe(2);
    expect(pollCalls).toBe(1);
    expect(stageCalls).toBe(2);
    expect(publishCalls).toBe(2);
    expect(published).toBe(true);
  });

  it("lets concurrent schedulers elect one CAS winner", async () => {
    const journal = new MemoryCloudJournal();
    const calls: string[] = [];
    const coordinator = createCloudDurableRunCoordinator({
      ownerId: "cloud-worker-1",
      journal,
      provider: {
        async submit() {
          calls.push("submit");
          return {
            status: "completed",
            outputs: [{ slot: "media", kind: "value", value: "ok" }],
          };
        },
        async poll() {
          throw new Error("poll should not run");
        },
      },
      outputStore: { stage: async () => ({ resourceId: "r1" }) },
      publisher: {
        publish: async () => undefined,
        publishFailure: async () => undefined,
      },
      retryPolicy: createBoundedRetryPolicy({
        maxFailures: { submit: 1, poll: 1, stage: 1, publish: 1 },
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
      clock: { now: () => 1 },
    });

    await coordinator.coordinate({ type: "create", ...command() });
    const identity = {
      actionRunId: "cloud-run-1",
      outputSlot: "media",
    } as const;
    await coordinator.coordinate({ type: "advance", identity });
    const results = await Promise.all([
      coordinator.coordinate({ type: "advance", identity }),
      coordinator.coordinate({ type: "advance", identity }),
    ]);

    expect(results.some((result) => result.kind === "contended")).toBe(true);
    expect(calls).toEqual(["submit"]);
  });

  it("starts Workflow after the journal and treats duplicate starts as success", async () => {
    const journal = new MemoryCloudJournal();
    const create = async () => {
      throw new Error("workflow already exists");
    };
    const result = await dispatchCloudDurableRun({
      ownerId: "cloud-worker-1",
      journal,
      workflow: { create },
      command: command(),
      clock: { now: () => 1 },
    });

    expect(result.workflowStarted).toBe(false);
    expect(result.workflowId).toBe(
      cloudDurableWorkflowId({
        actionRunId: "cloud-run-1",
        outputSlot: "media",
      }),
    );
    expect(
      await journal.load({ actionRunId: "cloud-run-1", outputSlot: "media" }),
    ).toBeTruthy();
  });

  it("recovers due rows by identity only", async () => {
    const journal = new MemoryCloudJournal();
    const due = createDurableRunRecord({
      actionRunId: "cloud-run-recover",
      outputSlot: "media",
      owner: { realm: "cloud", id: "cloud-worker-1" },
      executorInput: { projectId: "project-1" },
      createdAt: 1,
      deadlineAt: 100,
    });
    await journal.create(due);
    const scheduled: string[] = [];
    const result = await recoverCloudDurableRuns({
      ownerId: "cloud-worker-1",
      journal,
      workflow: {
        async create({ params }) {
          scheduled.push(`${params.actionRunId}/${params.outputSlot}`);
        },
      },
      now: 1,
    });
    expect(result).toEqual({ scanned: 1, scheduled: 1 });
    expect(scheduled).toEqual(["cloud-run-recover/media"]);
  });

  it("drives waiting and contended advances through named Workflow steps", async () => {
    const journal = new MemoryCloudJournal();
    let now = 1;
    const coordinator = createCloudDurableRunCoordinator({
      ownerId: "cloud-worker-1",
      journal,
      provider: {
        async submit() {
          return {
            status: "accepted",
            pollState: { id: "p1" },
            retryAfterMs: 10,
          };
        },
        async poll() {
          return {
            status: "completed",
            outputs: [{ slot: "media", kind: "value", value: "ok" }],
          };
        },
      },
      outputStore: { stage: async () => ({ resourceId: "r1" }) },
      publisher: {
        publish: async () => undefined,
        publishFailure: async () => undefined,
      },
      retryPolicy: createBoundedRetryPolicy({
        maxFailures: { submit: 1, poll: 1, stage: 1, publish: 1 },
        baseDelayMs: 0,
        maxDelayMs: 0,
      }),
      clock: { now: () => now },
    });
    await coordinator.coordinate({ type: "create", ...command() });

    const names: string[] = [];
    const sleeps: number[] = [];
    const step = {
      async do<T>(
        name: string,
        _config: Record<string, unknown>,
        fn: () => Promise<T>,
      ) {
        names.push(name);
        return fn();
      },
      async sleepUntil(name: string, timestamp: number) {
        names.push(name);
        sleeps.push(timestamp);
        now = Math.max(now, timestamp);
      },
    };
    const run = await runCloudDurableWorkflow({
      coordinator,
      identity: { actionRunId: "cloud-run-1", outputSlot: "media" },
      step,
      now: () => now,
      maxSteps: 20,
    });
    expect(run.phase).toBe("succeeded");
    expect(names.some((name) => name.startsWith("durable-run-advance-"))).toBe(
      true,
    );
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("passes a deterministic long-sequence chaos run", async () => {
    // This is intentionally a small deterministic model checker rather than
    // a flaky random test: every seed injects crashes at different boundaries
    // and the same seed is reproducible in CI.
    for (let seed = 0; seed < 96; seed += 1) {
      const journal = new MemoryCloudJournal();
      let now = 1;
      let submitCalls = 0;
      let pollCalls = 0;
      let stageCalls = 0;
      let publishCalls = 0;
      let published = false;
      let staged: Record<string, string> | undefined;
      const crashOnce = (
        operation: "submit" | "poll" | "stage" | "publish",
        count: number,
      ) => {
        const offset =
          operation === "submit"
            ? 1
            : operation === "poll"
              ? 7
              : operation === "stage"
                ? 13
                : 29;
        return count === 1 && (seed + offset) % 5 === 0;
      };
      const coordinator = createCloudDurableRunCoordinator({
        ownerId: "cloud-worker-1",
        journal,
        provider: {
          async submit() {
            submitCalls += 1;
            if (crashOnce("submit", submitCalls))
              throw new Error(`chaos submit ${seed}`);
            return {
              status: "accepted",
              pollState: { id: `provider-${seed}` },
              retryAfterMs: 0,
            };
          },
          async poll() {
            pollCalls += 1;
            if (crashOnce("poll", pollCalls))
              throw new Error(`chaos poll ${seed}`);
            return {
              status: "completed",
              outputs: [
                { slot: "media", kind: "value", value: `result-${seed}` },
              ],
            };
          },
        },
        outputStore: {
          async stage() {
            stageCalls += 1;
            staged ??= { resourceId: `resource-${seed}` };
            if (crashOnce("stage", stageCalls))
              throw new Error(`chaos stage ${seed}`);
            return staged;
          },
        },
        publisher: {
          async publish() {
            publishCalls += 1;
            if (published) return;
            published = true;
            if (crashOnce("publish", publishCalls))
              throw new Error(`chaos publish ${seed}`);
          },
          async publishFailure() {
            throw new Error(`unexpected terminal failure ${seed}`);
          },
        },
        retryPolicy: createBoundedRetryPolicy({
          maxFailures: { submit: 4, poll: 4, stage: 4, publish: 4 },
          baseDelayMs: 0,
          maxDelayMs: 0,
        }),
        clock: { now: () => now },
        attemptTimeoutMs: { submit: 100, poll: 100, stage: 100, publish: 100 },
      });
      await coordinator.coordinate({ type: "create", ...command(now) });
      const identity = {
        actionRunId: "cloud-run-1",
        outputSlot: "media",
      } as const;
      let terminal = false;
      for (let tick = 0; tick < 80 && !terminal; tick += 1) {
        const result = await coordinator.coordinate({
          type: "advance",
          identity,
        });
        if (result.kind === "terminal") {
          terminal = true;
        } else if (result.kind === "waiting") {
          now = Math.max(now, result.wakeAt);
        }
      }
      const run = await journal.load(identity);
      expect(terminal, `seed ${seed} did not terminate`).toBe(true);
      expect(run?.phase, `seed ${seed} phase`).toBe("succeeded");
      expect(published, `seed ${seed} publication`).toBe(true);
      expect(submitCalls).toBeGreaterThanOrEqual(1);
      expect(pollCalls).toBeGreaterThanOrEqual(1);
      expect(stageCalls).toBeGreaterThanOrEqual(1);
      expect(publishCalls).toBeGreaterThanOrEqual(1);
    }
  });
});
