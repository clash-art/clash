import { describe, expect, it } from "vitest";
import { supportsMessagePointFork } from "./fork-support.js";

describe("supportsMessagePointFork", () => {
  it("follows the runtime session/fork advertisement and no harness identity", () => {
    expect(supportsMessagePointFork(true)).toBe(true);
    expect(supportsMessagePointFork(false)).toBe(false);
  });
});
