// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  applyHtmlMotionElementPatch,
  deriveHtmlMotionContent,
  listHtmlMotionEditableElements,
  listHtmlMotionEditableElementsWithOverrides,
  mergeElementOverride,
  normalizeElementOverrides,
  resolveHtmlMotionNodeContent,
  seedElementOverridesFromHtml,
  serializeElementOverrides,
} from "./htmlMotionElementEdit";

const SAMPLE = `<!doctype html>
<html><body>
  <h1 data-mg-id="title" data-mg-editable="text,position" data-mg-x="10" data-mg-y="20" style="transform: translate(10px, 20px);">Hello</h1>
  <p data-mg-id="bad">no editable</p>
  <span data-mg-id="dup" data-mg-editable="text">a</span>
  <span data-mg-id="dup" data-mg-editable="text">b</span>
</body></html>`;

describe("htmlMotionElementEdit", () => {
  it("lists unique admitted text/position editables", () => {
    const list = listHtmlMotionEditableElements(SAMPLE);
    expect(list.map((e) => e.id)).toEqual(["title"]);
    expect(list[0]?.text).toBe("Hello");
    expect(list[0]?.x).toBe(10);
    expect(list[0]?.y).toBe(20);
    expect(list[0]?.editable).toEqual(["text", "position"]);
  });

  it("applies text and position patches into the HTML source", () => {
    const next = applyHtmlMotionElementPatch(SAMPLE, "title", {
      text: "Edited",
      x: 40,
      y: -5,
    });
    const listed = listHtmlMotionEditableElements(next);
    expect(listed[0]?.text).toBe("Edited");
    expect(listed[0]?.x).toBe(40);
    expect(listed[0]?.y).toBe(-5);
    expect(next).toContain("Edited");
    expect(next).toContain('data-mg-x="40"');
    expect(next).toContain("translate(40px, -5px)");
  });

  it("rejects patches for non-editable capabilities", () => {
    const textOnly = `<p data-mg-id="line" data-mg-editable="text">Hi</p>`;
    expect(() =>
      applyHtmlMotionElementPatch(textOnly, "line", { x: 1 }),
    ).toThrow(/HTML_MOTION_ELEMENT_NOT_EDITABLE/);
  });

  it("normalizes override maps and merges absolute patches", () => {
    expect(normalizeElementOverrides(null)).toEqual({});
    expect(
      normalizeElementOverrides({
        title: { text: "A", x: 1, y: 2 },
        "bad id": { text: "nope" },
        empty: {},
        __proto__: { text: "no" },
      }),
    ).toEqual({ title: { text: "A", x: 1, y: 2 } });

    const merged = mergeElementOverride(
      { title: { text: "Hello", x: 10 } },
      "title",
      { y: 5, text: "Hi" },
    );
    expect(merged).toEqual({ title: { text: "Hi", x: 10, y: 5 } });
  });

  it("derives HTML from base + override map (idempotent re-apply)", () => {
    const derived = deriveHtmlMotionContent(SAMPLE, {
      title: { text: "Edited", x: 40, y: -5 },
    });
    const listed = listHtmlMotionEditableElements(derived);
    expect(listed[0]?.text).toBe("Edited");
    expect(listed[0]?.x).toBe(40);
    expect(listed[0]?.y).toBe(-5);

    const again = deriveHtmlMotionContent(derived, {
      title: { text: "Edited", x: 40, y: -5 },
    });
    expect(listHtmlMotionEditableElements(again)[0]?.text).toBe("Edited");
    expect(listHtmlMotionEditableElements(again)[0]?.x).toBe(40);
  });

  it("lists with overrides without mutating base HTML parse for missing keys", () => {
    const listed = listHtmlMotionEditableElementsWithOverrides(SAMPLE, {
      title: { text: "Draft" },
    });
    expect(listed[0]?.text).toBe("Draft");
    expect(listed[0]?.x).toBe(10);
    expect(listHtmlMotionEditableElements(SAMPLE)[0]?.text).toBe("Hello");
  });

  it("seeds overrides from HTML for migrate / first-edit path", () => {
    const seeded = seedElementOverridesFromHtml(SAMPLE, {}, ["title"]);
    expect(seeded).toEqual({
      title: { text: "Hello", x: 10, y: 20 },
    });
    const keep = seedElementOverridesFromHtml(
      SAMPLE,
      { title: { text: "Keep" } },
      ["title"],
    );
    expect(keep).toEqual({ title: { text: "Keep" } });
  });

  it("resolves node content via content + elementOverrides", () => {
    const html = resolveHtmlMotionNodeContent(
      {
        content: SAMPLE,
        elementOverrides: { title: { text: "From map", x: 3 } },
      },
      "",
    );
    expect(html).toContain("From map");
    expect(html).toContain('data-mg-x="3"');
    expect(
      resolveHtmlMotionNodeContent({ content: SAMPLE }, "").includes("Hello"),
    ).toBe(true);
  });

  it("serializes overrides stably for draft equality", () => {
    expect(
      serializeElementOverrides({ b: { text: "2" }, a: { x: 1, y: 2 } }),
    ).toBe(serializeElementOverrides({ a: { y: 2, x: 1 }, b: { text: "2" } }));
  });
});
