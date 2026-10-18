import { describe, expect, it } from "vitest";
import { parseCodedCloseReason } from "./useLoroSync";

describe("parseCodedCloseReason", () => {
  it("reads the server's coded revocation reason", () => {
    expect(
      parseCodedCloseReason(
        "PROJECT_AUTHORIZATION_REVOKED: Your session expired or your access to this project was revoked.",
      ),
    ).toEqual({
      code: "PROJECT_AUTHORIZATION_REVOKED",
      message: "Your session expired or your access to this project was revoked.",
    });
  });

  it("returns null for an empty or uncoded reason, so the client keeps its fallback text", () => {
    expect(parseCodedCloseReason("")).toBeNull();
    expect(parseCodedCloseReason(undefined)).toBeNull();
    expect(parseCodedCloseReason("Project authorization expired or revoked")).toBeNull();
  });
});
