# Spike: MG preview isolation toward Worker / iframe (#435)

**Date:** 2026-10-27 (America/Detroit)  
**Parent epic:** #434  
**Status:** Spike scaffold landed — isolation contract + metric API; InteractiveCanvas not cut over yet  
**Clock:** Remotion Player remains time authority. **No audio-master-clock** in this work.

Related phase plan: `docs/research-mg-remotion-html-2026-10-27.md` §7 / Track A.

## Findings

### Remotion Player needs DOM / `document`

`@remotion/player` `<Player>` and Clash’s `InteractiveCanvas` / `VideoComposition` path expect a browser document (React mount, CSSOM, media elements). Evidence in-tree:

- `packages/remotion-ui/src/components/InteractiveCanvas.tsx` — mounts `<Player>`; comment: “The Player drives its own clock.”
- Transport facts come from Player events via `playerTransport.ts` / `CanvasPreview.tsx`.

**Pure Dedicated Worker hosting of Remotion Player is blocked** for preview: Workers have no `document`, no full DOM layout, and Remotion Player is not designed as a headless Worker frame pump.

OffscreenCanvas alone does not remove the DOM requirement for Player; it may help later for blit/composite of already-produced frames (see Hilo shared-texture notes below).

### Chosen isolation path (next implementation)

| Mode | Role |
| --- | --- |
| `main-thread` | Today’s behaviour, wrapped in the same `PreviewHost` contract |
| `iframe` | **Chosen first isolation target** — host Remotion Player in a **cross-site** iframe so Chromium site isolation moves long tasks off the editor renderer |

Same-site / `srcdoc` / `blob:` frames do **not** get a separate site; they stay in the editor process. Measurement harness uses `localhost` parent → `127.0.0.1` frame (different sites).

**Worker orchestration** remains a follow-up for encode-adjacent work and for HTML producers that can paint to OffscreenCanvas / ImageBitmap without Player. Preview Remotion stays iframe-first.

### Boundary vs browser-export Worker/iframe

| Surface | Isolation goal | Latency budget |
| --- | --- | --- |
| **Preview** (this issue) | Keep editor UI interactive while MG plays | Frame-by-frame |
| **Browser export** (prior decision) | Draw in iframe if Remotion cannot draw in Worker; encode in Worker | Minutes OK |

**Recommendation:** **separate services, shared protocol ideas.** Do not share one host instance between scrubbing preview and export encode. Shared pieces: cross-site iframe draw pattern, long-task metric shape, postMessage framing vocabulary — not one process lifetime or capacity pool.

### HTML preview producer plug-in

`PreviewFrameProducer` (`packages/remotion-ui/src/preview-host/producer.ts`) is the seam: `kind: "remotion-player" | "html-scene" | …`. Host forwards seek/play/pause; producer owns its clock and reports frames/transport. Track B (#436) can attach an HTML producer without changing editor transport once InteractiveCanvas uses `PreviewHost`.

### Main-thread metric (before/after)

API: `summarizeLongTasks` / `createLongTaskRecorder` → `PreviewMainThreadMetric` (longTasks, totalLongTaskMs, longestLongTaskMs, windowMs).

Harness (not required to run in CI for this spike): `apps/web/e2e/preview-iframe-longtask.ts` + `pnpm --filter @clash/web test:e2e:preview-longtask`. Pattern mirrors `browser-render-longtask.ts` but measures **preview**, not export.

**No fabricated numbers in this PR.** Run the harness on a machine with Chrome when validating cutover.

## Hilo references (borrow isolation / HTML product shape — **not** clock)

Inspected on user Mac (`c15de77c-…`): `/Users/minimax/Proj/hilo-agent-opencode/clip-startup-recovery` and `html-motion-preview`.

| Hilo area | Takeaway for Clash |
| --- | --- |
| `docs/reliability/html-motion-interactive-hosting.md` | Sandboxed iframe (`allow-scripts`, no same-origin), capacity/LRU-style bounds, dedicated interactive surface host, postMessage channel as correlation not credential. Clash preview iframe should plan CSP/sandbox when HTML MG lands. |
| `scratchpad-mg-texture` + Electron `offscreen: { useSharedTexture: true }` | Desktop path for shared-texture blit; relevant later for Electron Clash, not required for first web iframe milestone. |
| `scripts/html-motion-preview-harness` | Separate viewer/editor harness for HTML MG — reinforces preview host as a first-class surface. |
| `engine-v2` / audio master clock | **Out of phase** — do not port clock semantics into Clash preview host. |

## Code landed (this PR)

- `packages/remotion-ui/src/preview-host/` — `PreviewHost`, main-thread + iframe hosts, protocol, metrics, producer seam; unit tests (22).
- `apps/web/e2e/preview-iframe-longtask.ts` (+ probe assets) — measurement harness.
- This spike report.

**Not in this PR:** wiring `InteractiveCanvas` / `CanvasPreview` to `createPreviewHost({ mode: "iframe" })`; real Remotion-in-iframe bundle page; HTML producer implementation.

## Explicit non-goals

- Audio master clock / media-time realignment  
- Deleting main-thread Remotion path  
- Conflating preview with browser-export encode Worker  
- Single-host product scoping  

## Next steps

1. Cross-site iframe page that mounts Clash `VideoComposition` + Remotion Player; wire editor behind a flag.  
2. Run long-task harness; record before/after in Evidence on the cutover PR.  
3. Align HTML producer (#436) with the same host; adopt Hilo-style sandbox CSP for HTML documents.  
4. Optional desktop: evaluate shared-texture OffscreenBrowserWindow for Electron only.
