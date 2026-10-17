import { describe, expect, it } from "vitest";
import { preflightBrowserTimelineRender } from "./preflight";

const browser = { isWebKit: false, hasWebCodecs: true };

describe("preflightBrowserTimelineRender", () => {
  it("accepts an expressible short Timeline and computes its duration", () => {
    const result = preflightBrowserTimelineRender({
      browser,
      maxDurationSeconds: 600,
      state: {
        compositionWidth: 1280,
        compositionHeight: 720,
        fps: 30,
        tracks: [
          {
            items: [
              { id: "a", type: "text", from: 15, durationInFrames: 45 },
              {
                id: "b",
                type: "image",
                assetId: "asset-1",
                from: 0,
                durationInFrames: 30,
                mask: { shape: "ellipse" },
              },
            ],
          },
        ],
      },
    });
    expect(result).toEqual({
      ok: true,
      tracks: expect.any(Array),
      width: 1280,
      height: 720,
      fps: 30,
      durationInFrames: 60,
    });
  });

  it.each([
    [
      "no-items",
      { tracks: [] },
      browser,
      600,
      "no-items",
    ],
    [
      "duration-cap",
      { fps: 30, tracks: [{ items: [{ from: 0, durationInFrames: 900 }] }] },
      browser,
      10,
      "duration-cap",
    ],
    [
      "inline-remotion",
      {
        tracks: [
          {
            items: [
              { id: "tsx", runtime: "remotion", from: 0, durationInFrames: 1 },
            ],
          },
        ],
      },
      browser,
      600,
      "inline-remotion",
    ],
    [
      "safari-filters",
      {
        tracks: [
          {
            items: [
              {
                id: "filtered",
                from: 0,
                durationInFrames: 1,
                effects: [{ effectId: "clash/warm-film", effectVersion: 1 }],
              },
            ],
          },
        ],
      },
      { ...browser, isWebKit: true },
      600,
      "safari-filters",
    ],
    [
      "no WebCodecs",
      {
        tracks: [{ items: [{ from: 0, durationInFrames: 1 }] }],
      },
      { ...browser, hasWebCodecs: false },
      600,
      "webcodecs-unavailable",
    ],
    [
      "unexpressible mask",
      {
        tracks: [
          {
            items: [
              {
                id: "masked",
                from: 0,
                durationInFrames: 1,
                mask: { shape: "path" },
              },
            ],
          },
        ],
      },
      browser,
      600,
      "unexpressible-mask",
    ],
  ] as const)("falls back for %s", (_label, state, support, cap, reason) => {
    expect(
      preflightBrowserTimelineRender({
        state,
        browser: support,
        maxDurationSeconds: cap,
      }),
    ).toMatchObject({ ok: false, reason });
  });
});
