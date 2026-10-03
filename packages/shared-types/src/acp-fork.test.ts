import { describe, expect, it } from "vitest";
import {
  ACP_SESSION_FORK_UNSUPPORTED,
  describeAcpForkFailure,
  OPENMA_SESSION_FORK_UNSUPPORTED,
} from "./acp-fork";

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
