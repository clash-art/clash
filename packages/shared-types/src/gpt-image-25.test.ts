import { describe, expect, it } from "vitest";
import { MODEL_CARDS } from "./models.js";
import { validateModelCardConfiguration } from "./model-constraints.js";

describe("GPT Image 2.5 catalog", () => {
  // developers.openai.com/api/docs/guides/image-generation (2026-09-10).
  it.each(["flare", "sunburst"])(
    "allows %s max quality and transparent output",
    (variant) => {
      const card = MODEL_CARDS.find(
        (card) => card.id === `gpt-image-2.5-${variant}`,
      );
      expect(card).toBeDefined();
      expect(
        validateModelCardConfiguration(card!, {
          modelParams: {
            quality: "max",
            background: "transparent",
            output_format: "webp",
            resolution: "3840x2160",
            aspect_ratio: "16:9",
          },
        }),
      ).toBeNull();
    },
  );
});

import { resolveGptImageSize } from "./gpt-image-size.js";
it("preserves a concrete resolution instead of converting it to a K tier", () => {
  expect(resolveGptImageSize({ resolution: "3840x2160" }, "16:9")).toEqual({
    width: 3840,
    height: 2160,
  });
});
it("rejects a concrete resolution that would reframe the requested ratio", () => {
  expect(() => resolveGptImageSize({ resolution: "3840x2160" }, "1:1")).toThrow(
    /ratio/i,
  );
});
