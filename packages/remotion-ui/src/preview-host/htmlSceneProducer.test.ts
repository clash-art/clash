// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compositionIsHtmlOnly,
  createHtmlSceneProducer,
  extractHtmlScenesFromComposition,
} from "./htmlSceneProducer";
import { HTML_SCENE_SANDBOX } from "@clash/remotion-components/html-scene";

describe("extractHtmlScenesFromComposition", () => {
  it("resolves live HTML from allNodes via sourceNodeId", () => {
    const scenes = extractHtmlScenesFromComposition({
      width: 1280,
      height: 720,
      fps: 30,
      durationInFrames: 90,
      tracks: [
        {
          id: "t1",
          items: [
            {
              id: "html-1",
              type: "composition",
              runtime: "html",
              compositionKind: "motion-graphics",
              sourceNodeId: "node-a",
              from: 0,
              durationInFrames: 90,
            },
          ],
        },
      ],
      allNodes: {
        "node-a": {
          type: "html-motion",
          data: { content: "<html><body>Hello MG</body></html>" },
        },
      },
    });
    expect(scenes).toHaveLength(1);
    expect(scenes[0]?.source).toContain("Hello MG");
    expect(scenes[0]?.sourceNodeId).toBe("node-a");
  });

  it("ignores remotion composition items", () => {
    const scenes = extractHtmlScenesFromComposition({
      width: 100,
      height: 100,
      fps: 30,
      durationInFrames: 30,
      tracks: [
        {
          id: "t1",
          items: [
            {
              id: "r1",
              type: "composition",
              runtime: "remotion",
              sourceNodeId: "n1",
              from: 0,
              durationInFrames: 30,
            },
          ],
        },
      ],
      allNodes: {
        n1: { type: "remotion-component", data: { content: "export default () => null" } },
      },
    });
    expect(scenes).toEqual([]);
  });
});

describe("compositionIsHtmlOnly", () => {
  it("is true when every item is runtime html", () => {
    expect(
      compositionIsHtmlOnly({
        width: 100,
        height: 100,
        fps: 30,
        durationInFrames: 30,
        tracks: [
          {
            id: "t",
            items: [
              {
                id: "h",
                type: "composition",
                runtime: "html",
                sourceNodeId: "n",
                from: 0,
                durationInFrames: 30,
              },
            ],
          },
        ],
        allNodes: {
          n: { type: "html-motion", data: { content: "<html></html>" } },
        },
      }),
    ).toBe(true);
  });

  it("is false when a solid or remotion item is present", () => {
    expect(
      compositionIsHtmlOnly({
        width: 100,
        height: 100,
        fps: 30,
        durationInFrames: 30,
        tracks: [
          {
            id: "t",
            items: [
              {
                id: "h",
                type: "composition",
                runtime: "html",
                sourceNodeId: "n",
                from: 0,
                durationInFrames: 30,
              },
              { id: "s", type: "solid", from: 0, durationInFrames: 30, color: "#000" },
            ],
          },
        ],
        allNodes: {
          n: { type: "html-motion", data: { content: "<html></html>" } },
        },
      }),
    ).toBe(false);
  });
});

describe("createHtmlSceneProducer", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("mounts sandboxed iframes and seeks without Remotion Player", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const frames: number[] = [];
    const producer = createHtmlSceneProducer({
      mountElement: mount,
      reporter: {
        reportFrame: (f) => frames.push(f),
        reportTransport: vi.fn(),
        reportError: vi.fn(),
      },
    });

    producer.prepare({
      width: 640,
      height: 360,
      fps: 30,
      durationInFrames: 60,
      tracks: [
        {
          id: "t",
          items: [
            {
              id: "h1",
              type: "composition",
              runtime: "html",
              sourceNodeId: "node-1",
              from: 0,
              durationInFrames: 60,
            },
          ],
        },
      ],
      allNodes: {
        "node-1": {
          type: "html-motion",
          data: {
            content:
              "<!doctype html><html><body><h1>HTML Scene</h1></body></html>",
          },
        },
      },
    });

    const iframe = mount.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("sandbox")).toBe(HTML_SCENE_SANDBOX);
    expect(iframe?.dataset.htmlSceneSourceNodeId).toBe("node-1");
    expect(producer.kind).toBe("html-scene");

    producer.seek(12);
    expect(frames.at(-1)).toBe(12);

    producer.dispose();
    expect(mount.querySelector("iframe")).toBeNull();
  });
});
