# Clash Creative Artifact Benchmarks

This benchmark evaluates what a headless agent leaves in an isolated workspace.
The agent receives an outcome and acceptance criteria, owns the plan, and must
write `submission.json`. The evaluator does not use the agent's final prose as
evidence.

Clash-host cases install the packaged skills but do not create or replace an
`AGENTS.md`. Codex and Claude Code discover the Clash skill from the task, enter
the stdio MCP root command menu, and progressively select typed operations from their live
descriptions, schemas, structured results, and recovery guidance. Outcomes may
name product-level lineage that is part of acceptance, but they do not provide
copy-paste tool arguments or reveal hidden scoring rubrics.

Run one real Codex case:

```bash
pnpm benchmark:artifacts -- \
  --suite benchmarks/creative-artifacts/v2/suite.json \
  --agent codex \
  --model gpt-5.6-sol \
  --quality-reviewer codex \
  --quality-provider openai \
  --quality-model gpt-5.6-sol \
  --case director-street-vlog-cold-open-v2 \
  --out artifacts/headless-benchmarks
```

Run the same case through Claude Code's native headless protocol:

```bash
pnpm benchmark:artifacts -- \
  --suite benchmarks/creative-artifacts/v2/suite.json \
  --agent claude \
  --model "$CLAUDE_BENCH_MODEL" \
  --case director-street-vlog-cold-open-v2 \
  --out artifacts/headless-benchmarks
```

Pi also uses an explicit provider/model pair:

```bash
pnpm benchmark:artifacts -- \
  --suite benchmarks/creative-artifacts/v2/suite.json \
  --agent pi \
  --provider openai \
  --model gpt-5.6-sol \
  --out artifacts/headless-benchmarks
```

Ready Environments reject an omitted model, provider-changing native arguments,
and the generic command adapter. Codex binds the provider to `openai`; Claude
binds it to `anthropic`; Pi requires `--provider` because its provider is
otherwise mutable.

Content-effect cases have explicit semantic `qualityCriteria` separate from
technical acceptance gates. Technical evidence by itself produces
`pending-review`, never a pass. An optional judge is configured in the harness
environment; the CLI flags only override it. Either judge runs without Clash
tools and publishes its evaluator/spec identity and every score in an immutable
Evaluation bound to exact artifact SHA-256 evidence and the `attemptDigest`. A
judge reviews only the evidence kinds it can inspect; if any criterion requires
another kind, the entire review stays pending instead of asking the model to
infer what it cannot inspect.

| Harness environment variable   | Override flag                           | Meaning                                                              |
| ------------------------------ | --------------------------------------- | -------------------------------------------------------------------- |
| `CLASH_BENCH_QUALITY_REVIEWER` | `--quality-reviewer codex\|gemini`      | Which judge runs. Unset means no judge.                              |
| `CLASH_BENCH_QUALITY_PROVIDER` | `--quality-provider openai\|google`     | Must be `openai` for `codex` and `google` for `gemini`.              |
| `CLASH_BENCH_QUALITY_MODEL`    | `--quality-model <model>`               | Judge model. Required once a judge is selected.                      |
| `GEMINI_API_KEY`               | `--quality-api-key-env <NAME>` (a name) | Gemini key. The flag selects another _variable_, never a value.      |
| `GEMINI_BASE_URL`              | `--quality-base-url <url>`              | Gemini-native API origin, e.g. a relay. Unset means Google's origin. |

- `codex` runs the Codex CLI read-only and inspects image evidence only.
  `--quality-reviewer-command` selects its executable.
- `gemini` calls the Gemini-native `generateContent` endpoint with no tools and
  inspects image, video, and audio evidence. The base URL must be an https
  origin without credentials. The key is sent only as the `x-goog-api-key`
  header and never written to the run; the CLI refuses to start a run that
  needs the key from the harness environment when the variable is unset. Media
  over the inline request limit is uploaded through the Gemini Files API and
  deleted after the review; a relay without that API fails the review closed.

`environment-lock.json` records the configured judge in its own `qualityJudge`
section, outside `resolvedEnvironment`: the reviewer kind, provider, and model,
and for Gemini the endpoint host and the _names_ of the variables the key and
base URL came from (`env.apiKey`, `env.baseUrl`). It never holds a key value or
a URL path. The Evaluation's evaluator identity carries the same endpoint host
and key variable name. Because the judge is evaluator identity,
`resolvedEnvironmentDigest` and the rest of the lock are identical across
judges, and resume compares the lock without `qualityJudge`: a completed
Attempt keeps the judge it recorded and can be resumed or re-judged under
another one, while any change to the Agent Environment is still refused.

On a remote backend the worker runs the judge. The unit names the key variable
in `judgeEnvNames`; the container backend passes it with `--env NAME`, a cloud
session reads it from its environment's secrets, and it is not added to the
Agent's explicit environment. The resolved base URL travels in the unit, so
`GEMINI_BASE_URL` only needs to be set where the harness starts.

Known limit, measured 2026-10-10 with `gemini-3.8-flash`: the judge sees the
moving picture and hears the audio, but it did not separate a render whose
visuals were shifted 250 ms off the beat from the on-beat render, and repeated
reviews of identical evidence moved a criterion by about ten points. Treat a
sub-second synchrony score as coarse, and do not compare single reviews.

```bash
export GEMINI_API_KEY=...
export GEMINI_BASE_URL=https://cf.api.fan
export CLASH_BENCH_QUALITY_REVIEWER=gemini
export CLASH_BENCH_QUALITY_PROVIDER=google
export CLASH_BENCH_QUALITY_MODEL=gemini-3.8-flash

pnpm benchmark:artifacts -- \
  --suite benchmarks/creative-artifacts/v2/suite.json \
  --agent claude \
  --model "$AGENT_MODEL" \
  --case remotion-rhythm-mascot-mv-v2 \
  --out artifacts/headless-benchmarks
```

Every case directory contains the durable outcome, agent workspace, stdout and
stderr logs, the submitted artifact manifest, an external scorecard, and an
`outcome-result.json` written by the runner. Required gates fail closed.

Both functional and content-effect tracks use the same standardized Environment
pipeline. Each ready case imports one exact product Workspace bundle and must
produce a verified modified Workspace bundle. The runner separately preserves
the adapter-native event stream, a normalized trajectory, a Codex/Pi ATIF-v1.7
structured projection when supported, trusted readback/report artifacts, a
sealed OTLP/JSON trace and receipt, and a sanitized execution lock. Before any Agent
runs, the lock records its explicit model/provider, exact executable
SHA-256/size/version, every installed skill digest, and the Clash plugin
manifest identity plus deterministic runtime digest. The Agent sources are
checked around the main run. Reviewer executable verification remains
runner-private, while public reviewer provenance belongs to its Evaluation and
does not change the Agent Environment or Attempt identity. A successful content
score cannot hide a missing modified Workspace capture.

Every rollout ends with immutable, score-free `attempt.json` covering the Task,
resolved Agent Environment, input and modified Workspace trees, trajectories,
readback, and facts-only OTLP evidence. Technical and quality Evaluations are
separate content-addressed records; versioned policies derive optional
Aggregate and Reward records, and `result-bundle.json` indexes the current
selection. The executor is currently truthfully recorded as `native-local`,
not container-hermetic. The shared contract is documented in
[`../README.md`](../README.md).

The knowledge boundary is intentional: the base Clash skill teaches peer CLI
or MCP navigation; production skills teach creative judgment and revision; MCP
contracts teach live product operation; the benchmark runner owns isolation and
hidden transport/readback checks. No benchmark guidance is injected through a
repository instruction file.

## Skills mounted per task

Each case selects a named `skillPack` from
[`plugins/clash/skill-packs.json`](../../plugins/clash/skill-packs.json).
The six content categories select product-ad, talking-head, explainer, narrative,
music-video, or brand-motion. Case-level `skills` adds only the required product
media operations, such as Director, Timeline, or Remotion construction.

The suite loader expands that one pack, resolves members relative to its catalog,
and deduplicates additions. The runner copies the resolved set into the fresh
task workspace's native skill directories. It does not mount the entire plugin
skill tree or install anything globally. Task evidence retains the selected
pack and expanded paths; the Environment lock hashes each installed skill and
checks its content before and after execution. Editing a task copy cannot alter
another task or the source pack.

Codex's `--ignore-user-config` still discovers user skills. The adapter therefore
sets `skills.include_instructions=false` and provides only the mounted Task's
name/description/path catalog through native `developer_instructions`. It keeps
skill bodies lazy and records the supplied catalog in `logs/task-skills.md`.
This changes the run's prompt context, not filesystem permissions. Global skill
files remain untouched. The independent image judge has no creative skill
catalog or plugins injected. These switches use the
[upstream Codex configuration contract](https://developers.openai.com/codex/config-schema.json).

This is the benchmark Task mounting contract. Ordinary Desktop sessions still
use their existing project-scoped skill discovery; this change does not claim
per-session isolation of skill discovery inside a shared project cwd.

Catalog coverage and mounting tests do not establish a content-effect pass.
Inspect each Attempt and independent Evaluation: missing audio review remains
pending, and a stale packaged runtime is an infrastructure issue to resolve.

The original Version 2 set contains 21 cases: five each for Director,
Timeline/editor, Remotion character, and mixed workflows, plus a music/rhythm/MV
content-effect case. The catalog also includes the separate
`product-ad-director-to-video-v1` contract described below.
Director outcomes require exact-time PNGs from
`clash_director_capture`. Remotion characters are editable TSX components
persisted as Canvas `remotion-component` nodes; the stable Canvas node ID is
retained as the Timeline composition `sourceNodeId`, the runtime is `remotion`,
and playable media must come from `clash_timeline_render`. Sampled PNGs are
evaluated from the real rendered media, while the runner retains the MCP
trajectory and trusted product readback separately from agent-authored reports.

Cases may also declare an immutable `inputFixture`. The runner validates a
canonical path/size/SHA-256 manifest, copies the public source pack into the
fresh workspace, validates it again, and records provenance without exposing
hidden evaluation data. `timeline-talking-head-tech-review-v2` uses this path:
its 43.633-second synthetic口播 includes a false start, fillers, repetition,
dead air, a timed transcript, and source audio for a real text-based cut.

Creator names in the catalog are editorial-format shorthand, not likeness or
brand targets. Every corresponding outcome forbids imitation of a real face,
voice, logo, mascot, trade dress, map artwork, or proprietary brand package;
evaluation concerns only the enumerated, observable framing, pacing, narrative,
typographic, and animation traits.

## Version 2 case catalog

`director-premium-gadget-hero-v2` ends at a Stage and three PNGs. It measures
Director staging, not a completed generated advertisement. Its historical
scores remain scoped to those artifacts.

`product-ad-director-to-video-v1` adds the complete advertising workflow:
Director captures → optional refined image keyframes → video-model takes →
editable Timeline → rendered ad. The Task requires actual image Asset bindings
in video generation and preserves the complete provenance chain; a slideshow
or a direct Stage render does not satisfy the outcome. Its task-specific
mounts add Director, Timeline, and finishing to the product-ad pack.

The new contract is currently in `blocked-contract`: the runner does not yet
independently read back that capture/keyframe-to-video-to-edit lineage. This
does not mean the product lacks video generation. The semantic criteria also
include full video evidence, so the image-only Codex judge leaves review
pending rather than inferring motion quality from stills; the Gemini judge can
inspect that video once the contract is unblocked. Do not mark this
contract ready or reuse the old three-PNG score as its result.

| Category           | Case ID                                          | Editorial challenge                                                                                             |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Director           | `director-street-vlog-cold-open-v2`              | Casey Neistat shorthand: occluded arrival, moving medium, prop reveal, and close reaction.                      |
| Director           | `director-challenge-arena-countdown-v2`          | MrBeast shorthand: immediately legible contestants, obstacle, prize, escalation, and finish reaction.           |
| Director           | `director-premium-gadget-hero-v2`                | MKBHD shorthand: dark studio, one accent color, material detail, orbit, and clean hero lockup.                  |
| Director           | `director-future-lab-walkthrough-v2`             | Cleo Abram shorthand: walking introduction, mechanism point, and optimistic scale reveal.                       |
| Director           | `director-investigation-evidence-wall-v2`        | Johnny Harris shorthand: desk, map, and evidence-wall progression from question to finding.                     |
| Timeline           | `timeline-vertical-retention-hook-v2`            | MrBeast shorthand: first-second promise, escalating numeric or scale beats, and payoff tease.                   |
| Timeline           | `timeline-talking-head-tech-review-v2`           | MKBHD shorthand: talking-head jump cuts, restrained typography, motivated product B-roll, and audio continuity. |
| Timeline           | `timeline-productivity-tip-cutdown-v2`           | Ali Abdaal shorthand: friendly problem question, three-step checklist, desk B-roll, and useful takeaway.        |
| Timeline           | `timeline-map-investigation-explainer-v2`        | Johnny Harris shorthand: presenter-plus-map layouts, route and clue buildup, and causal conclusion.             |
| Timeline           | `timeline-street-vlog-mini-story-v2`             | Casey Neistat shorthand: location, movement, obstacle, arrival payoff, and audio-motivated momentum.            |
| Remotion character | `remotion-character-cosmic-question-host-v2`     | Kurzgesagt shorthand: original flat-geometric science host, orbiting icons, and limited-palette pose arc.       |
| Remotion character | `remotion-character-task-juggler-v2`             | Original productivity overlay with planted walk contacts, readable prop handoffs, and follow-through.           |
| Remotion character | `remotion-character-hot-take-reaction-v2`        | Original talking-head reaction overlay progressing through disbelief, insight, and relief.                      |
| Remotion character | `remotion-character-claim-evidence-synthesis-v2` | Two original explainer characters align claim and evidence through continuous contact and resolution.           |
| Remotion character | `remotion-character-channel-sting-v2`            | Original creator sting with weighted impact, recovery, pointing pose, and readable end card.                    |
| Mixed              | `mixed-productivity-mythbust-short-v2`           | Ali Abdaal shorthand: Director desk host, Remotion checklist reaction, and myth-to-tip edit.                    |
| Mixed              | `mixed-challenge-cold-open-v2`                   | MrBeast shorthand: Director challenge arena, Remotion countdown character, and suspense-led final cut.          |
| Mixed              | `mixed-premium-gadget-mini-review-v2`            | MKBHD shorthand: Director product orbit, Remotion metric presenter, and three-point mini review.                |
| Mixed              | `mixed-map-investigation-story-v2`               | Johnny Harris shorthand: Director evidence wall, Remotion guide, sourced geography, and causal reframe.         |
| Mixed              | `mixed-future-tech-optimist-short-v2`            | Cleo Abram shorthand: Director lab reveal, Remotion science guide, and question-to-impact progression.          |
| Music/rhythm/MV    | `remotion-rhythm-mascot-mv-v2`                   | Original pulse mascot choreographed as a four-part phrase against a deterministic 120 BPM audio fixture.        |

The medium mixed review publishes its functional gate in the agent-visible task:
the Stage needs at least four objects, two cameras, three ordered sequence shots,
and one animated track; the canonical Timeline needs at least three tracks, five
items, 270 frames, and image, composition, and text item types, with every media
item retaining the actual kind of its Project Asset. The Director capture
receipt pins its `projectAssetId` output to the final Stage revision, and a
canonical Timeline media item references that same Project Asset. Capture does
not write its Action output back into the source Stage or require a recapture
loop. These are acceptance requirements, not reviewer-only scoring hints.
