import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sourceContains } from "../test-support/source-match";

describe("PresenceBar primitives", () => {
  it("composes shared avatars, badges and keyboard-focusable tooltips", () => {
    const source = readFileSync(
      "packages/web-ui/src/components/PresenceBar.tsx",
      "utf8",
    );
    const avatar = readFileSync(
      "packages/web-ui/src/components/PresenceAvatar.tsx",
      "utf8",
    );
    for (const token of [
      "./ui/tooltip",
      "./ui/avatar",
      "<PresenceSessions",
      "<PresenceAvatar",
      "tabIndex={0}",
    ]) {
      expect(sourceContains(source, token)).toBe(true);
    }
    for (const token of [
      "./ui/avatar",
      "./ui/badge",
      "<AvatarRoot",
      "<AvatarImage",
      "<AvatarFallback",
    ]) {
      expect(sourceContains(avatar, token)).toBe(true);
    }
    for (const token of [
      "@ariakit/react",
      "TooltipProvider",
      "TooltipAnchor",
      "<img",
      'role="tooltip"',
    ]) {
      expect(sourceContains(source, token)).toBe(false);
    }
  });
});
