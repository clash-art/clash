import { describe, it, expect } from "vitest";
import { LoroDoc } from "loro-crdt";
import { Canvas, type StoryboardViewState } from "@clash/shared-types";
import { saveStoryboardViewState } from "./storyboardViewState";

describe("Storyboard View persistence adapter", () => {
  it("stores edits in node data and retains them when the project snapshot is reopened", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {});
    const state: StoryboardViewState = {
      keyElements: [],
      shots: [],
      audioLayers: [],
      uncategorized: [],
    };
    canvas.createNode("storyboard", "plugin-view", {
      state,
      label: "Storyboard",
    });
    const edited = {
      ...state,
      keyElements: [
        { id: "host", label: "主持人", description: [], materials: [] },
      ],
    };
    expect(
      saveStoryboardViewState(
        (id, patch) => canvas.updateNodeRecord(id, patch),
        "storyboard",
        edited,
      ),
    ).toBe(true);
    const reopened = new LoroDoc();
    reopened.import(doc.export({ mode: "snapshot" }));
    expect(
      new Canvas(reopened, () => {}).readNode("storyboard")?.data.state,
    ).toEqual(edited);
  });
});

it("omits unset optional fields instead of persisting Loro nulls that hide the View", () => {
  const doc = new LoroDoc();
  const canvas = new Canvas(doc, () => {});
  const empty: StoryboardViewState = {
    keyElements: [],
    shots: [],
    audioLayers: [],
    uncategorized: [],
  };
  canvas.createNode("storyboard", "plugin-view", { state: empty });
  saveStoryboardViewState(
    (id, patch) => canvas.updateNodeRecord(id, patch),
    "storyboard",
    {
      ...empty,
      shots: [
        {
          id: "shot",
          label: "Opening",
          description: [],
          materials: [],
          details: undefined,
          durationSeconds: undefined,
        },
      ],
    },
  );
  const reopened = new LoroDoc();
  reopened.import(doc.export({ mode: "snapshot" }));
  const state = new Canvas(reopened, () => {}).readNode("storyboard")?.data
    .state as StoryboardViewState;
  expect(state.shots[0]).not.toHaveProperty("details");
  expect(state.shots[0]).not.toHaveProperty("durationSeconds");
});
