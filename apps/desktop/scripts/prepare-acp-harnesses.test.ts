import { describe, expect, it } from "vitest";

import {
  BUILTIN_ACP_WRAPPERS,
  prepareAcpHarnesses,
} from "./prepare-acp-harnesses.ts";

describe("prepare-acp-harnesses", () => {
  it("documents dev/E2E wrapper command names", () => {
    expect(BUILTIN_ACP_WRAPPERS).toEqual(["codex-acp", "claude-agent-acp"]);
  });

  it("exports prepareAcpHarnesses", () => {
    expect(typeof prepareAcpHarnesses).toBe("function");
  });
});
