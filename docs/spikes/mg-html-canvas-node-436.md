# Spike slice: Canvas `html-motion` node (#436)

**Date:** 2026-10-27 (America/Detroit)  
**Parent:** #436 / epic #434  
**Prior DSL slice:** #439 / #440 (`docs/spikes/mg-html-remotion-dual-436.md`)  
**Clock:** Remotion Player remains time authority for Remotion MG. HTML MG does **not** introduce an audio-master-clock.

## Decision

**Distinct Canvas node type** `html-motion` (peer of `remotion-component`), not a `runtime` discriminant on the Remotion node.

| Surface | Remotion | HTML Motion |
| --- | --- | --- |
| Canvas RF type | `remotion-component` | `html-motion` |
| Agent create key | `remotion` | `html_motion` |
| Source field | `data.content` (TSX) | `data.content` (HTML document) |
| Identity field | `componentId` | `documentId` |
| Timeline live ref | `sourceNodeId` + `runtime: remotion` | `sourceNodeId` + `runtime: html` + `compositionKind: motion-graphics` |

Timeline still stores **no** HTML snapshot — only `sourceNodeId`.

## Hilo references (isolation / capacity — not clock)

From Hilo `html-motion-interactive-hosting.md` (Mac checkout):

| Pattern | Clash adoption in this slice |
| --- | --- |
| Sandbox `allow-scripts`, no `allow-same-origin`; no `srcDoc` for production | Documented for the upcoming iframe PreviewHost; Canvas node stores HTML only (placeholder preview in-node) |
| Capacity bounds (2e6 bytes/doc, 16/owner, 128 agg, 16e6 agg bytes) | Exported as `HTML_MOTION_*` constants in `@clash/shared-types` for hosts to fail closed |
| Channel = correlation, not credential | Aligns with `clash.preview-host.v1` protocol on #435 |
| ACK ≠ animation clock tick | Explicit non-goal: no clock swap |

## Shipped here

- `RF_NODE_TYPE.HtmlMotion` + `AGENT_NODE_TYPE_MAP.html_motion` + `documentId` on `NodeDataSchema`
- Capacity constants
- `appendHtmlMotionToTimelineState` / `deriveHtmlMotionConnectionUpdate`
- `HtmlMotionNode` (edit HTML; placeholder preview until isolation host wires iframe)
- Create menu + ProjectEditor create/size/connect
- CLI projection kind `html-motion` → `projections/html-motion/*.html`
- This spike note

## Explicit non-goals

- Sandboxed cross-site iframe live Canvas/Timeline paint (uses #435 `PreviewHost`)
- Export of HTML MG items
- Agent skill / package-boundary reopen of banned HTML MG tokens
- Legacy `spec` / `renderedAssetPath` migration
- Audio master clock

## Next

1. Wire `html-motion` producer into `PreviewHost` iframe (CSP + capacity enforcement).
2. Timeline live paint for `runtime: html` compositions.
3. Export parity rules.
4. Deliberate skill/eval contract update when authoring is ready.
