import { describe, expect, it } from "vitest";
import { createUnavailableHostRoutes } from "./host-unavailable";

describe("Cloudflare adapter: unavailable Project Host capabilities", () => {
  it("answers text revision routes with 501 COMMAND_UNAVAILABLE, never 404", async () => {
    const app = createUnavailableHostRoutes();
    for (const [method, path] of [
      ["GET", "/projects/p1/text-revisions?nodeId=n&limit=5"],
      ["GET", "/projects/p1/text-revisions/r1/content"],
      ["POST", "/text-revisions"],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status, path).toBe(501);
      expect(await response.json()).toMatchObject({
        code: "COMMAND_UNAVAILABLE",
        capability: "text-revisions",
      });
    }
  });
});
