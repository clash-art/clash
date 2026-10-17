# Project, Canvas, Timeline, Action, and Asset Model

Status: Historical reference; superseded as an implementation contract

Last updated: 2026-08-13

This document records an earlier ownership proposal and must not be used as the
current Asset or execution authority. The canonical contracts are:

- [`apps/docs/guide/asset-system.md`](../apps/docs/guide/asset-system.md) for
  `Resource`, `ProjectAssetEntry`, `ActionAssetBinding`, `ResolvedAsset`,
  deletion, and Local/Cloud replication boundaries; and
- [`apps/docs/guide/durable-run-protocol.md`](../apps/docs/guide/durable-run-protocol.md)
  for Provider steps, owner-private journals, output staging/publication, and
  the design-only Cloud Workflow adapter.

In particular, the `AssetRevision` and standalone synchronized `ActionRun`
language below is not the current Local storage model. Immutable bytes are
Resources, Project media identity is `ProjectAssetEntry`, and durable Local run
state lives in SQLite while Canvas outcome plus `ActionAssetBinding` lineage is
the public projection. A future Project `ActionRun` may use only the five
coarse states defined by the Durable Run Protocol. Storage keys and URLs are
Host projections, never Asset identity. Plugin Asset delivery remains the
single permanently named `v0` contract; this historical document does not
authorize a `v1` alias or `url + reach` path.

## Purpose

This document defines the durable ownership and execution model for Project,
Canvas, Timeline, Action, and Asset. Product UI, CLI commands, local-api, cloud
sync, and Loro mutations must preserve the same model.

## Core Model

A Project is the durable collaboration and persistence boundary. One Project
has one Loro replica per machine and may contain multiple Canvases, Timelines,
Actions, and Assets. A Canvas is one spatial organization surface inside the
Project; it is not the Project itself.

Use concrete identifiers such as `canvasId` and `timelineId`. Do not introduce
a generic `viewId` abstraction for these domain objects.

```text
Project
|- Canvases
|  |- Canvas-owned ActionNodes
|  |- Asset placements
|  `- Derived graph connections
|- Standalone Timelines
|- Custom Views
|- ActionRuns
`- Immutable AssetRevisions
```

## Ownership Invariants

### Orthogonal product dimensions

Do not infer ownership or standalone behavior from state size or editor UI.
These are three independent product dimensions:

```text
State representation: parameters | DSL | richer structured state
Product ownership:    standalone | Canvas-owned
Editor surface:       inline | modal | full-screen
```

A full-screen Editor is UI, not a persisted entity type. Likewise, a Timeline
can be edited through structured parameters or commands without changing its
standalone behavior. Standalone support is a product decision based on whether
the workflow has useful independent discovery, navigation, and lifecycle. It
is not evidence that the state must use a generic `WorkDocument` abstraction.

Current and expected classifications are:

| Product surface | Current ownership          | State shape           | Editor surface     |
| --------------- | -------------------------- | --------------------- | ------------------ |
| Image Editor    | Canvas-owned               | Edit parameters       | Full-screen modal  |
| Video Clipper   | Canvas-owned               | Edit parameters       | Full-screen modal  |
| Timeline        | Standalone or Canvas-owned | Timeline DSL/state    | Full-screen Editor |
| 3D Director     | Standalone or Canvas-owned | Scene/directing state | Dedicated Editor   |

Image Editor or another parameterized tool may gain standalone behavior later
if its independent workflow is valuable. That decision must not require first
changing its state into a generic document type.

### Canvas

- A Project may contain multiple Canvases.
- A Canvas owns its nodes, their positions, and their upstream references.
- A node belongs to exactly one Canvas.
- Graph edge payloads are derived from downstream nodes' `upstream` references.
  They are not duplicated in a second canonical payload store.
- In Loro, those references are normalized as one deterministic mergeable
  `nodeUpstreams[downstreamNodeId]` child map keyed by `edgeId`. This is the
  CRDT storage representation of the node-owned field. A mergeable
  `edgeIdentity[edgeId]` register contains only the winning downstream node (or
  a deletion tombstone), allowing concurrent retarget/delete operations to
  converge on one identity without duplicating the edge payload. The old
  top-level `edges` map is migration input only.

### Action

An Action Definition and an Action instance are different objects:

- An Action Definition is a capability supplied by Clash or a Skill. It is not
  owned by a Canvas.
- An ActionNode is a Canvas-native instance of an Action Definition. It cannot
  exist without a Canvas and belongs to exactly one Canvas.
- An ActionRun is an immutable execution checkpoint. It records the exact
  input revisions and output AssetRevisions and survives independently of the
  ActionNode's visible lifetime.

An ActionNode cannot move across Canvases while retaining its identity.
Copying an Action to another Canvas creates a new ActionNode. The source
ActionNode remains unchanged.

### Asset

An AssetRevision is an immutable, Project-owned value. A Canvas never owns the
AssetRevision itself; it owns an Asset placement that references it.

```text
Project owns AssetRevision R

Canvas A owns AssetPlacement A --\
Canvas B owns AssetPlacement B ----> AssetRevision R
Canvas C owns AssetPlacement C --/
```

Consequences:

- The same AssetRevision may appear on any number of Canvases.
- Adding an Asset to another Canvas creates another placement, not another
  AssetRevision.
- An Asset must not store Canvas backreferences as canonical state. Reverse
  lookup indexes may be derived and rebuilt.
- Editing immutable asset content creates a new AssetRevision and moves only
  the explicitly selected placements.

### Media Pool, Official Views, and Custom Views

The asset catalog and an asset browsing surface are different layers:

- The Asset Catalog stores stable Asset identities, immutable AssetRevisions,
  media locations, proxies, and analysis metadata.
- A Project Media Pool is the set of catalog assets explicitly linked into a
  Project. It does not duplicate media blobs.
- A Global Asset Library is the set of catalog assets a user explicitly marks
  reusable across Projects. `asset_library_refs` records this membership;
  it does not own or duplicate media blobs.
- Adding a Global Library asset from the Project `Assets` add menu first creates
  the Project asset reference. It then behaves like any other Project asset and
  may be previewed or dragged into a Canvas. Promoting a Project asset to the
  Global Library creates only the library membership row.
- A Bin or Collection stores Project asset references. The same asset may
  appear in multiple Bins without being copied.
- A Smart Bin stores a query over Project assets and metadata.
- The built-in Assets screen is the default Media Pool browser. It is a UI
  projection, not a persisted generic View entity.
- The home `Assets` tab manages the Global Asset Library. A Project navigator
  shows only its Project-scoped `Assets` folder; the folder's add menu offers
  both local upload and selection from the Global Asset Library.

The product exposes two kinds of View:

- An `OfficialView` is shipped and maintained by Clash. Canvas, Timeline,
  Media Pool, metadata tables, and future specialized production surfaces are
  Official Views.
- A `CustomView` is a user- or agent-authored HTML work surface that uses the
  same public asset query, selection, Action execution, and output-routing
  contracts.

This is a product/runtime classification, not a universal persistence schema.
Canvas and Timeline retain their concrete domain state and ownership rules.
The navigation layer may use a typed `ViewRef` union:

```text
ViewRef =
  | CanvasViewRef(canvasId)
  | TimelineViewRef(timelineId)
  | OfficialViewRef(definitionId, target?)
  | CustomViewRef(customViewId)
```

### Scope-aware asset acquisition and propagation

Asset selection follows the persisted ownership path of the destination. It is
not a separate import rule implemented by each editor:

```text
Canvas destination:                 Project -> Canvas
Standalone Timeline destination:    Project -> Timeline
Canvas-owned Timeline destination:  Project -> Canvas -> Timeline
```

The picker exposes only valid ancestors of that path. A Canvas can select from
Project assets or the external source tier. A standalone Timeline has the same
choices. A Canvas-owned Timeline additionally exposes placements on its current
Canvas. `Global Library` and the capability-labelled upload entry (`Upload from
device` in the browser, `Upload from computer` on the local Host) are two
acquisition methods in one external source tier; the Global Library is not a
parent of a Project.

Selection extends the reference chain from the source to the destination:

- Global Library selection ensures a Project asset reference first.
- Local upload creates the catalog asset and Project reference, but never
  creates Global Library membership implicitly.
- Entering a Canvas creates or reuses an Asset placement.
- Entering a Canvas-owned Timeline connects that exact placement to its owning
  Timeline Action; the placement identity is passed forward by the cascade.
- Entering a standalone Timeline creates a direct Timeline media reference.

Every step is idempotent. Re-selecting an asset reuses an existing Project
reference, Canvas placement, or Timeline input. Canvas has no parent Canvas,
and a current-Canvas source is valid only for the Timeline owned by that same
Canvas. The scope planner is domain logic shared by all surfaces; UI components
only present sources and storage adapters only apply the planned mutations.

Projects may contain multiple `CustomView` objects. A CustomView is a saved
HTML-based work surface for organizing and acting on Project entities.
Examples include a character bible, storyboard wall, selects board,
continuity review, shot approval page, and an agent-generated decision
interface.

A CustomView:

- owns its HTML layout, pinned references, saved queries, local presentation
  state, and action bindings;
- references AssetRevisions, Timelines, Action Definitions, and other Project
  entities without owning or duplicating them;
- may create View-local placements, but an AssetRevision remains catalog-owned;
- has a stable identity and a current immutable source revision;
- evolves by producing a new source revision while Loro retains collaborative
  history;
- is not a superclass for Canvas or Timeline. Product navigation may use a
  `ViewRef` union, but persisted objects retain concrete IDs such as
  `canvasId`, `timelineId`, and `customViewId`.

Whether a CustomView uses an implicit backing Canvas is an implementation
choice, not a product invariant. The required invariant is that Official and
Custom Views reuse the same surface-independent Action definitions, execution
planner, executor, ActionRun provenance, and output routers.

HTML is untrusted presentation code. It runs in a sandboxed, opaque-origin
iframe with a restrictive Content Security Policy. It cannot access the host
DOM, product credentials, Loro, SQLite, the filesystem, or arbitrary network
resources. A typed host bridge exposes explicit, permission-checked
capabilities such as querying Project assets, selecting or annotating assets,
running an Action Definition, adding an Asset placement, or opening a
Timeline. Every mutation is validated by the host and follows the same
observation, CAS, copy-on-write, provenance, and permission rules as CLI and
first-party UI mutations.

The local agent workflow is projection-based:

```text
clash views pull --view <custom-view-id>
-> edit native HTML/CSS/JS files in cwd
-> clash views apply --view <custom-view-id>
-> implicit observed-version check
-> CAS
-> new CustomView source revision
```

The HTML may provide controls for human-agent exchange, but button clicks must
emit typed intents through the host bridge. HTML must not encode hidden direct
database or Canvas mutations.

### Timeline

A Timeline is an editable, executable work object rather than an immutable
shared value. It has exactly one logical owner:

```text
Timeline owner = ProjectRoot | TimelineActionNode
```

- A ProjectRoot-owned Timeline is standalone.
- Moving a standalone Timeline into a Canvas makes it the Timeline owned by a
  TimelineActionNode in that Canvas. It is no longer standalone.
- A TimelineActionNode and its Timeline can be owned by only one Canvas.
- A Canvas-owned Timeline may still open in the full Timeline Editor. Opening
  an editor does not change ownership.
- Detaching a Timeline from its Canvas makes the same Timeline standalone
  again.
- Copying a Timeline Action to another Canvas creates both a new ActionNode and
  a new Timeline. The copy starts from the source Timeline's current content
  and then evolves independently.
- Cross-Canvas drag, duplicate, or "add to another Canvas" is copy semantics,
  not identity-preserving ownership transfer. The source remains unchanged.

Do not persist a separate `standalone` boolean. Standalone status is derived
from the Timeline's unique parent/owner.

## Timeline Rendering

Rendering always creates a new immutable AssetRevision and an ActionRun that
pins `sourceTimelineRevisionId`. Later Timeline edits must not change an
existing render.

Output routing is determined by Timeline ownership, not by which editor button
started the render:

### Standalone Timeline

```text
Standalone Timeline
-> render
-> ActionRun
-> AssetRevision in Project Assets
```

Rendering does not create or update a Canvas node.

### Canvas-owned Timeline

```text
TimelineActionNode in Canvas A
-> render
-> ActionRun
-> AssetRevision
-> output placement in Canvas A
```

The output node belongs to the owning Canvas and records the TimelineActionNode
as an upstream reference. This remains true when rendering from the full
Timeline Editor because that editor is only a view over the Canvas-owned
Timeline.

## Product Behavior

The Project navigation should expose concrete product surfaces:

- Canvases
- Standalone Timelines
- Media Pool and Bins
- Official Views and Custom Views

Canvas-owned Timelines are discoverable through their owning Canvas and may be
opened in the same full Timeline Editor used by standalone Timelines. They do
not also appear as standalone objects.

The product must distinguish these operations:

| Operation                              | Identity result                                 | Source result                |
| -------------------------------------- | ----------------------------------------------- | ---------------------------- |
| Add Asset to another Canvas            | New placement, same AssetRevision               | Unchanged                    |
| Move standalone Timeline into Canvas   | Same Timeline, new Canvas Action role           | Removed from standalone list |
| Detach Timeline from Canvas            | Same Timeline, standalone again                 | Removed from Canvas          |
| Copy Timeline Action to another Canvas | New ActionNode and new Timeline                 | Unchanged                    |
| Render standalone Timeline             | New ActionRun and AssetRevision                 | No Canvas mutation           |
| Render Canvas-owned Timeline           | New ActionRun, AssetRevision, and Canvas output | Existing Action remains      |

## CRDT and Persistence Requirements

- All Canvases and Timelines in a Project synchronize through the same Project
  Loro replica. Do not create one snapshot or sync room per Canvas.
- Exclusive Timeline ownership must converge to one parent under concurrent
  edits. A movable-tree/single-parent CRDT representation is preferable to
  independent references from multiple Canvases.
- The current owner pointer uses Loro map conflict resolution and deterministic
  post-import reconciliation to remove the losing TimelineActionNode.
- V1 Timeline YAML apply is an atomic, host-CAS mutation. The Timeline state is
  not yet a field-level collaborative CRDT, so simultaneous interactive edits
  to different tracks may converge by whole-state LWW. Multi-user live Timeline
  editing must remain disabled until Timeline state moves to nested mergeable
  containers or an equivalent lossless operation model.
- Canvas graph connections remain derived from node-owned `upstream`
  references.
- Loro stores canonical synchronized mutable state and revision history.
- SQLite/D1 may index Projects, Canvases, Assets, revisions, ActionRuns, and
  rebuildable reverse references for query performance.
- Filesystem blobs hold immutable AssetRevision content.
- Global SQLite/D1 catalogs hold stable Asset and AssetRevision records;
  Project Loro state holds collaborative Project asset references, Bins, Smart
  Bins, and CustomView identity/current-revision pointers.
- JSON/YAML/Markdown files are agent-editable projections or config only; they
  are not an alternative canonical database.

## Non-goals

- Using a generic `WorkDocument` type as the gate for standalone behavior.
- Treating Editor UI shape or state complexity as an ownership rule.
- Sharing one mutable Timeline instance across multiple Canvases.
- Treating an ActionNode as a Project-global object.
- Duplicating an AssetRevision merely because it appears on another Canvas.
- Making Timeline Editor UI state part of Timeline ownership.
- Routing standalone Timeline renders into an arbitrary or most-recent Canvas.
- Treating the built-in Media Pool browser as the only possible asset
  organization surface.
- Allowing CustomView HTML to bypass host capabilities or mutate product
  persistence directly.

## Industry References

- Adobe Premiere Productions uses source-clip references across media and
  timeline projects instead of duplicating clips:
  <https://helpx.adobe.com/uk/premiere/desktop/collaborate-with-others/collaborate-using-productions/how-clips-markers-and-labels-work-in-a-production.html>
- DaVinci Resolve organizes a Project Media Pool with manual Bins, metadata,
  and automatically maintained Smart Bins:
  <https://www.blackmagicdesign.com/products/davinciresolve/media>
- Avid MediaCentral folders contain references to media assets held in an
  Asset Management database:
  <https://mediacentral.avid.com/MCCUX/Content/Users_Guide/Working_with_MediaCentral_AM.htm>
