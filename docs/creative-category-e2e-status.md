# Creative categories, task skills, and E2E — 2026-09-10

Content categories describe the user's intended work. Director, Timeline, and
Remotion describe implementation surfaces; exercising one surface does not
certify every creative category that can use it.

## Maintained category methods

| User category                             | Workflow             | Task pack      | Representative existing E2E case       |
| ----------------------------------------- | -------------------- | -------------- | -------------------------------------- |
| Advertising / product / TVC               | `clash-product-ad`   | `product-ad`   | `product-ad-director-to-video-v1` (contract blocked; not run) |
| Talking head / interview / podcast        | `clash-talking-head` | `talking-head` | `timeline-talking-head-tech-review-v2` |
| Tutorial / explanation                    | `clash-explainer`    | `explainer`    | `director-future-lab-walkthrough-v2`   |
| Narrative / short drama / cinematic scene | `clash-narrative`    | `narrative`    | `director-street-vlog-cold-open-v2`    |
| Music / rhythm / MV                       | `clash-music-video`  | `music-video`  | `remotion-rhythm-mascot-mv-v2`         |
| Motion graphics / brand identity          | `clash-brand-motion` | `brand-motion` | `remotion-character-channel-sting-v2`  |

The earlier image/storyboard consistency category is served by the independent
`clash-multiview-consistency` and `clash-reference-composition` atoms in
`reference-images`. Full filmmaking has a `film-production` orchestration pack.
Cover, infographic, and comic packs use the reviewed Clash adaptations with
upstream credits. They do not replace the original video categories.

Definitions live in [the shipped pack catalog](../plugins/clash/skill-packs.json).
The old creator entry point no longer directs agents to deleted category folders.

## Advertising scope correction — 2026-09-11

`director-premium-gadget-hero-v2` measures an editable Stage and three captured
PNGs. Its recorded 64-point visual review concerns those stills; it does not
establish video-model generation or a finished advertisement. Preserve that
case and its prior results as Director-stage coverage.

The added `product-ad-director-to-video-v1` requires the full path requested by
the user: Director capture, optional image-model refinement, actual image-bound
video-model generation, selected takes in an editable Timeline, and a final
six-second rendered ad. It mounts the product-ad pack plus the Director,
Timeline, and finishing skills. Stage captures remain intermediate evidence.
The Director and product-ad methods now teach that handoff explicitly instead
of directing captured stills straight into the final edit.

This new case is **not run** and is in the existing `blocked-contract` lane.
The runner has Stage capture and Timeline/Remotion readback, but lacks trusted
readback linking the exact captured or refined keyframes through video-model
Generator revisions, ActionRuns, and OutputCommits to selected Timeline takes
and the final render. This is an evaluator gap, not a claim that Clash lacks
video generation. Its quality criteria require the videos themselves; the
current image-only Codex judge cannot certify motion and must leave that review
pending. Enabling the case requires that lineage readback and an independent
review capable of inspecting the complete moving output. Schema/mounting checks
or the deliberately blocked runner result are not creative E2E passes.

The 2026-09-11 contract check returned `agentStatus: not-run`,
`executionStatus: blocked`, and `qualityReviewStatus: pending`; no video model
was invoked. See the preserved
[outcome](../artifacts/director-to-video-20260911/contract-check/product-ad-director-to-video-v1/outcome-result.json).
The runner/task-pack tests passed (14), the skill registry tests passed (13),
and artifact-evals type checking plus `make lint` passed. The catalog test no
longer fixes a case count or assumes every mixed workflow contains Remotion;
it continues to require readback for the editable sources and videos each
mixed case actually declares.

## Task mounting contract

Each benchmark Task names `skillPack: { path, id }` and may add output-specific
`skills`. The loader and runner resolve the selected pack relative to its
catalog, deduplicate the source paths, and use the existing per-case installer.
Each fresh Task workspace receives copied `.agents/skills` and `.claude/skills`
payloads. Other packs are not installed, and source/global directories are not
modified. Task evidence records the pack selection and expanded members;
Environment locks fingerprint the installed content before and after execution.

For Codex, `--ignore-user-config` alone still exposes global skill descriptions.
The adapter now disables automatic skill instructions and supplies the mounted
Task's metadata through native `developer_instructions`; bodies remain lazy
files. The exact catalog is preserved in `logs/task-skills.md`. This is a prompt
context boundary, not a filesystem access boundary or a change to user settings.
The independent image judge receives no creative skill catalog or plugin
instructions. See the [upstream options](https://developers.openai.com/codex/config-schema.json).

The original 21 creative cases select their corresponding category pack. The 14
functional cases select the base Project pack and add only the product surface
skills they need. The music fixture, speech fixture, technical criteria, and
independent semantic-review requirements are preserved.

This contract applies to benchmark Tasks. Ordinary Desktop ACP sessions retain
their existing project-scoped discovery. Per-session native discovery isolation
inside one shared project cwd is not implemented by this change.

## Verified history versus current coverage

- **Native Hilo media path:** an earlier real product-session E2E generated a
  5.167-second video and selected three seconds into a Timeline. Formal interface
  readback and editor interaction were recorded. This establishes that route,
  not general success across creative categories. See
  [acceptance](../artifacts/hilo-native-generator-e2e-20260910/ACCEPTANCE.md).
- **Ten-minute film:** script, revisions, duration planning, context-compaction
  continuation, and partial media trials exist. There is no verified 600-second
  editable final cut and reviewed complete export. The earlier
  [evaluation log](../artifacts/agent-complex-e2e-20260910/EVALUATION.md) includes
  historical planning-only checkpoints and must not be read as final completion.
- **Task packs:** filesystem tests verify distinct selections, copied content,
  unknown-pack rejection, deduplication, and independence between task copies
  and their sources. Registry and category coverage checks are separate from
  media quality assessment.
- **Fresh E2E attempt:** `task-pack-smoke` reached packaged Host warmup, which
  returned HTTP 500 because `nano-banana-2` registered a duplicate `fal` binding.
  The Agent was `not-run`; this is an infrastructure failure and earns no E2E
  pass. The preserved record is under
  [task-pack-smoke](../artifacts/task-skill-packs-20260910/runs/task-pack-smoke/).

## This round's real executions

These use native Codex CLI (`gpt-6-astra`) with the real packaged Clash MCP and
Host. They do not simulate the persistent Desktop ACP chat session. Independent
image review also uses an explicitly selected `gpt-6-astra` process.

| Attempt                     | Observed outcome                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task-pack-smoke-refreshed` | Real Asset import/list/get and exact byte readback passed; overall failure because Workspace export rejected the public Asset `createdAt` field.                                                                            |
| `task-pack-smoke-final`     | **Full functional pass, 100/100**, including exact media readback and modified Workspace export. The real Agent read its task-local `clash` skill; the supplied catalog is preserved in its logs.                           |
| `product-ad-pack`           | Editable Stage and three PNGs produced, technical score 100. Raw independent image review scored 58; the then-current normalizer incorrectly rejected a nonfatal diagnostic item. Workspace export also failed.             |
| `product-ad-pack-refined`   | Three new PNGs produced, technical score 100, independently recorded visual score **64/85 (fail)**. Native capture origin was also rejected by a legacy ActionAssetBinding readback assumption. No content pass is claimed. |
| `brand-motion-pack`         | Agent authored TSX, persisted its Canvas node and Timeline. Creation returned the wrong public result shape, and rendering failed because the executor required a retired `outputSlot` value. No completed video.           |
| `explainer-pack`            | Agent stopped after real `director.create` returned 503 `GENERATOR_PROJECTION_SURFACE_NOT_INSTALLED`. No Stage, images or quality pass.                                                                                     |
| `brand-motion-pack-native` | Real Timeline operations and MP4 rendering completed after the protocol repairs. Actual frames contain “Missing Remotion component source”; independent image review scored **0/100**. Native Timeline render provenance also fails a legacy node-shaped readback assumption. Overall **fail**, despite an Agent exit code of zero. |

The new category pack sources were read by the real Agents. Automatic global
skill-budget warnings disappeared after native automatic skill instructions were
disabled. No user's global skill files or credentials were modified.

Repairs made from these executions:

- Preserve the shipped Asset schema's `createdAt` fact during Workspace export.
- Accept nonfatal Codex diagnostic items while still rejecting actual tool use
  and failed reviewer lifecycle events.
- Return the public Timeline entity for create/attach/detach/copy, retaining
  internal Host receipt envelopes inside the adapter.
- Use Remotion's declared Generator output slot rather than requiring an extra
  invocation parameter absent from the native contract.
- Verify Director origin through its succeeded native Action Run and Output
  Commit. Validate Stage/revision, executor, frame parameters and exact Asset
  bytes. Missing commits, wrong assets, stale revisions and mismatched runs fail.

The product-ad prompt method also gained actual-output checks for silhouette,
material response, support/contact geometry and crop. The second attempt is a
new observation, not evidence that the skill change alone caused its score.
No rubric or threshold was lowered.

Remaining product findings:

- Remotion's frozen native Timeline input has a Canvas `sourceNodeId` but lacks
  the component source required by the renderer. Retrying the composition ID
  did not repair it. Exact source freezing/lineage and native render readback
  still require work; producing an error-card MP4 is not a successful render.
- The Director 503 was traced to its packaged ESM executor importing YAML through
  the shared-types root barrel (`Dynamic require of "process" is not supported`).
  During this investigation the concurrent Director work extracted the pure
  `director-code` subpath. A real build-and-Node regression reproduced the failure
  and then passed alongside the executor tests (4 tests total). A fresh creative
  E2E against a newly packaged Host has not yet verified that correction.
- The other three category representatives have not received fresh executions
  in this round. Configuring their Task packs does not count as passing them.

Task-pack/reviewer/readback acceptance checks passed (95 tests), as did the Host
regression group (74), Timeline adapter group (27), and Remotion executor group
(4). These groups cover different boundaries; none replaces media inspection.

Refreshing the runtime package exposed release compilation of cross-package
tests under the Host's production `rootDir`. Release compilation now uses
`tsconfig.build.json`, excludes test payloads, and sets `noEmitOnError`;
`tsconfig.dev.json` still checks full source and tests. This does not remove
tests from validation or treat a package build as a creative-quality result.

Current logs and subsequent attempts are recorded under
[`artifacts/task-skill-packs-20260910`](../artifacts/task-skill-packs-20260910/).
For any fresh content-effect result, require product readback, actual artifact
evidence, and an independent supported quality review. Uninspected audio or
motion remains pending; `session.complete` only means that a dialogue turn ended.
