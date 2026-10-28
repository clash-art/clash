// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  applyHtmlMotionElementPatch,
  listHtmlMotionEditableElements,
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
});
