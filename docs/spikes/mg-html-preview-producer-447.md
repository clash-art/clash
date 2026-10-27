# Spike / slice: HTML PreviewFrameProducer live Timeline paint (#447)

**Date:** 2026-10-27 (America/Detroit)  
**Parent:** #434 / Track B remainder after #440 + #444 (#436 closed)  
**Depends on:** PreviewHost iframe cutover (#446 / #435)  
**Clock:** Remotion Player remains time authority for Remotion items. HTML MG uses a **local** producer clock (`html-scene`) or Sequence-local frame when layered inside VideoComposition. **No audio-master-clock.**

## Goal

Wire `html-motion` / `runtime: html` Timeline items into live preview via `clash.preview-host.v1`, with Hilo-style sandbox/CSP.

## Design

| Surface | Behaviour |
| --- | --- |
| `PreviewFrameProducer` `kind: "html-scene"` | Sandboxed iframe(s), blob: URL, capacity fail-closed, owns rAF clock on `play()` |
| Mixed Timeline (Remotion + HTML) | Remotion `Player` + `VideoComposition`; HTML items render `HtmlSceneSurface` (not Remotion JSX compile) |
| HTML-only Timeline | preview-frame skips Player; mounts `createHtmlSceneProducer` |
| Sandbox | `allow-scripts` **without** `allow-same-origin`; CSP meta; bootstrap seeks via `clash.html-scene-doc.v1` |
| Protocol to editor | Still `clash.preview-host.v1` (not export `clash.timeline-render.v1`) |

## Hilo references (isolation — not clock)

- Sandbox without same-origin; capacity bounds (`HTML_MOTION_*`); channel = correlation.
- ACK ≠ animation clock tick.

## Explicit non-goals

- InteractiveCanvas overlay parity on iframe (see #449)
- Export / Agent / Library contracts (see #448)
- Audio master clock
- Reopening banned `MgCompositionSpec` / `render-mg` skill tokens

## Evidence

See `docs/evidence/mg-html-preview-producer/`.
