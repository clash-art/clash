import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ExecutablePluginInvocationSchema } from "@clash/shared-types";
import { createMockExternalAigcService } from "./local-aigc.js";
import { createLocalMediaAnalysisService } from "./local-media-analysis.js";
import { createProviderPluginExecutor } from "./provider-plugin-executor.js";
import {
  PluginHostClient,
  startPluginHostIpcServer,
} from "./runtime/host/lib/plugin-host-ipc.js";

it("keeps nested analysis and boundary review inside one Host deadline across IPC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "analysis-deadline-"));
  const socketPath = join(dir, "host.sock");
  const binding = {
    pluginId: "clash.google",
    exportId: "google-execute",
    version: "0.1.0",
    schemaHash: `sha256:${"a".repeat(64)}` as const,
  };
  const budgets: number[] = [];
  const server = await startPluginHostIpcServer({
    socketPath,
    host: {
      listCards: () => [],
      resolveBinding: () => binding,
      listFunctionExports: () => [
        {
          id: binding.exportId,
          kind: "provider-executor",
          operations: ["submit", "poll"],
        },
      ],
      invoke: async (_id, invocation, options) => {
        const parsed = ExecutablePluginInvocationSchema.parse(invocation);
        budgets.push(options?.timeoutMs ?? 0);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          protocol: "clash.plugin.result/v1",
          invocationId: parsed.invocationId,
          status: "completed",
          outputs: [
            {
              slot: "text",
              kind: "value",
              value:
                budgets.length === 1
                  ? JSON.stringify({
                      scenes: [
                        { description: "Before", startMs: 0, endMs: 4800 },
                        { description: "After", startMs: 4800, endMs: 10_000 },
                      ],
                    })
                  : '{"boundaryMs":5017}',
            },
          ],
        };
      },
    },
  });
  const client = new PluginHostClient({ socketPath, timeoutMs: 10 });
  const route = {
    providerId: "official",
    accountId: "account",
    upstreamId: "google-ai-studio",
    upstreamModel: "gemini-3.1-pro-preview",
    apiShape: "google-ai-studio",
  };
  const service = createLocalMediaAnalysisService({
    config: {
      get: async () => ({
        videoEnabled: true,
        modelId: "gemini-3.1-pro",
        allowedCategories: null,
        video: {
          fps: 2,
          mediaResolution: "medium",
          boundaryRefinement: {
            enabled: true,
            fps: 12,
            safetyMarginSeconds: 0.75,
          },
        },
      }),
      assertRunnable: async () => ({
        id: "gemini-3.1-pro",
        name: "Gemini",
        provider: "official",
        route: route.apiShape,
        consumer: { pluginId: "clash.media-analysis" },
        visibility: "public",
        underlyingModel: route.upstreamModel,
        implementation: route,
        sourceKinds: ["video"],
      }),
    },
    aigc: createMockExternalAigcService({
      providerAccounts: async () => [
        {
          id: "account",
          providerId: "official",
          upstreamId: "google-ai-studio",
          enabled: true,
          configuredCredentials: ["apiKey"],
          region: "global",
        },
      ],
      providerPluginExecutor: createProviderPluginExecutor({ client }),
    }),
  });
  const input = {
    projectId: "project",
    invocationId: "invocation",
    taskId: "task",
    modelId: "gemini-3.1-pro",
    route,
    category: "scene-shot",
    prompt: "Find scenes",
    promptVersion: "v1",
    deadlineAt: Date.now() + 2_000,
    reference: {
      slot: "source",
      index: 0,
      asset: {
        assetId: "video",
        kind: "video" as const,
        uri: "clash-asset://video",
        mediaType: "video/mp4",
      },
    },
  };
  try {
    await expect(service.analyze(input)).resolves.toMatchObject({
      status: "completed",
      result: {
        scenes: [{ endMs: 5017 }, { startMs: 5017 }],
      },
    });
    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBeGreaterThan(1_000);
    expect(budgets[0]).toBeLessThanOrEqual(2_000);
    expect(budgets[1]).toBeLessThan(budgets[0]!);
    await expect(
      service.analyze({ ...input, deadlineAt: Date.now() - 1 }),
    ).rejects.toThrow(/deadline|timed out/i);
    expect(budgets).toHaveLength(2);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
