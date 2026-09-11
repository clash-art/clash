import { describe, expect, it } from "vitest";

import { visibleUserPromptText } from "./prompt-content.js";

describe("visibleUserPromptText", () => {
  it("hides a replayed host context prefix while preserving the authored message", () => {
    const prefix = "[Clash host context — supplied by the application, not written by the user]\nSession binding: {\"projectId\":\"private-project\"}\n[/Clash host context]";
    expect(visibleUserPromptText(`${prefix}\n用户原文`)).toBe("用户原文");
    expect(visibleUserPromptText(prefix)).toBe("");
    expect(visibleUserPromptText(`Explain this quoted block:\n${prefix}`))
      .toBe(`Explain this quoted block:\n${prefix}`);
  });

  it("keeps the authored prompt while removing internal protocol comments", () => {
    expect(visibleUserPromptText([
      '<!-- clash-workspace-context {"version":1} -->',
      '<!-- clash-agent-annotations {"version":1,"annotations":[]} -->',
      "Run pwd with your shell tool.",
    ].join("\n"))).toBe("Run pwd with your shell tool.");
  });
});
