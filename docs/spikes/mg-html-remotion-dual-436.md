# Spike B — Motion Graphics may be Remotion or HTML (DSL slice)

- **Status:** Product contract + DSL slice for issue [#436](https://github.com/clash-art/clash/issues/436)
- **Parent epic:** [#434](https://github.com/clash-art/clash/issues/434)
- **Phase context:** [`docs/research-mg-remotion-html-2026-10-27.md`](../research-mg-remotion-html-2026-10-27.md) §2, §4, Track B

## Product decision

Clash Motion Graphics is a **dual-runtime** product contract:

- **Remotion MG** stays valid. Canvas owns the TSX source and Timeline stores only
  a live `sourceNodeId` reference.
- **HTML MG** is valid again. It follows the same live-reference rule: the
  Timeline stores `sourceNodeId`, and preview/export resolve the Canvas-owned
  HTML source when they start.

The Timeline never stores an inline source snapshot, rendered frame cache, or
`MgCompositionSpec`-style layer document as the source of truth. The existing
Remotion live path is unchanged.

## HTML live identity: reuse `sourceNodeId`

For this slice, the HTML live identity is the **same** `sourceNodeId` already
used by Remotion MG. A `motion-graphics` item with `runtime: "html"` must carry a
non-empty `sourceNodeId` that identifies the Canvas node holding the HTML MG
source. A distinct Timeline source field or a second identity concept is not
needed, so one survives:

| Runtime | Timeline identity | Canvas source owner |
| --- | --- | --- |
| `remotion` | `sourceNodeId` | Canvas `remotion-component` node (`data.content` is TSX) |
| `html` | `sourceNodeId` | Canvas node whose data carries the HTML MG source document |

The Canvas-side HTML node discriminator and editor are follow-ups (see below).
This PR lands the DSL contract so the identity is stable before UI work starts.

## Validation contract (shipped here)

`compositionKind: motion-graphics` follows these rules:

| `runtime` | `sourceNodeId` | Result |
| --- | --- | --- |
| `remotion` | non-empty | accepted (existing live path) |
| `remotion` | missing/empty | rejected — Remotion requires a live Canvas source |
| `html` | non-empty | **accepted** — new live HTML contract |
| `html` | missing/empty | rejected — HTML requires a live Canvas source |
| `react` | any | rejected — `react` is not a live MG runtime |
| other/unknown | any | rejected by the runtime enum/contract |

Unsafe or incomplete shapes stay rejected:

- remote or absolute `sourcePath` / `renderedAssetPath`;
- missing `compositionId`;
- missing `sourcePath`;
- HTML MG with no live `sourceNodeId` (including the old `spec`-based authoring
  fixture);
- `runtime: "react"` on a motion-graphics item.

The same rule is enforced in both the shared semantic validator
(`timeline-dsl-semantics.ts`) and the YAML apply path (`timeline-yaml.ts`) so the
agent projection cannot bypass the product contract.

## Legacy `runtime: html|react` + `renderedAssetPath`: coexist, do not migrate here

Decision: **coexist for legacy custom compositions; no migration in this PR.**

- `runtime: "react"` remains a legacy pre-rendered path for `compositionKind:
  custom`. It still requires a local `renderedAssetPath`; it is not a live MG
  runtime.
- A legacy `runtime: "html"` custom composition remains readable when its
  existing contract is satisfied. This PR does not rewrite stored Timeline state
  or convert legacy HTML `spec` documents into live Canvas sources.
- New motion-graphics authoring must use a live Canvas `sourceNodeId`. A legacy
  `spec` document is not revived as `MgCompositionSpec`; it is not the source of
  truth for MG preview or export.

A migration that rewrites legacy HTML MG state can be scheduled separately once
the Canvas HTML node and preview/export adapter exist. Until then, old shapes
that fail the live-reference contract fail closed instead of silently rendering.

## Explicit non-goals

- **No audio-master-clock dependency.** This slice does not change the Player
  clock, introduce an audio master clock, or set a media-time origin. Remotion
  preview keeps its current clock; HTML preview work must fit that constraint.
- **No single-host scoping.** The contract is runtime-scoped, not host-scoped;
  browser, desktop, and existing container export paths stay in the product
  picture.
- No new banned-token allowance for `MgCompositionSpec`, `render-mg`,
  `export-mg`, or `verify-mg-preview`. Those stay rejected by package-boundary
  and artifact-eval checks because the deleted command layer is not back. This
  PR only allows `runtime: html` in the Timeline DSL contract and its tests.

## Not in this PR (follow-ups)

1. ~~Canvas HTML node discriminator~~ → see `mg-html-canvas-node-436.md` (create/edit node + live Timeline handoff; sandboxed iframe preview still open).
2. Full Timeline HTML live preview paint and preview transport integration.
3. HTML MG export (browser and/or existing container path) with parity rules.
4. Agent skill rewrite so the MG skill may teach HTML authoring; package-boundary
   and artifact-eval bans stay in place until that replacement contract ships.
5. Library apply contracts for both runtimes; richer Canvas HTML editor UX /
   sandbox preview.
6. A migration for legacy HTML `spec` / `renderedAssetPath` states, if product
   data warrants it.

## Evidence

Run in the PR worktree:

```bash
pnpm --filter @clash/shared-types test
pnpm --filter @clash/shared-types typecheck
pnpm --filter @clash/remotion-core test
pnpm --filter @clash/remotion-core typecheck
```

The shared-types suite covers acceptance of live HTML MG, rejection of HTML MG
without `sourceNodeId`, rejection of `motion-graphics + runtime: react`, and the
existing Remotion live-source contract.
