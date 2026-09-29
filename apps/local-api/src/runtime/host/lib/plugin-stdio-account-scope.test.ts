import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  ExecutablePluginInvocationSchema,
  ExecutablePluginManifestSchema,
} from "@clash/shared-types";

import { PluginStdioSession } from "./plugin-stdio-runner.js";
import type { PluginBroker } from "./plugin-stdio-runner.js";

const manifest = ExecutablePluginManifestSchema.parse({
  apiVersion: "clash.plugin/v1",
  id: "test.account-session",
  version: "1.0.0",
  name: "Account session",
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

const invocation = ExecutablePluginInvocationSchema.parse({
  protocol: "clash.plugin.invoke/v1",
  invocationId: "invocation-1",
  taskId: "task-1",
  projectId: "project-1",
  target: {
    pluginId: manifest.id,
    version: manifest.version,
    exportId: "execute",
    schemaHash: `sha256:${"a".repeat(64)}`,
    kind: "provider-executor",
  },
  input: {
    values: { accountId: "forged-account" },
    references: [],
  },
  actor: { kind: "system", id: "test" },
});

function brokerWithInvocationRelease(options: {
  onRelease(invocationId: string): void | Promise<void>;
}): PluginBroker {
  return Object.assign(async () => ({ value: null }), {
    releaseInvocation: options.onRelease,
  });
}

describe("stdio plugin Host account scope", () => {
  it("keeps the original Host deadline on nested stdio broker requests", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let seenDeadline: number | undefined;
    const session = new PluginStdioSession({ manifest, stdin, stdout,
      broker: async (_request, context) => { seenDeadline = context.deadlineAt; return { value: null }; },
    });
    try {
      const completed = session.invoke(invocation, { timeoutMs: 2_000 });
      now = 1_500;
      stdout.write(`${JSON.stringify({ protocol: "clash.plugin.broker-request/v1", invocationId: invocation.invocationId,
        requestId: "nested", operation: { kind: "store.get", key: "key" } })}\n`);
      stdout.write(`${JSON.stringify({ protocol: "clash.plugin.result/v1", invocationId: invocation.invocationId,
        status: "completed", outputs: [] })}\n`);
      await completed;
      expect(seenDeadline).toBe(3_000);
    } finally { session.close(); clock.mockRestore(); }
  });

  it("releases an invocation exactly once after its result even when the session later closes", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const released: string[] = [];
    const session = new PluginStdioSession({
      manifest,
      stdin,
      stdout,
      broker: brokerWithInvocationRelease({
        onRelease: (invocationId) => {
          released.push(invocationId);
        },
      }),
    });

    const completed = session.invoke(invocation, { timeoutMs: 1_000 });
    stdout.write(
      `${JSON.stringify({
        protocol: "clash.plugin.result/v1",
        invocationId: invocation.invocationId,
        status: "completed",
        outputs: [],
      })}\n`,
    );

    await expect(completed).resolves.toMatchObject({ status: "completed" });
    session.close();
    expect(released).toEqual(["invocation-1"]);
  });

  it("preserves an invalid-result error when invocation cleanup also fails", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const released: string[] = [];
    const session = new PluginStdioSession({
      manifest,
      stdin,
      stdout,
      broker: brokerWithInvocationRelease({
        onRelease: (invocationId) => {
          released.push(invocationId);
          throw new Error("cleanup failed");
        },
      }),
    });

    const completed = session.invoke(invocation, { timeoutMs: 1_000 });
    stdout.write(
      `${JSON.stringify({
        protocol: "clash.plugin.result/v1",
        invocationId: invocation.invocationId,
        status: "completed",
        outputs: [{ slot: "media", kind: "invalid-output" }],
      })}\n`,
    );

    await expect(completed).rejects.toThrow(/invalid result.*invocation-1/i);
    expect(released).toEqual(["invocation-1"]);
    session.close();
  });

  it("releases a timed-out invocation exactly once even when the session later closes", async () => {
    vi.useFakeTimers();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const released: string[] = [];
    const session = new PluginStdioSession({
      manifest,
      stdin,
      stdout,
      broker: brokerWithInvocationRelease({
        onRelease: (invocationId) => {
          released.push(invocationId);
        },
      }),
    });

    try {
      const completed = session.invoke(invocation, { timeoutMs: 25 });
      const rejection = completed.catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(25);

      await expect(rejection).resolves.toMatchObject({
        message: "Plugin invocation invocation-1 timed out.",
      });
      session.close();
      expect(released).toEqual(["invocation-1"]);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  });

  it("releases an active invocation exactly once when the stdio channel closes", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const released: string[] = [];
    const session = new PluginStdioSession({
      manifest,
      stdin,
      stdout,
      broker: brokerWithInvocationRelease({
        onRelease: (invocationId) => {
          released.push(invocationId);
        },
      }),
    });
    const completed = session.invoke(invocation, { timeoutMs: 1_000 });

    stdout.end();

    await expect(completed).rejects.toThrow(/closed its stdio channel/i);
    session.close();
    expect(released).toEqual(["invocation-1"]);
  });

  it("binds broker requests to the account saved with the pending invocation", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const broker = vi.fn(async (_request: unknown, _context: unknown) => ({
      value: "host-key",
    }));
    const session = new PluginStdioSession({
      manifest,
      stdin,
      stdout,
      broker,
    });

    const completed = session.invoke(invocation, {
      timeoutMs: 1_000,
      accountId: "host-account",
    });
    stdout.write(
      `${JSON.stringify({
        protocol: "clash.plugin.broker-request/v1",
        requestId: "broker-1",
        invocationId: invocation.invocationId,
        operation: { kind: "store.get", key: "apiKey" },
      })}\n`,
    );

    await vi.waitFor(() => expect(broker).toHaveBeenCalledOnce());
    expect(broker.mock.calls[0]?.[1]).toMatchObject({
      accountId: "host-account",
      invocation: {
        input: { values: { accountId: "forged-account" } },
      },
    });

    stdout.write(
      `${JSON.stringify({
        protocol: "clash.plugin.result/v1",
        invocationId: invocation.invocationId,
        status: "completed",
        outputs: [{ slot: "text", kind: "value", value: "done" }],
      })}\n`,
    );
    await expect(completed).resolves.toMatchObject({ status: "completed" });
    session.close();
  });

  it("ignores an invalid result for an invocation that is no longer pending", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const session = new PluginStdioSession({
      manifest,
      stdin,
      stdout,
      broker: async () => null,
    });

    const completed = session.invoke(invocation, { timeoutMs: 1_000 });
    stdout.write(
      `${JSON.stringify({
        protocol: "clash.plugin.result/v1",
        invocationId: "already-finished",
        status: "failed",
        error: {
          code: "execution_failed",
          message: "late failure",
          retryable: false,
        },
      })}\n`,
    );
    stdout.write(
      `${JSON.stringify({
        protocol: "clash.plugin.result/v1",
        invocationId: invocation.invocationId,
        status: "completed",
        outputs: [{ slot: "text", kind: "value", value: "done" }],
      })}\n`,
    );

    await expect(completed).resolves.toMatchObject({ status: "completed" });
    session.close();
  });

  it("rejects the pending invocation when its result violates the plugin protocol", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const session = new PluginStdioSession({
      manifest,
      stdin,
      stdout,
      broker: async () => null,
    });

    const completed = session.invoke(invocation, { timeoutMs: 1_000 });
    stdout.write(
      `${JSON.stringify({
        protocol: "clash.plugin.result/v1",
        invocationId: invocation.invocationId,
        status: "failed",
        error: {
          code: "execution_failed",
          message: "invalid failure",
          retryable: false,
        },
      })}\n`,
    );

    await expect(completed).rejects.toThrow(/invalid result.*invocation-1/i);
    session.close();
  });
});
