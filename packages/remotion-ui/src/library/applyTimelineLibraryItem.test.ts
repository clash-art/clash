import { describe, expect, it } from "vitest";
import { timelineDslFromYaml } from "@clash/shared-types";
import {
  editorReducer,
  normalizeEditorAsset,
  type EditorState,
  type Item,
  type Track,
} from "@clash/remotion-core";
import { TIMELINE_LIBRARY_CATALOG } from "./timelineLibraryCatalog";
import {
  buildTimelineLibraryApplication,
  timelineLibraryMediaAdmissionInput,
} from "./applyTimelineLibraryItem";

const makeState = (
  tracks: Track[] = [],
  overrides: Partial<EditorState> = {},
): EditorState => ({
  tracks,
  primaryTrackId:
    tracks.find((track) => track.category === "primary")?.id ?? null,
  selectedItemId: null,
  selectedTrackId: null,
  currentFrame: 30,
  playing: false,
  zoom: 1,
  assets: [],
  assetTranscripts: {},
  compositionWidth: 1920,
  compositionHeight: 1080,
  fps: 30,
  durationInFrames: 300,
  ...overrides,
});

const record = (category: string, label?: string) => {
  const match = TIMELINE_LIBRARY_CATALOG.find(
    (candidate) =>
      candidate.item.category === category &&
      (!label || candidate.item.label === label),
  );
  if (!match)
    throw new Error(`Missing catalog record ${category}/${label ?? "*"}`);
  return match;
};

const apply = (
  state: EditorState,
  category: string,
  label?: string,
): EditorState => {
  const catalogRecord = record(category, label);
  const admissionInput = timelineLibraryMediaAdmissionInput(catalogRecord);
  const application = buildTimelineLibraryApplication({
    state,
    record: catalogRecord,
    mediaAsset: admissionInput
      ? normalizeEditorAsset({
          ...admissionInput,
          projectAssetId: `project:${admissionInput.catalogId}`,
        })
      : undefined,
    createId: (() => {
      let index = 0;
      return (prefix: string) => `${prefix}-${++index}`;
    })(),
  });
  expect(application.disabledReason).toBeUndefined();
  return application.actions.reduce(editorReducer, state);
};

describe("buildTimelineLibraryApplication", () => {
  it("inserts text, stickers, and real sound assets into compatible typed lanes", () => {
    let state = makeState();
    state = apply(state, "text");
    state = apply(state, "stickers");
    state = apply(state, "sound-effects", "Mouse Click");

    expect(state.tracks.map((track) => track.category)).toEqual([
      "text",
      "visual",
      "primary",
      "audio",
    ]);
    expect(
      state.tracks.flatMap((track) => track.items).map((item) => item.type),
    ).toEqual(expect.arrayContaining(["text", "sticker", "audio"]));
    expect(state.assets).toHaveLength(2);
    expect(state.assets.find((asset) => asset.type === "audio")?.src).toMatch(
      /^data:audio\/wav;base64,/,
    );
  });

  it("keeps sound effects on an SFX lane instead of colliding with narration", () => {
    const narration: Item = {
      id: "voice",
      type: "audio",
      src: "voice.wav",
      from: 0,
      durationInFrames: 90,
    };
    const state = makeState(
      [
        {
          id: "voice-track",
          name: "Voice",
          role: "narration",
          category: "audio",
          items: [narration],
        },
      ],
      { currentFrame: 0 },
    );

    const next = apply(state, "sound-effects", "Mouse Click");

    expect(
      next.tracks.filter((track) => track.category === "audio"),
    ).toHaveLength(2);
    expect(
      next.tracks.find((track) => track.role === "narration")?.items,
    ).toEqual([narration]);
    expect(next.tracks.find((track) => track.role === "sfx")?.items).toEqual([
      expect.objectContaining({
        type: "audio",
        assetId: "project:library:sound:mouse-click",
        audioGainDb: 0,
      }),
    ]);
    expect(
      next.tracks.find((track) => track.role === "sfx")?.items[0],
    ).not.toHaveProperty("volume");
  });

  it("requires media-backed catalog entries to be admitted as Project Assets", () => {
    const application = buildTimelineLibraryApplication({
      state: makeState(),
      record: record("sound-effects", "Mouse Click"),
      createId: (prefix) => prefix,
    });
    expect(application.actions).toEqual([]);
    expect(application.disabledReason).toMatch(/added to the Project/i);
  });

  it("attaches a version-pinned effect to the selected visual item", () => {
    const image: Item = {
      id: "image-1",
      type: "image",
      src: "data:image/png;base64,AA==",
      from: 0,
      durationInFrames: 90,
    };
    const state = makeState(
      [
        {
          id: "primary",
          name: "Media",
          role: "primary-video",
          category: "primary",
          items: [image],
        },
      ],
      { selectedItemId: image.id, primaryTrackId: "primary" },
    );

    const next = apply(state, "fx", "Camera Shake");
    const updated = next.tracks[0].items[0];
    expect(updated.effects).toEqual([
      expect.objectContaining({
        effectId: "clash/camera-shake",
        effectVersion: 1,
      }),
    ]);
  });

  it("creates a transition only when the selected visual clip has an adjacent clip", () => {
    const clips: Item[] = [
      { id: "a", type: "image", src: "a.png", from: 0, durationInFrames: 60 },
      { id: "b", type: "image", src: "b.png", from: 60, durationInFrames: 60 },
    ];
    const state = makeState(
      [
        {
          id: "primary",
          name: "Media",
          role: "primary-video",
          category: "primary",
          items: clips,
        },
      ],
      { selectedItemId: "a", primaryTrackId: "primary" },
    );

    const next = apply(state, "transitions");
    const transition = next.tracks
      .flatMap((track) => track.items)
      .find((item) => item.type === "transition");
    expect(transition).toMatchObject({
      fromItemId: "a",
      toItemId: "b",
      from: 53,
      durationInFrames: 15,
    });

    const disabled = buildTimelineLibraryApplication({
      state: makeState([state.tracks[0]], {
        selectedItemId: null,
        primaryTrackId: "primary",
      }),
      record: record("transitions"),
      createId: (prefix) => prefix,
    });
    expect(disabled.actions).toEqual([]);
    expect(disabled.disabledReason).toMatch(/continuous clips/i);
  });

  it("rejects transition pairs that are ordered but not frame-contiguous", () => {
    const clips: Item[] = [
      { id: "a", type: "video", src: "a.mp4", from: 0, durationInFrames: 60 },
      { id: "b", type: "video", src: "b.mp4", from: 75, durationInFrames: 60 },
    ];
    const state = makeState(
      [
        {
          id: "primary",
          name: "Media",
          role: "primary-video",
          category: "primary",
          items: clips,
        },
      ],
      { selectedItemId: "a", primaryTrackId: "primary" },
    );

    const application = buildTimelineLibraryApplication({
      state,
      record: record("transitions"),
      createId: (prefix) => prefix,
    });

    expect(application.actions).toEqual([]);
    expect(application.disabledReason).toMatch(/continuous clips/i);
  });

  it("targets an exact continuous edit point when a transition is dropped", () => {
    const clips: Item[] = [
      { id: "a", type: "video", src: "a.mp4", from: 0, durationInFrames: 60 },
      { id: "b", type: "video", src: "b.mp4", from: 60, durationInFrames: 60 },
    ];
    const state = makeState(
      [
        {
          id: "primary",
          name: "Media",
          role: "primary-video",
          category: "primary",
          items: clips,
        },
      ],
      { selectedItemId: null, primaryTrackId: "primary" },
    );

    const exact = buildTimelineLibraryApplication({
      state,
      record: record("transitions"),
      createId: (prefix) => prefix,
      transitionTarget: { trackId: "primary", frame: 60 },
    });
    expect(exact.disabledReason).toBeUndefined();
    expect(exact.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "ADD_TRACK",
          payload: expect.objectContaining({
            items: [
              expect.objectContaining({
                fromItemId: "a",
                toItemId: "b",
                from: 53,
                durationInFrames: 15,
              }),
            ],
          }),
        }),
      ]),
    );

    const insideClip = buildTimelineLibraryApplication({
      state,
      record: record("transitions"),
      createId: (prefix) => prefix,
      transitionTarget: { trackId: "primary", frame: 61 },
    });
    expect(insideClip.actions).toEqual([]);
    expect(insideClip.disabledReason).toMatch(/this position/i);
  });

  it("replaces the transition already bound to the same continuous edit point", () => {
    const clips: Item[] = [
      { id: "a", type: "image", src: "a.png", from: 0, durationInFrames: 60 },
      { id: "b", type: "image", src: "b.png", from: 60, durationInFrames: 60 },
    ];
    const existing: Item = {
      id: "transition-1",
      type: "transition",
      from: 60,
      durationInFrames: 15,
      transitionType: "circle-wipe",
      fromItemId: "a",
      toItemId: "b",
    };
    const state = makeState(
      [
        {
          id: "effects",
          name: "Transitions",
          role: "transition",
          category: "effect",
          items: [existing],
        },
        {
          id: "primary",
          name: "Media",
          role: "primary-video",
          category: "primary",
          items: clips,
        },
      ],
      { selectedItemId: existing.id, primaryTrackId: "primary" },
    );

    const application = buildTimelineLibraryApplication({
      state,
      record: record("transitions", "Crossfade"),
      createId: (prefix) => prefix,
    });

    expect(application.disabledReason).toBeUndefined();
    expect(
      application.actions.some(
        (action) => action.type === "ADD_ITEM" || action.type === "ADD_TRACK",
      ),
    ).toBe(false);
    expect(application.actions).toContainEqual(
      expect.objectContaining({
        type: "UPDATE_ITEM",
        payload: expect.objectContaining({
          trackId: "effects",
          itemId: existing.id,
          updates: expect.objectContaining({
            from: 53,
            durationInFrames: 15,
            transitionType: "crossfade",
          }),
        }),
      }),
    );
  });

  it("applies caption and audio presets to a compatible selection and reports truthful disabled states", () => {
    const caption: Item = {
      id: "caption",
      type: "text",
      text: "Caption",
      color: "#ffffff",
      from: 0,
      durationInFrames: 90,
      cues: [],
    };
    const audio: Item = {
      id: "voice",
      type: "audio",
      src: "voice.wav",
      from: 0,
      durationInFrames: 90,
    };
    let state = makeState(
      [
        {
          id: "captions",
          name: "Captions",
          role: "subtitle",
          category: "text",
          items: [caption],
        },
        {
          id: "audio",
          name: "Audio",
          role: "narration",
          category: "audio",
          items: [audio],
        },
      ],
      { selectedItemId: caption.id },
    );
    state = apply(state, "captions", "Creator Pop");
    expect(state.tracks[0].items[0]).toMatchObject({
      style: { backgroundColor: "#fff3a8" },
    });

    state = { ...state, selectedItemId: audio.id };
    state = apply(state, "audio-fx", "Audio Fade In");
    expect(state.tracks[1].items[0]).toMatchObject({ audioFadeInFrames: 15 });

    const disabled = buildTimelineLibraryApplication({
      state: { ...state, selectedItemId: caption.id },
      record: record("fx"),
      createId: (prefix) => prefix,
    });
    expect(disabled.disabledReason).toMatch(/visual item/i);
  });

  it("keeps caption style presets separate from ordinary text items", () => {
    const text: Item = {
      id: "title",
      type: "text",
      text: "Shared style",
      color: "#ffffff",
      from: 0,
      durationInFrames: 90,
    };
    const state = makeState(
      [
        {
          id: "text",
          name: "Text",
          role: "subtitle",
          category: "text",
          items: [text],
        },
      ],
      { selectedItemId: text.id },
    );

    const application = buildTimelineLibraryApplication({
      state,
      record: record("captions", "Creator Pop"),
      createId: (prefix) => prefix,
    });

    expect(application.actions).toEqual([]);
    expect(application.disabledReason).toMatch(/structured text item/i);
  });
});

it.each(TIMELINE_LIBRARY_CATALOG.filter(entry => entry.item.category === 'text'))('creates a persistable ordinary title from $item.label', entry => {
  const next = apply(makeState(), 'text', entry.item.label);
  const parsed = timelineDslFromYaml(JSON.stringify(next));
  expect(parsed.ok, parsed.ok ? undefined : parsed.error).toBe(true);
});

it('puts simultaneous library titles on different lanes, and reuses a compatible lane at a free time', () => {
  let sequence=0;
  const insert=(state:EditorState) => {
    const application=buildTimelineLibraryApplication({ state,record:record('text'),createId:prefix=>`${prefix}-repeated-${++sequence}` });
    return application.actions.reduce(editorReducer,state);
  };
  const one=insert(makeState());
  const two=insert(one);
  const original=one.tracks.flatMap(track=>track.items)[0];
  const inserted=two.tracks.flatMap(track=>track.items).find(item=>item.id!==original.id);
  expect(inserted).toBeDefined();
  expect(inserted!.from).toBe(original.from);
  expect(two.tracks.find(track=>track.items.some(item=>item.id===original.id))!.id)
    .not.toBe(two.tracks.find(track=>track.items.some(item=>item.id===inserted!.id))!.id);
  const later=insert({...two,currentFrame:original.from+original.durationInFrames});
  expect(later.tracks.length).toBe(two.tracks.length);
  expect(later.tracks.flatMap(track=>track.items)).toHaveLength(3);
});
