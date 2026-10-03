import { describe, expect, it } from "vitest";
import {
  ACP_SESSION_FORK_UNSUPPORTED,
  describeAcpForkFailure,
  OPENMA_SESSION_FORK_UNSUPPORTED,
  supportsAcpMessageFork,
} from "./acp-fork";

describe("supportsAcpMessageFork", () => {
  it("accepts only the checked inclusive-fork adapter versions", () => {
    expect(supportsAcpMessageFork("codex-acp", "1.10.0")).toBe(true);
    expect(supportsAcpMessageFork("@agentclientprotocol/codex-acp", "1.10.1")).toBe(
      true,
    );
    expect(supportsAcpMessageFork("codex-acp", "1.9.9")).toBe(false);
    expect(supportsAcpMessageFork("claude-acp", "0.75.1")).toBe(true);
    expect(
      supportsAcpMessageFork("@agentclientprotocol/claude-agent-acp", "0.47.0"),
    ).toBe(false);
    expect(supportsAcpMessageFork("dsh-acp", "9.9.9")).toBe(false);
    expect(supportsAcpMessageFork(undefined, "1.10.0")).toBe(false);
  });
});

describe("describeAcpForkFailure", () => {
  it("explains an unadvertised session/fork in place of the runtime error", () => {
    expect(describeAcpForkFailure(OPENMA_SESSION_FORK_UNSUPPORTED, true)).toBe(
      ACP_SESSION_FORK_UNSUPPORTED,
    );
  });

  it("leaves the runtime error unchanged when the caller did not request a fork", () => {
    expect(describeAcpForkFailure(OPENMA_SESSION_FORK_UNSUPPORTED, false)).toBe(
      OPENMA_SESSION_FORK_UNSUPPORTED,
    );
  });

  it("passes other session errors through", () => {
    expect(describeAcpForkFailure("transport failed", true)).toBe(
      "transport failed",
    );
  });
});
