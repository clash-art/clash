# Legacy convergence roadmap

Baseline: `1315eb6d`. Started 2026-09-11 after a repository-wide static audit.

## Execution contract

Execute stages in order with one high-effort implementation subagent at a time.
The coordinating agent reviews each stage's diff, behavioral evidence, and
remaining risks before dispatching the next stage. Update this document after
each stage. Audit findings are hypotheses until their live callers and current
contracts are verified; record disproved findings instead of implementing them.

Cloud v1 admission, replication, and coordination are current product work.
Do not remove them or substitute a second local/cloud domain model. Preserve
immutable facts, Project Loro authority, implicit observations, CAS, and explicit
project admission. Old data readers, migrations, and explicit retired-protocol
errors are not equivalent to active legacy writers. Do not rewrite Git history,
delete user data, publish packages, deploy infrastructure, or use paid providers.

Implementation and tests use TypeScript. Read `AGENTS.md`, the relevant
`agents.json`, `apps/docs/guide/testing-rules.md`, and the authoritative Asset,
Document, Generator, and Durable Run guides for each affected area. Reproduce
behavioral regressions before fixing them. Run scoped tests/typechecks and
`make lint`; do not run `make build`. Report incomplete validation explicitly.

## Package boundaries

The user also requested sensible package organization. Apply this throughout each
stage: shared domain contracts and platform-neutral behavior belong in shared
packages; Node/Cloudflare persistence and transport belong in adapter modules;
CLI and Web keep presentation/command glue. Extract coherent services/routes
from oversized modules when the stage touches them, eliminate duplicated
authority, and prevent runtime-incompatible imports or dependency cycles. Do not
create forwarding-only packages, split by line count, or rename packages without
a concrete boundary benefit. Validate public exports and affected consumers.

## Ordered stages

| Stage | Scope | Acceptance | Status |
| --- | --- | --- | --- |
| 1 | Project cloud readiness | Project status and Web/Share gates use that Project's admission and verified replication state. Global capability switches cannot fabricate readiness. Missing, pending, failed, and revoked admission fail closed without impairing local work. | Complete — reviewed; restart identity follows in Stage 2 |
| 2 | Resource replication wiring | Connect the existing Resource SDK and delivery ports to admitted Project sync and the supported cloud entrypoint. Establish a durable machine replica identity (process host IDs rotate on restart), then reuse the existing Project cloud coordinator; verify digest/length, idempotent retry, revocation during sync, later-edit invalidation, failure reporting, and isolation between admitted and local-only Projects. Never report ready before required bytes are available. | Complete — reviewed |
| 3 | Cloud generation convergence | Trace live hosted generation consumers and converge legacy entrypoints onto the shared durable execution contract where supported. Preserve working cloud functionality and restart safety; eliminate in-process Provider polling. Unsupported old protocols fail explicitly, with a documented replacement rather than a silent loss of functionality. | Complete — reviewed; pre-existing plugin type errors tracked in Stage 7 |
| 4 | Metadata and Document authority | Remove the public second-authority manifest metadata write path by routing supported operations through native Document/Host authority with exact revisions and CAS. Retain deliberate old-data reading/migration; eliminate the hardcoded best-effort host write. | Complete — reviewed; existing CLI dev type errors tracked in Stage 7 |
| 5 | Executable plugin installation | Remove active Worker Action installation fallback and use the supported executable plugin contract. Keep existing installed records readable/removable as needed; install success must correspond to executable product behavior. | Complete — reviewed |
| 6 | Schemas and architecture guidance | Audit duplicate schemas and remaining foreign keys; converge active schema definitions without destructive historical migration edits. Correct root guidance and current docs for Vite/RR7, the integrated gateway, host discovery, and actual Cloud delivery. Mark historical material rather than rewriting its history. | Complete — reviewed |
| 7 | Verification coverage | Make the repository quality gate include relevant source/typecheck coverage for CLI, web-ui, local-api, and api-cf, with accurate naming and no accidental full release build. Expose and resolve genuine failures; do not weaken tests to claim a pass. | Complete — reviewed |
| 8 | Legacy executable scripts | Inventory remaining tracked JS scripts and migrate maintained source/tests/shims to TypeScript with all command references updated. Preserve executable packaging behavior; document any externally required launcher boundary rather than counting generated output as source. | Complete — reviewed |
| 9 | Package boundary review | Review the accumulated changes for duplicated domain logic, Node/Cloudflare leakage, cycles, oversized orchestration, and exports. Complete justified extractions and dependency cleanup, with consumer tests; document intentional adapter boundaries. | Complete — reviewed |

## Review record

### Stage 1

- Active Host status uses exact Project/replica admission; remote admission
  responses become pending until the local coordinator verifies readiness.
- CLI reads Host status with a bounded offline diagnostic fallback. Manual
  readiness toggles were removed; the metadata transport toggle retains real
  behavior. Unused Web status/gate helpers and their tests were removed.
- Audit correction: the old Web/Share helpers had no live UI callers; they were
  dormant code, not evidence of a shipped button bypass.
- Regression evidence: shared status/readiness (22), Local admission/config (9),
  CLI status/doctor (62), Settings sync (117) tests passed. Scoped typechecks for
  local-api, web-ui, CLI, shared-runtime passed; make lint passed (10 cached tasks).
  Coordinator independently replayed global flags and confirmed fail-closed.
- Stage 2 must replace the process-random default replica identity with durable
  machine identity so exact admission survives restart; do not use latest-record
  fallback to conceal the mismatch.

### Stage 2

- Production Host startup, admission, durable Project edits, and metadata edits
  trigger one shared coordinator through a Node adapter. SQLite admission CAS
  versions prevent an older sync from marking later edits or revocation ready.
- Replica identity persists across process restarts. Old process-id admissions
  require explicit re-admission rather than adopting an unrelated record.
- Cloud adapters check exact admission and Project Loro membership, acknowledge
  Loro persistence, and transfer verified Resource and Document bytes. Default
  D1/ProjectRoom/R2 integration passed in local workerd; the coordinator also
  independently replayed the content routes (3 tests passed).
- Host tests cover retry after restart, unchanged content without repeated PUTs,
  resources added during upload, cancellation, source-Host-offline receiving,
  and preservation of opaque Resource identity. Final checks passed.
- User-requested transport limit: cloud replication was initially capped at
  32 MiB per Resource or Document body (raised to 512 MiB by the
  multipart follow-up below). Enforce declared facts before allocation
  and actual streamed bytes on both sides, with explicit over-limit errors.
  Local asset publication remains unrestricted; generic media range delivery
  preserves streaming. Implementation and boundary regressions passed; the
  coordinating agent independently replayed SDK transfer/limit tests (8 passed).
  Final make lint passed (10 cached tasks); broader coverage follows in Stage 7.
- Final regression evidence: local sync/resource checks (29), SDK checks (16),
  cloud route checks (26), real D1/ProjectRoom/R2 integration (1), Settings (117),
  shared coordinator/status (25), and shared reference enumeration (2) passed.
  The wider local regression selection also passed (149 before the final limit
  addition). Local-api, api-cf, and web-ui typechecks passed. Narrow shared export
  ESM/declaration packaging and Node/Worker consumption were checked without a
  release build. Remote HTTP 413 preserves the server's reported smaller limit.
- Stage 1 correction: after admitted replication was connected, the remaining
  global metadata switch no longer controlled that path. Remove that orphan
  control; retain compatibility config fields without readiness authority.
- Package boundaries use shared reference enumeration and the shared coordinator,
  with separate Node Host and Cloudflare delivery/persistence adapters. No new
  forwarding-only package is needed. Deployed-cloud availability is unverified.

### Stage 3

- Preserve existing Workflow/task IDs while driving the shared durable engine.
  Freeze route/account references and input in the private D1 journal before
  scheduling; provider credentials remain invocation-time dependencies.
- Split asynchronous providers into submit and single-poll operations. Media
  receives a durable private receipt before result checkpointing; finalization
  and acknowledged publication remain distinct retryable phases.
- Preserve supported legacy output projections and lineage. Journal-backed
  task status must not report success merely because a D1 Asset row exists.
  Publication must reject stale task identity and conflicting replay.
- Audit correction: the description adapter is already a disabled no-op.
  Replace false success with an explicit unsupported response; this finding
  does not justify removing live visual analysis or supported text generation.
- Default Workflow integration now exercises dispatch, the render adapter,
  private R2 receipts, D1 Asset publication, and ProjectRoom persistence after
  eviction. Room-initialization recovery also passed. The coordinator
  independently replayed receipt/publication regressions (4 tests passed).
- Recovered queued runs must revalidate node admission before calling a
  Provider. Obsolete results cannot overwrite a newer task; obsolete failure
  acknowledgment must still allow the old journal run to become terminal.
- Remove NodeProcessor's automatic submission to the retired description
  adapter; retain the separate supported visual-understanding path. External
  billing hooks retain at-least-once crash semantics across their side effect
  and the private receipt marker; do not claim exactly-once settlement.
- Final evidence: cloud scoped regressions (133), real Workflow/D1/R2/ProjectRoom
  integration (5), shared Provider checks (38), and MiniMax plugin regressions
  (24) passed. API and shared-runtime typechecks passed. Both agents ran
  make lint successfully (10 cached tasks); diff whitespace checks passed.
- A workerd canceled/hung-request diagnostic appears in explicit room-eviction
  tests despite successful Workflow completion and durable reload assertions.
  The non-eviction control passed without that diagnostic; preserve this test
  environment observation rather than suppressing its output.
- The extra MiniMax plugin typecheck exposed five existing TS2339 errors in
  resolved-reference union handling. The adapter's only Stage 3 change is its
  shared executor import; fix the narrowing in Stage 7 and rerun the plugin gate.
- Pre-migration Workflow payloads require owner reconciliation rather than
  blind paid resubmission. The cloud path retains supported legacy publication,
  not native Generator Output Commits. Deployment and live-provider operation
  remain unverified. Portable MiniMax execution now has one shared implementation
  with a narrow export, while plugin process/auth glue stays in the plugin.

### Stage 4

- Reuse native Host Document create/read/advance/attachment authority and implicit
  CLI observations; remove the manifest-first public mutation path.
- Audit correction: `attachTranscript` has no production callers; Timeline only
  consumes its grid-hash helper. Preserve the useful read/hash behavior without
  keeping an unused writer. Descriptive Media attributes remain distinct from
  Document bodies; migrate declared consumers explicitly.
- Deliver list/head/history/exact-revision reads, create/copy, native-file
  pull/apply, and explicit revision-pinned attachments. Honor each declaration's
  text/JSON projection format and editability. Apply keeps the draft's original
  observation baseline; it must not silently refresh it with a new read.
- Coordinator review found that CLI `apiFetch` lost `Headers` instances through
  object spread. Correct HeadersInit merging and verify receipts through real
  HTTP, not only helper injection. Resolve file arguments from the calling cwd;
  keep protocol receipt removal separate from unmodified Document body content.
- Attachment advancement follows the existing same-Document revision contract.
  Attach a copied Document explicitly; do not promise cross-Document replacement
  of an existing attachment. Keep original attachments and pinned revisions.
- Final evidence: Host integration/service checks (19), CLI checks (20), MCP
  checks (2), and skill documentation checks (13) passed. Host, shared-runtime,
  and shared-mcp typechecks passed; make lint and diff checks passed. The
  coordinator independently replayed CLI transport/exact-read checks (2).
- Six existing CLI dev-check TS2769 diagnostics remain in `director.ts:784` and
  `workspace.ts:168,181,189,198,230`; fix in Stage 7. The supported Host package
  typecheck uses its dev config; the plain Host compiler command reads stale
  distribution contracts and is not the supported source gate.
- Retired manifest and index mutations fail explicitly before writing; old
  manifest/body/index readers remain. Active skill command references and
  registry descriptions now match the native CLI. Copy lineage and immutable
  source revisions persist across Host restart. JSON and text files, dirty-file
  protection, stale drafts/attachments, and real receipt rejection are covered.
- MCP authoring, general Document GUI editing, automatic metadata migration,
  and migration of old ASR/Timeline consumers are not claimed. Noneditable
  projections stay read-only after copy; no new downstream consumer is implied
  by registration of a Document kind.

### Stage 5

- Close active Worker Action installation and Web fallback paths. Preserve
  deliberate legacy installed-record reads/removal and actual executable plugin
  installation through the existing Local Host package authority.
- Existing installer `installed: false` can mean an immutable bundled plugin or
  an idempotent no-op. Confirm a valid active package through the existing receipt
  reader; do not reinterpret that flag alone. Drifted records are not usable
  installed plugins, and bundled Codex must not expose an install action.
- Default Host TCP tests cover actual Storyboard installation, idempotent retry,
  receipt validation, runtime view registration, installed listing, and removal.
  Cloud workerd/D1 tests preserve authentication and historical read/delete
  isolation while retiring new Worker Action writes without inserting records.
- Related tests: 68 unique checks passed across Host, installers, cloud, shared
  contracts, UI, and loaders. Host, api-cf, web-ui, and Web typechecks passed.
  Coordinator independently replayed the Host contract tests (3) and make lint
  (10 tasks, 9 cached); diff checks passed.
- Installation descriptors are a serving-Host capability, not authorization to
  install arbitrary remote code. Cloud catalogs remain read-only; legacy
  records are labeled honestly and removal controls follow actual backend ports.
  Neutral descriptors stay in shared-types and Host routes form a coherent
  adapter module. No cloud plugin execution system was introduced.
- Default Host testing reports a pre-existing missing generated artifact at
  plugins/asset-edit/dist/loro_wasm_bg.wasm. Storyboard is successfully registered;
  this does not verify all bundled plugin packaging. Skill installer tests use
  local command/file fixtures rather than live downloads.

### Stage 6

- Preserve distinct Web/API tables while unifying identical hosted definitions.
  The coordinator captured pre-refactor table/column/default/index/key contracts
  in /tmp/clash-stage6-schema-contract-before.json for independent comparison.
  Remove SQL foreign-key declarations, preserving ORM relation metadata and
  historical migration data.
- Introduced backend-only shared-cloud-schema with narrow auth/app/broker/runtime
  exports. Compatibility modules preserve each backend's existing table profile;
  all pre-refactor non-FK contracts compare exactly. Root guidance, both READMEs,
  and the architecture guide now reflect Vite/RR7, integrated gateway, and Host
  discovery rather than retired Next/standalone gateway paths.
- 52 related tests passed, including generated SQLite DDL with foreign_keys=ON,
  auth relation queries, and real workerd/D1 consumers. Schema, API, and Web
  typechecks passed. Existing migration configuration resolves all original
  tables; historical SQL and deployed constraints were not modified.
- Coordinator independently replayed the SQLite test and compared every captured
  contract. Workspace dependencies are acyclic, with only API/Web consuming the
  schema package. make lint passed (11 tasks, 9 cached), as did frozen offline
  installation. Lock peer snapshots changed without resolved version upgrades.

### Stage 7

- Expand the source quality gate and transitive invalidation without release
  builds; resolve the recorded CLI and MiniMax narrowing diagnostics honestly.
- make lint now checks generated source-profile drift and the quality tool,
  followed by 48 workspace source typechecks and five existing ESLint tasks.
  Final acceptance ran all 53 tasks successfully with zero cache hits. CI retains
  Desktop tests and uses the expanded root gate; no release build is involved.
- Fixed CLI Headers types, MiniMax/Pika unsupported Document/executor-URL handling,
  Move AI upload types, and portable Fetch/Crypto contracts. No Worker DOM globals,
  lower strictness, or new source exclusions were used to conceal diagnostics.
  Relevant behavioral/config tests passed (118); frozen installation passed.
- Source resolution checks cover all 48 TypeScript workspace projects without
  repository dist/runtime declarations. Timeline's intentional artifact test
  still checks actual runtime behavior, without borrowing generated static types.
  Documentation-only apps/docs is outside these TypeScript project profiles.
- Coordinator compared the raw Turbo dry-run hashes independently: shared-source,
  root TypeScript config, and root ESLint config changes invalidate all five key
  downstream checks; all graph hashes restore exactly, with no build nodes.
  Root source mappings and sparse runtime aliases have one maintained definition;
  generated copies are checked for drift. Remote CI/full Desktop tests were not
  executed in this stage.

### Stage 8

- Disposed of all 40 maintained JS-family files: migrated 37 scripts to
  TypeScript, preserved the ESLint configuration exactly as JSON, and removed
  two unused CLI launchers. The old drive-agent's fixed port and obsolete
  credential contract have no production callers; no fictional replacement
  CLI command was introduced. Generated runtime/bin filenames remain unchanged.
- Packaging, runner, artwork and shared Web E2E tools now have strict checks.
  Existing opt-in Desktop/CLI E2E scopes retain native parse verification;
  migrating an extension does not imply full runtime or strict-check coverage.
  Real built-Host E2E loading stays explicit without borrowing stale dist types.
- Behavioral evidence: 105 scoped tests passed, including Desktop/Host helpers,
  CLI runner selection/failure propagation, native bundler/import guards, CDP
  loopback and temporary Git/ripgrep/npm packaging fixtures. Three credentialed
  E2E prerequisites explicitly skipped. No full browser/Provider E2E or release
  build was run. Both bin and non-bin Host artifacts survive npm pack dry-run.
- Coordinator independently verified all 37 paths and executable modes, exact
  parsed ESLint equality, and electron-builder's real TypeScript afterPack hook
  loader using a non-mutating platform branch. No maintained JS-family source
  file remains in the pending Git scope; generated outputs remain ignored.
- Explicit root tooling dependencies reuse installed versions; frozen offline
  installation passed. A full gate exposed and resolved Web script type errors.
  A later run was system-killed at default concurrency; limiting Turbo to three
  retains all checks and dependencies. Final make lint passed 53/53 with no
  cache (4m5s), and diff checks passed. Evidence: /tmp/clash-stage8-validation.md.

### Stage 9

- Added the narrow Action SDK executable-failure export over its existing pure
  implementation. Four portable Provider modules and Cloud error consumers no
  longer import Node assembly/stdio through the SDK root. Root Node exports
  remain intact, with identical error-class identity across both entrypoints.
  Source mappings and affected Vitest aliases consistently resolve current code.
- Actual pnpm workspace inventory has no production dependency cycles or
  missing source exports; shared-cloud-schema remains backend-only. Existing
  Document/marketplace adapters and the shared sync coordinator have coherent
  boundaries and need no arbitrary split by line count. Node filesystem and
  discovery adapters, deliberate legacy readers/publication and historical SQL
  remain explicitly documented compatibility boundaries.
- Regression evidence: 117 selected shared/API/SDK/MiniMax tests passed. Browser
  bundles of the error entry and all four Providers contain only their expected
  source modules; a VM with injected fetch and no Node globals executes their
  actual HTTP failure paths. No polyfills, externalization or repository dist
  input is used. Coordinator independently replayed the original MiniMax
  failure and verified it now bundles using only two source files.
- Scoped source checks, frozen installation, profile drift and diff checks
  passed. Final make lint passed 53/53 with zero cache (4m13s). Commands and
  evidence: /tmp/clash-stage9-validation.md. No full release build, deployment,
  real Provider request or full browser E2E is implied by this acceptance.

### Initial audit notes (resolved by the stages above)

- Stage 5: production Local Host injects the executable plugin installer, not
  the optional legacy Action installer. The active Cloud registry still merges
  community Worker Actions, and Web's no-package fallback persists a workerUrl
  through settings as apparent install success. Close that live path while
  retaining deliberate old-record read/removal support.
  Review `MarketplaceItemCard` and the manage loader too: `canManage` currently
  follows page mode alone. Do not expose install controls for entries whose
  connected backend has no real installer; preserve supported skill/plugin
  workflows based on actual endpoint behavior.
- Stage 6: the three Better Auth schema files are identical, while the two app
  schemas contain both common definitions and realm-specific tables. Unify
  shared definitions without dropping unique tables or changing historical SQL.
- Stage 7: check Turbo cache dependencies as well as command inclusion. Existing
  lint/typecheck tasks have no dependency edges, so a cached consumer check can
  survive shared-source changes. The source gate must invalidate transitively
  without adding release builds. Include the CLI dev-check findings in
  `director.ts` (Headers iteration) and `workspace.ts` (optional authorization),
  plus the MiniMax reference-union errors recorded above.
  MiniMax's narrowing must handle or explicitly reject Document and executor-URL
  forms. An executor URL is a Host capability and must never be forwarded to a
  Provider as if it were a provider URL (see Action SDK ResolvedReference).
- Stage 8: the remaining ESLint CJS file is a static object and can use the
  existing ESLint JSON configuration format; a major ESLint upgrade is not
  required to remove that JS file. Packaging launchers need executable smoke
  checks and updated references in addition to extension changes.
  `packages/cli/bin/clash.mjs` has no repository callers and is not the package
  bin (the real bin is generated `dist/index.js`); confirm whether to remove the
  dormant launcher. Keep intentional generated ESM/CJS output contracts such as
  `dist/plugin.mjs` distinct from maintained source scripts.
- Stage 9: a browser-platform bundle probe of shared-runtime/minimax-executor
  fails because its error helpers import the Action SDK root, which also loads
  Node fs/path/readline assembly and stdio modules. Similar neutral provider
  adapters import the same root. Existing Worker node compatibility can conceal
  this boundary leak. Add an appropriate narrow portable SDK export and migrate
  portable consumers; verify browser/Worker resolution without Node polyfills.
  Reproducer log: /tmp/clash-stage9-minimax-browser-probe.log. Do not merely
  externalize Node built-ins or add polyfills to claim portability.


Record for each completed stage: concrete behavior changed; affected entrypoints;
tests/checks and their results; compatibility or migration decisions; any remaining
deployment-only dependency. A green lint result alone is not end-to-end evidence.

The working tree started clean. During Stage 1, another task added
`docs/cloud-launch-roadmap.md` and began cloud authorization changes. Preserve
those edits and review overlap before each stage; never stage unrelated work
with a blanket `git add -A`. Generated plugin `runtime/` directories remain
ignored and must not be recommitted. Commit/push checkpoints follow the user's
existing authorization, after reviewing the staged scope and validation.

## Follow-up: 512 MiB cloud content transport

- Raised the user-requested per-Resource and per-Document limit to 512 MiB.
  Uploads larger than 8 MiB use sequential bounded multipart requests through
  the existing authenticated endpoints; downloads and local installation stream.
- Private R2 staging is published only after exact length and full SHA-256
  verification. Each request checks admission; completion and abort coordinate
  through persisted publication state. Expired sessions are reclaimed in bounded
  cron batches. Preserve R2's default incomplete multipart lifecycle rule.
- Verified an actual 512 MiB Resource round trip and a roughly 40 MiB Document
  round trip in Miniflare/R2. SDK tests (14), Host tests (13), API unit tests (12),
  and seven distinct integration cases passed, including boundary rejection,
  revocation, concurrent completion, cleanup, and uncertain publication recovery.
- Final `make lint` passed all 53 tasks. No production deployment.
