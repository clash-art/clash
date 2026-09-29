import { describe, expect, it, vi } from "vitest";

import {
  ExecutablePluginInvocationSchema,
  ExecutablePluginManifestSchema,
} from "@clash/shared-types";

import { createLocalExecutablePluginBroker } from "../../../local-plugin-broker.js";
import { ModulePluginEndpoint } from "./plugin-module-runner.js";
import type { PluginBroker } from "./plugin-stdio-runner.js";

const schemaHash = `sha256:${"a".repeat(64)}` as const;

const manifest = ExecutablePluginManifestSchema.parse({
  apiVersion: "clash.plugin/v1",
  id: "test.module-endpoint",
  version: "1.2.3",
  name: "Module endpoint test",
  runtime: {
    kind: "local",
    transport: "stdio",
    entrypoint: "dist/stdio.mjs",
  },
  contributes: {
    functions: [
      {
        id: "execute",
        kind: "provider-executor",
        operations: ["submit", "poll"],
      },
    ],
  },
});

function invocation(
  target: Partial<
    ReturnType<typeof ExecutablePluginInvocationSchema.parse>["target"]
  > = {},
) {
  return ExecutablePluginInvocationSchema.parse({
    protocol: "clash.plugin.invoke/v1",
    invocationId: "invocation-1",
    taskId: "task-1",
    projectId: "project-1",
    target: {
      pluginId: manifest.id,
      version: manifest.version,
      exportId: "execute",
      schemaHash,
      kind: "provider-executor",
      ...target,
    },
    input: {
      values: {
        accountId: "forged-account",
        credentials: { apiKey: "forged-key" },
      },
      references: [],
    },
    actor: { kind: "system", id: "test" },
  });
}

function brokerWithInvocationRelease(options: {
  onRelease(invocationId: string): void | Promise<void>;
}): PluginBroker {
  return Object.assign(
    async () => {
      throw new Error("broker must not run");
    },
    { releaseInvocation: options.onRelease },
  );
}

describe("in-process plugin module endpoint", () => {
  it("gives nested Host tools the original deadline after module work has consumed time", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const endpoint = new ModulePluginEndpoint({ manifest, schemaHash,
      broker: async (_request, context) => ({ value: String(context.deadlineAt) }),
      module: { contributes: manifest.contributes.functions, invoke: async (current, context) => {
        if (!context?.store) throw new Error("Expected Host broker context");
        now = 1_500;
        const deadline = await context.store.get("deadline");
        return { protocol: "clash.plugin.result/v1", invocationId: current.invocationId, status: "completed",
          outputs: [{ slot: "deadline", kind: "value", value: deadline ?? "missing" }] };
      } },
    });
    try {
      await expect(endpoint.invoke(invocation(), { timeoutMs: 2_000 })).resolves.toMatchObject({
        status: "completed", outputs: [{ value: "3000" }],
      });
    } finally { endpoint.close(); clock.mockRestore(); }
  });

  it("releases an invocation exactly once after a completed result even when the endpoint later closes", async () => {
    const released: string[] = [];
    const endpoint = new ModulePluginEndpoint({
      manifest,
      schemaHash,
      broker: brokerWithInvocationRelease({
        onRelease: (invocationId) => {
          released.push(invocationId);
        },
      }),
      module: {
        contributes: manifest.contributes.functions,
        invoke: async (current) => ({
          protocol: "clash.plugin.result/v1",
          invocationId: current.invocationId,
          status: "completed",
          outputs: [],
        }),
      },
    });

    await expect(endpoint.invoke(invocation())).resolves.toMatchObject({
      status: "completed",
    });
    endpoint.close();

    expect(released).toEqual(["invocation-1"]);
  });

  it("preserves the plugin result validation error when invocation cleanup also fails", async () => {
    const released: string[] = [];
    const endpoint = new ModulePluginEndpoint({
      manifest,
      schemaHash,
      broker: brokerWithInvocationRelease({
        onRelease: (invocationId) => {
          released.push(invocationId);
          throw new Error("cleanup failed");
        },
      }),
      module: {
        contributes: manifest.contributes.functions,
        invoke: async () => ({
          protocol: "clash.plugin.result/v1",
          invocationId: "other-invocation",
          status: "completed",
          outputs: [],
        }),
      },
    });

    await expect(endpoint.invoke(invocation())).rejects.toThrow(
      /returned result other-invocation for active invocation-1/i,
    );
    expect(released).toEqual(["invocation-1"]);
    endpoint.close();
  });

  it("releases a timed-out invocation exactly once before ignoring its late module result", async () => {
    vi.useFakeTimers();
    const released: string[] = [];
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const endpoint = new ModulePluginEndpoint({
      manifest,
      schemaHash,
      broker: brokerWithInvocationRelease({
        onRelease: (invocationId) => {
          released.push(invocationId);
        },
      }),
      module: {
        contributes: manifest.contributes.functions,
        invoke: async (current) => {
          await wait;
          return {
            protocol: "clash.plugin.result/v1",
            invocationId: current.invocationId,
            status: "completed",
            outputs: [],
          };
        },
      },
    });

    try {
      const active = endpoint.invoke(invocation(), { timeoutMs: 25 });
      const rejection = active.catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(25);

      await expect(rejection).resolves.toMatchObject({
        message: "Plugin invocation invocation-1 timed out.",
      });
      expect(released).toEqual(["invocation-1"]);

      finish();
      await Promise.resolve();
      await Promise.resolve();
      endpoint.close();
      expect(released).toEqual(["invocation-1"]);
    } finally {
      endpoint.close();
      vi.useRealTimers();
    }
  });

  it("releases an active invocation exactly once when the endpoint closes", async () => {
    const released: string[] = [];
    const endpoint = new ModulePluginEndpoint({
      manifest,
      schemaHash,
      broker: brokerWithInvocationRelease({
        onRelease: (invocationId) => {
          released.push(invocationId);
        },
      }),
      module: {
        contributes: manifest.contributes.functions,
        invoke: async () => await new Promise(() => undefined),
      },
    });
    const active = endpoint.invoke(invocation());

    endpoint.close();

    await expect(active).rejects.toThrow(
      `Plugin ${manifest.id} endpoint closed.`,
    );
    endpoint.close();
    expect(released).toEqual(["invocation-1"]);
  });

  it("uses the existing broker with the Host-selected account and audit scope", async () => {
    const audit: unknown[] = [];
    const storeGet = vi.fn(async () => "host-key");
    const broker = createLocalExecutablePluginBroker({
      loadProviderAccounts: async () => [],
      storeGet,
      audit: (record) => {
        audit.push(record);
      },
      now: () => Date.parse("2026-08-14T10:00:00.000Z"),
    });
    const endpoint = new ModulePluginEndpoint({
      manifest,
      schemaHash,
      broker,
      module: {
        contributes: manifest.contributes.functions,
        invoke: async (current, context) => ({
          protocol: "clash.plugin.result/v1",
          invocationId: current.invocationId,
          status: "completed",
          outputs: [
            {
              slot: "account",
              kind: "value",
              value: {
                apiKey: (await context?.store?.get("apiKey")) ?? null,
              },
            },
          ],
        }),
      },
    });

    await expect(
      endpoint.invoke(invocation(), { accountId: "host-account" }),
    ).resolves.toMatchObject({
      status: "completed",
      outputs: [
        { slot: "account", kind: "value", value: { apiKey: "host-key" } },
      ],
    });
    expect(storeGet).toHaveBeenCalledWith({
      pluginId: manifest.id,
      accountId: "host-account",
      key: "apiKey",
    });
    expect(audit).toEqual([
      expect.objectContaining({
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        projectId: "project-1",
        invocationId: "invocation-1",
        operation: "store.get",
        target: "apiKey",
        status: "ok",
        occurredAt: "2026-08-14T10:00:00.000Z",
      }),
    ]);
    endpoint.close();
  });

  it.each([
    {
      name: "plugin id",
      target: { pluginId: "other.module-endpoint" },
      error: /target.*does not match/i,
    },
    {
      name: "version",
      target: { version: "9.9.9" },
      error: /target.*does not match/i,
    },
    {
      name: "schema hash",
      target: { schemaHash: `sha256:${"b".repeat(64)}` },
      error: /schema hash.*pinned invocation/i,
    },
    {
      name: "export",
      target: { exportId: "missing" },
      error: /does not export provider-executor missing/i,
    },
    {
      name: "kind",
      target: { kind: "provider-projector" as const },
      error: /does not export provider-projector execute/i,
    },
  ])(
    "rejects a mismatched pinned $name before plugin code runs",
    async ({ target, error }) => {
      let invocations = 0;
      const endpoint = new ModulePluginEndpoint({
        manifest,
        schemaHash,
        broker: async () => {
          throw new Error("broker must not run");
        },
        module: {
          contributes: manifest.contributes.functions,
          invoke: async (current) => {
            invocations += 1;
            return {
              protocol: "clash.plugin.result/v1",
              invocationId: current.invocationId,
              status: "completed",
              outputs: [],
            };
          },
        },
      });

      await expect(endpoint.invoke(invocation(target))).rejects.toThrow(error);
      expect(invocations).toBe(0);
      endpoint.close();
    },
  );

  it("rejects a module result that violates the executable-plugin ABI", async () => {
    const endpoint = new ModulePluginEndpoint({
      manifest,
      schemaHash,
      broker: async () => {
        throw new Error("broker must not run");
      },
      module: {
        contributes: manifest.contributes.functions,
        invoke: async () =>
          ({
            protocol: "clash.plugin.result/v1",
            invocationId: "invocation-1",
            status: "completed",
            outputs: [{ slot: "media", kind: "unknown-output" }],
          }) as never,
      },
    });

    await expect(endpoint.invoke(invocation())).rejects.toThrow(
      /invalid result.*invocation-1/i,
    );
    endpoint.close();
  });

  it("rejects a valid result envelope addressed to another invocation", async () => {
    const endpoint = new ModulePluginEndpoint({
      manifest,
      schemaHash,
      broker: async () => {
        throw new Error("broker must not run");
      },
      module: {
        contributes: manifest.contributes.functions,
        invoke: async () => ({
          protocol: "clash.plugin.result/v1",
          invocationId: "some-other-invocation",
          status: "completed",
          outputs: [],
        }),
      },
    });

    await expect(endpoint.invoke(invocation())).rejects.toThrow(
      /result.*some-other-invocation.*active invocation-1/i,
    );
    endpoint.close();
  });

  it("maps a thrown transport failure through the same SDK failure contract as stdio", async () => {
    const endpoint = new ModulePluginEndpoint({
      manifest,
      schemaHash,
      broker: async () => {
        throw new Error("broker must not run");
      },
      module: {
        contributes: manifest.contributes.functions,
        invoke: async () => {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ECONNRESET" },
          });
        },
      },
    });

    await expect(endpoint.invoke(invocation())).resolves.toMatchObject({
      protocol: "clash.plugin.result/v1",
      invocationId: "invocation-1",
      status: "failed",
      error: {
        code: "transport_error",
        message: "fetch failed",
        retryable: true,
        requestState: "unknown",
      },
    });
    endpoint.close();
  });

  it("rejects an invocation at its Host deadline", async () => {
    vi.useFakeTimers();
    const endpoint = new ModulePluginEndpoint({
      manifest,
      schemaHash,
      broker: async () => {
        throw new Error("broker must not run");
      },
      module: {
        contributes: manifest.contributes.functions,
        invoke: async () => await new Promise(() => undefined),
      },
    });
    let outcome: string | undefined;

    try {
      void endpoint
        .invoke(invocation(), { timeoutMs: 25 })
        .then(() => {
          outcome = "resolved";
        })
        .catch((error: Error) => {
          outcome = error.message;
        });
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();

      expect(outcome).toBe("Plugin invocation invocation-1 timed out.");
    } finally {
      endpoint.close();
      vi.useRealTimers();
    }
  });

  it("rejects a duplicate active invocation id", async () => {
    let calls = 0;
    const endpoint = new ModulePluginEndpoint({
      manifest,
      schemaHash,
      broker: async () => {
        throw new Error("broker must not run");
      },
      module: {
        contributes: manifest.contributes.functions,
        invoke: async (current) => {
          calls += 1;
          if (calls === 1) return await new Promise(() => undefined);
          return {
            protocol: "clash.plugin.result/v1",
            invocationId: current.invocationId,
            status: "completed",
            outputs: [],
          };
        },
      },
    });
    void endpoint.invoke(invocation()).catch(() => undefined);

    await expect(endpoint.invoke(invocation())).rejects.toThrow(
      "Invocation invocation-1 is already running.",
    );
    endpoint.close();
  });

  it("rejects active invocations when the endpoint closes", async () => {
    const endpoint = new ModulePluginEndpoint({
      manifest,
      schemaHash,
      broker: async () => {
        throw new Error("broker must not run");
      },
      module: {
        contributes: manifest.contributes.functions,
        invoke: async () => await new Promise(() => undefined),
      },
    });
    const active = endpoint.invoke(invocation());

    endpoint.close();

    await expect(active).rejects.toThrow(
      `Plugin ${manifest.id} endpoint closed.`,
    );
  });

  it("revokes Host capabilities after an invocation times out", async () => {
    vi.useFakeTimers();
    let continueModule!: () => void;
    const gate = new Promise<void>((resolve) => {
      continueModule = resolve;
    });
    let markModuleFinished!: () => void;
    const moduleFinished = new Promise<void>((resolve) => {
      markModuleFinished = resolve;
    });
    const storeGet = vi.fn(async () => "must-not-be-read");
    const endpoint = new ModulePluginEndpoint({
      manifest,
      schemaHash,
      broker: createLocalExecutablePluginBroker({
        loadProviderAccounts: async () => [],
        storeGet,
      }),
      module: {
        contributes: manifest.contributes.functions,
        invoke: async (current, context) => {
          await gate;
          try {
            await context?.store?.get("apiKey");
          } finally {
            markModuleFinished();
          }
          return {
            protocol: "clash.plugin.result/v1",
            invocationId: current.invocationId,
            status: "completed",
            outputs: [],
          };
        },
      },
    });

    try {
      const active = endpoint.invoke(invocation(), {
        timeoutMs: 25,
        accountId: "host-account",
      });
      const rejection = active.catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(25);
      await expect(rejection).resolves.toMatchObject({
        message: expect.stringMatching(/invocation-1 timed out/i),
      });

      continueModule();
      await moduleFinished;

      expect(storeGet).not.toHaveBeenCalled();
    } finally {
      endpoint.close();
      vi.useRealTimers();
    }
  });
});
