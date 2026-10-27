# PreviewHost UI Evidence (#442 / #441)

- `01-preview-probe-main-thread.png` — Remotion Player preview probe page (producer that PreviewHost hosts).
- Isolation path: cross-site iframe (see `preview-iframe-longtask.ts` + spike report); no audio master clock.
- Agent-side MG evidence for dual runtime lives under `docs/evidence/mg-dual-runtime/` (dsh + DeepSeek Flash as Clash Agent).
