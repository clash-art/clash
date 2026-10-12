import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

import { readRemotionBrowserPin } from "@clash/shared-runtime/render-browser";
import { expect, it } from "vitest";

// TESTED_VERSION is read from an internal file of the pinned @remotion/renderer. This runs against
// the installed package so a Remotion upgrade that moves the file fails here, not at render time.
it("reads the Chrome version pinned by the installed Remotion renderer", () => {
  const pin = readRemotionBrowserPin(createRequire(import.meta.url));

  expect(pin.testedVersion).toMatch(/^\d+(\.\d+){3}$/);
  expect(isAbsolute(pin.rendererEntry)).toBe(true);
  expect(existsSync(pin.rendererEntry)).toBe(true);
});
