import { describe, it, expect } from "vitest";
import {
  editorReducer,
  editorInitialState,
  normalizeInitialState,
} from "./EditorContext";
import type { Track, VideoItem, EditorState, SubtitleTextItem } from "../types";

const makeTrack = (id: string, items: any[] = []): Track => ({
  id,
  name: id,
  items,
});

const makeVideo = (
  id: string,
  from: number,
  dur: number,
  sourceStart = 0,
): VideoItem => ({
  id,
  type: "video",
  src: `${id}.mp4`,
  from,
  durationInFrames: dur,
  sourceStartInFrames: sourceStart,
});

const seedState = (
  tracks: Track[],
  overrides: Partial<EditorState> = {},
): EditorState => ({
  ...editorInitialState,
  tracks,
  primaryTrackId: tracks[tracks.length - 1]?.id ?? null,
  ...overrides,
});

describe("main storyline invariant", () => {
  it("keeps an unlabeled primary lane present on an empty timeline", () => {
    const normalized = normalizeInitialState({
      tracks: [],
      primaryTrackId: null,
    });

    expect(normalized.primaryTrackId).toBe("primary");
    expect(normalized.tracks).toEqual([
      {
        id: "primary",
        name: "Media",
        role: "primary-video",
        category: "primary",
        items: [],
      },
    ]);
  });

  it("keeps the same primary lane after its final item is removed", () => {
    const story = {
      ...makeTrack("story", [makeVideo("clip", 0, 90)]),
      name: "Media",
      role: "primary-video" as const,
      category: "primary" as const,
    };
    const audio = { ...makeTrack("audio"), category: "audio" as const };
    const next = editorReducer(
      seedState([story, audio], { primaryTrackId: "story" }),
      { type: "REMOVE_ITEM", payload: { trackId: "story", itemId: "clip" } },
    );

    expect(next.primaryTrackId).toBe("story");
    expect(next.tracks.find((track) => track.id === "story")).toMatchObject({
      category: "primary",
      items: [],
    });
  });

  it("makes the first track primary and keeps later tracks above it", () => {
    const first = editorReducer(seedState([]), {
      type: "ADD_TRACK",
      payload: makeTrack("story"),
    });

    expect((first as any).primaryTrackId).toBe("story");
    expect(first.tracks.map((track) => track.id)).toEqual(["story"]);

    const withOverlay = editorReducer(first, {
      type: "ADD_TRACK",
      payload: makeTrack("overlay"),
    });

    expect((withOverlay as any).primaryTrackId).toBe("story");
    expect(withOverlay.tracks.map((track) => track.id)).toEqual([
      "overlay",
      "story",
    ]);
  });

  it("switches the primary track and moves it to the bottom", () => {
    const state = seedState([makeTrack("overlay"), makeTrack("story")]);
    const next = editorReducer(state, {
      type: "SET_PRIMARY_TRACK",
      payload: "overlay",
    } as any);

    expect((next as any).primaryTrackId).toBe("overlay");
    expect(next.tracks.map((track) => track.id)).toEqual(["story", "overlay"]);
  });

  it("does not let track reordering pull the primary track above overlays", () => {
    const story = makeTrack("story");
    const overlay = makeTrack("overlay");
    const state = seedState([overlay, story]);
    const next = editorReducer(state, {
      type: "REORDER_TRACKS",
      payload: [story, overlay],
    });

    expect((next as any).primaryTrackId).toBe("story");
    expect(next.tracks.map((track) => track.id)).toEqual(["overlay", "story"]);
  });

  it("promotes a remaining track when the primary track is removed", () => {
    const state = seedState([makeTrack("overlay"), makeTrack("story")]);
    const next = editorReducer(state, {
      type: "REMOVE_TRACK",
      payload: "story",
    });

    expect((next as any).primaryTrackId).toBe("overlay");
    expect(next.tracks.map((track) => track.id)).toEqual(["overlay"]);
  });

  it("replaces the primary lane immediately when it is the only track removed", () => {
    const state = seedState(
      [
        {
          ...makeTrack("story"),
          category: "primary",
          role: "primary-video",
        } as Track,
      ],
      { primaryTrackId: "story" },
    );
    const next = editorReducer(state, {
      type: "REMOVE_TRACK",
      payload: "story",
    });

    expect(next.primaryTrackId).toBe("primary");
    expect(next.tracks).toEqual([
      {
        id: "primary",
        name: "Media",
        role: "primary-video",
        category: "primary",
        items: [],
      },
    ]);
  });

  it("migrates a legacy timeline and prefers an explicit primary-video role", async () => {
    const context = (await import("./EditorContext")) as Record<string, any>;
    expect(typeof context.normalizeInitialState).toBe("function");

    const normalized = context.normalizeInitialState({
      tracks: [
        { ...makeTrack("story"), role: "primary-video" },
        makeTrack("overlay"),
      ],
    }) as EditorState;

    expect((normalized as any).primaryTrackId).toBe("story");
    expect(normalized.tracks.map((track) => track.id)).toEqual([
      "overlay",
      "story",
    ]);
  });

  it("keeps typed track groups contiguous around the primary track", async () => {
    const context = (await import("./EditorContext")) as Record<string, any>;
    const normalized = context.normalizeInitialState({
      primaryTrackId: "story",
      tracks: [
        { ...makeTrack("audio"), category: "audio" },
        { ...makeTrack("visual"), category: "visual" },
        { ...makeTrack("story"), category: "primary" },
        { ...makeTrack("text"), category: "text" },
        { ...makeTrack("effect"), category: "effect" },
        { ...makeTrack("text-2"), category: "text" },
      ],
    }) as EditorState;

    expect(normalized.tracks.map((track) => track.id)).toEqual([
      "effect",
      "text",
      "text-2",
      "visual",
      "story",
      "audio",
    ]);
    expect(normalized.tracks.map((track) => (track as any).category)).toEqual([
      "effect",
      "text",
      "text",
      "visual",
      "primary",
      "audio",
    ]);
  });
});

describe("subtitle text sticker normalization", () => {
  it("normalizes a legacy continuous caption item into editable sentence stickers", () => {
    const normalized = normalizeInitialState({
      tracks: [
        {
          id: "text",
          name: "Text",
          role: "subtitle",
          category: "text",
          items: [
            {
              id: "captions",
              type: "text",
              text: "First sentence.\nSecond sentence.",
              color: "#ffffff",
              from: 0,
              durationInFrames: 90,
              cues: [
                {
                  id: "cue-1",
                  startFrame: 6,
                  durationInFrames: 24,
                  text: "First sentence.",
                  wordIds: ["word-1"],
                  sourceStartFrame: 6,
                  sourceEndFrame: 30,
                },
                {
                  id: "cue-2",
                  startFrame: 45,
                  durationInFrames: 30,
                  text: "Second sentence.",
                  wordIds: ["word-2"],
                  sourceStartFrame: 45,
                  sourceEndFrame: 75,
                },
              ],
              wordRefs: [
                {
                  id: "word-1",
                  text: "First sentence.",
                  sourceStartFrame: 6,
                  sourceEndFrame: 30,
                },
                {
                  id: "word-2",
                  text: "Second sentence.",
                  sourceStartFrame: 45,
                  sourceEndFrame: 75,
                },
              ],
              sourceToOutputMap: [
                {
                  sourceStartFrame: 6,
                  sourceEndFrame: 30,
                  outputStartFrame: 6,
                  outputEndFrame: 30,
                },
                {
                  sourceStartFrame: 6,
                  sourceEndFrame: 30,
                  outputStartFrame: 6,
                  outputEndFrame: 30,
                },
                {
                  sourceStartFrame: 45,
                  sourceEndFrame: 75,
                  outputStartFrame: 45,
                  outputEndFrame: 75,
                },
              ],
            },
          ],
        },
      ],
      primaryTrackId: null,
    });

    const stickers = normalized.tracks.find(
      (track) => track.id === "text",
    )?.items;
    expect(stickers).toHaveLength(2);
    expect(stickers).toMatchObject([
      {
        id: "captions",
        type: "text",
        text: "First sentence.",
        from: 6,
        durationInFrames: 24,
        cues: [
          { startFrame: 0, durationInFrames: 24, text: "First sentence." },
        ],
        wordRefs: [{ id: "word-1" }],
      },
      {
        id: "captions:cue:cue-2",
        type: "text",
        text: "Second sentence.",
        from: 45,
        durationInFrames: 30,
        cues: [
          { startFrame: 0, durationInFrames: 30, text: "Second sentence." },
        ],
        wordRefs: [{ id: "word-2" }],
      },
    ]);
    expect(
      stickers?.map((item) =>
        item.type === "text" ? item.sourceToOutputMap : undefined,
      ),
    ).toEqual([
      [
        {
          sourceStartFrame: 6,
          sourceEndFrame: 30,
          outputStartFrame: 0,
          outputEndFrame: 24,
        },
      ],
      [
        {
          sourceStartFrame: 45,
          sourceEndFrame: 75,
          outputStartFrame: 0,
          outputEndFrame: 30,
        },
      ],
    ]);
  });

  it("keeps sticker duration, cue duration, and edited text synchronized", () => {
    const state = normalizeInitialState({
      tracks: [
        {
          id: "text",
          name: "Text",
          role: "subtitle",
          category: "text",
          items: [
            {
              id: "sentence",
              type: "text",
              text: "Before",
              color: "#ffffff",
              from: 20,
              durationInFrames: 30,
              cues: [
                {
                  id: "cue",
                  startFrame: 0,
                  durationInFrames: 30,
                  text: "Before",
                  wordIds: ["word"],
                  sourceStartFrame: 0,
                  sourceEndFrame: 30,
                },
              ],
              wordRefs: [
                {
                  id: "word",
                  text: "Before",
                  sourceStartFrame: 0,
                  sourceEndFrame: 30,
                },
              ],
              sourceToOutputMap: [
                {
                  sourceStartFrame: 0,
                  sourceEndFrame: 30,
                  outputStartFrame: 0,
                  outputEndFrame: 30,
                },
              ],
            },
          ],
        },
      ],
    });

    const resized = editorReducer(state, {
      type: "UPDATE_ITEM",
      payload: {
        trackId: "text",
        itemId: "sentence",
        updates: { durationInFrames: 42, text: "After" },
      },
    });
    const sticker = resized.tracks.find((track) => track.id === "text")
      ?.items[0] as any;

    expect(sticker).toMatchObject({
      text: "After",
      durationInFrames: 42,
      cues: [{ startFrame: 0, durationInFrames: 42, text: "After" }],
      sourceToOutputMap: [{ outputStartFrame: 0, outputEndFrame: 42 }],
    });
  });
});

describe("editorReducer — track ops", () => {
  it("ADD_TRACK appends", () => {
    const s = editorReducer(seedState([]), {
      type: "ADD_TRACK",
      payload: makeTrack("t1"),
    });
    expect(s.tracks.map((t) => t.id)).toEqual(["t1"]);
  });

  it("INSERT_TRACK at a specific index", () => {
    const s = editorReducer(seedState([makeTrack("a"), makeTrack("b")]), {
      type: "INSERT_TRACK",
      payload: { track: makeTrack("mid"), index: 1 },
    });
    expect(s.tracks.map((t) => t.id)).toEqual(["a", "mid", "b"]);
  });

  it("REMOVE_TRACK removes by id and clears selectedTrackId if matching", () => {
    const s = editorReducer(
      seedState([makeTrack("a"), makeTrack("b")], { selectedTrackId: "b" }),
      { type: "REMOVE_TRACK", payload: "b" },
    );
    expect(s.tracks.map((t) => t.id)).toEqual(["a"]);
    expect(s.selectedTrackId).toBeNull();
  });

  it("REMOVE_TRACK preserves selectedTrackId when not matching", () => {
    const s = editorReducer(
      seedState([makeTrack("a"), makeTrack("b")], { selectedTrackId: "a" }),
      { type: "REMOVE_TRACK", payload: "b" },
    );
    expect(s.selectedTrackId).toBe("a");
  });

  it("UPDATE_TRACK merges partial updates", () => {
    const s = editorReducer(seedState([makeTrack("a")]), {
      type: "UPDATE_TRACK",
      payload: { id: "a", updates: { name: "renamed", locked: true } },
    });
    expect(s.tracks[0].name).toBe("renamed");
    expect(s.tracks[0].locked).toBe(true);
  });

  it("REORDER_TRACKS reorders overlays but leaves the primary track at the bottom", () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    const s = editorReducer(seedState([a, b]), {
      type: "REORDER_TRACKS",
      payload: [b, a],
    });
    expect(s.tracks.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("editorReducer — item ops", () => {
  it("keeps the persistent primary lane visual-only for video and image media", () => {
    const state = seedState(
      [
        {
          ...makeTrack("primary"),
          category: "primary",
          role: "primary-video",
        } as Track,
      ],
      { primaryTrackId: "primary" },
    );
    const audio = {
      id: "standalone-audio",
      type: "audio",
      src: "voice.wav",
      from: 0,
      durationInFrames: 30,
    } as const;

    const rejected = editorReducer(state, {
      type: "ADD_ITEM",
      payload: { trackId: "primary", item: audio },
    });
    expect(rejected).toBe(state);

    const withVideo = editorReducer(state, {
      type: "ADD_ITEM",
      payload: { trackId: "primary", item: makeVideo("video", 0, 30) },
    });
    expect(withVideo.tracks[0].items.map((item) => item.type)).toEqual([
      "video",
    ]);
  });

  it("ADD_ITEM appends to the matching track", () => {
    const s = editorReducer(seedState([makeTrack("t1"), makeTrack("t2")]), {
      type: "ADD_ITEM",
      payload: { trackId: "t1", item: makeVideo("v1", 0, 60) },
    });
    expect(s.tracks[0].items.map((i) => i.id)).toEqual(["v1"]);
    expect(s.tracks[1].items).toHaveLength(0);
  });

  it("types an empty track from its first item and rejects incompatible items", () => {
    const audio = {
      id: "a1",
      type: "audio",
      src: "a1.wav",
      from: 0,
      durationInFrames: 30,
    } as const;
    const typed = editorReducer(
      seedState([{ ...makeTrack("audio"), category: "audio" } as Track]),
      { type: "ADD_ITEM", payload: { trackId: "audio", item: audio } },
    );
    const typedAudioTrack = typed.tracks.find((track) => track.id === "audio");
    expect((typedAudioTrack as any)?.category).toBe("audio");
    expect(typedAudioTrack?.items.map((item) => item.id)).toEqual(["a1"]);

    const rejected = editorReducer(typed, {
      type: "ADD_ITEM",
      payload: { trackId: "audio", item: makeVideo("v1", 0, 30) },
    });
    expect(rejected).toBe(typed);
  });

  it("moves items atomically only between compatible track categories", () => {
    const video = makeVideo("v1", 0, 30);
    const state = seedState(
      [
        { ...makeTrack("visual-a", [video]), category: "visual" } as Track,
        { ...makeTrack("text"), category: "text" } as Track,
        { ...makeTrack("visual-b"), category: "visual" } as Track,
      ],
      { primaryTrackId: null },
    );

    const rejected = editorReducer(state, {
      type: "MOVE_ITEM",
      payload: {
        sourceTrackId: "visual-a",
        targetTrackId: "text",
        itemId: "v1",
        from: 10,
      },
    } as any);
    expect(rejected).toBe(state);

    const moved = editorReducer(state, {
      type: "MOVE_ITEM",
      payload: {
        sourceTrackId: "visual-a",
        targetTrackId: "visual-b",
        itemId: "v1",
        from: 10,
      },
    } as any);
    expect(
      moved.tracks.find((track) => track.id === "visual-a"),
    ).toBeUndefined();
    expect(
      moved.tracks.find((track) => track.id === "visual-b")?.items[0],
    ).toMatchObject({
      id: "v1",
      from: 10,
    });
  });

  it("REMOVE_ITEM auto-deletes the parent track when it becomes empty", () => {
    const s = editorReducer(
      seedState([
        makeTrack("only", [makeVideo("v1", 0, 60)]),
        makeTrack("keep", [makeVideo("v2", 0, 60)]),
      ]),
      { type: "REMOVE_ITEM", payload: { trackId: "only", itemId: "v1" } },
    );
    expect(s.tracks.map((t) => t.id)).toEqual(["keep"]);
  });

  it("REMOVE_ITEM keeps the track if it still has other items", () => {
    const s = editorReducer(
      seedState([
        makeTrack("t", [makeVideo("a", 0, 30), makeVideo("b", 30, 30)]),
      ]),
      { type: "REMOVE_ITEM", payload: { trackId: "t", itemId: "a" } },
    );
    expect(s.tracks).toHaveLength(1);
    expect(s.tracks[0].items.map((i) => i.id)).toEqual(["b"]);
  });

  it("REMOVE_ITEM clears selectedItemId if it matched the removed item", () => {
    const s = editorReducer(
      seedState(
        [makeTrack("t", [makeVideo("a", 0, 30), makeVideo("b", 30, 30)])],
        { selectedItemId: "a" },
      ),
      { type: "REMOVE_ITEM", payload: { trackId: "t", itemId: "a" } },
    );
    expect(s.selectedItemId).toBeNull();
  });

  it("UPDATE_ITEM merges partial updates without disturbing siblings", () => {
    const s = editorReducer(
      seedState([
        makeTrack("t", [makeVideo("a", 0, 30), makeVideo("b", 60, 30)]),
      ]),
      {
        type: "UPDATE_ITEM",
        payload: {
          trackId: "t",
          itemId: "a",
          updates: { durationInFrames: 50 },
        },
      },
    );
    expect(s.tracks[0].items[0].durationInFrames).toBe(50);
    expect(s.tracks[0].items[1].durationInFrames).toBe(30);
  });

  it("UPDATE_ITEM removes optional fields explicitly set to undefined", () => {
    const legacy = {
      ...makeVideo("a", 0, 30),
      volume: 0.5,
      audioFadeIn: 12,
      audioFadeOut: 18,
    };
    const s = editorReducer(seedState([makeTrack("t", [legacy])]), {
      type: "UPDATE_ITEM",
      payload: {
        trackId: "t",
        itemId: "a",
        updates: {
          audioGainDb: 0,
          audioFadeInFrames: 10,
          audioFadeOutFrames: 16,
          volume: undefined,
          audioFadeIn: undefined,
          audioFadeOut: undefined,
        },
      },
    });

    expect(s.tracks[0].items[0]).toMatchObject({
      audioGainDb: 0,
      audioFadeInFrames: 10,
      audioFadeOutFrames: 16,
    });
    expect(s.tracks[0].items[0]).not.toHaveProperty("volume");
    expect(s.tracks[0].items[0]).not.toHaveProperty("audioFadeIn");
    expect(s.tracks[0].items[0]).not.toHaveProperty("audioFadeOut");
  });

  it("RIPPLE_DELETE_RANGE removes a spoken range, splits its clip, and closes the gap", () => {
    const state = seedState(
      [
        makeTrack("dialogue", [
          makeVideo("clip", 0, 90, 10),
          makeVideo("next", 100, 20, 0),
        ]),
        { ...makeTrack("locked", [makeVideo("bed", 0, 120, 0)]), locked: true },
      ],
      { durationInFrames: 120 },
    );

    const next = editorReducer(state, {
      type: "RIPPLE_DELETE_RANGE",
      payload: { startFrame: 30, endFrame: 45 },
    } as any);

    expect(next.durationInFrames).toBe(105);
    expect(next.tracks[0].items).toMatchObject([
      { id: "clip", from: 0, durationInFrames: 30, sourceStartInFrames: 10 },
      {
        id: "clip-ripple-30-45",
        from: 30,
        durationInFrames: 45,
        sourceStartInFrames: 55,
      },
      { id: "next", from: 85, durationInFrames: 20, sourceStartInFrames: 0 },
    ]);
    expect(next.tracks[1]).toEqual(state.tracks[1]);
  });

  it("RIPPLE_DELETE_RANGE slices keyframes around a removed middle range", () => {
    const animated: VideoItem = {
      ...makeVideo("clip", 0, 90, 10),
      keyframes: {
        rotation: [
          { frame: 0, value: 0, interpolation: "linear" },
          { frame: 89, value: 89, interpolation: "linear" },
        ],
      },
    };
    const state = seedState([makeTrack("dialogue", [animated])], {
      durationInFrames: 90,
    });

    const next = editorReducer(state, {
      type: "RIPPLE_DELETE_RANGE",
      payload: { startFrame: 30, endFrame: 45 },
    });
    const [left, right] = next.tracks[0].items as VideoItem[];

    expect(left.keyframes?.rotation).toEqual([
      { frame: 0, value: 0, interpolation: "linear" },
      { frame: 29, value: 29, interpolation: "linear" },
    ]);
    expect(right.keyframes?.rotation).toEqual([
      { frame: 0, value: 45, interpolation: "linear" },
      { frame: 44, value: 89, interpolation: "linear" },
    ]);
  });

  it("RIPPLE_DELETE_RANGE rebinds a later transition to the clip segment that still reaches its seam", () => {
    const state = seedState(
      [
        {
          id: "transitions",
          name: "Transitions",
          role: "transition",
          category: "effect",
          items: [
            {
              id: "tx-a-b",
              type: "transition",
              transitionType: "crossfade",
              fromItemId: "a",
              toItemId: "b",
              from: 68,
              durationInFrames: 24,
            },
          ],
        },
        {
          ...makeTrack("media", [
            makeVideo("a", 0, 80),
            makeVideo("b", 80, 120),
          ]),
          role: "b-roll",
          category: "primary",
        },
      ],
      { primaryTrackId: "media", durationInFrames: 200 },
    );

    const next = editorReducer(state, {
      type: "RIPPLE_DELETE_RANGE",
      payload: { startFrame: 53, endFrame: 55 },
    } as any);

    expect(
      next.tracks.find((track) => track.id === "media")?.items,
    ).toMatchObject([
      { id: "a", from: 0, durationInFrames: 53 },
      { id: "a-ripple-53-55", from: 53, durationInFrames: 25 },
      { id: "b", from: 78, durationInFrames: 120 },
    ]);
    expect(
      next.tracks.find((track) => track.id === "transitions")?.items,
    ).toMatchObject([
      {
        id: "tx-a-b",
        from: 66,
        durationInFrames: 24,
        fromItemId: "a-ripple-53-55",
        toItemId: "b",
      },
    ]);
  });

  it("RIPPLE_DELETE_RANGE removes deleted words from structured captions without duplicating the caption item", () => {
    const caption = {
      id: "captions",
      type: "text" as const,
      text: "Hello um world",
      color: "#ffffff",
      from: 0,
      durationInFrames: 120,
      keyframes: {
        opacity: [
          { frame: 0, value: 0, interpolation: "linear" as const },
          { frame: 119, value: 1, interpolation: "linear" as const },
        ],
      },
      wordRefs: [
        { id: "w1", text: "Hello", sourceStartFrame: 0, sourceEndFrame: 30 },
        { id: "w2", text: "um", sourceStartFrame: 30, sourceEndFrame: 45 },
        { id: "w3", text: "world", sourceStartFrame: 45, sourceEndFrame: 90 },
      ],
      sourceToOutputMap: [
        {
          sourceStartFrame: 0,
          sourceEndFrame: 90,
          outputStartFrame: 0,
          outputEndFrame: 90,
        },
      ],
      cues: [
        {
          id: "cue-1",
          startFrame: 0,
          durationInFrames: 90,
          text: "Hello um world",
          wordIds: ["w1", "w2", "w3"],
          sourceStartFrame: 0,
          sourceEndFrame: 90,
        },
      ],
    };
    const state = seedState(
      [
        makeTrack("dialogue", [makeVideo("clip", 0, 120, 0)]),
        {
          id: "subtitles",
          name: "Captions",
          role: "subtitle" as const,
          category: "text" as const,
          items: [caption],
        },
      ],
      { durationInFrames: 120 },
    );

    const next = editorReducer(state, {
      type: "RIPPLE_DELETE_RANGE",
      payload: { startFrame: 30, endFrame: 45 },
    } as any);

    const captions = next.tracks.find(
      (track) => track.id === "subtitles",
    )!.items;
    expect(captions).toHaveLength(1);
    expect(captions[0]).toMatchObject({
      id: "captions",
      from: 0,
      durationInFrames: 105,
      text: "Hello world",
      cues: [
        {
          startFrame: 0,
          durationInFrames: 75,
          text: "Hello world",
          wordIds: ["w1", "w3"],
        },
      ],
      wordRefs: [
        { id: "w1", text: "Hello" },
        { id: "w3", text: "world" },
      ],
      keyframes: {
        opacity: [
          { frame: 0, value: 0, interpolation: "linear" },
          { frame: 29, value: 29 / 119, interpolation: "linear" },
          { frame: 30, value: 45 / 119, interpolation: "linear" },
          { frame: 104, value: 1, interpolation: "linear" },
        ],
      },
    });
    expect((captions[0] as { text?: string }).text).not.toContain("um");
  });

  it("RESTORE_TIMELINE_SNAPSHOT gives transcript editing a non-destructive undo", () => {
    const originalTracks = [
      makeTrack("dialogue", [makeVideo("clip", 0, 90, 10)]),
    ];
    const edited = seedState(
      [makeTrack("dialogue", [makeVideo("clip", 0, 30, 10)])],
      {
        durationInFrames: 75,
      },
    );

    const restored = editorReducer(edited, {
      type: "RESTORE_TIMELINE_SNAPSHOT",
      payload: { tracks: originalTracks, durationInFrames: 90 },
    } as any);

    expect(restored.tracks).toEqual([
      { ...originalTracks[0], category: "primary" },
    ]);
    expect(restored.durationInFrames).toBe(90);
  });
});

describe("editorReducer — keyframed trim", () => {
  const animatedItem = (): VideoItem => ({
    ...makeVideo("animated", 100, 61, 0),
    keyframes: {
      position: [
        { frame: 0, value: [0, 0], interpolation: "linear" },
        { frame: 60, value: [60, 120], interpolation: "linear" },
      ],
    },
  });

  it("rebases keys when trimming the start and leaves item-local keys unchanged when moving", () => {
    const state = seedState([makeTrack("t", [animatedItem()])]);
    const trimmed = editorReducer(state, {
      type: "UPDATE_ITEM",
      payload: {
        trackId: "t",
        itemId: "animated",
        updates: { from: 110, durationInFrames: 51 },
      },
    });
    const trimmedItem = trimmed.tracks[0].items[0] as VideoItem;

    expect(trimmedItem.keyframes?.position).toEqual([
      { frame: 0, value: [10, 20], interpolation: "linear" },
      { frame: 50, value: [60, 120], interpolation: "linear" },
    ]);

    const moved = editorReducer(state, {
      type: "UPDATE_ITEM",
      payload: {
        trackId: "t",
        itemId: "animated",
        updates: { from: 120 },
      },
    });
    expect((moved.tracks[0].items[0] as VideoItem).keyframes).toEqual(
      animatedItem().keyframes,
    );
  });
});

describe("editorReducer — SPLIT_ITEM", () => {
  it("splits a video item at a frame inside its bounds; second piece advances sourceStartInFrames", () => {
    const item = makeVideo("clip", 100, 60, /* sourceStart */ 200);
    const s = editorReducer(seedState([makeTrack("t", [item])]), {
      type: "SPLIT_ITEM",
      payload: { trackId: "t", itemId: "clip", splitFrame: 130 },
    });
    const items = s.tracks[0].items as VideoItem[];
    expect(items).toHaveLength(2);
    // First piece: same start, half the duration
    expect(items[0].id).toBe("clip");
    expect(items[0].from).toBe(100);
    expect(items[0].durationInFrames).toBe(30);
    expect(items[0].sourceStartInFrames).toBe(200);
    // Second piece: starts at split frame, sourceStart advances by the consumed frames
    expect(items[1].id).toMatch(/^clip-split-/);
    expect(items[1].from).toBe(130);
    expect(items[1].durationInFrames).toBe(30);
    expect(items[1].sourceStartInFrames).toBe(230); // 200 + 30 consumed
  });

  it("slices and rebases item-local keyframes on both split pieces", () => {
    const item: VideoItem = {
      ...makeVideo("animated", 100, 61, 0),
      keyframes: {
        position: [
          { frame: 0, value: [0, 0], interpolation: "linear" },
          { frame: 60, value: [60, 120], interpolation: "linear" },
        ],
      },
    };
    const next = editorReducer(seedState([makeTrack("t", [item])]), {
      type: "SPLIT_ITEM",
      payload: { trackId: "t", itemId: "animated", splitFrame: 130 },
    });
    const [first, second] = next.tracks[0].items as VideoItem[];

    expect(first.keyframes?.position).toEqual([
      { frame: 0, value: [0, 0], interpolation: "linear" },
      { frame: 29, value: [29, 58], interpolation: "linear" },
    ]);
    expect(second.keyframes?.position).toEqual([
      { frame: 0, value: [30, 60], interpolation: "linear" },
      { frame: 30, value: [60, 120], interpolation: "linear" },
    ]);
  });

  it("SPLIT_ITEM is a no-op when splitFrame is at or before item.from", () => {
    const item = makeVideo("clip", 100, 60, 0);
    const s = editorReducer(seedState([makeTrack("t", [item])]), {
      type: "SPLIT_ITEM",
      payload: { trackId: "t", itemId: "clip", splitFrame: 100 },
    });
    expect(s.tracks[0].items).toHaveLength(1);
    expect(s.tracks[0].items[0].id).toBe("clip");
  });

  it("SPLIT_ITEM is a no-op when splitFrame is at or after item.end", () => {
    const item = makeVideo("clip", 100, 60, 0);
    const s = editorReducer(seedState([makeTrack("t", [item])]), {
      type: "SPLIT_ITEM",
      payload: { trackId: "t", itemId: "clip", splitFrame: 160 },
    });
    expect(s.tracks[0].items).toHaveLength(1);
  });

  it("SPLIT_ITEM does not touch other tracks", () => {
    const item = makeVideo("clip", 0, 60, 0);
    const s = editorReducer(
      seedState([
        makeTrack("t", [item]),
        makeTrack("other", [makeVideo("o", 0, 60)]),
      ]),
      {
        type: "SPLIT_ITEM",
        payload: { trackId: "t", itemId: "clip", splitFrame: 30 },
      },
    );
    expect(s.tracks[0].items).toHaveLength(2);
    expect(s.tracks[1].items).toHaveLength(1);
    expect(s.tracks[1].items[0].id).toBe("o");
  });

  it("splits an editable subtitle Text sticker with relative cue timing on both pieces", () => {
    const item: SubtitleTextItem = {
      id: "sentence",
      type: "text",
      text: "一句可编辑文字",
      color: "#ffffff",
      from: 20,
      durationInFrames: 30,
      cues: [
        {
          id: "sentence-cue",
          text: "一句可编辑文字",
          startFrame: 0,
          durationInFrames: 30,
          sourceStartFrame: 40,
          sourceEndFrame: 70,
          wordIds: [],
        },
      ],
      sourceToOutputMap: [
        {
          sourceStartFrame: 40,
          sourceEndFrame: 70,
          outputStartFrame: 0,
          outputEndFrame: 30,
        },
      ],
    };

    const s = editorReducer(seedState([makeTrack("text", [item])]), {
      type: "SPLIT_ITEM",
      payload: { trackId: "text", itemId: "sentence", splitFrame: 35 },
    });
    const items = s.tracks[0].items as SubtitleTextItem[];

    expect(items).toHaveLength(2);
    expect(
      items.map((piece) => ({
        from: piece.from,
        durationInFrames: piece.durationInFrames,
        text: piece.text,
        cueStart: piece.cues[0]?.startFrame,
        cueDuration: piece.cues[0]?.durationInFrames,
        mapStart: piece.sourceToOutputMap?.[0]?.outputStartFrame,
        mapEnd: piece.sourceToOutputMap?.[0]?.outputEndFrame,
      })),
    ).toEqual([
      {
        from: 20,
        durationInFrames: 15,
        text: "一句可编辑文字",
        cueStart: 0,
        cueDuration: 15,
        mapStart: 0,
        mapEnd: 15,
      },
      {
        from: 35,
        durationInFrames: 15,
        text: "一句可编辑文字",
        cueStart: 0,
        cueDuration: 15,
        mapStart: 0,
        mapEnd: 15,
      },
    ]);
  });
});

describe("editorReducer — selection / playback / scalars", () => {
  it("SELECT_ITEM and SELECT_TRACK store the id", () => {
    let s = editorReducer(seedState([]), { type: "SELECT_ITEM", payload: "x" });
    expect(s.selectedItemId).toBe("x");
    s = editorReducer(s, { type: "SELECT_ITEM", payload: null });
    expect(s.selectedItemId).toBeNull();
    s = editorReducer(s, { type: "SELECT_TRACK", payload: "tt" });
    expect(s.selectedTrackId).toBe("tt");
  });

  it("SET_CURRENT_FRAME / SET_PLAYING / SET_ZOOM / SET_DURATION / SET_COMPOSITION_SIZE", () => {
    let s = editorReducer(seedState([]), {
      type: "SET_CURRENT_FRAME",
      payload: 42,
    });
    expect(s.currentFrame).toBe(42);
    s = editorReducer(s, { type: "SET_PLAYING", payload: true });
    expect(s.playing).toBe(true);
    s = editorReducer(s, { type: "SET_ZOOM", payload: 2 });
    expect(s.zoom).toBe(2);
    s = editorReducer(s, { type: "SET_DURATION", payload: 3000 });
    expect(s.durationInFrames).toBe(3000);
    s = editorReducer(s, {
      type: "SET_COMPOSITION_SIZE",
      payload: { width: 1280, height: 720 },
    });
    expect(s.compositionWidth).toBe(1280);
    expect(s.compositionHeight).toBe(720);
  });

  it("ADD_ASSET / REMOVE_ASSET maintain the assets array", () => {
    const asset = {
      id: "a",
      name: "A",
      type: "video" as const,
      src: "a.mp4",
      createdAt: 0,
    };
    let s = editorReducer(seedState([]), { type: "ADD_ASSET", payload: asset });
    expect(s.assets.map((a) => a.id)).toEqual(["a"]);
    s = editorReducer(s, { type: "REMOVE_ASSET", payload: "a" });
    expect(s.assets).toEqual([]);
  });

  it("UPSERT_ASSET enriches an existing connected asset without duplicating it", () => {
    const asset = {
      id: "canvas-node",
      sourceNodeId: "canvas-node",
      projectAssetId: "asset-row",
      name: "Image",
      type: "image" as const,
      src: "/initial.png",
      createdAt: 0,
    };
    const state = seedState([]);
    state.assets = [asset];

    const next = editorReducer(state, {
      type: "UPSERT_ASSET",
      payload: {
        ...asset,
        name: "Opening frame",
        src: "/signed/image.png",
        thumbnail: "/signed/cover.webp",
      },
    });

    expect(next.assets).toHaveLength(1);
    expect(next.assets[0]).toMatchObject({
      id: "canvas-node",
      name: "Opening frame",
      src: "/signed/image.png",
      thumbnail: "/signed/cover.webp",
    });
  });

  it("SET_ASSET_TRANSCRIPT caches one word-aligned transcript by immutable asset id", () => {
    const transcript = {
      schemaVersion: 1 as const,
      kind: "clash.editor.asset-transcript" as const,
      assetId: "asset-row",
      text: "大家好",
      durationMs: 600,
      words: [
        { id: "w1", text: "大家", startMs: 0, endMs: 300 },
        { id: "w2", text: "好", startMs: 300, endMs: 600 },
      ],
    };

    const next = editorReducer(seedState([]), {
      type: "SET_ASSET_TRANSCRIPT",
      payload: transcript,
    } as any);

    expect((next as any).assetTranscripts["asset-row"]).toEqual(transcript);
  });

  it("SET_ASSET_TRANSCRIPT keeps linked subtitle Text word refs, cues, and top-level text in sync", () => {
    const originalTranscript = {
      schemaVersion: 1 as const,
      kind: "clash.editor.asset-transcript" as const,
      assetId: "speech",
      text: "删掉依据",
      durationMs: 600,
      words: [
        { id: "delete", text: "删掉", startMs: 0, endMs: 300 },
        { id: "line", text: "依据", startMs: 300, endMs: 600 },
      ],
    };
    const caption = {
      id: "subtitle-text",
      type: "text" as const,
      text: "删掉依据",
      color: "#ffffff",
      from: 0,
      durationInFrames: 30,
      wordRefs: [
        {
          id: "caption-delete",
          text: "删掉",
          assetId: "speech",
          assetWordId: "delete",
          clipId: "voice",
          trackId: "voiceover",
          sourceStartFrame: 0,
          sourceEndFrame: 9,
        },
        {
          id: "caption-line",
          text: "依据",
          assetId: "speech",
          assetWordId: "line",
          clipId: "voice",
          trackId: "voiceover",
          sourceStartFrame: 9,
          sourceEndFrame: 18,
        },
      ],
      sourceToOutputMap: [
        {
          sourceStartFrame: 0,
          sourceEndFrame: 18,
          outputStartFrame: 0,
          outputEndFrame: 18,
        },
      ],
      cues: [
        {
          id: "cue",
          startFrame: 0,
          durationInFrames: 18,
          text: "删掉依据",
          wordIds: ["caption-delete", "caption-line"],
          sourceStartFrame: 0,
          sourceEndFrame: 18,
        },
      ],
    };
    const state = seedState(
      [
        makeTrack("dialogue", [makeVideo("voice", 0, 30, 0)]),
        {
          id: "subtitles",
          name: "Text",
          role: "subtitle" as const,
          category: "text" as const,
          items: [caption],
        },
      ],
      {
        assetTranscripts: { speech: originalTranscript },
      },
    );
    const correctedTranscript = {
      ...originalTranscript,
      text: "删掉一句",
      words: [
        originalTranscript.words[0],
        { ...originalTranscript.words[1], text: "一句" },
      ],
    };

    const next = editorReducer(state, {
      type: "SET_ASSET_TRANSCRIPT",
      payload: correctedTranscript,
    } as any);
    const textItem = next.tracks.find((track) => track.id === "subtitles")!
      .items[0] as any;

    expect(textItem.wordRefs[1].text).toBe("一句");
    expect(textItem.cues[0].text).toBe("删掉一句");
    expect(textItem.text).toBe("删掉一句");
  });
});

describe('single-lane edit safety', () => {
  it('refuses a move or trim into a neighboring clip, but accepts touching boundaries', () => {
    const state = seedState([makeTrack('lane', [makeVideo('a', 0, 30), makeVideo('b', 40, 30)])]);
    for (const updates of [{ from: 20 }, { durationInFrames: 50 }]) {
      const itemId = 'from' in updates ? 'b' : 'a';
      expect(editorReducer(state, { type: 'UPDATE_ITEM', payload: { trackId: 'lane', itemId, updates } })).toBe(state);
    }
    const moved = editorReducer(state, { type: 'UPDATE_ITEM', payload: { trackId: 'lane', itemId: 'b', updates: { from: 30 } } });
    expect(moved.tracks[0].items[1].from).toBe(30);
  });
  it('refuses an overlapping insert without dropping any existing item', () => {
    const state = seedState([makeTrack('lane', [makeVideo('a', 0, 30)])]);
    expect(editorReducer(state, { type: 'ADD_ITEM', payload: { trackId: 'lane', item: makeVideo('b', 20, 30) } })).toBe(state);
  });
});
