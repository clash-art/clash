import { readFile } from "node:fs/promises";

import { createExecutorContext, type ExecutorContext } from "@clash/action-sdk";
import type {
  ExecutablePluginInvocation,
  ExecutablePluginOutput,
} from "@clash/shared-types/executable-plugin";
import { ExecutablePluginManifestSchema } from "@clash/shared-types/executable-plugin";
import { describe, expect, it } from "vitest";

const invocation: ExecutablePluginInvocation = {
  protocol: "clash.plugin.invoke/v1",
  invocationId: "render-invocation-1",
  taskId: "timeline-render-1",
  projectId: "project-1",
  target: {
    pluginId: "clash.remotion",
    version: "0.1.0",
    exportId: "render-timeline",
    schemaHash: `sha256:${"0".repeat(64)}`,
    kind: "action",
  },
  operation: "submit",
  input: {
    values: {
      // Captured native Generator invocations do not carry an outputSlot value.
      // The output is defined by generators/timeline.json, not user parameters.
      __generatorActionId: "render",
      timeline: {
        name: "Rough cut",
        owner: { kind: "project" },
        state: {
          compositionWidth: 720,
          compositionHeight: 1280,
          fps: 24,
          durationInFrames: 96,
          tracks: [
            {
              id: "visuals",
              items: [
                {
                  id: "hero",
                  type: "image",
                  assetId: "project-asset-image",
                  from: 0,
                  durationInFrames: 48,
                },
                {
                  id: "demo",
                  type: "video",
                  assetId: "project-asset-video",
                  from: 48,
                  durationInFrames: 48,
                },
              ],
            },
          ],
        },
      },
    },
    references: [
      {
        slot: "timeline:item:hero",
        index: 0,
        asset: {
          assetId: "project-asset-image",
          uri: "clash-asset://project-asset-image",
          kind: "image",
          mediaType: "image/png",
        },
      },
      {
        slot: "timeline:item:demo",
        index: 0,
        asset: {
          assetId: "project-asset-video",
          uri: "clash-asset://project-asset-video",
          kind: "video",
          mediaType: "video/mp4",
        },
      },
    ],
  },
  assetInputs: [
    {
      match: { kinds: ["image", "video", "audio"] },
      representations: ["executor-url"],
    },
  ],
  actor: { kind: "agent", id: "codex" },
};

async function loadRemotionModule() {
  return await import("./stdio.js").catch(() => undefined);
}

function context(options: {
  resolvedForm?: "executor-url" | "provider-url" | "bytes";
  onUpload?: (request: {
    slot: string;
    bytes?: Uint8Array;
    mediaType?: string;
    kind: string;
  }) => void;
}): ExecutorContext {
  return createExecutorContext({
    reference: async (reference) => {
      const suffix = reference.slot.replace("timeline:item:", "");
      if (options.resolvedForm === "provider-url") {
        return {
          form: "provider-url",
          providerUrl: `https://provider.example.test/${suffix}`,
          expiresAt: "2026-08-15T12:00:00.000Z",
        };
      }
      if (options.resolvedForm === "bytes") {
        return { form: "bytes", bytes: Uint8Array.of(1, 2, 3) };
      }
      return {
        form: "executor-url",
        executorUrl: `http://127.0.0.1:43111/capabilities/${suffix}`,
        expiresAt: "2026-08-15T12:00:00.000Z",
      };
    },
    upload: async (request) => {
      options.onUpload?.(request);
      return {
        slot: request.slot,
        kind: "asset",
        asset: {
          assetId: "rendered-video",
          uri: "clash-asset://rendered-video",
          kind: "video",
          mediaType: request.mediaType,
        },
      } satisfies ExecutablePluginOutput;
    },
  });
}

describe("Remotion bundled Action", () => {
  it("renders a native Generator invocation and uploads the MP4 to its declared output slot", async () => {
    const module = await loadRemotionModule();
    expect(module?.createRemotionPlugin).toBeTypeOf("function");
    if (!module?.createRemotionPlugin) return;

    let browserInput: Record<string, any> | undefined;
    let uploaded:
      | { slot: string; bytes?: Uint8Array; mediaType?: string; kind: string }
      | undefined;
    const plugin = module.createRemotionPlugin({
      browserBundlePath: "/plugin/dist/browser-bundle",
      renderer: {
        selectComposition: async (options: Record<string, unknown>) => {
          browserInput = options.inputProps as Record<string, any>;
          return { id: "VideoComposition" };
        },
        renderMedia: async (options: Record<string, unknown>) => {
          await import("node:fs/promises").then(({ writeFile }) =>
            writeFile(
              String(options.outputLocation),
              Buffer.from("rendered-mp4"),
            ),
          );
        },
      },
    });

    const result = await plugin.invoke(
      structuredClone(invocation),
      context({
        onUpload: (request) => {
          uploaded = request;
        },
      }),
    );

    expect(result).toEqual({
      protocol: "clash.plugin.result/v1",
      invocationId: "render-invocation-1",
      status: "completed",
      outputs: [
        {
          slot: "render:output",
          kind: "asset",
          asset: {
            assetId: "rendered-video",
            uri: "clash-asset://rendered-video",
            kind: "video",
            mediaType: "video/mp4",
          },
        },
      ],
    });
    expect(browserInput?.tracks[0].items.map((item: any) => item.src)).toEqual([
      "http://127.0.0.1:43111/capabilities/hero",
      "http://127.0.0.1:43111/capabilities/demo",
    ]);
    expect(
      (
        (invocation.input.values.timeline as Record<string, any>)
          .state as Record<string, any>
      ).tracks[0].items,
    ).toEqual([
      {
        id: "hero",
        type: "image",
        assetId: "project-asset-image",
        from: 0,
        durationInFrames: 48,
      },
      {
        id: "demo",
        type: "video",
        assetId: "project-asset-video",
        from: 48,
        durationInFrames: 48,
      },
    ]);
    expect(uploaded).toMatchObject({
      slot: "render:output",
      mediaType: "video/mp4",
      kind: "video",
    });
    expect(Buffer.from(uploaded?.bytes ?? []).toString()).toBe("rendered-mp4");
  });

  it.each(["provider-url", "bytes"] as const)(
    "rejects %s because browser media must be an invocation-scoped executor URL",
    async (resolvedForm) => {
      const module = await loadRemotionModule();
      expect(module?.createRemotionPlugin).toBeTypeOf("function");
      if (!module?.createRemotionPlugin) return;
      const plugin = module.createRemotionPlugin({
        browserBundlePath: "/plugin/dist/browser-bundle",
        renderer: {
          selectComposition: async () => ({ id: "VideoComposition" }),
          renderMedia: async () => undefined,
        },
      });

      await expect(
        plugin.invoke(structuredClone(invocation), context({ resolvedForm })),
      ).rejects.toThrow(/executor-url/);
    },
  );

  it("declares its Action delivery and packaged browser bundle in the validated manifest", async () => {
    const module = await loadRemotionModule();
    expect(module?.plugin).toBeDefined();
    const manifest = ExecutablePluginManifestSchema.parse(
      JSON.parse(
        await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
      ),
    );

    expect(manifest).toMatchObject({
      apiVersion: "clash.plugin/v1",
      id: "clash.remotion",
      runtime: {
        kind: "local",
        resources: ["dist/browser-bundle"],
      },
      contributes: {
        functions: [
          {
            id: "render-timeline",
            kind: "action",
            assetInputs: [
              {
                match: { kinds: ["image", "video", "audio"] },
                representations: ["executor-url"],
              },
            ],
          },
        ],
      },
    });
  });
});
