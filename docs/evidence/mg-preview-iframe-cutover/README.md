# Evidence: MG preview iframe cutover (#435)

**Date:** 2026-10-27 (America/Detroit)  
**Slice:** Wire Timeline Remotion preview behind `PreviewHost` iframe + before/after long-task numbers.  
**Clock:** Remotion Player remains time authority. **No audio-master-clock.**

## Before / after (main-thread responsiveness)

Command:

```bash
CHROME_BIN=/usr/bin/google-chrome pnpm --filter @clash/web test:e2e:preview-longtask
```

| Host | Long tasks | Total long-task ms | Longest (ms) | Frames advanced |
| --- | ---: | ---: | ---: | ---: |
| Main-thread baseline | 9 | **583** | 97 | 120 |
| Cross-site iframe **parent** (editor) | **0** | **0** | 0 | — |
| Cross-site iframe **frame** | 9 | 603 | 87 | 119 |

Raw JSON: [`longtask-results.json`](./longtask-results.json).

Interpretation: Chromium site isolation moved Remotion Player long tasks off the editor renderer. OOPIF confirmed via CDP `Target.getTargets`.

## Product flag

```bash
VITE_PREVIEW_HOST_MODE=iframe
VITE_PREVIEW_FRAME_ORIGIN=http://127.0.0.1:<preview-frame-site-port>
```

Default remains main-thread `InteractiveCanvas`. Same-origin frame origins warn and are not process-isolated (same caveat as `VITE_RENDER_FRAME_ORIGIN` for export).

## Boundary vs browser export

Preview (`preview-frame.html` / `clash.preview-host.v1`) and browser export (`render-frame.html` / `clash.timeline-render.v1`) stay **separate services**. Shared ideas only: cross-site iframe, long-task metrics, postMessage origin checks.

## UI

| Shot | File |
| --- | --- |
| Remotion preview probe (main-thread Player) | [`01-preview-probe-main-thread.png`](./01-preview-probe-main-thread.png) |
| Preview frame idle (protocol host page) | [`02-preview-frame-idle.png`](./02-preview-frame-idle.png) |

## Agent (Clash Agent = dsh-acp + DeepSeek Flash — not a coding agent)

| Shot / artifact | File |
| --- | --- |
| DeepSeek Harness enabled | [`00-agents-dsh-enabled.png`](./00-agents-dsh-enabled.png) |
| Harness picker | [`01-harness-menu-deepseek-flash.png`](./01-harness-menu-deepseek-flash.png) |
| Flash transcript | [`07-agent-transcript-snippet.txt`](./07-agent-transcript-snippet.txt) |

Flash confirmed: Player remains clock owner; isolation is cross-site iframe not Worker; parent longtasks 583→0 ms; no audio-master-clock; preview ≠ export host.
