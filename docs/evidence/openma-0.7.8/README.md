# OpenMA common — Backchat disclosure evidence

**Clash pin:** `@openma/common` **v0.7.9** (`afc628e5`) — includes install.json version / install-state fix ([openma-ai/openma-common#28](https://github.com/openma-ai/openma-common/pull/28)).

**Screenshots below** were captured while pinned to **v0.7.8** (disclosure alignment/hover UX unchanged in v0.7.9; no full matrix re-run for this bump).

Captured with `scripts/e2e/copilot-disclosure-real-ui.ts` (Mock ACP, real project editor).

## Alignment (backchat #45 / openma confirmed)

**Pass:** left edge of the row’s **leading icon** within **1px** of the answer body text left edge.

**Expected (not a Clash bug):** summary label sits **after** the icon (+20px tool group, +26px process with Clash persona slot). Row chrome left edge matches body (0px). Clash does not override disclosure padding/color.

Regenerate:

```bash
OPENMA_EVIDENCE_VERSION=v0.7.8-after pnpm exec tsx scripts/e2e/copilot-disclosure-real-ui.ts
```

Master baseline (`origin/master`, `@openma/common` v0.7.6) — same harness and 4-tool mock; use `CLASH_E2E_STUB_ACP_YIELD_MS=15` so the legacy pin finishes the turn. v0.7.6 does not render the grouped **「已执行 N 项操作」** tool-summary row (tool captures skipped; process rows + alignment guides still captured).

```bash
CLASH_E2E_STUB_ACP_YIELD_MS=15 OPENMA_EVIDENCE_VERSION=v0.7.6-before pnpm exec tsx scripts/e2e/copilot-disclosure-real-ui.ts
```

Published copies land under `real-ui/<versionLabel>/` in this directory and `/opt/cursor/artifacts/openma-0.7.8/real-ui/<versionLabel>/`.
