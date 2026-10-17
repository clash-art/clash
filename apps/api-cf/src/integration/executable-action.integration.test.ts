import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { Canvas } from "@clash/shared-types";
import { LoroDoc } from "loro-crdt";
import type { ExecutablePluginBinding } from "@clash/shared-types/executable-plugin";
import type { ExecutablePluginResult } from "@clash/shared-types/executable-plugin";
import type { ExecutablePluginActionRequest } from "@clash/shared-runtime/executable-run";

import type { Env } from "../config";
import { Status } from "../domain/canvas";
import { createD1CloudDurableRunJournal } from "../cloud-runs/cloud-durable-run-journal";
import {
  submitExecutableAction,
  type SubmitExecutableActionInput,
} from "../generation/executable-admission";
import { createExecutableActionRuntime } from "../generation/executable-runtime";
import { createGenerationOutputBroker } from "../generation/output";

const binding: ExecutablePluginBinding = {
  pluginId: "third.party",
  version: "1.0.0",
  exportId: "run",
  schemaHash: `sha256:${"a".repeat(64)}`,
};

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);

async function seedPendingAction(input: {
  projectId: string;
  userId: string;
  nodeId: string;
}): Promise<SubmitExecutableActionInput> {
  await env.DB.prepare(
    "INSERT INTO project (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(input.projectId, input.userId, "Executable", Date.now(), Date.now())
    .run();
  const doc = new LoroDoc();
  doc.getMap("nodes").set(input.nodeId, {
    type: "image",
    data: {
      status: Status.Pending,
      actionType: "custom:third",
      customActionId: "third",
      outputType: "image",
      prompt: "a cat",
      actorType: "user",
      actorUserId: input.userId,
      pluginBinding: binding,
    },
  });
  const room = env.ROOM.get(env.ROOM.idFromName(input.projectId));
  const response = await room.fetch(
    new Request(`http://internal/loro/${input.projectId}/updates`, {
      method: "POST",
      headers: {
        "x-internal-loro": "true",
        "x-loro-project-id": input.projectId,
      },
      body: doc.export({ mode: "snapshot" }),
    }),
  );
  expect(response.status).toBe(204);
  doc.free();
  return {
    projectId: input.projectId,
    nodeId: input.nodeId,
    data: {
      status: Status.Pending,
      actionType: "custom:third",
      customActionId: "third",
      outputType: "image",
      prompt: "a cat",
      actorType: "user",
      actorUserId: input.userId,
      pluginBinding: binding,
    },
    userId: input.userId,
    custom: { actionId: "third", outputType: "image" },
  };
}

async function readNode(projectId: string, nodeId: string) {
  const room = env.ROOM.get(env.ROOM.idFromName(projectId));
  const snapshot = new LoroDoc();
  snapshot.import(
    new Uint8Array(
      await (
        await room.fetch(
          new Request(`http://internal/loro/${projectId}/snapshot`, {
            headers: {
              "x-internal-loro": "true",
              "x-loro-project-id": projectId,
            },
          }),
        )
      ).arrayBuffer(),
    ),
  );
  const node = new Canvas(snapshot, () => undefined).readNode(nodeId);
  snapshot.free();
  return node;
}

const BINDING_RESOLVER = async () => ({
  binding,
  kind: "in-process" as const,
  idempotentSubmit: true,
});

describe("Cloudflare executable Action run", () => {
  it("journals before invoking, publishes one D1 asset, and replays without a second effect", async () => {
    const bindings = env as unknown as Env;
    const id = crypto.randomUUID();
    const input = await seedPendingAction({
      projectId: `exec-${id}`,
      userId: `user-${id}`,
      nodeId: `node-${id}`,
    });
    const journal = createD1CloudDurableRunJournal(bindings.DB);
    const workflow = { create: vi.fn(async () => undefined) };
    let effects = 0;
    let invocations = 0;
    const now = { value: Date.now() };
    const clocked = createExecutableActionRuntime(bindings, {
      journal,
      clock: { now: () => now.value },
      action: async (request: ExecutablePluginActionRequest) => {
        invocations += 1;
        if (effects === 0) {
          effects += 1;
          throw Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ECONNRESET" },
          });
        }
        const broker = createGenerationOutputBroker(
          bindings.R2_BUCKET,
          {
            actionRunId: request.taskId,
            outputSlot: request.outputSlot!,
          },
          request.projectId,
        );
        return {
          protocol: "clash.plugin.result/v1",
          invocationId: request.invocationId,
          status: "completed",
          outputs: [
            {
              slot: "image",
              kind: "asset",
              asset: await broker.store(PNG, "image/png", "image"),
            },
          ],
        } satisfies ExecutablePluginResult;
      },
    });
    const created = await submitExecutableAction(bindings, input, {
      journal,
      workflow,
      resolveBinding: BINDING_RESOLVER,
    });
    expect(
      await journal.load({
        actionRunId: created.actionRunId,
        outputSlot: created.outputSlot,
      }),
    ).toBeDefined();
    expect(invocations).toBe(0);

    const identity = {
      actionRunId: created.actionRunId,
      outputSlot: created.outputSlot,
    };
    let result = await clocked.coordinate({ type: "advance", identity });
    for (let step = 0; step < 20 && result.kind !== "terminal"; step += 1) {
      now.value += 2_000;
      result = await clocked.coordinate({ type: "advance", identity });
    }
    expect(result.kind).toBe("terminal");
    if (result.kind !== "terminal") throw new Error("run did not finish");
    expect(result.run.phase).toBe("succeeded");
    expect(effects).toBe(1);

    const asset = await bindings.DB.prepare(
      "SELECT id, kind, src_r2_key FROM assets WHERE id = ?",
    )
      .bind(created.actionRunId)
      .first<{ id: string; kind: string; src_r2_key: string }>();
    expect(asset).toMatchObject({ id: created.actionRunId, kind: "image" });
    expect(await readNode(input.projectId, input.nodeId)).toMatchObject({
      data: {
        status: Status.Completed,
        assetId: created.actionRunId,
      },
    });

    // A replayed terminal run is not a second Action call.
    const replay = await clocked.coordinate({ type: "advance", identity });
    expect(replay.kind).toBe("terminal");
    expect(invocations).toBe(2);
  });

  it("invokes an ambiguous submit exactly once when the plugin cannot deduplicate", async () => {
    const bindings = env as unknown as Env;
    const id = crypto.randomUUID();
    const input = await seedPendingAction({
      projectId: `ambiguous-${id}`,
      userId: `user-${id}`,
      nodeId: `node-${id}`,
    });
    const journal = createD1CloudDurableRunJournal(bindings.DB);
    let invocations = 0;
    const now = { value: Date.now() };
    const runtime = createExecutableActionRuntime(bindings, {
      journal,
      clock: { now: () => now.value },
      action: async () => {
        invocations += 1;
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET" },
        });
      },
    });
    const created = await submitExecutableAction(bindings, input, {
      journal,
      workflow: { create: async () => undefined },
      resolveBinding: async () => ({
        binding,
        kind: "in-process" as const,
        idempotentSubmit: false,
      }),
    });
    const identity = {
      actionRunId: created.actionRunId,
      outputSlot: created.outputSlot,
    };
    let result = await runtime.coordinate({ type: "advance", identity });
    for (let step = 0; step < 20 && result.kind !== "terminal"; step += 1) {
      now.value += 2_000;
      result = await runtime.coordinate({ type: "advance", identity });
    }
    expect(result.kind).toBe("terminal");
    expect(invocations).toBe(1);
    if (result.kind !== "terminal") throw new Error("run did not finish");
    expect(result.run.phase).toBe("failed");
    expect(result.run.failure).toMatchObject({
      code: "transport_error",
      requestState: "unknown",
    });
  });

  it("writes no journal row for a plugin this deployment cannot execute", async () => {
    const bindings = env as unknown as Env;
    const id = crypto.randomUUID();
    const input = await seedPendingAction({
      projectId: `missing-${id}`,
      userId: `user-${id}`,
      nodeId: `node-${id}`,
    });
    const journal = createD1CloudDurableRunJournal(bindings.DB);
    await expect(
      submitExecutableAction(bindings, input, {
        journal,
        resolveBinding: async () => undefined,
      }),
    ).rejects.toThrow(/plugin_unavailable/);
    expect(
      await bindings.DB.prepare(
        "SELECT action_run_id FROM cloud_durable_run_journal WHERE owner_id = 'api-cf:executable' AND action_run_id LIKE ?",
      )
        .bind(`%${input.nodeId}%`)
        .all(),
    ).toMatchObject({ results: [] });
  });

  it("re-admits the same node revision to the same run instead of failing it", async () => {
    const bindings = env as unknown as Env;
    const id = crypto.randomUUID();
    const input = await seedPendingAction({
      projectId: `readmit-${id}`,
      userId: `user-${id}`,
      nodeId: `node-${id}`,
    });
    const journal = createD1CloudDurableRunJournal(bindings.DB);
    const workflow = { create: vi.fn(async () => undefined) };
    const first = await submitExecutableAction(bindings, input, {
      journal,
      workflow,
      resolveBinding: BINDING_RESOLVER,
      now: () => 1_000_000,
    });
    const again = await submitExecutableAction(bindings, input, {
      journal,
      workflow,
      resolveBinding: BINDING_RESOLVER,
      now: () => 9_000_000,
    });
    expect(again).toEqual(first);
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM cloud_durable_run_journal WHERE action_run_id = ?",
      )
        .bind(first.actionRunId)
        .first<{ n: number }>(),
    ).toMatchObject({ n: 1 });
  });
});
