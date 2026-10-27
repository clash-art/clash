---
name: clash-mg-character
description: Create expressive motion-graphics characters as editable Remotion TSX **or** HTML Motion documents, connect them to a Clash Timeline through a live Canvas source, and judge their final rendered performance. Use this skill whenever a brief calls for an animated mascot, geometric character, presenter, reaction figure, or character-led motion graphic.
---

# Clash MG Character

Design the character and its performance; let the base `clash` skill and each
live tool description provide the product syntax. Clash Motion Graphics is a
**dual-runtime** product: Remotion TSX and HTML Motion are both valid.

- **Remotion MG:** a default-exported, single-file Remotion TSX component in a
  Canvas `remotion-component` node. CLI: `--type remotion`.
- **HTML MG:** an HTML document in a Canvas `html-motion` node. CLI:
  `--type html_motion`. Timeline items use `runtime: html` with the same live
  `sourceNodeId` identity (never a deleted `MgCompositionSpec` / `render-mg`
  command path).

Prefer Remotion when the brief needs Remotion springs, sequences, or TSX
composition; prefer HTML when the brief is DOM/CSS/SVG motion that should stay
editable as HTML.

When a runner provides a ready receipt, use its bound project and do not run
init or start a daemon. Outside that environment, let the base `clash` skill
establish the workspace and runtime before creative work begins.

Keep that Canvas node as the editable source of truth. A Timeline composition
item points to it through `sourceNodeId`, and the product resolves the node's
latest TSX when a Timeline render starts. Do not copy the source into Timeline
state or turn the component into an intermediate clip. Canvas Player playback
is useful rehearsal, but only a product Timeline render is delivery evidence.

## Find the character in silhouette

Begin with an idea that survives at thumbnail size. Choose a small shape
vocabulary—round and buoyant, angular and tense, tall and elegant, compact and
energetic—and repeat it across the head, torso, limbs, and accents. Give the
character one memorable proportion before adding decoration.

Make the line of action, center of gravity, support point, and gaze readable in
every key pose. Separate limbs from the torso, protect the face and hands, and
use negative space to prevent accidental tangencies. Test the silhouette on
both light and dark fields.

## Pose the idea before animating it

Design at least three meaningfully different poses: anticipation, decisive
action, and reaction or settle. Change compression, asymmetry, occupied space,
and direction—not merely coordinates. If those poses are interchangeable, the
performance has no dramatic thought.

Use nested visual parts so pivots feel anatomical: a torso can lead a shoulder,
the shoulder can lead an arm, and the hand can arrive last. Choose transform
origins deliberately. Preserve believable contact and balance whenever a foot,
hand, or prop bears weight.

## Author a seek-safe Remotion performance

Write a single TSX module with a default React component export. Inline source
may import only from `react` and `remotion`; dynamic imports and `require()` are
not part of this runtime. Build vector-like forms with normal React markup,
CSS, and SVG primitives, and use `AbsoluteFill` or proportional layout so the
character remains legible in the target Timeline dimensions.

Give each major visual part a stable, literal semantic marker so poses remain
inspectable while the drawing evolves. Use `data-character-part="head"`,
`data-character-part="torso"`, `data-character-part="arm-left"`,
`data-character-part="arm-right"`, `data-character-part="leg-left"`, and
`data-character-part="leg-right"` on the corresponding TSX elements; add
similarly named markers for eyes, hands, hair, or props when they matter. Keep
the marker on the part's persistent transform wrapper rather than on a
transient highlight or effect.

Drive every visible state from Remotion time. Use `useCurrentFrame`,
`useVideoConfig`, `interpolate`, and `spring` as appropriate. Avoid wall-clock
timers, event-driven state, DOM measurement, and unseeded randomness: scrubbing
to a frame and rendering that frame must produce the same pose.

Shape motion around anticipation, action, overshoot, and settle. Favor curved
arcs over mechanical diagonals. Let spacing express weight: light parts respond
quickly, while heavy masses take longer to start and stop. Offset secondary
parts for overlap and follow-through, but remove any motion that competes with
the focal gesture. Blinks, breaths, and small holds are punctuation, not noise.

Keep focal shapes and lettering inside a deliberate safe area at their most
extreme animated pose, not just at frame zero. Check scale overshoot, rotating
limbs, shadows, and strokes against all four edges.

## Use the live product path

CLI and MCP are peer surfaces with the same capabilities over the same project.
Use whichever is available; do not invoke one through the other or create a
second implementation of product behavior.

For CLI work, keep the TSX in the working tree while authoring it, then persist
its contents in a distinct Canvas node:

```sh
clash canvas add --type remotion --label "<character-name>" --content-file <component.tsx> --json
clash canvas get --node <remotion-node-id> --json

# After revising the TSX, read immediately before the guarded update.
clash canvas get --node <remotion-node-id> --json
clash canvas update --node <remotion-node-id> --content-file <component.tsx> --json
clash canvas get --node <remotion-node-id> --json
```

`--content-file` reads one UTF-8 file inside the Workspace and persists only
its exact contents; the path is not stored or watched. Use `--content` only for
short literal source. The two options are mutually exclusive.

Reuse the intended Timeline when one exists. Timeline create/save/apply run
the authoritative validation before any mutation. Invalid submissions return
the same structured issues and leave product state unchanged. When the next
intended step is create, save, or apply, submit directly—do not call standalone
validate first. After a rejected write, fix the draft and retry that same
write. Reserve standalone validate for diagnostic-only workflows where no
write is intended:

```sh
clash timeline list --json
clash timeline pull --timeline <timeline-id> --json
clash timeline apply --timeline <timeline-id> --file timelines/<timeline-id>.timeline.yaml --json
clash timeline pull --timeline <timeline-id> --json
clash timeline render --timeline <timeline-id> --json
```

Add a composition item to the complete Timeline state without disturbing other
tracks or items. Its essential live-source shape is:

```yaml
- id: <item-id>
  type: composition
  from: <start-frame>
  durationInFrames: <duration>
  compositionKind: custom
  runtime: remotion
  compositionId: <component-id>
  sourcePath: components/<remotion-node-id>.tsx
  sourceNodeId: <remotion-node-id>
```

`sourcePath` is a safe project-local authoring path; `sourceNodeId` is the live
product identity. The Timeline must not contain a duplicate of the TSX.

For HTML Motion, create the Canvas node with `--type html_motion`, then add a
composition item whose essential live-source shape is:

```yaml
- id: <item-id>
  type: composition
  from: <start-frame>
  durationInFrames: <duration>
  compositionKind: motion-graphics
  runtime: html
  compositionId: <document-id>
  sourcePath: html-motion/<html-motion-node-id>.html
  sourceNodeId: <html-motion-node-id>
```

Preview and export both resolve the Canvas node's latest HTML when they start.
Do not invent `render-mg`, `export-mg`, `verify-mg-preview`, or
`MgCompositionSpec` — those deleted commands stay banned. Use
`clash timeline render --timeline` (or `clash_timeline_render`) for delivery
evidence on either runtime.

Do not copy output pixel dimensions into an item's `properties.width` or
`properties.height`. Those two fields are scale multipliers, and both default
to `1`; `720` by `1280` belongs only in the Timeline's root
`compositionWidth` and `compositionHeight`. For a full-frame Remotion
composition, omit `properties` entirely unless an intentional transform is
needed. Pixel-sized item properties create an enormous off-screen layer and
can produce a valid but visually black render.

For MCP work, reveal `canvas` through the root `clash` menu, then use
`clash_canvas_add` with `type: "remotion"` and workspace-relative
`contentFile`, followed by `clash_canvas_get`. MCP strings are literal: never
pass shell syntax such as `$(cat file)` as `content`. Before a revision, get
the node again, update it through `clash_canvas_update` with `contentFile`, and
read it back. The Host stores the resolved source text, not the path. Reveal
`timeline`, then use
`clash_timeline_get`, preserve the complete returned state, add or revise the
live composition item, and submit it with `clash_timeline_save` using the
returned `revisionId` as `baseRevisionId`. Read it back with
`clash_timeline_get`, then request the final media with
`clash_timeline_render`.

Treat every Canvas and Timeline write as read-before-write. If a write is stale
or read-required, read the current entity again, merge the intended change,
and resubmit; never force an overwrite. Ordinary code revisions update the same
mutable `remotion-component` node ID. Do not copy the node merely because its
TSX changed: every Timeline item carrying that `sourceNodeId` must resolve the
latest saved code, just as a Timeline reference to a mutable Text node resolves
the latest text.

## Review the rendered performance

- Compare anticipation, action, and settle as still frames at delivery size.
- Watch the final Timeline media at normal speed for intention and weight, then
  frame-step it for arcs, spacing, contacts, and edge safety.
- Check that the first readable gesture arrives soon enough for the edit and
  that the final hold gives the next cut room to land.
- Confirm that secondary motion supports rather than masks the main action.
- Judge transparency, compositing, typography, and color in the final Timeline
  context, not against the isolated Canvas preview alone.

Editable TSX proves construction, sampled frames prove selected appearances,
and a completed, playable product Timeline render proves timing and
performance. A submitted or pending render is not completion: require the
completed render receipt and its playable Asset. Revise the Canvas source,
render the Timeline again, and compare the actual media until the character
reads without explanation.
