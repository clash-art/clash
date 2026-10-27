import { describe, it, expect } from "vitest";
import {
  timelineDslToYaml,
  timelineDslFromYaml,
  timelineDslHash,
  parseFromExpression,
  resolveFromExpression,
} from "./timeline-yaml.js";

describe("parseFromExpression", () => {
  it("parses raw numbers", () => {
    expect(parseFromExpression(30)).toEqual({ kind: "absolute", value: 30 });
    expect(parseFromExpression(0)).toEqual({ kind: "absolute", value: 0 });
  });

  it("parses numeric strings", () => {
    expect(parseFromExpression("30")).toEqual({ kind: "absolute", value: 30 });
    expect(parseFromExpression("30.5")).toEqual({ kind: "absolute", value: 30.5 });
  });

  it("treats `start` as 0", () => {
    expect(parseFromExpression("start")).toEqual({ kind: "absolute", value: 0 });
  });

  it("parses bare references with zero offset", () => {
    expect(parseFromExpression("clip-A")).toEqual({ kind: "reference", refId: "clip-A", offset: 0 });
    expect(parseFromExpression("prev")).toEqual({ kind: "reference", refId: "prev", offset: 0 });
  });

  it("parses references with positive and negative offsets", () => {
    expect(parseFromExpression("clip-A+30")).toEqual({ kind: "reference", refId: "clip-A", offset: 30 });
    expect(parseFromExpression("clip-A-15")).toEqual({ kind: "reference", refId: "clip-A", offset: -15 });
    expect(parseFromExpression("prev + 5")).toEqual({ kind: "reference", refId: "prev", offset: 5 });
  });

  it("returns null on garbage", () => {
    expect(parseFromExpression("")).toBeNull();
    expect(parseFromExpression(null)).toBeNull();
    expect(parseFromExpression(undefined)).toBeNull();
    expect(parseFromExpression({})).toBeNull();
  });
});

describe("timelineDslFromYaml — relative reference resolution", () => {
  it("resolves `prev` chain on a single track", () => {
    const yaml = `
tracks:
  - id: video
    name: Main
    items:
      - id: clip-A
        type: video
        from: 0
        durationInFrames: 150
      - id: clip-B
        type: video
        from: prev
        durationInFrames: 90
      - id: clip-C
        type: video
        from: prev-30
        durationInFrames: 60
`;
    const result = timelineDslFromYaml(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const items = result.dsl.tracks[0].items;
    expect(items[0].from).toBe(0);
    expect(items[1].from).toBe(150); // 0 + 150
    expect(items[1].fromExpr).toBe("prev");
    expect(items[2].from).toBe(210); // 150 + 90 - 30
    expect(items[2].fromExpr).toBe("prev-30");
  });

  it("resolves explicit id references", () => {
    const yaml = `
tracks:
  - id: video
    items:
      - id: a
        type: video
        from: 100
        durationInFrames: 60
      - id: b
        type: video
        from: a+0
        durationInFrames: 30
      - id: c
        type: video
        from: a-15
        durationInFrames: 30
`;
    const r = timelineDslFromYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const items = r.dsl.tracks[0].items;
    expect(items[1].from).toBe(160); // 100 + 60 + 0
    expect(items[2].from).toBe(145); // 100 + 60 - 15
  });

  it("falls back to 0 on cycle and unknown refs", () => {
    const yaml = `
tracks:
  - id: t
    items:
      - id: a
        type: video
        from: b+0
        durationInFrames: 30
      - id: b
        type: video
        from: a+0
        durationInFrames: 30
      - id: c
        type: video
        from: missing+10
        durationInFrames: 30
`;
    const r = timelineDslFromYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Cycle a↔b: both should fall back to 0 (then resolve to 0 + 30 + 0 = 30
    // for whoever is resolved second). Either way both ≥ 0 and finite.
    for (const it of r.dsl.tracks[0].items) {
      expect(Number.isFinite(it.from)).toBe(true);
      expect(it.from).toBeGreaterThanOrEqual(0);
    }
  });

  it("treats `start` as zero", () => {
    const yaml = `
tracks:
  - id: t
    items:
      - id: a
        type: video
        from: start
        durationInFrames: 30
`;
    const r = timelineDslFromYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dsl.tracks[0].items[0].from).toBe(0);
  });

  it("rejects items missing required fields", () => {
    const yaml = `
tracks:
  - id: t
    items:
      - type: video
        from: 0
        durationInFrames: 30
`;
    const r = timelineDslFromYaml(yaml);
    expect(r.ok).toBe(false);
  });
});

describe("timelineDslToYaml round-trip", () => {
  it("preserves typed track categories for agent-authored timelines", () => {
    const yaml = timelineDslToYaml({
      primaryTrackId: "story",
      tracks: [
        { id: "titles", category: "text", items: [] },
        { id: "story", category: "primary", items: [] },
        { id: "music", category: "audio", items: [] },
      ],
    } as any);

    expect(yaml).toContain("category: text");
    expect(yaml).toContain("category: primary");
    expect(yaml).toContain("category: audio");
    const parsed = timelineDslFromYaml(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dsl.tracks.map((track) => (track as any).category)).toEqual([
      "text",
      "primary",
      "audio",
    ]);
  });

  it("rejects unknown track categories", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: mystery
    category: anything
    items: []
`);
    expect(parsed).toEqual({ ok: false, error: "Track mystery has invalid category" });
  });

  it("rejects items placed in an incompatible typed track", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: music
    category: audio
    items:
      - id: wrong-video
        type: video
        from: 0
        durationInFrames: 30
`);
    expect(parsed).toEqual({
      ok: false,
      error: "Track music category audio cannot contain video items",
    });
  });

  it("rejects typed tracks outside the canonical vertical order", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: titles
    category: text
    items: []
  - id: fx
    category: effect
    items: []
`);
    expect(parsed).toEqual({
      ok: false,
      error: "Track categories must follow effect, text, visual, primary, audio order",
    });
  });

  it("rejects an untyped legacy track that mixes structural item categories", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: legacy-mixed
    items:
      - id: video
        type: video
        from: 0
        durationInFrames: 30
      - id: title
        type: text
        from: 0
        durationInFrames: 30
`);
    expect(parsed).toEqual({
      ok: false,
      error: "Track legacy-mixed mixes incompatible item categories",
    });
  });

  it("preserves the main storyline id for agent-authored timelines", () => {
    const yaml = timelineDslToYaml({
      primaryTrackId: "dialogue",
      tracks: [
        { id: "overlay", items: [] },
        { id: "dialogue", role: "primary-video", items: [] },
      ],
    } as any);

    expect(yaml).toContain("primaryTrackId: dialogue");
    const parsed = timelineDslFromYaml(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.dsl as any).primaryTrackId).toBe("dialogue");
  });

  it("rejects a main storyline id that does not reference a track", () => {
    const parsed = timelineDslFromYaml(`
primaryTrackId: missing
tracks:
  - id: dialogue
    items: []
`);

    expect(parsed).toEqual({
      ok: false,
      error: "primaryTrackId must reference an existing track",
    });
  });

  it("rejects a primary id that points at a non-primary typed lane", () => {
    const parsed = timelineDslFromYaml(`
primaryTrackId: music
tracks:
  - id: music
    category: audio
    items: []
`);
    expect(parsed).toEqual({
      ok: false,
      error: "primaryTrackId must reference the primary track category",
    });
  });

  it("preserves fromExpr through a round trip", () => {
    const dsl = {
      compositionWidth: 1920,
      compositionHeight: 1080,
      fps: 30,
      durationInFrames: 300,
      tracks: [
        {
          id: "video",
          name: "Main",
          items: [
            { id: "a", type: "video", from: 0, durationInFrames: 150 },
            { id: "b", type: "video", from: 150, durationInFrames: 90, fromExpr: "prev" },
            { id: "c", type: "video", from: 210, durationInFrames: 60, fromExpr: "prev-30" },
          ],
        },
      ],
    };
    const yaml = timelineDslToYaml(dsl);
    expect(yaml).toContain("from: prev");
    expect(yaml).toContain("from: prev-30");
    expect(yaml).not.toContain("fromExpr"); // collapsed into `from`
    const parsed = timelineDslFromYaml(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dsl.tracks[0].items.map((i) => i.from)).toEqual([0, 150, 210]);
    expect(parsed.dsl.tracks[0].items[1].fromExpr).toBe("prev");
    expect(parsed.dsl.tracks[0].items[2].fromExpr).toBe("prev-30");
  });

  it("emits items with stable key order (id, type, from, durationInFrames first)", () => {
    const yaml = timelineDslToYaml({
      tracks: [
        {
          id: "t",
          items: [
            // Author with deliberately scrambled key order:
            { durationInFrames: 50, id: "x", from: 0, type: "video", volume: 0.5 },
          ],
        },
      ],
    });
    // The first occurrence of each key in the output should match the
    // canonical ordering. Use indexOf as a cheap structural check.
    const idAt = yaml.indexOf("id: x");
    const typeAt = yaml.indexOf("type: video");
    const fromAt = yaml.indexOf("from: 0");
    const durAt = yaml.indexOf("durationInFrames: 50");
    expect(idAt).toBeGreaterThanOrEqual(0);
    expect(idAt).toBeLessThan(typeAt);
    expect(typeAt).toBeLessThan(fromAt);
    expect(fromAt).toBeLessThan(durAt);
  });

  it("preserves track role for semantic timeline projections", () => {
    const yaml = timelineDslToYaml({
      tracks: [
        {
          id: "subtitles",
          name: "Subtitles",
          role: "subtitle",
          items: [
            {
              id: "captions-main",
              type: "text",
              text: "大家好",
              color: "#ffffff",
              from: 0,
              durationInFrames: 45,
              cues: [
                {
                  id: "cue-1",
                  startFrame: 0,
                  durationInFrames: 45,
                  text: "大家好",
                  wordIds: ["w1"],
                  sourceStartFrame: 0,
                  sourceEndFrame: 45,
                },
              ],
              wordRefs: [{ id: "w1", text: "大家好", sourceStartFrame: 0, sourceEndFrame: 45 }],
              sourceToOutputMap: [{ sourceStartFrame: 0, sourceEndFrame: 45, outputStartFrame: 0, outputEndFrame: 45 }],
            },
          ],
        },
      ],
    });

    expect(yaml).toContain("role: subtitle");
    const parsed = timelineDslFromYaml(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dsl.tracks[0].role).toBe("subtitle");
  });

  it("rejects the removed caption item taxonomy", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: subtitles
    role: subtitle
    items:
      - id: caption-main
        type: caption
        from: 0
        durationInFrames: 60
        text: hello
`);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/subtitle.*structured text.*caption/i);
  });

  it("rejects plain text clips on subtitle tracks", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: subtitles
    role: subtitle
    items:
      - id: text-subtitle
        type: text
        from: 0
        durationInFrames: 60
        text: hello
        color: "#ffffff"
`);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/subtitle text item.*cues.*wordRefs.*sourceToOutputMap/i);
  });

  it("rejects derived overlay items without copy-on-write lineage", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: overlays
    role: overlay
    items:
      - id: caption-burn-overlay
        type: derived-overlay
        from: 0
        durationInFrames: 120
        mediaType: video
        src: assets/video/caption-burn.mp4
`);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/derived overlay.*sourceAssetId.*derivedAssetId.*derivation/i);
  });

  it("rejects legacy HTML MG authoring without a live Canvas source node", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: overlays
    role: overlay
    items:
      - id: legacy-mg
        type: composition
        from: 0
        durationInFrames: 120
        compositionKind: motion-graphics
        runtime: html
        compositionId: lower-third
        sourcePath: compositions/lower-third/index.html
        spec:
          id: lower-third
          width: 1080
          height: 1920
          fps: 30
          durationInFrames: 120
          layers: []
`);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/HTML.*sourceNodeId/i);
  });

  it("rejects motion-graphics items with a non-live runtime", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: overlays
    role: overlay
    items:
      - id: react-mg
        type: composition
        from: 0
        durationInFrames: 90
        compositionKind: motion-graphics
        runtime: react
        compositionId: react-mg
        sourcePath: compositions/react-mg.tsx
        sourceNodeId: canvas-node
        renderedAssetPath: compositions/react-mg.mp4
`);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/motion-graphics.*Remotion or HTML.*sourceNodeId/i);
  });

  it("accepts a live HTML motion-graphics reference with a Canvas source node", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: overlays
    role: overlay
    items:
      - id: html-mg
        type: composition
        from: 0
        durationInFrames: 120
        compositionKind: motion-graphics
        runtime: html
        compositionId: lower-third
        sourcePath: compositions/lower-third/index.html
        sourceNodeId: html-mg-node
`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dsl.tracks[0]?.items[0]).toMatchObject({
      type: "composition",
      compositionKind: "motion-graphics",
      runtime: "html",
      sourceNodeId: "html-mg-node",
    });
  });

  it("rejects Remotion composition items without a live Canvas source node", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: overlays
    role: overlay
    items:
      - id: react-chart
        type: composition
        from: 0
        durationInFrames: 90
        compositionKind: custom
        runtime: remotion
        compositionId: react-chart
        sourcePath: compositions/react-chart/Composition.tsx
`);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/sourceNodeId/i);
  });

  it("accepts a live Remotion component reference without a pre-rendered asset", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: overlays
    role: overlay
    items:
      - id: react-chart
        type: composition
        from: 0
        durationInFrames: 90
        compositionKind: custom
        runtime: remotion
        compositionId: react-chart
        sourcePath: compositions/react-chart/Composition.tsx
        sourceNodeId: remotion-component-node
`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dsl.tracks[0]?.items[0]).toMatchObject({
      type: "composition",
      runtime: "remotion",
      sourceNodeId: "remotion-component-node",
    });
  });
});

describe("timelineDslHash", () => {
  it("treats omitted rendering defaults as explicit defaults", async () => {
    const minimal = { tracks: [], fps: 30, durationInFrames: 60 };
    const explicitDefaults = {
      ...minimal,
      compositionWidth: 1920,
      compositionHeight: 1080,
    };

    expect(await timelineDslHash(minimal)).toBe(await timelineDslHash(explicitDefaults));
  });

  it("returns the same hash for semantically identical DSLs (key order, fromExpr)", async () => {
    const a = {
      tracks: [{ id: "t", items: [{ id: "a", type: "video", from: 30, durationInFrames: 60 }] }],
      fps: 30,
    };
    const b = {
      // Different JS key order; should not affect hash.
      fps: 30,
      tracks: [{ items: [{ durationInFrames: 60, type: "video", from: 30, id: "a" }], id: "t" }],
    };
    const c = {
      // fromExpr added — semantic from is identical, hash should match.
      tracks: [{ id: "t", items: [{ id: "a", type: "video", from: 30, durationInFrames: 60, fromExpr: "30" }] }],
      fps: 30,
    };
    const d = {
      tracks: [{ id: "t", items: [{ id: "a", type: "video", from: 30, durationInFrames: 60, src: undefined }] }],
      fps: 30,
    };
    const ha = await timelineDslHash(a);
    const hb = await timelineDslHash(b);
    const hc = await timelineDslHash(c);
    const hd = await timelineDslHash(d);
    expect(ha).toBe(hb);
    expect(ha).toBe(hc);
    expect(ha).toBe(hd);
  });

  it("returns a different hash when `from` actually changes", async () => {
    const a = { tracks: [{ id: "t", items: [{ id: "a", type: "video", from: 30, durationInFrames: 60 }] }] };
    const b = { tracks: [{ id: "t", items: [{ id: "a", type: "video", from: 31, durationInFrames: 60 }] }] };
    expect(await timelineDslHash(a)).not.toBe(await timelineDslHash(b));
  });

  it("hash is sensitive to item order (reordering = different hash)", async () => {
    const a = {
      tracks: [
        {
          id: "t",
          items: [
            { id: "a", type: "video", from: 0, durationInFrames: 60 },
            { id: "b", type: "video", from: 60, durationInFrames: 60 },
          ],
        },
      ],
    };
    const b = {
      tracks: [
        {
          id: "t",
          items: [
            { id: "b", type: "video", from: 60, durationInFrames: 60 },
            { id: "a", type: "video", from: 0, durationInFrames: 60 },
          ],
        },
      ],
    };
    expect(await timelineDslHash(a)).not.toBe(await timelineDslHash(b));
  });

  it("hash is sensitive to track-level field changes (locked, name)", async () => {
    const a = { tracks: [{ id: "t", name: "A", items: [] }] };
    const b = { tracks: [{ id: "t", name: "B", items: [] }] };
    expect(await timelineDslHash(a)).not.toBe(await timelineDslHash(b));
  });
});

describe("cross-track references", () => {
  it("resolves an expression that targets an item on a different track", () => {
    const yaml = `
tracks:
  - id: video
    items:
      - id: shot-A
        type: video
        from: 0
        durationInFrames: 150
  - id: captions
    items:
      - id: caption-A
        type: text
        from: shot-A-30
        durationInFrames: 60
`;
    const r = timelineDslFromYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const caption = r.dsl.tracks[1].items[0];
    expect(caption.from).toBe(120); // 0 + 150 - 30
    expect(caption.fromExpr).toBe("shot-A-30");
  });

  it("`prev` is scoped per-track — does not look across tracks", () => {
    const yaml = `
tracks:
  - id: a
    items:
      - id: a1
        type: video
        from: 100
        durationInFrames: 50
  - id: b
    items:
      - id: b1
        type: video
        from: prev
        durationInFrames: 30
`;
    const r = timelineDslFromYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // b1 has no prev in its own track — falls back to absolute 0 + offset(0) = 0
    expect(r.dsl.tracks[1].items[0].from).toBe(0);
  });
});

describe("YAML edge cases", () => {
  it("handles empty tracks array", () => {
    const r = timelineDslFromYaml("tracks: []\n");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dsl.tracks).toEqual([]);
  });

  it("handles tracks with no items field", () => {
    const r = timelineDslFromYaml("tracks:\n  - id: empty\n    name: nothing\n");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dsl.tracks[0].items).toEqual([]);
  });

  it("rejects when root is not an object", () => {
    expect(timelineDslFromYaml("[1,2,3]").ok).toBe(false);
    expect(timelineDslFromYaml("just a string").ok).toBe(false);
    expect(timelineDslFromYaml("").ok).toBe(false);
  });

  it("rejects malformed YAML with a parse error", () => {
    const r = timelineDslFromYaml("tracks:\n  - { broken");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("YAML parse error");
  });

  it("rejects when `tracks` is missing", () => {
    const r = timelineDslFromYaml("fps: 30\ndurationInFrames: 100\n");
    expect(r.ok).toBe(false);
  });

  it("preserves track-level fields (name, locked, hidden) through round-trip", () => {
    const dsl = {
      tracks: [
        {
          id: "v",
          name: "Main video",
          locked: true,
          hidden: false, // false is dropped on serialize (no point in writing it)
          items: [{ id: "a", type: "video", from: 0, durationInFrames: 60 }],
        },
      ],
    };
    const yaml = timelineDslToYaml(dsl);
    const r = timelineDslFromYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.dsl.tracks[0];
    expect(t.name).toBe("Main video");
    expect(t.locked).toBe(true);
    expect(t.hidden).toBe(false);
  });

  it("preserves arbitrary item fields (volume, sourceStartInFrames, etc.) through round-trip", () => {
    const dsl = {
      tracks: [
        {
          id: "v",
          items: [
            {
              id: "a",
              type: "video",
              from: 0,
              durationInFrames: 60,
              sourceStartInFrames: 30,
              volume: 0.5,
              audioGainDb: 8.6,
              audioFadeInFrames: 12,
              audioFadeOutFrames: 18,
              videoFadeIn: 10,
              videoFadeOutColor: "white",
              entranceAnimation: {
                type: "zoom-in",
                durationInFrames: 14,
              },
              exitAnimation: {
                type: "fade",
                durationInFrames: 9,
              },
            },
          ],
        },
      ],
    };
    const yaml = timelineDslToYaml(dsl);
    const r = timelineDslFromYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.dsl.tracks[0].items[0] as Record<string, unknown>;
    expect(item.sourceStartInFrames).toBe(30);
    expect(item.volume).toBe(0.5);
    expect(item.audioGainDb).toBe(8.6);
    expect(item.audioFadeInFrames).toBe(12);
    expect(item.audioFadeOutFrames).toBe(18);
    expect(item.videoFadeIn).toBe(10);
    expect(item.videoFadeOutColor).toBe("white");
    expect(item.entranceAnimation).toEqual({
      type: "zoom-in",
      durationInFrames: 14,
    });
    expect(item.exitAnimation).toEqual({
      type: "fade",
      durationInFrames: 9,
    });
  });

  it("rejects malformed entrance and exit animation fields", () => {
    const r = timelineDslFromYaml(`
tracks:
  - id: video
    category: visual
    items:
      - id: clip
        type: video
        from: 0
        durationInFrames: 60
        entranceAnimation:
          type: spin-forever
          durationInFrames: 12
`);

    expect(r).toEqual({
      ok: false,
      error: "Timeline item clip entranceAnimation.type is unsupported",
    });
  });

  it("rejects audioGainDb outside the editor audio range", () => {
    const r = timelineDslFromYaml(`
tracks:
  - id: audio
    category: audio
    items:
      - id: voice
        type: audio
        from: 0
        durationInFrames: 60
        audioGainDb: 12.1
`);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/audioGainDb.*-60.*12/i);
  });

  it("rejects malformed audio ducking settings", () => {
    const r = timelineDslFromYaml(`
tracks:
  - id: music
    role: music
    category: audio
    items:
      - id: bed
        type: audio
        from: 0
        durationInFrames: 60
        audioDucking:
          amountDb: 1
          attackFrames: 6
          releaseFrames: 12
`);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/audioDucking\.amountDb.*-60.*0/i);
  });

  it("round-trips valid ducking settings on a music item", () => {
    const r = timelineDslFromYaml(`
tracks:
  - id: music
    role: music
    category: audio
    items:
      - id: bed
        type: audio
        src: music.wav
        from: 0
        durationInFrames: 120
        audioDucking:
          amountDb: -18
          attackFrames: 6
          releaseFrames: 12
`);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dsl.tracks[0]?.items[0]?.audioDucking).toEqual({
      amountDb: -18,
      attackFrames: 6,
      releaseFrames: 12,
    });
  });

  it("when `from` is a numeric YAML value it stays numeric and clears any stale fromExpr", () => {
    const dsl = {
      tracks: [
        {
          id: "t",
          items: [
            { id: "a", type: "video", from: 100, durationInFrames: 60, fromExpr: "prev+10" /* stale */ },
          ],
        },
      ],
    };
    // Round-trip: when serializing, fromExpr wins; on parse it's preserved
    // because it parses as a non-numeric reference. So the only way to
    // CLEAR a stale fromExpr is to write a numeric `from` directly.
    const yaml = "tracks:\n  - id: t\n    items:\n      - id: a\n        type: video\n        from: 100\n        durationInFrames: 60\n";
    const r = timelineDslFromYaml(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dsl.tracks[0].items[0].from).toBe(100);
    expect(r.dsl.tracks[0].items[0].fromExpr).toBeUndefined();
    void dsl;
  });
});

describe("timeline item keyframes", () => {
  it("round-trips valid item-local transform channels", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: overlays
    category: visual
    items:
      - id: title-card
        type: image
        from: 30
        durationInFrames: 60
        keyframes:
          position:
            - frame: 0
              value: [0, 0]
              interpolation: linear
            - frame: 59
              value: [120, 80]
              interpolation: hold
          opacity:
            - frame: 0
              value: 0
              interpolation: linear
            - frame: 15
              value: 1
              interpolation: linear
`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const yaml = timelineDslToYaml(parsed.dsl);
    const roundTrip = timelineDslFromYaml(yaml);
    expect(roundTrip).toEqual(parsed);
  });

  it("rejects duplicate frames within one keyframe channel", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: overlays
    category: visual
    items:
      - id: title-card
        type: image
        from: 0
        durationInFrames: 60
        keyframes:
          position:
            - frame: 12
              value: [0, 0]
              interpolation: linear
            - frame: 12
              value: [120, 80]
              interpolation: hold
`);

    expect(parsed).toEqual({
      ok: false,
      error: "Timeline item title-card keyframes.position contains duplicate frame 12",
    });
  });

  it("rejects keyframes on audio items", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: music
    category: audio
    items:
      - id: bed
        type: audio
        from: 0
        durationInFrames: 60
        keyframes:
          opacity:
            - frame: 0
              value: 1
              interpolation: linear
`);

    expect(parsed).toEqual({
      ok: false,
      error: "Timeline item bed keyframes are only valid on visual transform items",
    });
  });

  it("validates keyframes on structured subtitle text items", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: subtitles
    role: subtitle
    items:
      - id: subtitle
        type: text
        text: hello
        from: 0
        durationInFrames: 30
        cues:
          - id: cue
            startFrame: 0
            durationInFrames: 30
            text: hello
            wordIds: [word]
            sourceStartFrame: 0
            sourceEndFrame: 30
        wordRefs:
          - id: word
            text: hello
            sourceStartFrame: 0
            sourceEndFrame: 30
        sourceToOutputMap:
          - sourceStartFrame: 0
            sourceEndFrame: 30
            outputStartFrame: 0
            outputEndFrame: 30
        keyframes:
          opacity:
            - frame: 30
              value: 0
              interpolation: linear
`);

    expect(parsed).toEqual({
      ok: false,
      error: "Timeline item subtitle keyframes.opacity frame must be an integer between 0 and 29",
    });
  });

  it("round-trips a clip mask with item-local mask keyframes", () => {
    const parsed = timelineDslFromYaml(`
tracks:
  - id: overlays
    category: visual
    items:
      - id: masked-clip
        type: video
        from: 30
        durationInFrames: 60
        mask:
          shape: ellipse
          position: [50, 50]
          size: [70, 70]
          rotation: 0
          feather: 12
          inverted: false
        keyframes:
          maskPosition:
            - frame: 0
              value: [25, 50]
              interpolation: linear
            - frame: 59
              value: [75, 50]
              interpolation: linear
          maskFeather:
            - frame: 0
              value: 0
              interpolation: linear
            - frame: 59
              value: 40
              interpolation: linear
`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(timelineDslFromYaml(timelineDslToYaml(parsed.dsl))).toEqual(parsed);
  });

  it("rejects invalid masks and orphaned mask keyframes", () => {
    const invalidMask = timelineDslFromYaml(`
tracks:
  - id: overlays
    category: visual
    items:
      - id: masked-clip
        type: image
        from: 0
        durationInFrames: 30
        mask:
          shape: triangle
          position: [50, 50]
          size: [70, 70]
          rotation: 0
          feather: 0
          inverted: false
`);
    expect(invalidMask).toEqual({
      ok: false,
      error: "Timeline item masked-clip mask.shape must be rectangle or ellipse",
    });

    const orphanedKeys = timelineDslFromYaml(`
tracks:
  - id: overlays
    category: visual
    items:
      - id: orphaned-mask-motion
        type: image
        from: 0
        durationInFrames: 30
        keyframes:
          maskPosition:
            - frame: 0
              value: [50, 50]
              interpolation: linear
`);
    expect(orphanedKeys).toEqual({
      ok: false,
      error: "Timeline item orphaned-mask-motion mask keyframes require a mask",
    });
  });

  it("rejects masks on audio and transition items", () => {
    const maskYaml = `
        mask:
          shape: rectangle
          position: [50, 50]
          size: [70, 70]
          rotation: 0
          feather: 0
          inverted: false`;
    expect(timelineDslFromYaml(`
tracks:
  - id: audio
    category: audio
    items:
      - id: bed
        type: audio
        from: 0
        durationInFrames: 30
${maskYaml}
`)).toEqual({
      ok: false,
      error: "Timeline item bed mask is only valid on visual items",
    });
    expect(timelineDslFromYaml(`
tracks:
  - id: effects
    category: effect
    items:
      - id: wipe
        type: transition
        from: 0
        durationInFrames: 15
        transitionType: wipe-left
        fromItemId: before
        toItemId: after
${maskYaml}
`)).toEqual({
      ok: false,
      error: "Timeline item wipe mask is only valid on visual items",
    });
  });
});

describe("resolveFromExpression direct API", () => {
  it("returns absolute value for `start`", () => {
    const expr = parseFromExpression("start")!;
    const out = resolveFromExpression(expr, { item: { id: "x", durationInFrames: 0 }, trackItems: [], trackIndex: 0 }, new Map());
    expect(out).toBe(0);
  });

  it("returns expr.offset when ref target is missing", () => {
    const expr = parseFromExpression("missing+42")!;
    const out = resolveFromExpression(
      expr,
      { item: { id: "self", durationInFrames: 0 }, trackItems: [], trackIndex: 0 },
      new Map(),
    );
    expect(out).toBe(42);
  });

  it("clamps to >= 0 even when offset would push it negative", () => {
    const expr = parseFromExpression("missing-100")!;
    const out = resolveFromExpression(
      expr,
      { item: { id: "self", durationInFrames: 0 }, trackItems: [], trackIndex: 0 },
      new Map(),
    );
    expect(out).toBe(0);
  });
});
