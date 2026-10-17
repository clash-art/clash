/**
 * Fixture timeline for the server-vs-browser Remotion parity check.
 *
 * The same object is passed to `@remotion/renderer` (through Root.tsx's
 * inputProps) and to `@remotion/web-renderer` (as component props). It
 * deliberately covers every composition path that used to be renderer
 * specific: keyframed text, a rotated image, clip-path and raster masks, a
 * video with a CSS-filter effect, and audio.
 */

import type { Track } from "@clash/remotion-core";

export const PARITY_WIDTH = 1280;
export const PARITY_HEIGHT = 720;
export const PARITY_FPS = 30;
export const PARITY_DURATION_IN_FRAMES = 120;
export const PARITY_SAMPLE_FRAMES = [15, 45, 75, 105] as const;

export type ParityMediaUrls = {
  still: string;
  clip: string;
  music: string;
};

export type ParityTimeline = {
  compositionWidth: number;
  compositionHeight: number;
  fps: number;
  durationInFrames: number;
  tracks: Track[];
};

export function createParityTimeline(media: ParityMediaUrls): ParityTimeline {
  const duration = PARITY_DURATION_IN_FRAMES;

  return {
    compositionWidth: PARITY_WIDTH,
    compositionHeight: PARITY_HEIGHT,
    fps: PARITY_FPS,
    durationInFrames: duration,
    // Track 0 is the top of the timeline UI. VideoComposition paints the
    // array bottom-up so the top track is last in the DOM.
    tracks: [
      {
        id: "titles",
        name: "Titles",
        category: "text",
        items: [
          {
            // A full-frame tint makes a stacking regression (tracks painting
            // in the wrong order) cost enough pixels to fail the SSIM gate.
            id: "grade",
            type: "solid",
            color: "#1b2a4a",
            from: 0,
            durationInFrames: duration,
            properties: {
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              rotation: 0,
              opacity: 0.18,
            },
          },
          {
            // High-contrast top-track furniture: if DOM order regresses, the
            // browser renderer paints the full-frame video over this bar and
            // the frame SSIM collapses.
            id: "top-bar",
            type: "solid",
            color: "#ff2d55",
            naturalWidth: 1280,
            naturalHeight: 720,
            from: 0,
            durationInFrames: duration,
            properties: {
              x: 0,
              y: 280,
              width: 1,
              height: 0.2,
              rotation: 0,
              opacity: 0.95,
            },
          },
          {
            id: "title",
            type: "text",
            text: "CLASH PARITY",
            color: "#ffffff",
            fontSize: 92,
            fontWeight: 800,
            textAlign: "center",
            letterSpacingPx: 2,
            from: 0,
            durationInFrames: duration,
            properties: {
              x: 0,
              y: -210,
              width: 1,
              height: 1,
              rotation: 0,
              opacity: 1,
            },
            keyframes: {
              opacity: [
                { frame: 0, value: 0, interpolation: "linear" },
                { frame: 18, value: 1, interpolation: "linear" },
              ],
              position: [
                { frame: 0, value: [0, -210], interpolation: "linear" },
                { frame: 60, value: [90, -170], interpolation: "linear" },
              ],
            },
          },
        ],
      },
      {
        id: "rotated-image",
        name: "Rotated image",
        category: "visual",
        items: [
          {
            id: "rotated-still",
            type: "image",
            src: media.still,
            naturalWidth: 640,
            naturalHeight: 360,
            mediaFit: "fill",
            from: 0,
            durationInFrames: duration,
            properties: {
              x: 355,
              y: -185,
              width: 0.3,
              height: 0.3,
              rotation: 18,
              opacity: 0.92,
            },
          },
        ],
      },
      {
        id: "masked-image",
        name: "Clip-path mask",
        category: "visual",
        items: [
          {
            id: "ellipse-masked-still",
            type: "image",
            src: media.still,
            naturalWidth: 640,
            naturalHeight: 360,
            mediaFit: "fill",
            from: 0,
            durationInFrames: duration,
            properties: {
              x: -355,
              y: 165,
              width: 0.3,
              height: 0.3,
              rotation: -8,
              opacity: 1,
            },
            mask: {
              shape: "ellipse",
              position: [50, 50],
              size: [72, 72],
              rotation: 25,
              feather: 0,
              inverted: false,
            },
          },
        ],
      },
      {
        id: "feathered-mask",
        name: "Raster mask",
        category: "visual",
        items: [
          {
            id: "feathered-inverted-still",
            type: "image",
            src: media.still,
            naturalWidth: 640,
            naturalHeight: 360,
            mediaFit: "fill",
            from: 0,
            durationInFrames: duration,
            properties: {
              x: -355,
              y: -165,
              width: 0.28,
              height: 0.28,
              rotation: 10,
              opacity: 1,
            },
            mask: {
              shape: "rectangle",
              position: [50, 50],
              size: [78, 78],
              rotation: 18,
              feather: 14,
              inverted: true,
            },
          },
        ],
      },
      {
        id: "main-video",
        name: "Main video",
        category: "visual",
        items: [
          {
            id: "warm-film-clip",
            type: "video",
            src: media.clip,
            from: 0,
            durationInFrames: duration,
            sourceStartInFrames: 15,
            effects: [
              {
                effectId: "clash/warm-film",
                effectVersion: 1,
                params: { intensity: 0.6 },
              },
            ],
          },
        ],
      },
      {
        id: "music",
        name: "Music",
        category: "audio",
        items: [
          {
            id: "tone",
            type: "audio",
            src: media.music,
            from: 0,
            durationInFrames: duration,
            audioGainDb: -6,
          },
        ],
      },
    ] as Track[],
  };
}
