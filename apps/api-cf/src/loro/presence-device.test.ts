import { describe, expect, it } from "vitest";
import { presenceDevice } from "./presence-device";

describe("presence device", () => {
  it.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Chrome · macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      "Edge · Windows",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      "Safari · iOS",
    ],
    ["", "Browser"],
  ])("derives a short browser label from %s", (ua, expected) => {
    expect(
      presenceDevice(
        new Headers({ "user-agent": ua, "x-device-name": "spoof" }),
        "browser",
      ),
    ).toBe(expected);
  });
  it("uses a declared Host device without treating it as identity", () => {
    expect(
      presenceDevice(
        new Headers({ "x-device-name": "Clash Host · studio" }),
        "cli",
      ),
    ).toBe("Clash Host · studio");
    expect(presenceDevice(new Headers(), "cli")).toBe("Clash CLI");
    expect(
      presenceDevice(new Headers({ "x-device-name": "x".repeat(200) }), "cli")
        .length,
    ).toBeLessThanOrEqual(80);
  });
});
