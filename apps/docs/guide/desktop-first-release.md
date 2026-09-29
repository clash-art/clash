# Desktop First Release

Status: **Scope frozen**, effective 2026-09-14 by product-owner decision.
Release acceptance remains pending. This document is the scope authority for
first-release work; it is not evidence that the product has passed acceptance.

## Release promise

A new user on macOS Apple Silicon can install Clash, configure a supported
agent and generation provider, create a local project, generate or import media,
edit a timeline, export a playable video, and reopen the project with their work
intact, without developer assistance or a source checkout.

Local project operations do not require cloud login. Provider or agent
authentication may be required for their respective services.

## Frozen scope

- First public target: macOS Apple Silicon desktop Beta.
- Local projects, existing Canvas and asset workflows, an existing supported
  agent path, an existing supported generation path, timeline editing, and export.
- Installation, first-run guidance, actionable failures, restart recovery, and
  preservation of projects, assets, and configuration during manual upgrades.
- Existing CLI and plugin clients continue to use the same local Host and
  concurrency rules. Preserve the local-first invariants in root AGENTS.md.

Windows, Linux, Intel Mac release commitments, new providers or models, new
creative tools, expanded Director workflows, expanded cloud collaboration,
automatic updates, and broad architectural or visual redesigns are deferred.
Existing implementations need not be removed simply because they are deferred;
do not advertise them as accepted first-release capabilities. Fix existing
security and data-integrity defects when encountered.

Changes during the freeze must resolve a reproducible defect, satisfy an
acceptance gate below, or supply the associated documentation or verification.
Record the relevant gate and validation in the change description. Product-owner
instructions may explicitly change scope; ordinary in-scope work proceeds
without another approval. Any required refactor should stay bounded to its fix.

## Acceptance gates

All items below are **pending** until evidence is attached for the candidate.

- [ ] **Install and launch:** Install the candidate on a clean supported Mac
  without Node, pnpm, a source checkout, or developer PATH dependencies. Verify
  first launch, bundled runtime availability, normal quit, and relaunch.
- [ ] **First successful video:** Through the installed GUI, configure the
  selected existing agent/provider path, create a local project, generate real
  media, edit a timeline, export a video, and play it outside Clash. Record the
  provider/model, steps, output, and any user-facing limitations.
- [ ] **Persistence and recovery:** Reopen the project after a normal restart
  and an interrupted Host session. Verify assets, timeline edits, and references
  survive. Exercise failed generation/export and recovery without corrupting
  project state or silently duplicating output.
- [ ] **Local integrity:** Run the existing agent-first local v1 gate for CAS,
  copy-on-write, project/workspace isolation, timeline persistence, and storage
  repair. Investigate failures; do not weaken assertions to obtain a pass.
- [ ] **Upgrade:** Replace an earlier candidate with the release candidate and
  verify existing projects, media, provider configuration, and settings remain
  usable. Document the manual upgrade path; automatic updates are not required.
- [ ] **Public distribution:** Configure signing and notarization, verify the
  downloaded installer on a clean machine, and provide a versioned release with
  release notes and known limitations. Unsigned builds remain invited previews.
- [ ] **Release gating:** Require successful source/lint checks and desktop
  tests for the exact release commit before publication. Attach installed-app
  and local integrity acceptance reports to that candidate; separate workflows
  running independently are not a publication gate.
- [ ] **Onboarding and support:** Supply installation, provider setup, first
  export, upgrade, and troubleshooting instructions suitable for end users.
  Confirm users can find diagnostic information for startup or export failures.

Invited previews may precede signing/notarization, but still require successful
installation, the core video workflow, and persistence checks. Do not present an
invited preview as a fully accepted public Beta.

## Evidence and current baseline

For each acceptance run, record commit SHA, installer version and checksum,
macOS version and architecture, clean-install or upgrade setup, command/manual
steps, result, and artifact/report paths. Keep credentials and private traces
out of published evidence. A blocked or skipped check remains unverified.

At the freeze decision, commit `f183525a` had these local checks:

- Desktop Vitest: 24 files and 157 tests passed.
- `make lint`: passed; all 53 Turbo tasks used cached results.
- Release configuration provided unsigned rolling preview installers.
- CI ran lint and desktop unit tests; the separate release workflow did not
  depend on their success or run installed-app acceptance.

These checks are a baseline, not installed-app or fresh-machine acceptance.
Older generation reports do not certify the current installer. The
2026-09-11 Director-to-video report was blocked on benchmark lineage
verification, not proof of a runtime failure; it does not certify that workflow.

## Work order

1. Establish an installed-app macOS candidate and run the first-video and
   persistence gates; turn observed failures into bounded release blockers.
2. Fix those blockers and validate local integrity and upgrade behavior.
3. Complete public distribution, release gating, and end-user documentation.
4. Revalidate the final candidate and make an explicit release decision.

Calendar estimates are planning assumptions, not release criteria. Freezing
scope does not authorize tagging, uploading installers, or publishing a release.
