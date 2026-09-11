// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { CustomActionDefinitionSchema } from "@clash/shared-types";
import { describe, expect, it, vi } from "vitest";

import { useSpawnPendingAsset } from "./useSpawnPendingAsset";

vi.mock("@clash/web-ui/lib/betterAuthClient", () => ({
  default: {
    useSession: () => ({ data: { user: { id: "user-1" } } }),
  },
}));

describe("useSpawnPendingAsset", () => {
  it("waits for a native draft acknowledgement and persists only the pinned revision", async () => {
    let accept!: (value: { generatorId: string; generatorRevisionId: string }) => void;
    const resolveGeneratorRevision = vi.fn(() => new Promise<{ generatorId: string; generatorRevisionId: string }>((resolve) => { accept = resolve; }));
    const addNode = vi.fn((node: any) => ({ ...node, position: { x: 0, y: 0 } }));
    const { result } = renderHook(() => useSpawnPendingAsset({
      actionBadgeId: "placement", actionType: "video-gen", isCustom: false, customDef: undefined,
      customActionParams: {}, modelId: "stale-model", modelParams: {}, selectedModel: undefined,
      content: "Stale Canvas prompt", lyrics: "", dataPrompt: undefined, projectId: "project", refNodeIds: [],
      getNodes: () => [], addNodeWithAutoLayout: addNode, addNodeWithLayout: addNode,
      addEdges: vi.fn(), setNodes: vi.fn(), loroSync: null, resolveGeneratorRevision,
    }));
    const pending = result.current.spawnPending({ assetId: "output" });
    expect(addNode).not.toHaveBeenCalled();
    accept({ generatorId: "native", generatorRevisionId: "accepted" });
    const output = await pending;
    expect(output?.data.generatorRevision).toEqual({ generatorId: "native", generatorRevisionId: "accepted" });
    expect(output?.data).not.toHaveProperty("prompt");
    expect(output?.data).not.toHaveProperty("modelParams");
  });

  it("uses an upgraded Custom Action binding when the next output is created", async () => {
    const oldBinding = {
      pluginId: "clash.codex-imagegen",
      version: "0.1.0",
      exportId: "generate-image",
      schemaHash: `sha256:${"a".repeat(64)}` as const,
    };
    const currentBinding = {
      ...oldBinding,
      version: "0.1.1",
      schemaHash: `sha256:${"b".repeat(64)}` as const,
    };
    const customDef = CustomActionDefinitionSchema.parse({
      id: "codex-imagegen",
      name: "Codex ImageGen",
      outputType: "image",
      presentation: { type: "form" },
      parameters: [],
      runtime: "local",
      version: currentBinding.version,
      pluginBinding: currentBinding,
    });
    const customActionParams = {};
    const modelParams = {};
    const refNodeIds: string[] = [];
    const getNodes = () => [
      {
        id: "action-1",
        type: "action-badge",
        position: { x: 0, y: 0 },
        data: {},
      },
    ];
    const addNodeWithAutoLayout = (node: any) => ({
      ...node,
      position: { x: 340, y: 0 },
    });
    const addNodeWithLayout = (node: any, position: any) => ({
      ...node,
      position,
    });
    const input = {
      actionBadgeId: "action-1",
      actionType: "custom:codex-imagegen",
      isCustom: true,
      customDef,
      customActionParams,
      modelId: "",
      modelParams,
      selectedModel: undefined,
      content: "A cat",
      lyrics: "",
      dataPrompt: undefined,
      projectId: "project-1",
      refNodeIds,
      getNodes,
      addNodeWithAutoLayout,
      addNodeWithLayout,
      addEdges: vi.fn(),
      setNodes: vi.fn(),
      loroSync: null,
    };
    const { result, rerender } = renderHook(
      ({ pluginBinding }) =>
        useSpawnPendingAsset({ ...input, pluginBinding }),
      { initialProps: { pluginBinding: oldBinding } },
    );

    rerender({ pluginBinding: currentBinding });
    const output = await result.current.spawnPending({ assetId: "output-1" });

    expect(output?.data.pluginBinding).toEqual(currentBinding);
  });
});
