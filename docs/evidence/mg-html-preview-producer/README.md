# Evidence: HTML PreviewFrameProducer live Timeline paint (#447)

**Date:** 2026-10-27 (America/Detroit)  
**Clock:** Remotion Player remains time authority for Remotion items. HTML-only uses local `html-scene` producer clock. **No audio-master-clock.**

## Unit

```bash
pnpm --filter @clash/remotion-components exec vitest run src/html-scene
# 1 file, 5 tests passed
pnpm --filter @clash/remotion-ui exec vitest run src/preview-host/htmlSceneProducer.test.ts
# 1 file, 5 tests passed
pnpm --filter @clash/remotion-components typecheck  # exit 0
pnpm --filter @clash/remotion-ui typecheck          # exit 0
```

## UI

| Shot | File |
| --- | --- |
| html-scene producer paint (no Remotion Player) | [`01-html-scene-producer-paint.png`](./01-html-scene-producer-paint.png) |
| Stage / sandboxed iframe | [`02-html-scene-stage.png`](./02-html-scene-stage.png) |

## Agent (Clash Agent = dsh-acp + DeepSeek Flash — not a coding agent)

| Shot / artifact | File |
| --- | --- |
| DeepSeek Harness enabled | [`00-agents-dsh-enabled.png`](./00-agents-dsh-enabled.png) |
| Harness picker | [`01-harness-menu-deepseek-flash.png`](./01-harness-menu-deepseek-flash.png) |
| Flash transcript | [`07-agent-transcript-snippet.txt`](./07-agent-transcript-snippet.txt) |

Flash confirmed: html-scene producer + sandbox; HTML-only without Player; mixed keeps Player clock for Remotion; no audio-master-clock; #448/#449 out of scope.

Spike: `docs/spikes/mg-html-preview-producer-447.md`.
