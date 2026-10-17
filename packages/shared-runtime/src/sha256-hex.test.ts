import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "./sha256-hex";

describe("sha256Hex", () => {
  it("matches node:crypto for ASCII, Unicode and empty input", () => {
    for (const text of [
      "",
      "abc",
      "Timeline 时间线 🎬",
      JSON.stringify({ a: [1, 2] }),
    ])
      expect(sha256Hex(text)).toBe(
        createHash("sha256").update(text).digest("hex"),
      );
  });
});
