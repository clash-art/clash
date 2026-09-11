// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { ResolvedAsset } from "@clash/shared-types";
import { invalidateAsset } from "../../lib/hooks/useAsset";
import { useProjectAssetHydration } from "./useProjectAssetHydration";

const pending: ResolvedAsset = {
  id: "hydration-1",
  kind: "image",
  name: "Scene",
  metadata: { originalName: "scene.png" },
  lifecycle: { state: "active" },
  status: "unavailable",
};
const node: Node = {
  id: "node-1",
  type: "image",
  position: { x: 0, y: 0 },
  data: { status: "completed", assetId: pending.id },
};
const response = (asset: unknown) =>
  new Response(JSON.stringify(asset), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-clash-read-receipt": "fixture",
    },
  });
type Inputs = {
  projectId: string;
  doc: LoroDoc | null;
  nodes: Node[];
  projectAssets: ResolvedAsset[];
};
function setup(overrides: Partial<Inputs> = {}) {
  const initialProps: Inputs = {
    projectId: "hydration-project",
    doc: null,
    nodes: [node],
    projectAssets: [pending],
    ...overrides,
  };
  const view = renderHook(
    (input: Inputs) => {
      const [assets, setAssets] = useState<ResolvedAsset[]>([]);
      useProjectAssetHydration({ ...input, onAssetsChange: setAssets });
      return assets;
    },
    { initialProps },
  );
  return { ...view, initialProps };
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const project of ["hydration-project", "other-project"]) {
    for (const id of [pending.id, "hydration-2"]) invalidateAsset(project, id);
  }
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("project asset hydration while editing the canvas", () => {
  it("keeps an active availability poll across geometry updates and publishes the ready projection", async () => {
    let current = pending;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => response(current));
    const view = setup();
    await advance(1);
    const initialRequests = fetch.mock.calls.length;
    expect(initialRequests).toBe(1);
    for (let x = 1; x <= 30; x++) {
      view.rerender({
        ...view.initialProps,
        nodes: [{ ...node, position: { x, y: 0 } }],
      });
      await advance(1);
    }
    expect(fetch.mock.calls.length - initialRequests).toBe(0);
    current = {
      ...pending,
      name: undefined,
      metadata: { width: 1280 },
      status: "ready",
      url: "https://media.clash.test/ready-image.png",
    };
    await advance(2_000);
    expect(view.result.current[0]).toMatchObject({
      status: "ready",
      url: "https://media.clash.test/ready-image.png",
      name: "Scene",
      metadata: { originalName: "scene.png", width: 1280 },
    });
    const requestsAtReady = fetch.mock.calls.length;
    await advance(5_000);
    expect(fetch.mock.calls.length).toBe(requestsAtReady);
  });

  it("starts a newly discovered target without restarting another target's poll", async () => {
    const second = { ...pending, id: "hydration-2" };
    const requestedIds: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/batch")) {
        const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };
        requestedIds.push(...ids);
        return response({
          assets: ids.map((id) => (id === second.id ? second : pending)),
        });
      }
      requestedIds.push(url.split("/").at(-1)!);
      return response(url.endsWith(second.id) ? second : pending);
    });
    const view = setup();
    await advance(1);
    const firstReads = () =>
      requestedIds.filter((id) => id === pending.id).length;
    const before = firstReads();
    view.rerender({ ...view.initialProps, projectAssets: [pending, second] });
    await advance(1);
    expect(firstReads()).toBe(before);
    expect(requestedIds).toContain(second.id);
  });

  it("uses updated fallback metadata without interrupting the poll", async () => {
    let current = pending;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => response(current));
    const view = setup();
    await advance(1);
    view.rerender({
      ...view.initialProps,
      projectAssets: [
        {
          ...pending,
          name: "Renamed scene",
          metadata: { originalName: "renamed.png" },
        },
      ],
    });
    await advance(1);
    expect(fetch).toHaveBeenCalledOnce();
    current = {
      ...pending,
      name: undefined,
      metadata: {},
      status: "ready",
      url: "https://media.clash.test/ready.png",
    };
    await advance(2_000);
    expect(view.result.current[0]).toMatchObject({
      name: "Renamed scene",
      metadata: { originalName: "renamed.png" },
    });
  });

  it("discovers another canvas's completed output and stops when its reference is removed", async () => {
    const doc = new LoroDoc();
    doc
      .getMap("nodes")
      .set("elsewhere", { canvasId: "other", type: "image", data: node.data });
    doc.commit();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => response(pending));
    const view = setup({ doc, nodes: [], projectAssets: [] });
    await advance(1);
    expect(fetch).toHaveBeenCalledOnce();
    doc.getMap("nodes").delete("elsewhere");
    doc.commit();
    view.rerender({ ...view.initialProps, nodes: [] });
    const before = fetch.mock.calls.length;
    await advance(5_000);
    expect(fetch.mock.calls.length).toBe(before);
  });

  it("ignores a previous project's late response and cleans up polling on unmount", async () => {
    let finishOld!: (value: Response) => void;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        if (String(input).includes("/other-project/"))
          return response({
            ...pending,
            status: "ready",
            url: "https://media.clash.test/other-project.png",
          });
        return new Promise<Response>((resolve) => {
          finishOld = resolve;
        });
      });
    const view = setup();
    await advance(1);
    view.rerender({ ...view.initialProps, projectId: "other-project" });
    await advance(1);
    expect(view.result.current[0]?.url).toBe(
      "https://media.clash.test/other-project.png",
    );
    await act(async () => {
      finishOld(
        response({
          ...pending,
          status: "ready",
          url: "https://media.clash.test/old-project.png",
        }),
      );
    });
    expect(view.result.current[0]?.url).toBe(
      "https://media.clash.test/other-project.png",
    );
    view.unmount();
    const before = fetch.mock.calls.length;
    await advance(5_000);
    expect(fetch.mock.calls.length).toBe(before);
  });

  it("retries a failed read on the next input change and stops pending polling when unmounted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi
      .spyOn(globalThis, "fetch")
      // A network failure is retried by the SDK before this hook is notified.
      // A terminal HTTP rejection exercises the hook's own retry lifecycle.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "rejected" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockImplementation(async () => response(pending));
    const view = setup();
    await advance(1);
    expect(fetch).toHaveBeenCalledOnce();
    view.rerender({
      ...view.initialProps,
      nodes: [{ ...node, position: { x: 10, y: 0 } }],
    });
    await advance(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    view.unmount();
    await advance(5_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
