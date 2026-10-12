import { describe, expect, it } from "vitest";
import { publicErrorMessage, sourceTag } from "./observability.js";

// Signed asset URL shape from apps/api-cf/src/services/asset-signing.ts:
// `/assets/<storageKey>?exp=<unix>&sig=<base64url>`.
const signed = "https://clash.example/assets/u1/a.mp3?exp=1791800000&sig=c2lnbmF0dXJl";

describe("sourceTag", () => {
  it("keeps origin and path but drops the signature query", () => {
    const tag = sourceTag(signed);
    expect(tag).toBe("https://clash.example/assets/u1/a.mp3");
    expect(tag).not.toContain("sig=");
  });

  it("does not echo unparseable input", () => {
    expect(sourceTag("not a url ?sig=abc")).not.toContain("sig=");
  });
});

describe("publicErrorMessage", () => {
  it("strips signed URL queries echoed in ffmpeg stderr", () => {
    const message = publicErrorMessage(
      new Error(`ffmpeg exited 1: ${signed}: Connection refused`),
    );
    expect(message).toContain("https://clash.example/assets/u1/a.mp3");
    expect(message).not.toContain("sig=");
    expect(message).not.toContain("exp=");
  });

  it("redacts bearer and Clash API tokens", () => {
    const token = `clsh_${"a".repeat(40)}`;
    const message = publicErrorMessage(`Bearer abc.def failed with ${token}`);
    expect(message).not.toContain("abc.def");
    expect(message).not.toContain(token);
  });

  it("accepts non-Error throws", () => {
    expect(publicErrorMessage(42)).toBe("42");
  });
});
