# Spike: InteractiveCanvas overlays on iframe PreviewHost (#449)

**Date:** 2026-10-27 (America/Detroit)  
**Parent:** #435 / epic #434  
**Prior:** iframe cutover `mg-preview-iframe-cutover-435.md` (#446)  
**Clock:** Remotion Player in the frame remains time authority. **No audio-master-clock.**

## Goal

When `VITE_PREVIEW_HOST_MODE=iframe`, restore InteractiveCanvas overlay parity
(selection handles, scrub hit targets, pan/zoom, minimap, audio meter) **without**
pulling Remotion paint back onto the editor UI thread.

## Approach

| Layer | Where it runs |
| --- | --- |
| Remotion Player + `VideoComposition` paint | Cross-site iframe (`preview-frame.html`) |
| Selection handles / item hit targets / snap lines / minimap / pan-zoom | Parent `InteractiveCanvas` |
| Audio meter | Frame samples media → `audio-levels` postMessage → parent store |

`InteractiveCanvas` accepts optional `paintSurface`. When set, it skips mounting
`@remotion/player` and Player sync/listeners; overlays keep using the same
geometry math against `tracks` / `currentFrame`. `CanvasPreview` passes
`IframedRemotionPreview` as `paintSurface` in iframe mode.

Protocol additions on `clash.preview-host.v1` (still clock-free):

- command `set-audio-meter { enabled }`
- event `audio-levels { left, right }`

Cross-origin media is unreachable from the editor document; the frame samples
locally (same Web Audio / `captureStream` pattern as main-thread InteractiveCanvas).

## Hilo notes

Parent-side chrome over an isolated paint surface matches Hilo's split between
trusted shell chrome and sandboxed MG document. Remotion preview still needs
`allow-scripts allow-same-origin` on the frame site for its module graph; HTML
MG producers (#447) should tighten to Hilo `allow-scripts` without same-origin.

## Explicit non-goals

- Audio master clock / media-time realignment  
- HTML live paint (#447)  
- HTML export / Agent contracts (#448)  
- Defaulting iframe mode on without the flag  

## How to try

Same dual-origin setup as the cutover spike; overlays and meter work with the
flag on.
