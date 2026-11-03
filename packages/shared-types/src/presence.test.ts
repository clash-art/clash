import { describe, expect, it } from "vitest";

import { isSidebandMessage } from "./presence";

describe("isSidebandMessage project.remote-state", () => {
  const remoteState = (code: string) => ({
    type: "project.remote-state",
    projectId: "project-1",
    state: "unavailable",
    code,
  });

  it("accepts a stopped link's not-admitted code so clients can show it", () => {
    expect(isSidebandMessage(remoteState("CLOUD_LINK_NOT_ADMITTED"))).toBe(true);
  });

  it("accepts a full Host store code so clients can show why bytes stopped downloading", () => {
    expect(isSidebandMessage(remoteState("LOCAL_STORE_DISK_FULL"))).toBe(true);
  });

  it("rejects a code outside the contract", () => {
    expect(isSidebandMessage(remoteState("CLOUD_LINK_INVENTED"))).toBe(false);
  });
});
