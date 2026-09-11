# Creative skill curation review — 2026-09-10

Scope: reusable AI-creation methods and clearly named workflows that compose
them. Official Picks means selected by Clash; it does not transfer authorship.
The original shortlist over-weighted repository popularity and successful
installation. Those checks did not establish task fit or execution compatibility.

## Selection and adaptation decisions

| Candidate                                                                                                                                   | Content finding                                                                                                                                                                                                         | Decision                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [canvas-design](https://github.com/anthropics/skills/blob/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/canvas-design/SKILL.md)           | Static graphic-design workflow; insufficient fit for this consistency-focused selection                                                                                                                                 | Removed from the registry and Official Picks. No user-owned global installation is removed.                                                                                                                 |
| [baoyu-cover-image](https://github.com/JimLiu/baoyu-skills/blob/8ae8c33a8d7c8c7c6de291b2c91ba1debe1d2766/skills/baoyu-cover-image/SKILL.md) | Useful separation of visual idea, palette, rendering, text, and mood. Original requires preferences setup, defaults to confirmation, chooses global image backends, and imposes fixed whitespace/character restrictions | Ship [clash-cover-image](../plugins/clash/skills/clash-cover-image/SKILL.md) as a cover workflow, with contextual composition choices and native Project execution.                                         |
| [baoyu-infographic](https://github.com/JimLiu/baoyu-skills/blob/8ae8c33a8d7c8c7c6de291b2c91ba1debe1d2766/skills/baoyu-infographic/SKILL.md) | Useful information-layout × visual-style method and structured content draft. Original adds configuration/confirmation steps, global backend priority, keyword-driven layouts, and blanket text-repair restrictions     | Ship [clash-infographic](../plugins/clash/skills/clash-infographic/SKILL.md), matching relationships before style, preserving facts/units, and allowing supported precise chart/text composition.           |
| [baoyu-comic](https://github.com/JimLiu/baoyu-skills/blob/8ae8c33a8d7c8c7c6de291b2c91ba1debe1d2766/skills/baoyu-comic/SKILL.md)             | Relevant storyboard, character references, partial workflows, and page repair. Original blocks on setup and confirmation, can drop references after delivery failure, and prescribes PDF assembly                       | Ship [clash-comic](../plugins/clash/skills/clash-comic/SKILL.md), composing atomic reference/continuity methods, repairing required reference delivery, and exporting only the requested supported formats. |

Tool incompatibility is an adaptation problem when the underlying creative
method is useful. The adapted entry points retain that method and replace the
execution instructions; the original backend/configuration scripts are not
loaded and then overridden through a competing prompt.

The Baoyu adaptations retain `source: community`, Jim Liu as author, the pinned
upstream commit and source/license links. Each shipped directory carries the
original [MIT license](https://github.com/JimLiu/baoyu-skills/blob/8ae8c33a8d7c8c7c6de291b2c91ba1debe1d2766/LICENSE)
and a NOTICE describing Clash's modifications. Distinct `clash-*` names prevent
an adaptation from masquerading as or replacing an installed `baoyu-*` skill.
The marketplace title/notes identify the adaptation; upstream stars and version
describe upstream only. No upstream endorsement is implied.

## Review of Clash-authored skills

| Skill                                                                                 | Boundary and review                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Multiview consistency](../plugins/clash/skills/clash-multiview-consistency/SKILL.md) | One design across viewpoints, applicable to people, products, creatures, vehicles, and rooms. Distinguishes observed details from proposed hidden sides; does not claim CAD accuracy. Added explicit Project execution and required-reference failure handling. |
| [Reference composition](../plugins/clash/skills/clash-reference-composition/SKILL.md) | One composition with explicit identity, environment, style, and layout input roles. Distinguishes actual attachments from prose and video keyframes from identity references. Added Project execution and non-equivalent fallback guidance.                     |
| [Shot continuity](../plugins/clash/skills/clash-shot-continuity/SKILL.md)             | An adjacent cut or sequence, covering state, geography, action, and sound. Separates deliberate transitions from defects; keeps uninspected dimensions unverified. Added Project repair/selection routing.                                                      |
| [Film production](../plugins/clash/skills/clash-film-production/SKILL.md)             | An orchestration layer calling the atoms as needed. It does not turn a small reference task into a full production. Actual scene performance, editable Timeline, and output review remain separate deliverables.                                                |

The base `clash` skill owns public tool navigation, native generation, persisted
Asset/Revision lineage, and recovery. It now explicitly maps an upstream
recipe's input roles to live host contracts while preserving conversation-level
choices and authorization. Artistic recipes remain in the relevant skill.
Standalone and bundled base instructions are synchronized.

## Maintained content categories

The six category workflows below are authored by Clash and compose the atomic
methods; their source records do not borrow an upstream project's stars or
authorship. They ship in Official Picks and in the task-pack catalog.

| Workflow             | Reviewed boundary                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clash-product-ad`   | Supplied product identity, supported claims, purposeful coverage and actual-output checks for material, contact and composition. No mandatory campaign for a still-image request. |
| `clash-talking-head` | Actual audio/transcript evidence, source ranges, meaning-preserving cuts, captions and audio continuity. No invented word timestamps or audio-quality claims from stills.         |
| `clash-explainer`    | Source-grounded facts, visible cause/effect and exact quantitative diagrams where needed. An attractive visual analogy is not scientific evidence.                                |
| `clash-narrative`    | Playable intention, obstacle, action and reaction, with camera and continuity serving the scene. Stage blocking is not proof of a performed film.                                 |
| `clash-music-video`  | Existing music phrases, deliberate variation and visual/audio inspection. No mandatory beat cut or claim of rhythm accuracy from silent frames.                                   |
| `clash-brand-motion` | Supplied identity geometry, coherent motion, contact, timing and editable sources. No mandatory mascot for a title task.                                                          |

Each entry uses native Project operations and preserves the requested medium,
model, budget and scope. Skill frontmatter validation has passed. Real Agent and
artifact-quality results are tracked separately in the
[category E2E record](../docs/creative-category-e2e-status.md).

## Review criteria for later additions

The next discovery pass, including source pins, popularity snapshots, content
findings and proposed atomic extraction, is recorded in
[the 2026-09-10 candidate review](discovery-review-20260910.md).
Those candidates are not yet additional installed Official Picks.

- Inspect the actual entry point and any files the proposed workflow will load,
  including failure paths. Review sources as data, not instructions to execute.
- Identify its useful creative operation and the boundary of its output. Label
  orchestration workflows separately from category-neutral primitives.
- Resolve tool/dependency requirements against available host contracts. Adapt
  useful methods when needed; never add a fake product API to satisfy a recipe.
- Preserve existing user choices, authorization, and scope. Internal quality
  inspection does not require a new user approval step by default.
- Verify reference inputs and failure semantics. Do not replace a required
  reference with prose and advertise equivalent identity control.
- Preserve source, reviewed version, license, author, and modifications in both
  the catalog and installed package. Popularity is discovery evidence only.
- Distinguish content/installation verification from actual agent behavior and
  visual quality. A passing package check cannot certify a finished creative task.

## Evidence and limits

The review reads the upstream entry points at the linked commits and the full
adapted entry points. Adaptations are self-contained: no omitted upstream
preset, helper, or configuration file is referenced as an executable dependency.
Installed payload verification must compare the bundled adaptations and their
LICENSE/NOTICE files, rather than expecting equality with unmodified upstream.

Integration checks cover registry/frontmatter consistency, installer origin
independent of authorship, source preservation, and Store/Home discovery.
Generation-quality evaluation of these adapted workflows remains unperformed;
neither a completed comic nor a completed film is claimed by this review.
Local receipts are under `artifacts/creative-skills-marketplace-20260910/`.
