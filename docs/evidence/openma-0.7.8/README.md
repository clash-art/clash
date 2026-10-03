# OpenMA common v0.7.8 — Backchat disclosure evidence

Captured with `scripts/e2e/copilot-disclosure-real-ui.ts` (Mock ACP, real project editor).

## Alignment (backchat #45 / openma confirmed)

**Pass:** left edge of the row’s **leading icon** within **1px** of the answer body text left edge.

**Expected (not a Clash bug):** summary label sits **after** the icon (+20px tool group, +26px process with Clash persona slot). Row chrome left edge matches body (0px). Clash does not override disclosure padding/color.

Regenerate:

```bash
OPENMA_EVIDENCE_VERSION=v0.7.8-after pnpm exec tsx scripts/e2e/copilot-disclosure-real-ui.ts
```

Master baseline (`origin/master`, `@openma/common` v0.7.6):

```bash
# after checking out master pins temporarily
CLASH_E2E_STUB_ACP_YIELD_MS=15 OPENMA_EVIDENCE_VERSION=v0.7.6-before pnpm exec tsx scripts/e2e/copilot-disclosure-real-ui.ts
```

Published copies land under `real-ui/<versionLabel>/` in this directory and `/opt/cursor/artifacts/openma-0.7.8/real-ui/<versionLabel>/`.
