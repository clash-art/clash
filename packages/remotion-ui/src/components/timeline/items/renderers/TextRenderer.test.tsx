// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TextItem } from "@clash/remotion-core";
import { TextRenderer } from "./TextRenderer";

afterEach(cleanup);

function textItem(fontSize: number): TextItem {
  return Object.freeze({
    id: "title",
    type: "text",
    text: "向智矾 · 四年级7班 · 大队委竞选",
    color: "#ffffff",
    from: 120,
    durationInFrames: 90,
    fontSize,
  });
}

describe("Timeline text clip labels", () => {
  it("keeps editor text readable independently of composition font size and clip zoom", () => {
    const largeTitle = textItem(144);
    const { container, rerender } = render(
      <TextRenderer
        item={textItem(18)}
        asset={null}
        width={320}
        height={36}
        pixelsPerFrame={2}
      />,
    );
    const initialFontSize = getComputedStyle(
      container.firstElementChild!,
    ).fontSize;
    rerender(
      <TextRenderer
        item={largeTitle}
        asset={null}
        width={80}
        height={36}
        pixelsPerFrame={0.5}
      />,
    );
    expect(getComputedStyle(container.firstElementChild!).fontSize).toBe(
      initialFontSize,
    );
    expect(Number.parseFloat(initialFontSize)).toBeLessThan(36);
    expect(largeTitle.fontSize).toBe(144);
    expect(screen.getByTitle(largeTitle.text)).toBeTruthy();
  });

  it("contains a shrinkable ellipsis label inside the supplied clip dimensions", () => {
    const item = textItem(144);
    const { container } = render(
      <TextRenderer
        item={item}
        asset={null}
        width={30}
        height={36}
        pixelsPerFrame={0.2}
      />,
    );
    const clip = container.firstElementChild as HTMLElement;
    const label = screen.getByText(item.text);
    expect(clip.style.boxSizing).toBe("border-box");
    expect(clip.style.width).toBe("30px");
    expect(clip.style.height).toBe("36px");
    expect(label.parentElement).toBe(clip);
    expect(Number.parseFloat(label.style.minWidth)).toBe(0);
    expect(label.style.overflow).toBe("hidden");
    expect(label.style.whiteSpace).toBe("nowrap");
    expect(label.style.textOverflow).toBe("ellipsis");
    expect(clip.title).toBe(item.text);
  });
});
