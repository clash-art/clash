---
name: clash-film-production
description: "Coordinate narrative AI film production from story and scene rehearsal through coverage, editable Timeline, and reviewed delivery. Use for short films or requests to shoot like a film; use the atomic creative skills for individual reference or continuity tasks."
---

# Clash Film Production

Produce a scene that can be covered by different cameras and cut into one
performance. A collection of attractive clips is not yet a scene. Treat cast,
costumes, sets, props, and recorded performances as reusable production inputs;
each shot observes a particular moment from a chosen point of view.

Use this workflow for connected generative scenes. Keep a standalone image or
single incidental shot lightweight. For footage that already exists, use
`clash-timeline-production`; for an actual Director Stage, use
`clash-director-production` for staging and capture. A film does not require
inventing a 3D Stage or generating a 3D model.

## Compose the skills the task needs

Read the brief and existing material before making new references. Preserve
the user's chosen identity, style, model/provider, language, duration, and
authorization. Make reasonable production decisions within that scope.
An internal review checkpoint means inspect and select; it is not automatically
a request for user approval. Ask when a consequential choice cannot be inferred
or when the user has requested a checkpoint.

Load the available atomic skill for the current production question:

- `clash-multiview-consistency`: derive and review missing character, prop,
  costume, or set views from selected designs.
- `clash-reference-composition`: combine selected inputs into each camera's
  intended image, with explicit identity, environment, and layout roles.
- `clash-shot-continuity`: connect neighboring shots through coherent state,
  action, geography, gaze, and sound.

Each can run independently for other creative categories. Do not load all three
for a single uncomplicated edit or make a character sheet for a product-only
task. Reuse already accepted material rather than repeating their workflows.

## Choose generation roles deliberately

Choose image and video models separately. Image generation/editing establishes
identities, consistent set views, and composed shot keyframes; video generation
supplies performance and motion; voice tools may supply reusable performances.
Use the current Model Cards and available routes to determine reference input
semantics, editing controls, audio, duration, and published output values.

Honor a requested model family such as GPT Image when it is available. Without
a user preference, select for the job's reference/editing and motion needs;
do not silently standardize on one vendor. Explain a meaningful choice briefly
when asked. A configured Provider is a route, not a model or proof that every
model feature is exposed through that route. Do not infer missing login from
redacted credentials or missing models from one filtered catalog view.

The atomic skills own reference prompts and input-role distinctions. Bind their
selected results to the actual supported Generator inputs when producing shots.

## Rehearse a scene before scaling production

Read [scene-production.md](references/scene-production.md) before generating
coverage. Establish a performance and blocking plan, then use the atomic skills
for the missing references, compositions, and joins.

Make an editable test sequence containing a continuous dramatic exchange and
its relevant coverage. For dialogue, test the speaker, listener, and the cut
between their viewpoints, including any important shared action. Several
unrelated technical tests do not establish scene continuity. Use valid test
takes in the final edit instead of recreating them merely because they were tests.

Read [review-and-repair.md](references/review-and-repair.md) when selecting takes
or diagnosing drift. Review the sequence with sound at normal speed and inspect
both sides of its cuts. Expand to the remaining scenes only after the recurring
identity, space, performance, and editing problems are understood and corrected.
If a scene fails, fix the failed reference, composition, action, or audio
assumption before submitting another large batch. Budget freedom does not make
identical rerolls informative.

## Keep production resumable in Clash

The base `clash` skill owns public CLI/MCP discovery, guarded writes, Generator
Actions, immutable Assets, and Timeline application. With a ready receipt, use
the bound project; do not run init or start a daemon. Do not substitute another
media service for the user's chosen Provider or a filesystem render for the
product's editable Timeline and rendered output.

Keep cast/set references, per-shot inputs, selected takes, audio references,
and cut decisions in the project. Use existing supported Views when suitable,
or concise working-tree notes and supported Canvas text. These notes are
production records, not a new product schema. Record actual Asset/Revision
identities and bind them to Generator inputs; filenames and prose alone do not
preserve lineage. Changing a selected reference requires identifying affected
shots, producing replacements as needed, and explicitly selecting those takes;
previous outputs remain pinned to their original inputs.

Carry accepted takes into the real Timeline with editable dialogue, ambience,
captions, and other layers that the project actually uses. Reconcile source
duration, cut points, audio timing, and total length there. Use the Timeline and
finishing skills for the final edit. Reference packs, planned timecodes, sampled
frames, and a successful render submission prove different things; delivery
requires actual playable media and a review proportional to the claim.
