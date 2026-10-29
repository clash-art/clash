import { describe, expect, it } from "vitest";

import {
  MG_ELEMENT_OVERRIDES_PROP,
  buildRemotionMgComponentProps,
  listRemotionEditableElements,
  listRemotionEditableElementsWithOverrides,
  resolveRemotionMgComponentProps,
  seedElementOverridesFromRemotionSource,
} from "./remotionElementEdit";

const SAMPLE = `
import React from "react";
import { AbsoluteFill } from "remotion";

export default function Component(props: {
  mgElementOverrides?: Record<string, { text?: string; x?: number; y?: number }>;
}) {
  const title = props.mgElementOverrides?.title;
  const text = title?.text ?? "Hello";
  const x = title?.x ?? 10;
  const y = title?.y ?? 20;
  return (
    <AbsoluteFill>
      <div
        data-mg-id="title"
        data-mg-editable="text,position"
        data-mg-default-x={10}
        data-mg-default-y={20}
        data-mg-default-text="Hello"
        data-mg-x={x}
        data-mg-y={y}
        style={{ transform: \`translate(\${x}px, \${y}px)\` }}
      >
        {text}
      </div>
      <p data-mg-id="bad">no editable</p>
      <span data-mg-id="dup" data-mg-editable="text">a</span>
      <span data-mg-id="dup" data-mg-editable="text">b</span>
    </AbsoluteFill>
  );
}
`;

describe("remotionElementEdit", () => {
  it("lists unique admitted text/position editables from TSX markers", () => {
    const list = listRemotionEditableElements(SAMPLE);
    expect(list.map((e) => e.id)).toEqual(["title"]);
    expect(list[0]?.text).toBe("Hello");
    expect(list[0]?.x).toBe(10);
    expect(list[0]?.y).toBe(20);
    expect(list[0]?.editable).toEqual(["text", "position"]);
  });

  it("applies override map onto listed elements for inspector draft view", () => {
    const listed = listRemotionEditableElementsWithOverrides(SAMPLE, {
      title: { text: "From map", x: 3 },
    });
    expect(listed[0]?.text).toBe("From map");
    expect(listed[0]?.x).toBe(3);
    expect(listed[0]?.y).toBe(20);
  });

  it("seeds missing overrides from TSX defaults", () => {
    const seeded = seedElementOverridesFromRemotionSource(SAMPLE, {}, ["title"]);
    expect(seeded.title).toEqual({ text: "Hello", x: 10, y: 20 });
    const keep = seedElementOverridesFromRemotionSource(
      SAMPLE,
      { title: { text: "Keep" } },
      ["title"],
    );
    expect(keep.title).toEqual({ text: "Keep" });
  });

  it("builds componentProps under mgElementOverrides", () => {
    const props = buildRemotionMgComponentProps({
      title: { text: "Hi", x: 1 },
    });
    expect(props[MG_ELEMENT_OVERRIDES_PROP]).toEqual({
      title: { text: "Hi", x: 1 },
    });
  });

  it("resolves node data.elementOverrides into componentProps", () => {
    const props = resolveRemotionMgComponentProps({
      content: SAMPLE,
      elementOverrides: { title: { text: "Node", y: 9 } },
    });
    expect(props[MG_ELEMENT_OVERRIDES_PROP]).toEqual({
      title: { text: "Node", y: 9 },
    });
  });

  it("parses string-literal data-mg-x/y when present", () => {
    const src = `<div data-mg-id="label" data-mg-editable="position" data-mg-x="5" data-mg-y="-2">Hi</div>`;
    const list = listRemotionEditableElements(src);
    expect(list[0]).toMatchObject({ id: "label", x: 5, y: -2, text: "Hi" });
  });
});
