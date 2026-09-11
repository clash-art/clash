# Clash Skill Marketplace

This folder contains Clash's skill registry, including **Official Picks** curated
by Clash from both its own skills and upstream authors. Curation does not change
authorship: `source` remains `first-party`, `provider-official`, or `community`.
The registry is intentionally checked into the repository so the
marketplace can be reviewed, versioned, and tested like product code.

## Files

- `registry.json`: first-party marketplace entries.
- `registry.schema.json`: JSON schema for registry shape.
- `skill-market.test.ts`: local integrity test for registry and `SKILL.md`
  files.
- `curation-review.md`: content review, adaptation decisions, pinned sources,
  and validation limits for the creative collection.
- `video-production/`: production skills for common video and image workflows.
- `../plugins/clash/skills/`: shipped native creative skills, including reusable
  multiview consistency, reference composition, and shot continuity. Film
  production composes these atomic skills instead of owning duplicate recipes.

## Official Picks and source attribution

`curation.collection: official-picks` selects a skill for the Store and home
feed. Each upstream pick keeps its author, repository, exact reviewed commit,
original SKILL.md URL, license URL, and dated repository star count. Repository
popularity helps discover candidates; inclusion requires a content and execution
review. Stars are not an individual skill rating or a quality guarantee. The
details page exposes these source links and adaptation notes.

Unmodified upstream skills install through `npx-skills` from their reviewed
source. Clash-maintained adaptations use distinct skill names and ship with
the original license, pinned source, and a NOTICE describing changes. They keep
`source: community` and the upstream author; `attribution.notes` identifies
Clash's adaptation and distinguishes upstream version/stars from the installed
copy. Do not label a derivative as an unmodified upstream release.

`bundled-skill` describes where the installer gets a skill, independently of its
authorship. Both native skills and reviewed adaptations use the same installer
against their shipped directory, resolved from the canonical plugin root used
by native agent workspaces. This path does not fetch the upstream workflow.

The current collection has three reusable creative atoms (multiview, reference
composition, continuity), a film orchestration skill, and adapted cover,
infographic, and comic workflows. The latter are task-specific compositions,
not new atomic operations. The maintained category workflows also cover product
advertising, speech editing, explanation, narrative scenes, music/MV, and brand
motion. [Task packs](../plugins/clash/skill-packs.json) compose these with relevant
atoms; E2E cases mount one pack plus output-specific skills in each isolated
Task workspace. See the [review](curation-review.md) for their scope.

Content/license review and installer discovery do not establish generated-media
quality. A selected workflow may still need its stated image or export tools.

## Design Rules

- A skill is a portable workflow and artifact contract. It should be useful from
  an agent's working directory even when Clash is not the execution runtime.
- Portable execution means an agent can follow the skill from its own cwd and
  produce readable files, manifests, metadata, and generated assets without
  depending on Clash internals.
- Clash is the collaboration and management layer: project state, asset registry,
  metadata fill, provenance, review gates, timeline CAS apply, and canvas/timeline
  projections.
- Skills depend on host capability contracts, not Clash private storage or UI
  internals. Clash is one host implementation for collaboration, permissioning,
  project state, and apply/review management.
- `actions` in `registry.json` are host bindings for discoverable local CLI
  production primitives. They do not make a skill Clash-only; they describe how
  Clash can trigger the same portable workflow, which artifacts it expects, and
  where explicit apply commands and cwd-observation CAS are required.
- Each action should also name the contract tests that prove the trigger command
  and produced artifacts are real, so the marketplace cannot drift away from
  executable system capability.
- Managed execution means Clash hosts or coordinates the same workflow as
  project-state changes with permissions, review, provenance, and CAS protection.
- Architecture skills define system shape, storage, safety, and QA gates.
- Detail skills define one production workflow such as short drama, MV, 口播,
  TVC/reference remix, or image storyboard consistency.
- Skills can ask agents to edit files, but product state enters canvas/timeline
  through explicit CLI or host APIs with CAS.
- `requiredSystemCapabilities` is a compatibility field for Clash-native
  automation bindings. It is not a gate for running a skill as a local
  file/artifact workflow.
- Missing Clash-native automation coverage must be declared in `registry.json`
  instead of hidden inside prose. A `blocked-by-system-gap` skill is blocked for
  fully managed Clash execution, not for portable drafting or artifact emission.
- Third-party projects are tracked as references in `thirdPartyReferences`.
  Research sources are not vendored by default. Code, model, or prompt reuse
  requires matching the upstream license, preserving required notices, and
  passing review for AGPL, noncommercial, custom, or unverified licenses.
