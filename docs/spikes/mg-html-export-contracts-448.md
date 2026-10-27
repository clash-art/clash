# Spike — HTML MG export + Agent/Library contracts (#448)

- **Status:** Export hydration + dual-runtime Agent/Library contracts
- **Parent:** [#434](https://github.com/clash-art/clash/issues/434) / [#448](https://github.com/clash-art/clash/issues/448)
- **Depends on:** Preview baseline [#447](https://github.com/clash-art/clash/issues/447) (HTML PreviewFrameProducer)

## Decisions

### Export path (browser Timeline + Host fallback)

Browser Timeline export (`clash.timeline-render.v1`) hydrates live HTML MG
items at render start:

1. `CanvasPreview` publishes the latest Canvas/runtime node map via
   `publishTimelineExportNodes`.
2. `createBrowserTimelineRenderExecutor` reads that map, validates readiness,
   stamps render-start-only `htmlSource` onto `runtime: "html"` composition
   items (`hydrateHtmlMotionSourcesForExport`), and passes `allNodes` into the
   render-frame request.
3. `VideoComposition` paints `HtmlSceneSurface` for HTML MG (same surface as
   preview). Remotion MG with unbounded CSS still falls back to Host (existing
   preflight). Missing HTML sources also fall back to Host instead of exporting
   a blank layer.

Host / container `request_timeline_render` remains the fallback and the path
for features the browser composer cannot express. No single-backend scoping.

### Preview / export parity

| Concern | Preview | Export |
| --- | --- | --- |
| Identity | `sourceNodeId` → Canvas `html-motion` | same |
| Protocol | `clash.preview-host.v1` | `clash.timeline-render.v1` |
| Paint | html-scene producer / `HtmlSceneSurface` | `VideoComposition` + `HtmlSceneSurface` |
| Clock | local Player / producer clock | Remotion web-renderer frame clock |
| Snapshot in Timeline | never | never (hydrate only for the render job) |

Constants live in `@clash/web-ui/lib/htmlMotionExport`
(`HTML_MOTION_EXPORT_PARITY`). **No audio-master-clock.**

### Agent authoring

`clash-mg-character` skill teaches dual-runtime authoring:

- Remotion: `--type remotion` / `runtime: remotion`
- HTML: `--type html_motion` / `runtime: html`

Deleted tokens stay banned: `MgCompositionSpec`, `render-mg`, `export-mg`,
`verify-mg-preview`, `rasterizer`, `spec.json`. Boundary + artifact-eval tests
were updated **intentionally** for this contract (not a silent reopen).

### Library apply

`buildHtmlMotionLibraryApplyActions` inserts a live HTML MG composition item
(`compositionKind: motion-graphics`, `runtime: html`, `sourceNodeId`) using the
same EditorAction path as other library applies. Canvas node creation stays on
Agent/CLI (`html_motion`).

### Legacy migrate-vs-coexist

**Coexist** (reinforces spike B / #436):

- Do not rewrite stored `runtime: "react"` custom comps or legacy
  html + `renderedAssetPath` shapes in this slice.
- New MG authoring must use live `sourceNodeId` + `runtime: html | remotion`.
- Fail closed when the live-reference contract is not satisfied.

See `HTML_MOTION_LEGACY_POLICY` in `htmlMotionExport.ts`.

## Explicit non-goals

- No audio-master-clock.
- No revival of `MgCompositionSpec` / `render-mg` command layer.
- No forced migration of legacy Timeline YAML in this PR.