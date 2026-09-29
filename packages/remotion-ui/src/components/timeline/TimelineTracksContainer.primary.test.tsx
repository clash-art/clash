// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorProvider, useEditorPlayback } from "@clash/remotion-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineTracksContainer } from "./TimelineTracksContainer";

afterEach(() => cleanup());

const PlaybackProbe = () => {
  const { currentFrame } = useEditorPlayback();
  return <output aria-label="Current transcript frame">{currentFrame}</output>;
};

describe("TimelineTracksContainer typed lanes", () => {
  it("separates the label rail from quiet typed lanes and keeps the primary label stable", () => {
    window.currentDraggedItem = null;

    const { container } = render(
      <EditorProvider
        initialState={{
          primaryTrackId: "story",
          tracks: [
            { id: "audio", name: "Music", category: "audio", items: [] },
            { id: "story", name: "Dialogue", category: "primary", items: [] },
            { id: "overlay", name: "B-roll", category: "visual", items: [] },
            { id: "titles", name: "Captions", role: "subtitle", category: "text", items: [] },
            { id: "fx", name: "FX", category: "effect", items: [] },
          ],
        }}
      >
        <TimelineTracksContainer
          durationInFrames={300}
          pixelsPerFrame={1}
          fps={30}
          selectedTrackId={null}
          selectedItemId={null}
          assets={[]}
          onSelectTrack={() => {}}
          onSelectItem={() => {}}
          onDeleteItem={() => {}}
          onUpdateItem={() => {}}
          onDragOver={() => {}}
          onDrop={() => {}}
          onEmptyDrop={() => {}}
          onItemDragStart={() => {}}
          onItemDragOver={() => {}}
          onItemDrop={() => {}}
          onItemDragEnd={() => {}}
          dragPreview={null}
          contentInsetLeftPx={16}
        />
      </EditorProvider>,
    );

    const labelRows = container.querySelectorAll(".track-labels-panel > div");
    const labelPanel = container.querySelector('.track-labels-panel') as HTMLElement;
    expect(labelPanel.style.borderRight).toBe(
      '1px solid var(--clash-timeline-border-subtle, #f0ede7)',
    );
    expect(labelPanel.style.background).toBe('var(--clash-warm-surface, #fffefd)');
    expect(Array.from(labelRows).map((row) => row.textContent)).toEqual([
      "Effects",
      "Text",
      "Media",
      "Media",
      "Audio",
    ]);
    expect(labelRows[3]?.getAttribute("data-primary-track")).toBe("true");
    const leadingGutters = container.querySelectorAll("[data-track-leading-gutter]");
    expect(leadingGutters).toHaveLength(5);
    expect((leadingGutters[0] as HTMLElement).style.width).toBe("16px");
    expect((leadingGutters[0] as HTMLElement).style.left).toBe("-16px");
    expect((leadingGutters[0] as HTMLElement).style.borderBottom).toBe("");
    const trackLanes = container.querySelectorAll('[data-track-lane]');
    expect(trackLanes).toHaveLength(5);
    expect(container.querySelector('[data-global-transcript-lane]')).toBeNull();
    expect(Array.from(labelRows).map((row) => (row as HTMLElement).style.height)).toEqual([
      '36px',
      '40px',
      '56px',
      '88px',
      '48px',
    ]);
    const labelDividers = container.querySelectorAll('[data-track-label-divider]');
    expect(labelDividers).toHaveLength(6);
    expect((labelDividers[0] as HTMLElement).dataset.trackLabelDivider).toBe('top');
    expect((labelDividers[1] as HTMLElement).dataset.trackLabelDivider).toBe('bottom');
    expect((labelDividers[0] as HTMLElement).style.left).toBe('12px');
    expect((labelDividers[0] as HTMLElement).style.right).toBe('12px');
    expect((labelDividers[0] as HTMLElement).style.backgroundColor)
      .toBe('var(--clash-warm-border, #e1ddd5)');
    expect(Array.from(labelRows).every((row) => (row as HTMLElement).style.backgroundColor === 'transparent')).toBe(true);
    expect(Array.from(trackLanes).map((lane) => (lane as HTMLElement).style.height)).toEqual([
      '36px',
      '40px',
      '56px',
      '88px',
      '48px',
    ]);
    expect(Array.from(trackLanes).every((lane) => (lane as HTMLElement).style.borderBottom === '')).toBe(true);
    const trackSurfaces = container.querySelectorAll('[data-track-bubble-surface]');
    expect(trackSurfaces).toHaveLength(5);
    expect((trackSurfaces[0] as HTMLElement).style.backgroundColor)
      .toBe('var(--clash-warm-page, #fbfaf7)');
    expect(container.querySelectorAll('[data-track-bubble-edge="label"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-track-bubble-edge="lane"]')).toHaveLength(5);
    expect((container.querySelector('[data-track-bubble-edge="lane"]') as HTMLElement).style.borderRadius)
      .toBe('10px');
    const tracksViewport = container.querySelector('.tracks-viewport') as HTMLElement;
    expect(tracksViewport.style.paddingLeft).toBe('16px');
    expect(Array.from(container.querySelectorAll("[data-track-category-icon]"))
      .map((icon) => icon.getAttribute("data-track-category-icon"))).toEqual([
        "effect",
        "text",
        "visual",
        "primary",
        "audio",
      ]);
    expect(screen.queryByText(/main storyline/i)).toBeNull();
    expect(screen.queryByText(/set as main/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /main storyline/i })).toBeNull();
  });

  it("keeps word timing precise while presenting and seeking sentence blocks", () => {
    window.currentDraggedItem = null;

    const { container } = render(
      <EditorProvider
        initialState={{
          fps: 30,
          durationInFrames: 90,
          currentFrame: 0,
          primaryTrackId: "story",
          tracks: [{
            id: "story",
            name: "Media",
            role: "primary-video",
            category: "primary",
            items: [{
              id: "clip",
              type: "video",
              assetId: "speech",
              src: "speech.mp4",
              from: 0,
              durationInFrames: 90,
            }],
          }],
          assetTranscripts: {
            speech: {
              schemaVersion: 1,
              kind: "clash.editor.asset-transcript",
              assetId: "speech",
              text: "I check comp. Products arrive.",
              durationMs: 2000,
              words: [
                { id: "i", text: "I", startMs: 0, endMs: 300 },
                { id: "check", text: "check", startMs: 300, endMs: 500 },
                { id: "comp", text: "comp.", startMs: 500, endMs: 1000 },
                { id: "products", text: "Products", startMs: 1500, endMs: 1750 },
                { id: "arrive", text: "arrive.", startMs: 1750, endMs: 2000 },
              ],
            },
          },
        }}
      >
        <TimelineTracksContainer
          durationInFrames={90}
          pixelsPerFrame={2}
          fps={30}
          selectedTrackId={null}
          selectedItemId={null}
          assets={[]}
          onSelectTrack={() => {}}
          onSelectItem={() => {}}
          onDeleteItem={() => {}}
          onUpdateItem={() => {}}
          onDragOver={() => {}}
          onDrop={() => {}}
          onEmptyDrop={() => {}}
          onItemDragStart={() => {}}
          onItemDragOver={() => {}}
          onItemDrop={() => {}}
          onItemDragEnd={() => {}}
          dragPreview={null}
          showTranscriptTimeline
        />
        <PlaybackProbe />
      </EditorProvider>,
    );

    const wordbar = container.querySelector("[data-primary-transcript-wordbar]");
    expect(wordbar).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Seek to transcript word I" })).toBeNull();
    const firstSentence = screen.getByRole("button", {
      name: "Seek to transcript sentence I check comp.",
    });
    expect(firstSentence.getAttribute("data-current-sentence")).toBe("true");
    expect((firstSentence as HTMLElement).style.left).toBe("0px");
    expect((firstSentence as HTMLElement).style.width).toBe("60px");
    const pause = screen.getByRole("button", { name: "Seek to pause 0.5 seconds" });
    expect(pause.textContent).toBe("0.5s");
    expect((pause as HTMLElement).style.left).toBe("60px");
    expect((pause as HTMLElement).style.width).toBe("30px");
    const secondSentence = screen.getByRole("button", {
      name: "Seek to transcript sentence Products arrive.",
    });
    expect((secondSentence as HTMLElement).style.left).toBe("90px");
    expect((secondSentence as HTMLElement).style.width).toBe("30px");
    fireEvent.click(secondSentence);

    expect(screen.getByLabelText("Current transcript frame").textContent).toBe("45");
    expect(secondSentence.getAttribute("data-current-sentence")).toBe("true");
  });

  it("keeps Voiceover separate while showing its sentence timing in the opt-in bottom lane", () => {
    window.currentDraggedItem = null;
    const onUpdateItem = vi.fn();

    const { container } = render(
      <EditorProvider
        initialState={{
          fps: 30,
          durationInFrames: 90,
          currentFrame: 0,
          primaryTrackId: "visuals",
          tracks: [
            {
              id: "visuals",
              name: "Media",
              role: "b-roll",
              category: "primary",
              items: [{
                id: "visual",
                type: "video",
                assetId: "picture",
                src: "picture.mp4",
                from: 0,
                durationInFrames: 90,
              }],
            },
            {
              id: "voice",
              name: "Voiceover",
              role: "narration",
              category: "audio",
              items: [{
                id: "voice-clip",
                type: "audio",
                assetId: "speech",
                src: "voice.wav",
                from: 0,
                durationInFrames: 90,
                volume: 1,
                audioFadeIn: 15,
                audioFadeOut: 12,
              }],
            },
            {
              id: "text",
              name: "Text",
              role: "subtitle",
              category: "text",
              items: [{
                id: "captions",
                type: "text",
                text: "subtitle A\nsubtitle B",
                color: "#fff",
                from: 0,
                durationInFrames: 30,
                cues: [
                  {
                    id: "cue-hello",
                    text: "subtitle A",
                    startFrame: 0,
                    durationInFrames: 12,
                    sourceStartFrame: 0,
                    sourceEndFrame: 12,
                    wordIds: ["caption-hello"],
                  },
                  {
                    id: "cue-world",
                    text: "subtitle B",
                    startFrame: 18,
                    durationInFrames: 12,
                    sourceStartFrame: 18,
                    sourceEndFrame: 30,
                    wordIds: ["caption-world"],
                  },
                ],
                wordRefs: [
                  {
                    id: "caption-hello",
                    text: "hello",
                    assetId: "speech",
                    assetWordId: "hello",
                    clipId: "voice-clip",
                    trackId: "voice",
                    sourceStartFrame: 0,
                    sourceEndFrame: 12,
                  },
                  {
                    id: "caption-world",
                    text: "world",
                    assetId: "speech",
                    assetWordId: "world",
                    clipId: "voice-clip",
                    trackId: "voice",
                    sourceStartFrame: 18,
                    sourceEndFrame: 30,
                  },
                ],
                sourceToOutputMap: [{
                  sourceStartFrame: 0,
                  sourceEndFrame: 30,
                  outputStartFrame: 0,
                  outputEndFrame: 30,
                }],
              }],
            },
            {
              id: "music",
              name: "Music",
              role: "music",
              category: "audio",
              items: [{
                id: "music-clip",
                type: "audio",
                assetId: "bed",
                src: "bed.wav",
                from: 0,
                durationInFrames: 90,
              }],
            },
            {
              id: "sfx",
              name: "Sound Design",
              role: "sfx",
              category: "audio",
              items: [{
                id: "sfx-clip",
                type: "audio",
                assetId: "impact",
                src: "impact.wav",
                from: 0,
                durationInFrames: 30,
              }],
            },
          ],
          assetTranscripts: {
            speech: {
              schemaVersion: 1,
              kind: "clash.editor.asset-transcript",
              assetId: "speech",
              text: "hello. world.",
              durationMs: 1000,
              words: [
                { id: "hello", text: "hello.", startMs: 0, endMs: 400 },
                { id: "world", text: "world.", startMs: 600, endMs: 1000 },
              ],
            },
          },
        }}
      >
        <TimelineTracksContainer
          durationInFrames={90}
          pixelsPerFrame={4}
          fps={30}
          selectedTrackId={null}
          selectedItemId={null}
          assets={[{
            id: "speech",
            name: "Voice",
            type: "audio",
            src: "voice.wav",
            waveform: [0.1, 0.6, 0.25, 0.85, 0.4, 0.7],
            createdAt: 1,
          }, {
            id: "bed",
            name: "Music bed",
            type: "audio",
            src: "bed.wav",
            waveform: [0.2, 0.45, 0.3, 0.5],
            createdAt: 2,
          }, {
            id: "impact",
            name: "Impact",
            type: "audio",
            src: "impact.wav",
            waveform: [0.7, 0.3, 0.1],
            createdAt: 3,
          }]}
          onSelectTrack={() => {}}
          onSelectItem={() => {}}
          onDeleteItem={() => {}}
          onUpdateItem={onUpdateItem}
          onDragOver={() => {}}
          onDrop={() => {}}
          onEmptyDrop={() => {}}
          onItemDragStart={() => {}}
          onItemDragOver={() => {}}
          onItemDrop={() => {}}
          onItemDragEnd={() => {}}
          dragPreview={null}
          showTranscriptTimeline
        />
      </EditorProvider>,
    );

    const wordbars = container.querySelectorAll("[data-primary-transcript-wordbar]");
    expect(wordbars).toHaveLength(1);
    const wordbar = wordbars[0] as HTMLElement;
    expect(wordbar.getAttribute("data-transcript-track-id")).toBe("voice");
    expect(wordbar.getAttribute("aria-label")).toBe("Voiceover transcript sentences");
    const coordinatedVoiceover = container.querySelector("[data-coordinated-voiceover]");
    expect(coordinatedVoiceover).toBeNull();
    const voiceItem = container.querySelector('[data-dnd-id="item-voice-clip"]') as HTMLElement;
    const waveform = voiceItem.querySelector('[data-waveform-id="voice-clip"]');
    expect(waveform).toBeTruthy();
    expect(waveform?.querySelector("svg")).toBeTruthy();
    expect(waveform?.querySelector("svg")?.getAttribute("height")).toBe("38");
    const primaryVisual = container.querySelector('[data-dnd-id="item-visual"]') as HTMLElement;
    expect(primaryVisual.style.top).toBe("50%");
    expect(primaryVisual.style.transform).toBe("translateY(-50%)");
    const musicItem = container.querySelector('[data-dnd-id="item-music-clip"]') as HTMLElement;
    const sfxItem = container.querySelector('[data-dnd-id="item-sfx-clip"]') as HTMLElement;
    expect(voiceItem.style.backgroundColor).toBe(
      "var(--clash-timeline-item-audio, #294454)",
    );
    expect(musicItem.style.backgroundColor).toBe(
      "var(--clash-timeline-item-audio, #294454)",
    );
    expect(sfxItem.style.backgroundColor).toBe(
      "var(--clash-timeline-item-audio, #294454)",
    );
    expect(waveform?.querySelector("svg")?.getAttribute("data-waveform-renderer"))
      .toBe("one-sided-area");
    expect(waveform?.querySelector("[data-waveform-envelope]")?.getAttribute("fill"))
      .toBe("var(--clash-timeline-audio-waveform, #68858d)");
    expect(musicItem.querySelector("[data-waveform-envelope]")?.getAttribute("fill"))
      .toBe("var(--clash-timeline-audio-waveform, #68858d)");
    expect(sfxItem.querySelector("[data-waveform-envelope]")?.getAttribute("fill"))
      .toBe("var(--clash-timeline-audio-waveform, #68858d)");
    expect(waveform?.querySelectorAll("rect")).toHaveLength(0);
    const transcriptLane = wordbar.closest("[data-global-transcript-lane]");
    expect(transcriptLane).toBeTruthy();
    expect(voiceItem.closest("[data-track-lane]")?.getAttribute("data-primary-track")).toBeNull();
    expect(voiceItem.closest("[data-track-lane]")?.contains(wordbar)).toBe(false);
    expect(voiceItem.querySelector("[data-audio-gain-envelope]")).toBeNull();
    const volumeControl = voiceItem.querySelector("[data-audio-volume-control]");
    const volumeLine = volumeControl?.querySelector("[data-volume-db-line]");
    const fadeControl = voiceItem.querySelector("[data-audio-fade-control]");
    expect(volumeControl).toBeTruthy();
    expect(volumeLine).toBeTruthy();
    expect(volumeLine?.getAttribute("y1")).toBe(volumeLine?.getAttribute("y2"));
    expect(volumeLine?.getAttribute("x1")).toBe("0");
    expect(volumeLine?.getAttribute("x2")).toBe("360");
    expect(volumeLine?.getAttribute("y1")).toBe("19");
    expect(voiceItem.querySelectorAll("[data-volume-envelope-handle]")).toHaveLength(0);
    expect(fadeControl).toBeTruthy();
    expect(fadeControl?.getAttribute("data-fade-anchor")).toBe("waveform-boundary");
    expect(fadeControl?.getAttribute("data-fade-boundary-y")).toBe("0");
    expect((fadeControl as HTMLElement).style.pointerEvents).toBe("none");
    expect(voiceItem.querySelectorAll("[data-audio-fade-mask]")).toHaveLength(2);
    expect(voiceItem.querySelector("[data-audio-fade-mask]")?.getAttribute("fill"))
      .toBe("rgba(0, 0, 0, 0.82)");
    expect(voiceItem.querySelectorAll("[data-audio-fade-curve]")).toHaveLength(2);
    expect(voiceItem.querySelectorAll("[data-audio-fade-curve]")[0]?.getAttribute("pointer-events"))
      .toBe("none");
    expect(voiceItem.querySelector("[data-audio-fade-curve]")?.getAttribute("stroke-width"))
      .toBe("0.5");
    expect(volumeLine?.getAttribute("stroke-width")).toBe("0.75");
    expect(voiceItem.querySelectorAll("[data-audio-fade-handle]")).toHaveLength(0);
    expect(voiceItem.textContent).not.toContain("Fade in");
    expect(voiceItem.textContent).not.toContain("Fade out");
    Object.defineProperty(voiceItem, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 40,
        height: 40,
        left: 0,
        right: 360,
        top: 0,
        width: 360,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    fireEvent.mouseEnter(voiceItem);
    expect(voiceItem.querySelectorAll("[data-audio-fade-handle]")).toHaveLength(2);
    const fadeInSlider = voiceItem.querySelector(
      '[data-audio-fade-handle="in"]',
    ) as HTMLElement;
    expect(fadeInSlider.getAttribute("role")).toBe("slider");
    expect(fadeInSlider.getAttribute("aria-valuetext")).toBe("0.50 seconds");
    expect(fadeInSlider.style.width).toBe("10px");
    expect(fadeInSlider.style.height).toBe("10px");
    expect(fadeInSlider.style.top).toBe("-5px");
    fireEvent.pointerDown(fadeInSlider, { pointerId: 1, clientX: 60 });
    expect(voiceItem.querySelector('[data-audio-fade-readout="in"]')?.textContent)
      .toBe("0.50s");
    fireEvent.pointerMove(fadeInSlider, { pointerId: 1, clientX: 72 });
    expect(onUpdateItem.mock.calls[onUpdateItem.mock.calls.length - 1]?.[2])
      .toEqual({ audioFadeInFrames: 18, audioFadeIn: undefined });
    fireEvent.pointerUp(fadeInSlider, { pointerId: 1 });
    const volumeSlider = voiceItem.querySelector(
      '[data-volume-db-hit-target]',
    ) as HTMLElement;
    expect(volumeSlider).toBeTruthy();
    expect(volumeSlider.getAttribute("role")).toBe("slider");
    expect(volumeSlider.getAttribute("aria-valuemin")).toBe("-60");
    expect(volumeSlider.getAttribute("aria-valuemax")).toBe("12");
    expect(volumeSlider.getAttribute("aria-valuetext")).toBe("0.0 dB");
    expect(volumeSlider.style.height).toBe("12px");
    expect(volumeSlider.style.top).toBe("13px");
    fireEvent.pointerDown(volumeSlider, { pointerId: 2, clientY: 20 });
    fireEvent.pointerMove(volumeSlider, { pointerId: 2, clientY: 23.6 });
    const lastVolumeUpdate = onUpdateItem.mock.calls[onUpdateItem.mock.calls.length - 1];
    expect(lastVolumeUpdate?.slice(0, 2)).toEqual(["voice", "voice-clip"]);
    expect(lastVolumeUpdate?.[2]).toEqual({ audioGainDb: -12, volume: undefined });
    expect(voiceItem.textContent).toContain("-12.0 dB");
    fireEvent.pointerUp(volumeSlider, { pointerId: 2 });
    const labelRows = Array.from(container.querySelectorAll(".track-labels-panel > div"));
    expect(labelRows.map((row) => row.textContent)).toEqual([
      "Text",
      "Media",
      "Audio",
      "Audio",
      "Audio",
      "Transcript",
    ]);
    expect(container.querySelectorAll("[data-track-lane]")).toHaveLength(6);
    const firstSentence = screen.getByRole("button", {
      name: "Seek to transcript sentence hello.",
    }) as HTMLElement;
    const secondSentence = screen.getByRole("button", {
      name: "Seek to transcript sentence world.",
    }) as HTMLElement;
    expect(firstSentence.style.width).toBe("72px");
    expect(secondSentence.style.left).toBe("72px");
    expect(screen.queryByRole("button", { name: "Seek to pause 0.2 seconds" })).toBeNull();
    expect(screen.queryByRole("button", {
      name: "Seek to transcript sentence subtitle A",
    })).toBeNull();
  });

  it("keeps embedded video audio, waveform, and transcript in one Media track", () => {
    const onUpdateItem = vi.fn();
    const { container } = render(
      <EditorProvider
        initialState={{
          fps: 30,
          durationInFrames: 60,
          primaryTrackId: "media",
          tracks: [
            {
              id: "media",
              name: "Media",
              role: "primary-video",
              category: "primary",
              items: [{
                id: "talking-head",
                type: "video",
                assetId: "talking-head-asset",
                src: "talking-head.mp4",
                from: 0,
                durationInFrames: 60,
                audioFadeInFrames: 10,
                audioFadeOutFrames: 12,
              }],
            },
            {
              id: "text",
              name: "Text",
              role: "subtitle",
              category: "text",
              items: [{
                id: "caption-recognition-lineage",
                type: "text",
                text: "字幕展示文案",
                color: "#fff",
                from: 0,
                durationInFrames: 30,
                cues: [{
                  id: "subtitle-cue",
                  text: "字幕展示文案",
                  startFrame: 0,
                  durationInFrames: 30,
                  wordIds: ["embedded-word"],
                  sourceStartFrame: 0,
                  sourceEndFrame: 30,
                }],
                wordRefs: [{
                  id: "embedded-word",
                  text: "内置音频。",
                  assetId: "talking-head-asset",
                  assetWordId: "embedded-word",
                  clipId: "talking-head",
                  trackId: "media",
                  sourceStartFrame: 0,
                  sourceEndFrame: 30,
                }],
                sourceToOutputMap: [{
                  sourceStartFrame: 0,
                  sourceEndFrame: 30,
                  outputStartFrame: 0,
                  outputEndFrame: 30,
                }],
              }],
            },
          ],
          assetTranscripts: {},
        }}
      >
        <TimelineTracksContainer
          durationInFrames={60}
          pixelsPerFrame={3}
          fps={30}
          selectedTrackId={null}
          selectedItemId={null}
          assets={[{
            id: "talking-head-asset",
            name: "Talking head",
            type: "video",
            src: "talking-head.mp4",
            waveform: [0.1, 0.8, 0.25, 0.65],
            createdAt: 1,
          }]}
          onSelectTrack={() => {}}
          onSelectItem={() => {}}
          onDeleteItem={() => {}}
          onUpdateItem={onUpdateItem}
          onDragOver={() => {}}
          onDrop={() => {}}
          onEmptyDrop={() => {}}
          onItemDragStart={() => {}}
          onItemDragOver={() => {}}
          onItemDrop={() => {}}
          onItemDragEnd={() => {}}
          dragPreview={null}
          showTranscriptTimeline
        />
      </EditorProvider>,
    );

    const mediaItem = container.querySelector(
      '[data-dnd-id="item-talking-head"]',
    ) as HTMLElement;
    const waveform = mediaItem?.querySelector('[data-waveform-id="talking-head"]');
    const thumbnail = mediaItem?.querySelector('[data-thumbnail-id="talking-head"]');
    const transcript = container.querySelector('[data-primary-transcript-wordbar]');
    expect(container.querySelectorAll("[data-track-lane]")).toHaveLength(3);
    expect(container.querySelector("[data-coordinated-voiceover]")).toBeNull();
    expect(waveform).toBeTruthy();
    expect(thumbnail).toBeTruthy();
    expect(mediaItem?.contains(waveform ?? null)).toBe(true);
    expect(mediaItem?.contains(thumbnail ?? null)).toBe(true);
    expect(waveform?.querySelector("[data-waveform-envelope]")?.getAttribute("fill"))
      .toBe("var(--clash-timeline-audio-waveform, #68858d)");
    expect(mediaItem?.querySelector("[data-filmstrip-renderer]")?.getAttribute("data-filmstrip-sample-count"))
      .toBe("40");
    expect(mediaItem?.querySelector("[data-audio-volume-control]")).toBeTruthy();
    expect(mediaItem?.querySelector("[data-volume-db-line]")).toBeTruthy();
    expect(mediaItem?.querySelector("[data-audio-fade-control]")).toBeTruthy();
    expect(mediaItem?.querySelector("[data-audio-fade-control]")?.getAttribute("data-fade-anchor"))
      .toBe("waveform-boundary");
    expect(Number(mediaItem?.querySelector("[data-audio-fade-control]")?.getAttribute("data-fade-boundary-y")))
      .toBeGreaterThan(0);
    expect(mediaItem?.querySelectorAll("[data-audio-fade-mask]")).toHaveLength(2);
    expect(mediaItem?.querySelectorAll("[data-audio-fade-curve]")).toHaveLength(2);
    expect(mediaItem?.querySelectorAll("[data-audio-fade-handle]")).toHaveLength(0);
    expect(transcript?.closest("[data-global-transcript-lane]")).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Seek to transcript sentence 内置音频。",
    })).toBeTruthy();
  });

  it("shows only bound transitions as duration ranges centered on contiguous clip seams", () => {
    window.currentDraggedItem = null;
    const onUpdateItem = vi.fn();

    const { container } = render(
      <EditorProvider
        initialState={{
          primaryTrackId: "story",
          tracks: [
            {
              id: "story",
              name: "Media",
              role: "primary-video",
              category: "primary",
              items: [
                { id: "a", type: "video", src: "a.mp4", from: 0, durationInFrames: 60 },
                { id: "b", type: "video", src: "b.mp4", from: 60, durationInFrames: 60 },
                { id: "c", type: "video", src: "c.mp4", from: 120, durationInFrames: 60 },
              ],
            },
            {
              id: "transitions",
              name: "Transitions",
              role: "transition",
              category: "effect",
              items: [{
                id: "crossfade",
                type: "transition",
                from: 53,
                durationInFrames: 15,
                transitionType: "crossfade",
                fromItemId: "a",
                toItemId: "b",
              }],
            },
          ],
        }}
      >
        <TimelineTracksContainer
          durationInFrames={240}
          pixelsPerFrame={2}
          fps={30}
          selectedTrackId={null}
          selectedItemId={null}
          assets={[]}
          onSelectTrack={() => {}}
          onSelectItem={() => {}}
          onDeleteItem={() => {}}
          onUpdateItem={onUpdateItem}
          onDragOver={() => {}}
          onDrop={() => {}}
          onEmptyDrop={() => {}}
          onItemDragStart={() => {}}
          onItemDragOver={() => {}}
          onItemDrop={() => {}}
          onItemDragEnd={() => {}}
          dragPreview={null}
        />
      </EditorProvider>,
    );

    expect(container.querySelector('[data-transition-edit-point]')).toBeNull();
    expect(screen.queryByText("Transitions")).toBeNull();

    const ranges = container.querySelectorAll('[data-transition-range]');
    expect(ranges).toHaveLength(1);
    const range = ranges[0] as HTMLElement;
    expect(range.getAttribute('data-transition-frame')).toBe('60');
    expect(range.getAttribute('data-transition-duration-frames')).toBe('15');
    expect(range.style.left).toBe('120px');
    expect(range.style.width).toBe('30px');
    expect(range.style.top).toBe('4px');
    expect(range.style.bottom).toBe('4px');
    expect(range.getAttribute('aria-label')).toMatch(/crossfade.*0\.50 seconds/i);
    expect(range.getAttribute('data-transition-range-visual')).toBe('seam-window');
    expect(range.style.border).toContain('rgba(255, 255, 255, 0.96)');
    expect(range.style.borderTop).toBe(range.style.borderBottom);
    expect(range.style.background).not.toContain('255, 107, 80');
    expect(range.querySelector('[data-transition-seam-icon]')).not.toBeNull();
    expect(range.querySelectorAll('[data-transition-resize-handle]')).toHaveLength(2);
    expect(range.querySelector('[data-transition-resize-grip]')).toBeNull();

    const rightHandle = screen.getByRole('separator', { name: /resize crossfade end/i });
    fireEvent.pointerDown(rightHandle, { clientX: 135, pointerId: 1 });
    fireEvent.pointerMove(rightHandle, { clientX: 141, pointerId: 1 });
    fireEvent.pointerUp(rightHandle, { clientX: 141, pointerId: 1 });
    expect(onUpdateItem).toHaveBeenLastCalledWith("transitions", "crossfade", {
      from: 50,
      durationInFrames: 21,
    });
  });
});
