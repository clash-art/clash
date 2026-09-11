---
name: agentic-video-creator
description: Use whenever an agent should autonomously turn a natural-language brief into a finished Clash video workflow: organize one or more draft Canvases by creative context or sequence, keep storyboard/A-roll/B-roll together in grouped generation paths, ask for only high-leverage human choices, select assets, and assemble the final edit in a Timeline. Trigger for end-to-end video creation, "make me a video", Flova-style agent creation, agent-driven editing, or requests that expect the agent to operate Clash rather than explain how Clash works.
compatibility: Requires a running Clash local host and @clash/cli >=0.1.0-beta.3 <0.2.0 for managed execution.
---

# Agentic Video Creator

Act as the project's creative director, producer, and editor. The user asks for
an outcome; operate Clash to produce it. Do not turn the response into a Clash
tutorial unless the user explicitly asks how the product works.

This is the execution counterpart to `agentic-video-architecture`. Use that
architecture skill when designing a new production system; use this skill when
an agent is expected to run an actual creative job.

## Read Before Acting

Read these references from this skill directory:

- `references/production-loop.md` for the stage machine, Canvas topology, and
  candidate strategy. Read it for every run.
- `references/clash-execution.md` before reading or mutating Clash state.
- `references/quality-gates.md` before selecting candidates, asking the user to
  choose, applying the Timeline, or claiming completion.

When the brief belongs to a specialist workflow, use the matching skill from
the task's mounted pack. These maintained skills are bundled with Clash; do not
follow retired sibling-directory paths or load every category for one task:

| Brief                              | Additional skill                                                 |
| ---------------------------------- | ---------------------------------------------------------------- |
| vertical drama or serialized story | `clash-narrative`; `clash-film-production` for a full production |
| MV, lyric video, beat-driven edit  | `clash-music-video`                                              |
| talking head, interview, podcast   | `clash-talking-head`                                             |
| TVC, branded ad, reference remix   | `clash-product-ad`                                               |
| tutorial or visual explanation     | `clash-explainer`                                                |
| motion identity or brand sting     | `clash-brand-motion`                                             |
| character or storyboard image pack | `clash-multiview-consistency` and `clash-reference-composition`  |

## Creative Contract

Turn the request into a compact creative contract before expensive generation:

- outcome and audience;
- platform, aspect ratio, duration, and language;
- narrative or message hierarchy;
- must-use inputs and must-not-do constraints;
- visual and audio direction;
- budget or generation ceiling;
- approval policy: `autonomous`, `key-checkpoints`, or `approve-final`.

Infer reversible defaults from context. Ask one concise question only when a
missing answer would materially change format, rights, cost, or identity. A
missing adjective is not a blocker; an unknown platform for a tightly specified
ad delivery may be.

Persist the contract as an agent-editable project artifact and a brief node on
the creative Canvas. Do not rely on chat memory for production-critical facts.

## Product Model

Keep these responsibilities separate:

```text
Project    = production boundary and shared asset catalog
Canvas     = disposable/revisable draft room for one creative context
Group      = one draft path, scene, shot family, or candidate batch
Node chain = inputs -> generation decisions -> candidates -> draft select
Asset      = immutable generated/imported media revision
Timeline   = accepted ordered editorial state
```

Canvases are scratch space. They classify, branch, and develop material; their
layout does not represent final time order or a production commitment. Groups
make Flova-like paths legible inside a Canvas without inventing a second
workflow engine. The same Project may contain several Canvases, and each may
contain several draft paths. The Timeline is where selected material becomes an
edit.

Create only the Canvases the job needs. Split them by creative context, sequence,
parallel owner, or alternate direction—not by media role. A useful topology is:

1. `development` — brief, global references, look development, identity/product
   locks, and constraints.
2. `sequence-01`, `sequence-02`, ... — one contiguous scene or editorial
   sequence per Canvas when the production is large enough to benefit.
3. `alternate-<direction>` — only when an intentionally separate creative route
   needs isolated references and review.
4. `audio-graphics` — optional when this is genuinely an independent production
   context; otherwise keep its draft nodes with the relevant sequence.

A small job should usually use one `drafts` Canvas with a Group per beat or shot.
A larger job may use `development` plus one Canvas per sequence. Do not create
separate Canvases merely for storyboard, A-roll, or B-roll: these are coupled
parts of the same shot decision. Do not create one Canvas per shot or duplicate
immutable media merely for organization.

Within a Canvas, use one Group per coherent path. A typical path contains the
beat/shot brief, storyboard or keyframe, primary-action candidates, coverage or
B-roll candidates, and a select note. Start a new Canvas when the creative
context, sequence, review owner, or alternate direction changes; start a new
Group when only the beat, shot, or candidate question changes.

## Autonomous Production Loop

Run the stages in order:

```text
brief -> lookdev -> storyboard -> generate -> selects -> edit -> QA -> delivery
```

At each stage:

1. Read current Project, Canvas, task, and Timeline state before deciding.
2. Write the stage artifact or state change so work is inspectable and resumable.
3. Execute all safe, reversible work available at that stage.
4. Stop only at a real blocker or a review gate defined below.
5. Record selected inputs and immutable output asset IDs before advancing.

Do not ask the user to drive routine production. The Agent owns decomposition,
prompt authoring, candidate generation, first-pass evaluation, continuity, and
Timeline assembly.

## Candidate Generation, Not Blind Rerolling

Treat generation as a directed search:

- one candidate for low-risk utility material;
- two for ordinary secondary shots;
- three for hero shots or uncertain composition/motion;
- up to four for a high-leverage style, character, product, or opening-hook
  decision.

Each candidate should test a named hypothesis such as camera distance, blocking,
lighting, motion, or emotional intensity. Hold identity/style anchors constant
unless the stage is explicitly exploring those anchors. Label the hypothesis in
the node and candidate record.

Trigger the candidate jobs first, then wait for their tasks. Do not serialize
generation itself merely because task observation is sequential.

After generation, score candidates using `references/quality-gates.md`. Reject
hard failures before ranking. Automatically select a clear winner when confidence
and score margin are high; otherwise show the user only the top two or three,
with the meaningful tradeoff and the Agent's recommendation.

If all candidates fail the same dimension, diagnose and revise that dimension.
Do not spend budget on identical rerolls. After one targeted regeneration cycle,
either choose the best safe option or raise a concise blocker.

## Human-in-the-Loop Policy

Human input should improve quality where taste or responsibility matters, not
serve as a remote control for the Agent.

Pause for approval when any of these is true:

- a style, character identity, product lock, or opening hook will fan out into
  many expensive downstream generations;
- brand, likeness, legal, safety, or reference-rights judgment is required;
- the planned paid generation exceeds the stated budget or default ceiling;
- the top candidates are close, low-confidence, or encode materially different
  creative directions;
- approval policy is `approve-final` and the master cut is ready.

Do not pause for naming, Canvas layout, ordinary B-roll, clearly failed outputs,
minor continuity repairs, mechanical Timeline edits, or low-cost reversible
experiments within the approved contract.

## Timeline Editing

Create the master Timeline after the first selects pass, not before. Draft
candidates remain on their generation Canvases; only selected media enters the
Timeline. Reorganizing draft Canvases must never substitute for editing the
Timeline.

Use a standalone Project Timeline by default. Attach it to a Canvas only when
the edit is intentionally owned by that Canvas workflow. Keep explicit tracks
for the media the job actually has, typically:

- main video / A-roll;
- B-roll and visual overlays;
- dialogue or voiceover;
- music;
- SFX;
- captions;
- titles and motion graphics.

Timeline items should pin stable `sourceNodeId` and `assetId` references when
available. Pull the Timeline, edit the YAML projection, and apply it through the
CLI's observation/CAS path. On a stale apply, re-pull and reconcile; never look
for a force-overwrite bypass.

Rough-cut priorities:

1. story/message clarity;
2. opening hook and pacing;
3. continuity and usable coverage;
4. audio intelligibility and rhythm;
5. graphics/caption safe areas;
6. polish and transitions.

Use B-roll to cover information, emotion, continuity repairs, and pacing—not as
random decoration. Every B-roll item should have a stated editorial purpose.

## Definition of Done

Do not say the video is finished merely because assets were generated.

For a completed managed run, require:

- creative contract and stage artifacts exist;
- required Canvases contain attributable generation work;
- selected media records retain node/task/asset lineage;
- the master Timeline exists and its latest projection applied successfully;
- required review gates are resolved;
- QA has no unresolved hard blockers;
- if the user requested a rendered deliverable, an export and validation receipt
  exist.

If a provider, host capability, or export path is unavailable, continue all
safe planning, Canvas organization, prompt preparation, and Timeline work that
does not depend on it. Then report the exact blocked stage, completed state, and
next executable action. Do not replace execution with generic advice.

## Final Response

Report outcomes, not command logs:

- what was created or changed;
- which creative direction and candidates were selected, with the key reason;
- Timeline status and duration;
- unresolved review items or system blockers;
- the single highest-value next action, if any.
