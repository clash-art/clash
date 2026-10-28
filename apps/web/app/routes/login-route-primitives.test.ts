import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceMatches } from "@clash/gui/test-support/source-match";

describe("login route primitives", () => {
  it("routes form controls through shared input and button primitives", () => {
    const source = readFileSync(new URL("./login.tsx", import.meta.url), "utf8");

    expect(source).toContain("@clash/gui/components/ui/button");
    expect(source).toContain("@clash/gui/components/ui/input");
    expect(source).toContain("@clash/gui/components/ui/feedback");
    expect(source).toContain("<Button");
    expect(source).toContain("<Input");
    expect(source).toContain("<InlineAlert");
    expect(source).not.toContain("<input");
    expect(source).not.toContain("<button");
    expect(source).not.toContain("<motion.button");
  });

  it("lets the shared input token own readable placeholder contrast", () => {
    const source = readFileSync(new URL("./login.tsx", import.meta.url), "utf8");

    expect(
      sourceMatches(source, /placeholder:text-(?:stone|neutral)-/),
    ).toBe(false);
  });

  it("wires Better Auth error query codes through oauthErrorMessage", () => {
    const source = readFileSync(new URL("./login.tsx", import.meta.url), "utf8");
    expect(source).toContain('from "../lib/auth/oauth-error-message"');
    expect(source).toContain("oauthErrorMessage");
    expect(source).toContain('params.get("error")');
  });
});
