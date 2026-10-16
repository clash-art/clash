import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Codex copilot preview primitives", () => {
  it("routes composer controls through shared button primitives", () => {
    const source = readFileSync(new URL("./__codex-copilot-preview.tsx", import.meta.url), "utf8");

    expect(source).toContain("@clash/gui/components/ui/button");
    expect(source).toContain("<Button");
    expect(source).not.toContain("<button");
  });
});
