# Spike cutover: Remotion Timeline preview → PreviewHost iframe (#435)

**Date:** 2026-10-27 (America/Detroit)  
**Parent:** #435 / epic #434  
**Prior scaffold:** `docs/spikes/mg-preview-worker-435.md` (#441 / #442)  
**Clock:** Remotion Player remains time authority. **No audio-master-clock.**

## What this slice ships

1. Protocol `clash.preview-host.v1` mount carries optional `tracks` / `allNodes` plus required `parentOrigin`; host waits for frame `ready` before mount (render-frame handshake pattern).
2. Vite entry `preview-frame.html` + `apps/web/app/preview-frame/main.tsx` mounts `@remotion/player` + `VideoComposition` and speaks the protocol.
3. `IframedRemotionPreview` + `resolvePreviewHostConfig()` — CanvasPreview opts into iframe mode when:
   - `VITE_PREVIEW_HOST_MODE=iframe`
   - `VITE_PREVIEW_FRAME_ORIGIN` is set (different site for OOPIF)
4. Before/after long-task Evidence: editor parent **583 ms → 0 ms** total long-task time over 4 s; work retained in the frame (~603 ms). See `docs/evidence/mg-preview-iframe-cutover/`.

## Explicit non-goals (still open)

- ~~Full InteractiveCanvas transform overlays / audio meter~~ → see `mg-preview-iframe-overlays-449.md` (#449).
- HTML `PreviewFrameProducer` implementation for `html-motion` live paint (#447).
- Conflating preview with browser-export encode Worker.
- Audio master clock / media-time realignment.

## Hilo notes (isolation only — not clock)

Borrowed from `clip-startup-recovery` interactive hosting: sandboxed iframe, capacity fail-closed, postMessage as correlation. Remotion preview frame currently uses `allow-scripts allow-same-origin` because the frame site must load its own module graph; HTML MG producers must tighten to Hilo-style `allow-scripts` without same-origin when they land.

## How to try locally

```bash
# Terminal A — serve preview-frame on 127.0.0.1 (different site from localhost editor)
pnpm --filter @clash/web exec vite --host 127.0.0.1 --port 5183

# Terminal B — editor on localhost with iframe preview
VITE_PREVIEW_HOST_MODE=iframe \
VITE_PREVIEW_FRAME_ORIGIN=http://127.0.0.1:5183 \
pnpm --filter @clash/web dev -- --host localhost --port 5173
```
