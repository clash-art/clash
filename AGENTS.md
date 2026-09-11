# AGENTS.md

This file guides coding agents working in this repository. Current product guides under `apps/docs/guide/` describe the supported architecture; older design material may describe retired paths.

## Critical Rules

- **No foreign keys.** Never add `REFERENCES`, `FOREIGN KEY`, or `.references()` in schema definitions or migrations. D1 enables foreign key enforcement and it causes issues with user IDs across auth boundaries.
- **No orphan GUI.** Do not ship buttons, menus, filters, toggles, status labels, or detail panels unless they are backed by real product behavior: a state change, persisted data, a backend/API action, navigation, or a clearly implemented local workflow. If a control has no functional contract yet, delete it instead of leaving placeholder UI. Never copy another product's surface literally; adapt the interaction to Clash's actual data model and supported actions.
- **Use mature interaction primitives.** Dialogs, sheets, popovers, dropdowns, selects, comboboxes, tabs, collapsibles, sortable lists, and switches must use the existing shared Radix/Ariakit/dnd-kit primitives instead of hand-rolled roles, document-level keyboard listeners, click-outside handlers, or ad hoc expanded/open state. If the dependency is missing and the interaction is real, add the dependency; if the interaction has no functional contract, delete the UI.
- **TypeScript only for source and tests.** Add or modify implementation and test code as `.ts` or `.tsx`; do not introduce `.js` or `.jsx` source files. Maintained executable scripts use native Node 24 TypeScript with erasable syntax and explicit `.ts` relative imports. Preserve scoped ESM metadata and shebang permissions. Published `dist`/`runtime` JavaScript remains a generated package boundary, not a TypeScript source launcher.
- **Route APIs through their real backend.** The hosted Web Worker gateway forwards `/api/v1/*` to api-cf (Hono); add hosted routes in `apps/api-cf/src/routes/v1/` and register them in `index.ts`. The local Host independently serves its supported `/api/v1/*` contracts in `apps/local-api`; shared paths do not make hosted infrastructure the local authority. Web is Vite/React Router, not Next.js: never add Next API routes. Preserve `apps/web/workers/app.ts` routing and the existing Better Auth proxy for `/api/better-auth/*`.
- **A generated frame's size is `ratio + resolution`, and the two are not symmetric.** A ratio is one geometric fact with a canonical `W:H` form, so provider spellings (`landscape_16_9`, `square_hd`) belong in the adapter. A resolution is a **menu of concrete outputs** whose names are already exact — `720p` is 1280×720, `fhd` is 1920×1080, `768P` is MiniMax's own rung — so cards carry the provider's published values verbatim and **no adapter rewrites them**. Never invent a shared `0.5K/1K/2K/4K` ladder and map onto it: `720p → 1K` asserts a false equality (921600 vs 1048576 pixels) and silently reframes the user's image. A provider's own sentinel is a value, not a spelling — MiniMax means "match the reference" by `adaptive`, so the card says `adaptive`. Read [`apps/docs/guide/model-cards.md`](apps/docs/guide/model-cards.md) before touching a card's `aspect_ratio` or `resolution`.
- **A test may not pin a value invented in the same change.** Mutation testing proves a test is wired to the code, not that its assertion is true, so an implementation and test written from one assumption confirm nothing about each other — and a test locking an unverified invention makes _fixing_ the code turn the suite red. Pin only values with an external source of truth (upstream docs, a captured response, a shipped third-party implementation); otherwise assert behaviour or pass-through. Never pin counts, data copied out of the file under test, or a rule `ModelCardSchema`'s `superRefine` already enforces. Read [`apps/docs/guide/testing-rules.md`](apps/docs/guide/testing-rules.md) — it documents the ratchet, the `720p → 1K` incident, and why source-text assertions must use `source-match.ts`.
- **Timeline/composition has three distinct frame/pixel coordinate systems** (tracks-viewport px, composition-absolute frames, Sequence-relative frames). Mixing them silently "works" for the first item (`from=0`) and fails for everything else. Before touching `buildPreview`, `updatePreviewFromDnd`, `ItemComponent`, or anything passing frame numbers into `<Sequence>`, read [`packages/remotion-ui/TIMELINE_COORDINATES.md`](packages/remotion-ui/TIMELINE_COORDINATES.md) — it lists the two historical bugs (stale `.tracks-viewport` ref, sequence-relative vs composition-absolute mismatch) with reproducers.

## Local-first Project Invariants

These rules define the agent-first local product model. Hosted collaboration
must extend this model without creating a second local workflow.

- `.clash/project.toml` is a project reference, analogous to a Git worktree
  pointer. It may identify the project, workspace, and managed/external
  relationship. It must not contain collaboration mode, sync readiness,
  credentials, permissions, canonical storage paths, or mutable project state.
- The agent owns its working tree. It may use native filesystem tools for
  drafts, scripts, source assets, text projections, and timeline files. The
  marker resolves project identity automatically; normal operations must not
  require a status preflight or expose internal storage topology.
- Agent read-before-write is implicit. Successful CLI reads record an internal
  entity observation in `.clash/observed.json`; a connected host may append an
  opaque receipt so a fabricated semantic hash cannot authorize a write.
  Mutation commands perform read-presence verification and CAS internally.
  Never expose or require a `readToken`, `--if-match`, projection lock sidecar,
  or force bypass in the agent workflow. A stale write must tell the agent to
  read again. Observations are concurrency evidence, not permissions or secrets.
- Local-only, synced, and shared use the same local replica, working tree,
  asset model, CLI commands, CAS rules, and copy-on-write semantics. Never add
  a cloud-specific project directory, canvas, mutation API, or agent workflow.
- Cloud sync is a replicator attached to the local replica. Product-internal
  state owns remote admission, mirror readiness, auth, Web/share gates, CRDT
  transport, and conflict UI. A cwd file or agent edit must never grant cloud
  capability. Hosted `ProjectRoom` code remains valid remote infrastructure,
  but it must not become the local working-tree authority.
- For projected text and timelines, the workflow is checkout/pull, native file
  edit, then explicit apply. Apply performs CAS and copy-on-write when needed;
  stale overwrite, replace, delete, restore, or metadata-fill operations must
  fail with a structured conflict. Force is not a privilege: there is no
  mutation bypass. Re-read, merge, and apply again; use copy-on-write and
  explicit rewiring when downstream references must remain pinned.
- Media assets and applied text revisions are immutable facts. Timeline state
  evolves in Project Loro history rather than a second revision table/blob
  store; every committed state has a stable revision id. Downstream outputs
  keep the asset, text revision, and Timeline revision they rendered from.
- A canvas node with any downstream reference is immutable as a whole. Reads
  expose `immutable: true`; in-place writes fail with `IMMUTABLE_NODE`.
  `clash canvas copy --node <id>` is the uniform copy-on-write escape hatch;
  existing downstream references remain on the source until explicitly
  rewired.
- `project status` is diagnostic only. It may report working-tree dirtiness,
  conflicts, recovery state, or product-internal replication health, but an
  agent must be able to read and modify the project without calling it first.
  Deep storage inspection and repair belong under doctor/inspect surfaces.
- Local project room persistence and raw agent-trace sync are not part of the
  local default. Cloud collaboration may sync explicitly admitted public
  state; scratch context, tool logs, local paths, secrets, and raw traces stay
  local unless a separate product policy opts them in.

## Build & Development Commands

```bash
# Install dependencies
make install                # pnpm install

# Development (most common)
make dev                    # Web (:3000, api-cf auxiliary Worker) + render (:8080)
make dev-full               # Alias for make dev
make dev-desktop            # Electron + renderer HMR (prefers :3001)

# Individual services
make dev-web                # Vite/React Router + api-cf auxiliary Worker
make dev-api-cf-standalone   # Rare isolated API debugging; do not run beside dev-web
make dev-render             # Render server only (:8080)

# Database
make db-local               # Alias for db-web-local, shared local D1 migrations

# Build, test, lint
make test                   # turbo run test
make lint                   # Generated profile check + source tsc + existing ESLint
make typecheck              # Generated profile check + source tsc
make format                 # prettier on all TS/JSON/MD

# Per-app testing
cd apps/api-cf && pnpm test           # API unit tests (vitest)
cd apps/api-cf && pnpm test:watch     # API tests in watch mode
cd apps/api-cf && pnpm test:integration  # Integration tests

# Remotion
make remotion-bundle        # Build Remotion video bundle
```

**After completing a task, run `make lint` to verify.** Do not run `make build` — the project uses hot-reload in dev.

`make lint` runs both TypeScript source checks and the existing ESLint tasks;
root lint/typecheck limit Turbo concurrency to three checks to bound memory use.
ESLint and `tsc` are distinct checks. Package source profiles extend their actual
development/base configuration plus `tsconfig.source.json`, without changing
release compiler targets or relying on workspace `dist`. Browser overrides live
in `source-check-profiles.json`; after changing the shared mapping, run
`pnpm quality:configs:write`. Both public check commands reject stale generated
profiles without rewriting files. Turbo checks depend on upstream checks, and
root source/ESLint configuration is part of the cache key. CI runs this gate and
retains Desktop tests; no release build is required for the quality gate.

## Architecture

### Monorepo Structure

pnpm workspaces + Turborepo. Hosted Web/API use Cloudflare Workers; Desktop and the Local Host run on the user’s machine.

| Directory                     | What                                                  | Runtime                       |
| ----------------------------- | ----------------------------------------------------- | ----------------------------- |
| `apps/web`                    | Vite + React Router 7 SPA, integrated gateway        | Cloudflare Worker + browser    |
| `apps/api-cf`                 | Hono API + Durable Objects + Workflows                | Cloudflare Workers            |
| `apps/local-api`              | Persistent local Project Host and plugin runtime    | Node.js                       |
| `apps/desktop`                | Desktop GUI and machine integration                 | Electron                      |
| `apps/render-server`          | Remotion video rendering (Node.js)                    | Cloudflare Containers         |
| `packages/shared-types`       | Zod schemas, TS types, model cards, Loro operations   | Shared library                |
| `packages/shared-layout`      | Canvas node layout algorithms (zero deps)             | Shared library                |
| `packages/cli`                | Terminal CLI (`clash` command) for project/canvas ops | Node.js                       |
| `packages/shared-cloud-schema` | Backend Drizzle tables and Better Auth relations  | SQLite / D1 backend only      |
| `plugins/clash`               | Installable Clash agent plugin                      | Agent harness integration     |
| `packages/remotion-*`         | Video editor: core state, components, UI              | Shared libraries              |

### Hosted Gateway Pattern (Optional Cloud Path)

```
Hosted client → Web Worker (:3000 in development)
  ├─ /               → Vite / React Router SPA
  ├─ /sync/:projectId → ProjectRoom DO (WebSocket, Loro CRDT binary sync)
  ├─ /agents/*       → SupervisorAgent DO (AI chat WebSocket)
  ├─ /api/v1/*       → REST API (projects CRUD, authenticated)
  ├─ /api/tasks/*    → Hosted legacy task compatibility (not an Asset contract)
  ├─ /api/generate/* → Image/video generation endpoints
  └─ /assets/*       → Expiring HMAC capability delivery (internal issuers only)
```

The gateway is integrated in `apps/web/workers/app.ts`; there is no separate `apps/auth-gateway` service. Hosted authentication uses **Better Auth sessions** (browser cookies) and **API tokens** (`clsh_*`, CLI/agents). Preserve backend authentication and internal transport checks; an arbitrary client-supplied `x-user-id` is not authority.
Bare upload, signing, and storage-key thumbnail routes are retired. Product
callers publish through the Asset SDK/Host authority; `/assets/*` only consumes
an already-issued, expiring delivery capability and does not accept a raw object
key as authorization.

### Real-time Sync (Loro CRDT)

On each machine, the local-api host owns the persistent **Project Loro replica**.
Desktop, CLI, and local agents operate that same replica. Canvas graph payloads
are downstream-owned entries in mergeable `nodeUpstreams` containers; a
mergeable `edgeIdentity` register resolves each edge ID to one downstream node
or deletion tombstone.

When cloud collaboration is enabled, the local host replicates admitted product
state with the hosted `ProjectRoom` Durable Object. `ProjectRoom` is the remote
sequencer and fan-out point, not a prerequisite or alternate mutation model for
local work:

1. Local host loads the machine's canonical Project Loro snapshot.
2. Desktop, CLI, and agents read or mutate that local replica.
3. Optional cloud sync exchanges Loro updates with `ProjectRoom`.
4. Other admitted devices receive those updates and Loro resolves concurrency.

Machine-local metadata, provider credentials, sessions, and indexes live in the
local SQLite store. Hosted identity, membership, billing, and remote admission
live in D1 through Drizzle ORM. Backend definitions live in
`packages/shared-cloud-schema`: `auth` owns Better Auth tables and ORM relations;
`app` owns common cloud tables; `broker` and `runtime` preserve backend-specific
export profiles. Existing API/Web schema paths re-export these definitions.
`apps/web/drizzle.config.ts` reads `app/lib/db/migrations.schema.ts`; historical
SQL remains unchanged. Removing column `.references()` prevents future schema
generation from adding SQL foreign keys; ORM `relations({ fields, references })`
remain query metadata and must be preserved. Existing deployed constraints are
not silently removed by this source change. Do not import Drizzle into browser
domain packages such as `shared-types`.

### Durable Objects (api-cf)

- **`ProjectRoom`** (`src/agents/project-room.ts`) — Loro CRDT host, WebSocket hub, presence tracking, activity broadcasts (throttled 500ms), task polling, periodic snapshots.
- **`SupervisorAgent`** (`src/agents/supervisor.ts`) — AI chat agent per project. Maintains Loro replica synced with ProjectRoom. Has canvas tools (list/read/create/update/delete nodes, run generation). Room name format: `projectId:agentId`.
- **`GenerationWorkflow`** (`src/agents/generation.ts`) — Cloudflare Workflow driving the shared DurableRunEngine: journaled submit/poll, durable result staging, and acknowledged legacy node/Asset projection. See `apps/docs/guide/durable-run-protocol.md`.

### AI & Generation Providers

Provider/model facts come from the model cards in `packages/shared-types/src/models.ts`
and the installed executable plugin contracts. Hosted generation uses the live
api-cf registry and DurableRunEngine adapters; local execution uses Host plugin
ports. Do not infer supported models from historical provider lists or hardcode
model parameters. Read the model-card and durable-run guides before changing
provider protocol or generation state.

### Authentication

**Better Auth** with Drizzle adapter on D1. Supports email/password and Google OAuth. Base path: `/api/better-auth`.

API tokens: `clsh_` + 40 hex chars. Only SHA-256 hash stored in D1 (`api_token` table). Created via Settings UI, validated by the integrated Web gateway and api-cf authentication modules.

### Collaboration Visibility

Sideband JSON messages over the same WebSocket used for CRDT sync:

- **Presence**: `{ type: "presence", clients: [...] }` — who's connected (browser/CLI)
- **Activity**: `{ type: "activity", actor, action, nodeId, ... }` — who did what, throttled per node

Types defined in `packages/shared-types/src/presence.ts`. Detected via `isSidebandMessage()` type guard (string messages vs binary CRDT).

## Key Patterns

### Shared Types as Single Source of Truth

Product contracts live in `packages/shared-types`: both frontend and backend use the same Zod schemas for Canvas, tasks, model cards, and Project facts. Runtime orchestration belongs in `shared-runtime` and adapters. Database definitions are backend-only in `shared-cloud-schema`, never in browser/domain contracts.

### Canvas Operations (Loro)

All canvas operations are encapsulated in the `Canvas` class (`packages/shared-types/src/canvas-ops.ts`). Instantiate with `new Canvas(doc, broadcast)` and call methods directly. **All clients (web, CLI, api-cf agents) must use this class — never re-implement layout, validation, or node creation logic in client code.**

```typescript
const canvas = new Canvas(doc, broadcast);

// Read
canvas.listNodes(type?, parentId?)
canvas.readNode(nodeId)
canvas.searchNodes(query, types?)
canvas.findNode(idOrAssetId)
canvas.getNodeStatus(idOrAssetId)
canvas.listEdges()

// Write
canvas.createNode(id, type, data, position?, parentId?)    // auto-insert layout
canvas.createLinkedNode({ sourceNodeId, ... })              // + edge + auto-insert
canvas.updateNode(nodeId, updates)
canvas.deleteNode(nodeId)
canvas.insertEdge(edgeId, source, target, type?)

// Business operations
canvas.executeGeneration(nodeId, generateId)   // validate → buildPending → createLinkedNode
```

`executeGeneration` replaces the previously duplicated flow of read node → extract prompt/model → validate → build pending asset → create linked node. One call does everything.

**Validation & builders** (in `canvas.ts`, used internally by Canvas):

- `validateGenerationInput()` — Validates prompt + reference images against model card.
- `buildPendingAssetNode()` — Builds pending image/video node data.

**Layout** (`packages/shared-layout`, used internally by Canvas):

- `autoInsertNode` — Calculates position (right of reference via edge, or bottom of group) + chainPush.
- `relayoutToGrid` — Full grid relayout for the relayout button.

**Rules:**

- Reference images come from prompt parts (inline `@`-mentions via `parsePromptParts`), not from connected upstream nodes.
- Never hardcode positions — Canvas handles auto-insert internally.
- Any logic duplicated across clients must go into `packages/shared-types` or `packages/shared-layout`. Client code should only contain framework-specific glue (React hooks, CLI output formatting, etc.).

### agents.json Documentation

Significant directories contain `agents.json` files for progressive disclosure. When creating new modules, add an `agents.json`. When modifying architecture, update the relevant ones.

### API Validation

All API requests validated with Zod schemas in `apps/api-cf/src/domain/requests.ts`. Validation errors return 400 with structured details.

## Frontend Specifics (apps/web)

- **Styling**: Tailwind CSS v4, Framer Motion animations, Phosphor Icons (`weight="bold"` or `"duotone"`)
- **Fonts**: Inter (body), Space Grotesk (headings), JetBrains Mono (mono)
- **Design**: Modern minimalist — soft shadows, rounded corners (`rounded-xl`, `rounded-2xl`), glass morphism (`bg-white/30 backdrop-blur-xl`), red accent (`red-500`/`red-600` as brand)
- **Component model**: React client components and React Router 7 route modules/loaders; Vite serves the SPA. Shared product UI lives in `packages/web-ui` and platform-neutral GUI modules.
- **Canvas**: ReactFlow for node graph, dnd-kit for drag-and-drop
- **Path alias**: Use the actual app `tsconfig.json` and Vite aliases; Web route code lives under `apps/web/app`.
- **DB schema**: `apps/web/app/lib/db/{app,better-auth}.schema.ts` are backend compatibility exports from `@clash/shared-cloud-schema`.

## CLI (packages/cli)

Installed as `clash`. Normal local operations discover the machine Host and use its HTTP contracts; the Host owns Project Loro, receipts, and persistence. Streaming/subscription consumers may use WebSocket, but agents do not need to manage a separate Canvas replica for routine mutations.

```bash
clash host status --json             # Optional diagnostic; no mutation preflight
clash init --project <id> --json     # Link this cwd once
clash canvas list --json             # Read the marker-selected Canvas
clash timeline pull --timeline <id>  # Project Timeline to editable YAML
clash timeline apply --timeline <id> # CAS apply after native file edits
clash auth login                     # Optional cloud sync only
```

Local commands use the discovered local-api host and need no cloud credential.
Optional cloud OAuth config is stored below `$CLASH_HOME`. `CLASH_API_URL` explicitly
overrides endpoint selection; otherwise the CLI prefers Host discovery, then saved
configuration. The residual `localhost:8788` fallback in the low-level config helper
is legacy development compatibility, not the default product gateway or a port to
hardcode in new callers. Use `apiFetch`/Host discovery rather than inventing a mirror
request or requiring a cloud token for local work.
