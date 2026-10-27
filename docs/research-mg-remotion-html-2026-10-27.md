# Phase plan / research: Clash MG — Remotion + HTML dual support, preview Worker sink

**Date:** 2026-10-27 (America/Detroit)  
**Status:** Research + phase scoping (not a product decision lock beyond the two in-scope tracks)  
**Related (do not edit):** [`effect-systems-chatcut-remotion-hyperframes.md`](./effect-systems-chatcut-remotion-hyperframes.md)  
**User decisions (2026-10-27):** Support **both Remotion and HTML** MG; research/plan first; **clock replacement is out of this phase (TBD)**; explore sinking preview render toward a Worker as an incremental track.

> This document is a **phase plan backed by code/docs citations**. It does not pick a final clock, does not open implementation PRs by itself, and does not scope to a single host or defer one deployment target.

## Tracking

| Issue | URL |
| --- | --- |
| Epic | https://github.com/clash-art/clash/issues/434 |
| Track A — preview Worker / iframe sink | https://github.com/clash-art/clash/issues/435 |
| Track B — Remotion + HTML dual MG | https://github.com/clash-art/clash/issues/436 |

Doc path in repo (when committed): `docs/research-mg-remotion-html-2026-10-27.md`


---

## 1. Goal & non-goals

### Goal (this phase)

Product-level Clash Motion Graphics must support **both**:

1. **Remotion MG** (current live path, keep working), and  
2. **HTML MG** (rehabilitate a first-class path; today actively rejected for `motion-graphics`).

And as an engineering track in the same phase:

3. **Sink preview rendering toward a Worker** (or Worker-adjacent isolation: dedicated iframe / OffscreenCanvas where Worker alone is insufficient), so Timeline/Canvas preview work is less main-thread bound — **without** assuming an audio-master-clock swap.

### Non-goals / Out of scope (this phase)

| Item | Why out |
| --- | --- |
| **Clock replacement** (audio master clock, media-time origin = first video frame, `clockLeadMs`, video-never-holds-clock) | Explicitly **TBD**. Document options only (see §6). Do **not** write AC that requires swapping clocks. Worker sink must not depend on audio-master-clock. |
| New full composition engine rewrite as a hard requirement | Research options only (§5); dual-runtime product support can start on current Remotion Player + a defined HTML preview/export adapter. |
| Large production cutover / deleting Remotion path | Remotion remains a supported runtime. |
| Hyperframes / ChatCut / gl-transitions catalog absorption | Prior effect research still open (Phase 2–4 in effect-systems doc); orthogonal unless needed as HTML→texture adapter. |
| Single-host / deferred-host scoping | Anti-pattern; browser + desktop + existing container export paths stay in the picture. |

### In-scope summary

| Track | In this phase |
| --- | --- |
| A. Preview Worker sink | Move / isolate preview frame production off the editor UI thread where feasible; measure before/after; Remotion + future HTML preview both considered. |
| B. Remotion + HTML dual MG | Product contract, schema, Canvas node types, Timeline runtime, authoring/agent/library, preview + export for **both** runtimes. |

---

## 2. Clash status quo (Remotion vs HTML bans)

### Live Remotion path (current contract)

Documented product path (effect-systems, 2026-08-07 contract still in tree):

```text
Remotion TSX → Canvas remotion-component → Timeline sourceNodeId → Timeline render
```

Cited:

- `docs/effect-systems-chatcut-remotion-hyperframes.md` (header + §4)  
- `docs/timeline-dsl.md` (`compositionKind` / motion-graphics → live Remotion Canvas)  
- `docs/video-image-skill-market-research.md` (same single path)  
- `packages/web-ui/src/lib/remotionComponentTimeline.ts` — Timeline stores **no** source snapshot; `sourceNodeId` is identity; preview/export resolve Canvas `data.content` at start  
- Agent skill: `plugins/clash/skills/clash-mg-character/SKILL.md` — default-export single-file Remotion TSX only  

Runtime wiring:

- Timeline composition: `runtime: "remotion"` + non-empty `sourceNodeId`  
- Validation: `packages/shared-types/src/timeline-dsl-semantics.ts` (~740–761)  
  - `motion-graphics` **must** use Remotion + live Canvas `sourceNodeId`  
  - Remotion **requires** `sourceNodeId`  
- YAML reject of legacy HTML MG: `packages/shared-types/src/timeline-yaml.test.ts` (“rejects the legacy HTML MG authoring contract before timeline apply”)  
- Enum still lists `["html", "react", "remotion"]` in `TIMELINE_COMPOSITION_RUNTIMES` (`timeline-field-annotations.ts`) — HTML exists as a **legacy enum value**, not a supported MG authoring path.

### HTML / legacy MG actively banned

Fail-closed signals in-repo:

| Layer | Behavior | Path |
| --- | --- | --- |
| DSL semantics | `motion-graphics` + non-`remotion` → issue `timeline.composition.preview-contract` | `timeline-dsl-semantics.ts` |
| YAML apply | Same reject message | `timeline-yaml.test.ts` |
| Package / skill boundary | MG skill must **not** mention `render-mg`, `verify-mg-preview`, `export-mg`, `MgCompositionSpec`, `runtime: html`, `rasterizer`, `spec.json` | `plugins/clash/src/package-boundary.test.ts` |
| Artifact evals | Same banned tokens | `packages/shared-artifact-evals/src/index.test.ts` |
| UI copy | Properties panel distinguishes live Remotion vs “legacy composition … declared runtime or rendered asset fallback” | `packages/remotion-ui/src/components/PropertiesPanel.tsx` |

`runtime: "react"` still has a **legacy** preview contract via local `renderedAssetPath` (pre-rendered asset), not a live HTML scene.

### Preview / transport today (main-thread Remotion Player)

| Surface | What runs | Path |
| --- | --- | --- |
| Timeline preview | `@remotion/player` `<Player>` hosting `VideoComposition`; **Player drives its own clock** | `packages/remotion-ui/src/components/InteractiveCanvas.tsx` (~374–391, comment: “The Player drives its own clock”) |
| Preview chrome / transport | Play intent vs Player-reported transport (play/pause/buffering/error) | `CanvasPreview.tsx`, `playerTransport.ts` |
| Canvas remotion-component node | Separate `<Player>` + `RemotionSourceComposition` / inline compile | `packages/web-ui/src/components/nodes/RemotionComponentNode.tsx`, `packages/remotion-components/src/inline-remotion-source.tsx` |
| Export (browser, decided 2026-10-17) | Prefer browser export; Worker for encode when possible; if Remotion frame draw cannot run in Worker → **iframe draw + Worker encode**; fallback Cloudflare Container | User decision / memory — implement in export work, not this plan’s clock track |

**Implication for Worker sink:** Timeline preview is **DOM + React + Remotion Player on the editor main thread** (or the renderer process’s UI thread in Electron). There is no dedicated preview Worker today.

---

## 3. Peer / Hilo architecture points worth studying

### From prior Clash research (on-box, verified)

Source: `docs/effect-systems-chatcut-remotion-hyperframes.md`

| System | Point for dual MG / preview |
| --- | --- |
| **Remotion** | Unified effect graph, canvas pool, Player/renderer; Clash already invested. HTML-in-canvas for some transition presentations needs capability gates. |
| **Hyperframes** | DOM→texture (`drawElementImage` / `html2canvas` fallback), seek/clone/paint/capture protocol, worker pool + reorder buffer for deterministic export. Strong reference for **HTML scene as texture** into a compositor. |
| **ChatCut** | Catalog-first Agent protocol; MG code as asset, instance on timeline — useful for Library/agent apply contracts once HTML is a peer artifact type. |
| Open phases | Effect-systems Phase 2–4 (Timeline source adapter, effect graph, Agent authoring) still open; HTML dual support may **reuse** a DOM capture adapter without waiting on full Phase 4. |

### Hilo (reported from local inspection — verify before designing)

Parent inspected `/Users/minimax/Proj/hilo-agent-opencode/clip-startup-recovery` on the user’s Mac. **No full Hilo tree is on this box** (`/workspace/hilo-test` is unrelated image fixtures only). Treat the following as **“reported from local inspection”** until re-verified:

| Area | Reported fact |
| --- | --- |
| HTML MG preview service | Sandboxed Electron, offscreen frames, shared texture, capacity / LRU |
| engine-v2 | Worker + **audio master clock**; `clockLeadMs` ~4ms drift; **video never holds clock**; media time origin = first video frame |
| Active WIP | `mg-edit-session-convergence`, timeline motion native surface |

**Use for this phase:** preview isolation patterns (offscreen / shared texture / capacity) and Worker placement — **not** the audio-master-clock design (out of scope).

---

## 4. Capability gap matrix

Legend: ✅ supported · ⚠️ partial / legacy · ❌ banned or missing · 🔍 research

| Capability | Remotion (today) | HTML (today) | Dual-support target (this phase) |
| --- | --- | --- | --- |
| **Canvas node** | ✅ `remotion-component` + inline TSX compile | ❌ no first-class HTML MG node (legacy path rejected) | ✅ peer node types or one node with `runtime` discriminant; live source identity |
| **Timeline live preview** | ✅ Player + `sourceNodeId` | ❌ `motion-graphics` + `runtime: html` rejected | ✅ both runtimes preview on Timeline; shared transport UI |
| **Export** | ✅ Timeline Remotion render (+ browser export track / container fallback) | ❌ banned MG export commands / specs in skills & evals | ✅ export for both; preview/export parity rules documented |
| **Authoring (human)** | ✅ Canvas editor + Properties | ⚠️ legacy composition inspector only | ✅ edit HTML MG sources with clear UX (sandbox constraints TBD) |
| **Agent** | ✅ skills force Remotion-only TSX | ❌ HTML tokens fail package-boundary / evals | ✅ agent may choose Remotion **or** HTML MG; catalog-first still preferred |
| **Library** | ✅ MG → Remotion Canvas apply | ❌ HTML MG library apply invalid | ✅ Library items declare runtime; apply creates correct Canvas + Timeline link |

---

## 5. Native engine options (research only — no pick)

| Option | Idea | Pros | Cons / risks |
| --- | --- | --- | --- |
| **A. Reuse Remotion Player + adapters** | Keep Player as Remotion preview; HTML MG → texture/frames fed into composition or overlay pipeline | Least disruption; Remotion export path stays | Remotion-centric clock/transport; HTML may be second-class unless capture quality is high |
| **B. New composition engine** | Timeline compositor owns frames; Remotion and HTML are scene producers | Clean dual-runtime; closer to Hilo native surface | Large build; overlaps clock TBD; easy to over-scope |
| **C. Hybrid** | Remotion Player for Remotion items; HTML offscreen/Worker producer; shared Timeline transport façade | Incremental; matches dual product story | Two preview stacks to keep in sync; need clear frame/time contract **without** mandating audio-master-clock |

This phase can ship **product dual support** under A or C; B stays a longer-term option. **No engine pick locked here.**

---

## 6. Clock options (tradeoffs only — **no pick**; out of phase)

> Clock replacement is **out of scope** for this phase. Worker sink and dual MG must work with the **current Remotion Player clock** (and whatever HTML preview clock is introduced locally) without requiring a global audio-master-clock.

| Option | Description | Pros | Cons |
| --- | --- | --- | --- |
| **Keep Remotion / Player clock** | Status quo: Player advances frames; editor syncs seek/play intent | Known behavior; no migration | A/V drift cases; HTML peer must slave or duplicate |
| **Audio master clock** (Hilo-style, reported) | Audio is authority; video follows; media-time origin = first video frame; small lead (`clockLeadMs`) | Better A/V for editorial | Cross-cutting; couples Worker sink to clock rewrite if forced early |
| **Hybrid** | Player clock for Remotion preview; optional audio-led path behind flag later | Phased | Two semantics; risk of inconsistency |

**Phase rule:** document measurements (drift, stall) if useful; **do not** block Track A/B on choosing among these.

---

## 7. Preview Worker sink (dedicated research angle)

### What Clash preview runs on today

1. **Timeline:** `Editor` → `CanvasPreview` → `InteractiveCanvas` → `@remotion/player` `Player` + `VideoComposition` on the **UI/main thread**. Transport facts come from Player events (`playerTransport.ts`).  
2. **Canvas node:** `RemotionComponentNode` mounts its own `Player` for component preview.  
3. **Clock:** explicitly Player-owned (`InteractiveCanvas.tsx` comment).  
4. **No** preview Worker / shared-texture service in Clash tree today.

### What Hilo does (contrast — reported)

Offscreen / sandboxed HTML MG preview, shared texture, capacity LRU; engine Worker with audio master clock. **Clock part is out of scope**; isolation + capacity patterns are in-scope inspiration.

### Feasibility of sinking Remotion and/or HTML preview into a Worker first

| Approach | Feasibility | Notes |
| --- | --- | --- |
| Full Remotion `Player` inside a **Dedicated Worker** | 🔍 Low–medium | Player expects DOM/`document`; typical Remotion preview is not Worker-native. |
| Remotion preview in **iframe** (or nested BrowserWindow / offscreen webContents on desktop) | 🔍 Medium–high | Aligns with browser-export decision: draw in iframe when Worker cannot host Remotion draw; UI thread only composites / blits. |
| Remotion frame pump via **OffscreenCanvas** + Worker | 🔍 Medium | Depends on Remotion/React constraints; may still need a hidden DOM document. |
| **HTML MG** preview in Worker / offscreen document → ImageBitmap / shared texture | 🔍 Medium–high | Closer to Hyperframes/Hilo; natural first Worker win if HTML path is reintroduced. |
| Encode-only Worker (export) | Already decided direction for browser export | Do not confuse export encode Worker with **preview** sink — related isolation ideas, different UX latency budget. |

**Constraints (must respect):**

- Do not assume audio-master-clock.  
- Remotion DOM needs must be stated explicitly in spike results (Player vs headless frame API).  
- Main-thread responsiveness: measure before/after (same spirit as 2026-10-17 browser export decision).  
- Capacity / LRU if multiple MG previews (Hilo-reported pattern) — design note only until spike.

### Pros / cons (Worker sink track)

| Pros | Cons |
| --- | --- |
| Editor UI jank ↓ during heavy MG preview | Remotion may force iframe/offscreen DOM, not a pure Worker |
| Sets up HTML MG offscreen path early | Two preview hosts to maintain until unified |
| Shares lessons with browser export isolation | Easy to accidentally pull clock rewrite into scope |

### Worker-track open questions

- Can `@remotion/player` be driven from a non-visible iframe with acceptable seek latency?  
- Is OffscreenCanvas usable for Clash’s `VideoComposition` path on our Electron/Chromium versions?  
- Should Canvas-node preview and Timeline preview share one preview service?  
- What’s the blit path into the existing `InteractiveCanvas` overlay/selection UI?

---

## 8. Acceptance-style bullets (phase tracks)

### Track A — Preview Worker sink

- [ ] Document current preview call graph with file citations (done in this note; keep updated as code moves).  
- [ ] Timeboxed spike: Remotion Timeline preview isolation (Worker **or** iframe/offscreen) **without** clock swap; report what cannot run in a Worker.  
- [ ] Timeboxed spike: HTML offscreen/Worker frame production sketch (no product UI required).  
- [ ] Before/after main-thread responsiveness metric for at least one Remotion MG timeline preview scenario.  
- [ ] Explicit non-goal in PRs: no audio-master-clock dependency.  
- [ ] If iframe path is chosen for Remotion, align naming/architecture notes with browser-export iframe draw (no duplicate conflicting services without a plan).

### Track B — Remotion + HTML product dual support

- [ ] Product contract: MG may be Remotion **or** HTML; Remotion path remains valid.  
- [ ] Schema/DSL: lift or replace the fail-closed rule that `motion-graphics` ⇒ Remotion-only (`timeline-dsl-semantics.ts`); define HTML live identity (Canvas node / source fields) parallel to `sourceNodeId`.  
- [ ] Stop treating HTML MG skill/eval tokens as permanently banned once the new contract exists (update `package-boundary.test.ts` / artifact evals deliberately — not silent reopen of deleted `MgCompositionSpec` without a new contract).  
- [ ] Canvas: author + preview HTML MG; Timeline: live preview for HTML MG items.  
- [ ] Export: HTML MG items render in Timeline export (browser and/or existing container path) with documented parity rules.  
- [ ] Agent + Library: apply contracts for both runtimes; no single-backend-only wording.  
- [ ] Legacy `runtime: html` / `react` + `renderedAssetPath` behavior documented (migrate vs coexist).

### Explicitly **not** AC

- [ ] ~~Replace Player clock with audio master clock~~  
- [ ] ~~Lock Hyperframes or Hilo engine-v2 as the compositor~~  
- [ ] ~~“Ship on one host; defer the other”~~

---

## 9. Open questions for the user

1. HTML MG **source shape**: single HTML document, React-in-iframe, or constrained “MG HTML package” (HTML+CSS+assets)?  
2. Should HTML MG share the same Canvas node kind with a `runtime` field, or a distinct node type?  
3. Minimum HTML preview fidelity for v1 (DOM/CSS only vs canvas/WebGL inside the page)?  
4. Is iframe-isolated Remotion preview acceptable as the first “Worker sink” milestone if pure Worker is blocked?  
5. Library/agent: should catalog items be runtime-tagged, or dual-published Remotion+HTML pairs?  
6. When (if ever) to schedule a **separate** clock phase — after dual preview is green, or only if A/V metrics demand it?

---

## 10. Suggested next research spikes (timeboxed — not implementation epics)

| Spike | Budget (suggest) | Output |
| --- | --- | --- |
| S1 Remotion preview isolation | 0.5–1 day | Can Player live in iframe/offscreen? Seek latency? What APIs touch `document`? |
| S2 HTML offscreen capture | 0.5–1 day | Minimal HTML scene → ImageBitmap/texture; list Chromium capability gates (relate Hyperframes adapter notes). |
| S3 Schema dual-runtime sketch | 0.5 day | Proposed Timeline/Canvas fields for HTML live source; migration for rejected YAML fixtures. |
| S4 Agent/Library contract sketch | 0.5 day | Apply matrix Remotion\|HTML × Library\|Agent; list tests to invert (`package-boundary`, evals). |
| S5 Clock measurement only | optional, ≤0.5 day | Measure current Player A/V drift on one project — **data for later**, no swap. |

---

## 11. References (paths)

- `docs/effect-systems-chatcut-remotion-hyperframes.md`  
- `docs/timeline-dsl.md`  
- `docs/video-image-skill-market-research.md`  
- `packages/shared-types/src/timeline-dsl-semantics.ts`  
- `packages/shared-types/src/timeline-yaml.test.ts`  
- `packages/shared-types/src/timeline-field-annotations.ts` (`TIMELINE_COMPOSITION_RUNTIMES`)  
- `packages/remotion-ui/src/components/InteractiveCanvas.tsx`  
- `packages/remotion-ui/src/components/CanvasPreview.tsx`  
- `packages/remotion-ui/src/components/playerTransport.ts`  
- `packages/web-ui/src/components/nodes/RemotionComponentNode.tsx`  
- `packages/web-ui/src/lib/remotionComponentTimeline.ts`  
- `packages/remotion-components/src/inline-remotion-source.tsx`  
- `plugins/clash/skills/clash-mg-character/SKILL.md`  
- `plugins/clash/src/package-boundary.test.ts`  
- Hilo (reported): `/Users/minimax/Proj/hilo-agent-opencode/clip-startup-recovery` — not mirrored on box  

---

## Changelog

- **2026-10-27:** Initial research note; user locked phase in-scope = Worker sink + Remotion/HTML dual support; clock TBD out of scope; Worker section added per steering.
