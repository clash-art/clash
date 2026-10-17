# Asset Workspace Product Spec

Status: Historical UX proposal; not the Asset identity or lifecycle authority

The Preview/Edit interaction ideas below may remain useful, but Project/Global
Asset identity, Action references, resolution, deletion, and Local/Cloud
boundaries are defined by
[`apps/docs/guide/asset-system.md`](../apps/docs/guide/asset-system.md). The
historical “project reference”, blob-ownership, and immutable-asset-lineage
wording below must be translated to `Resource`, `ProjectAssetEntry`, and
`ActionAssetBinding`; it does not authorize storage-shaped product APIs.

## Scope

This document defines how project assets, the reusable global asset library,
Preview/Edit, and Canvas asset interactions behave. The action semantics are
described historically in [Action Spec System](./action-spec-system.md); current
execution and publication semantics come from the canonical documents linked
above.

## Asset scopes

### Project assets

The `Assets` section inside a project contains assets referenced by that
project. It is not the global library and must not contain a second
`Global Assets` tree.

The `Assets` add menu has two sources:

- `Upload from device` (hosted browser picker) or `Upload from computer` (local Host)
- `Add from Global Assets`

Adding from the global library creates a project reference to the existing
asset. It does not duplicate the file.

### Global asset library

The Home workspace has an `Assets` tab for reusable assets. The global library
supports folders as organizational metadata. Folder membership does not change
blob ownership, asset identity, or project references.

A project asset row uses a three-dot menu for asset actions. `Add to Global
Assets` belongs in that menu; a permanent plus button on every asset row is not
the interaction.

Backend ownership is split intentionally:

- immutable asset record and blob: shared asset storage;
- global library membership: user-scoped library reference;
- global folder and membership: user-scoped library organization;
- project membership: project asset reference.

## Thumbnails and media resolution

Image and video rows render a small real thumbnail. Audio and unavailable media
use a type-specific fallback icon.

All thumbnail and preview URLs go through one asset-media resolver. Callers do
not independently guess whether a value is a signed URL, local storage key,
remote URL, cover key, or generated thumbnail.

The shared thumbnail component owns:

- image rendering;
- video poster/first-frame presentation;
- loading and error fallback;
- sidebar/card sizing variants;
- accessible label behavior.

Lists choose the asset and variant. They do not reimplement media acquisition.

## Preview and Edit

Preview and Edit are two states of one asset workspace component, not separate
modal products.

### Image

Preview supports at least:

- fit to viewport;
- actual size;
- stepped zoom in/out;
- wheel zoom;
- pan when zoomed;
- crop;
- 0/90/180/270 degree rotation.

### Video

Preview supports normal video playback controls. Edit supports at least:

- seeking and frame selection;
- screenshot extraction;
- time-range crop/trim;
- a result preview before Apply where practical.

### Apply behavior

- From Canvas: create a new explicit edit/action node and a new result node,
  preserving graph provenance.
- From asset Preview: run an implicit action, create a new immutable asset, and
  keep the user in the same workspace showing the result.

The source asset is never overwritten. See `docs/action-spec-system.md` only
for the historical UI-intent shape; current lineage is an
`ActionAssetBinding` over a ProjectAsset.

Validation and execution failures are inline, readable, and actionable. Do not
use browser/native `alert()` dialogs for editor state.

### Provenance and workspace relations

Preview includes a docked provenance rail. It is part of the same asset
workspace, not a modal and not a separate metadata page. The rail is hidden
while the editor is active so editing keeps the available width.

The rail projects two sources of truth together:

- immutable asset lineage: source assets, generation/edit prompt, model, and
  ActionInvocation metadata;
- live project state: Canvas placements/references and Timeline clips.

It shows, when available:

- the origin Canvas and result node that created the asset;
- every other Canvas that places or references it;
- every Timeline that contains it, including reference counts;
- upstream source assets, with the shared thumbnail component;
- prompt and negative prompt text;
- source model/action identity.

Relation rows are navigation, not decorative metadata:

- Canvas rows open the Canvas and focus the related node;
- Timeline rows open that Timeline editor;
- source-asset rows open that asset in the same Preview workspace.

The relation projection reads every persisted Canvas node and edge in the
project Loro document. It must not infer project-wide usage from only the
currently mounted React Flow canvas. Legacy Timeline `sourceNodeId` references
remain readable, while new state should prefer stable `assetId` references.

Missing provenance is represented as unavailable/empty metadata; it must not
invent an origin or make an upstream asset navigable when the project does not
reference it.

## Canvas persistence

Opening an asset or timeline surface and returning to Canvas must preserve the
current graph. Surface navigation changes the projection being shown; it must
not initialize or replace the canonical canvas state.

Asset Preview must receive a stable asset id plus resolvable media information.
Temporary object URLs must be released only after their consumers unmount or
switch source.

## Canvas navigation aids

### Minimap

The minimap sits at the bottom-left of the canvas content area. Its viewport
outline must be completely visible on all sides and must not be clipped by the
panel, sidebar, or rounded container.

### Canvas folders

Canvas folders are a projection of Canvas `group` nodes. They are not a second
folder database.

- A `Canvas folders` text button appears above the minimap while the panel is
  closed.
- Clicking opens a folder panel between the project sidebar and Canvas toolbar,
  and hides the button.
- The panel has an `X` close control in its header.
- Closing restores the text button.
- The panel lists real groups from the current Canvas and reflects group
  rename/create/delete changes.
- Empty state is shown only when the current Canvas truly has no groups.

The panel must not overlap or shift the toolbar unpredictably. The minimap and
folder panel are transient UI state and are not persisted as Canvas content.

## Acceptance checks

1. A local upload appears in project Assets and opens in Preview.
2. A global asset can be selected from the Assets add menu and appears by
   reference in the project.
3. Image/video rows show real thumbnails through the shared component.
4. Opening Preview and returning to Canvas preserves every node and edge.
5. Image zoom/pan/crop/rotate produces a new result asset.
6. Video screenshot and trim produce correctly typed new result assets.
7. Canvas edits are explicit; Preview edits are implicit.
8. Both paths persist the same ActionInvocation schema and edit-source lineage.
9. Canvas folders reflect group nodes, and the minimap outline is not clipped.
10. Preview lists origin, Canvas/Timeline usage, source assets, prompts, and
    model from immutable lineage plus live project state.
11. Relation rows open the real Canvas node, Timeline, or source asset.
