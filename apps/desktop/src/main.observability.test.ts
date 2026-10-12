import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  sourceContains,
  sourceMatches,
} from "../../../packages/gui/test-support/source-match.js";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("desktop main observability wiring", () => {
  it("persists bounded desktop logs in Electron's configured logs directory", () => {
    expect(sourceContains(source, "createDesktopFileLogSink")).toBe(true);
    expect(
      sourceMatches(
        source,
        /createDesktopFileLogSink\(\{[\s\S]*?directory:\s*app\.getPath\("logs"\)[\s\S]*?maxBytes:[\s\S]*?retention:/,
      ),
    ).toBe(true);
    expect(
      sourceMatches(
        source,
        /createDesktopLogger\([\s\S]*?\{\s*fileSink,?\s*\}/,
      ),
    ).toBe(true);
    expect(
      sourceMatches(
        source,
        /app\.on\("will-quit",\s*\(\)\s*=>\s*desktopLog\.close\(\)\)/,
      ),
    ).toBe(true);
  });
});
