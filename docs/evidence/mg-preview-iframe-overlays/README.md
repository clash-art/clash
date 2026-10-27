# Evidence: InteractiveCanvas overlays on iframe PreviewHost (#449)

**Date:** 2026-10-27 (America/Detroit)  
**Clock:** Remotion Player in the frame remains time authority. **No audio-master-clock.**

## Unit

```bash
pnpm --filter @clash/remotion-ui exec vitest run src/preview-host \
  src/components/InteractiveCanvas.paint-surface.test.tsx \
  src/components/CanvasPreview.test.tsx
# 6 files, 45 tests passed
pnpm --filter @clash/remotion-ui typecheck  # exit 0
```

## UI

| Shot | File |
| --- | --- |
| Parent selection handles above iframe paint surface | [`01-overlays-on-iframe-paint.png`](./01-overlays-on-iframe-paint.png) |
| Preview frame idle (host page) | [`02-preview-frame-idle.png`](./02-preview-frame-idle.png) |

## Agent (Clash Agent = dsh-acp + DeepSeek Flash — not a coding agent)

| Shot / artifact | File |
| --- | --- |
| DeepSeek Harness enabled | [`00-agents-dsh-enabled.png`](./00-agents-dsh-enabled.png) |
| Harness picker | [`01-harness-menu-deepseek-flash.png`](./01-harness-menu-deepseek-flash.png) |
| Flash transcript | [`07-agent-transcript-snippet.txt`](./07-agent-transcript-snippet.txt) |

Flash confirmed: parent-side overlays via `paintSurface`; Player clock in iframe; `audio-levels` bridge; no audio-master-clock; HTML live paint/export out of scope.
