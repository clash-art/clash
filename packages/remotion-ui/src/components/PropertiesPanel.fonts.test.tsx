// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EditorProvider,
  type EditorState,
  type TextItem,
} from "@clash/remotion-core";
import { PropertiesPanel } from "./PropertiesPanel";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Text inspector discovery", () => {
  it("shows and edits an authored custom font and numeric weight without dropping them", async () => {
    vi.stubGlobal(
      "queryLocalFonts",
      vi
        .fn()
        .mockResolvedValue([
          { family: "Smiley Sans" },
          { family: "PingFang SC" },
        ]),
    );
    let latest: EditorState | undefined;
    const item: TextItem = {
      id: "title",
      type: "text",
      text: "向智矾",
      color: "#ffffff",
      from: 120,
      durationInFrames: 90,
      fontFamily: "Smiley Sans",
      fontWeight: 650,
    };
    render(
      <EditorProvider
        initialState={{
          tracks: [{ id: "text", name: "Text", items: [item] }],
          selectedItemId: item.id,
          currentFrame: 130,
        }}
        onStateChange={(state) => {
          latest = state;
        }}
      >
        <PropertiesPanel />
      </EditorProvider>,
    );
    const font = screen.getByRole("button", { name: "Text font family" });
    expect(font.textContent).toContain("Smiley Sans");
    expect(
      screen.getByRole("combobox", { name: "Text font weight" }).textContent,
    ).toContain("650");
    expect(screen.getAllByRole("heading", { level: 3 })[0].textContent).toBe(
      "Text",
    );
    fireEvent.click(font);
    fireEvent.click(await screen.findByRole("option", { name: "PingFang SC" }));
    expect((latest!.tracks[0].items[0] as TextItem).fontFamily).toBe(
      "PingFang SC",
    );
    expect((latest!.tracks[0].items[0] as TextItem).fontWeight).toBe(650);
    const add = screen.getByRole("button", {
      name: "Add Position keyframe at current frame",
    });
    expect(add.textContent).toMatch(/Add keyframe/);
    fireEvent.click(add);
    expect(latest!.tracks[0].items[0].keyframes?.position?.[0].frame).toBe(10);
    expect(
      screen.getByRole("button", {
        name: "Remove Position keyframe at current frame",
      }).textContent,
    ).toMatch(/Remove keyframe/);
  });
});
