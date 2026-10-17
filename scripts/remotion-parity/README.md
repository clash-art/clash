# Remotion server/browser parity

`pnpm test:remotion-parity` runs the same fixture `VideoComposition` through
both renderers and compares each sample frame with SSIM:

- **Server**: `@remotion/bundler` builds
  `packages/remotion-components/src/Root.tsx` (the same entry point and bundle
  approach as `apps/render-server`), then `@remotion/renderer` `renderStill`
  paints the requested frame.
- **Browser**: Vite builds `scripts/remotion-parity/browser` around the real
  composition, `@remotion/web-renderer` `renderStillOnWeb` paints the frame in
  headless Chromium launched through Playwright, and the PNG is sent back to
  Node.

The fixture timeline covers keyframed text, a rotated image, an unfeathered
clip-path mask, a feathered/inverted raster mask, a video with
`clash/warm-film`, and audio. All media is generated locally by ffmpeg at run
time (`still.png`, `clip.mp4`, `music.wav`); no network or checked-in media is
used.

## SSIM

Frames are compared as full-chroma `yuv444p` because ffmpeg's default
`ssim` path subsamples to yuv420p and under-reports PNG-vs-PNG parity. If the
`ssim` filter is unavailable (or `PARITY_SSIM_ENGINE=js` is set), the script
falls back to a small sharp-based SSIM implementation (sharp is already a
repository dependency). ffmpeg itself is still required to generate the
fixture media.

The gate is **SSIM >= 0.95 per sample frame** (`PARITY_SSIM_THRESHOLD`
overrides it).

Measured on 2026-10-17, 1280x720, sample frames 15/45/75/105:

| Variant | SSIM per frame | Average |
| --- | --- | --- |
| Fixed composition (DOM track order, clip-path/raster masks, `@remotion/media`) | 0.9925, 0.9924, 0.9914, 0.9911 | **0.9918** |
| Legacy stacking (`z-index` + top-first DOM order) | 0.8725, 0.8692, 0.8731, 0.8724 | **0.8718** |
| Legacy `OffthreadVideo` composition | browser render fails before producing a frame | n/a |

The 0.95 threshold sits between the two measured populations with margin on
both sides. The legacy stacking fixture is intentionally high-contrast (a
full-frame tint plus a top-track bar) so a regression cannot hide behind the
mostly-unchanged video pixels.

## Environment

- `PARITY_BROWSER_EXECUTABLE` (or `REMOTION_BROWSER_EXECUTABLE`) pins a browser
  path. Otherwise `@remotion/renderer`'s `ensureBrowser()` downloads
  Chromium 157.0.8080.0, the build pinned by Remotion 4.0.536.
- `FFMPEG_PATH` overrides ffmpeg detection; otherwise `ffmpeg` on `PATH` or
  `ffmpeg-static` is used.
- `PARITY_TEMP_DIR` moves intermediate bundles and frames (useful locally).
- `PARITY_KEEP_TEMP=1` keeps the temp directory for inspection.
