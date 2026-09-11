# Clash Product Context

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Creative professionals and agent-assisted makers working in the Clash desktop environment. They move between projects, assets, Canvas, Timeline, Director Stage, and agent-led creation workflows, often for long focused sessions.

## Product Purpose

Clash gives humans and agents one local-first creative workspace where projects can be understood, changed, reviewed, and shipped through explicit product contracts. The home surface should make it immediate to start an agent task or resume recent work.

## Positioning

Humans and agents work on the same local-first project model. Canvas, Timeline, Director Stage, assets, and agent tools are connected parts of that creative workspace; optional hosted collaboration extends the local workflow.

## Operating Context

Users work in the Clash desktop environment and move between visual editing and agent-assisted creation. Desktop, CLI, and local agents operate the same local Project Loro replica. Agents can edit working-tree files with native filesystem tools and explicitly apply projected text or timeline changes back to the project.

## Capabilities and Constraints

- Canvas organizes nodes, references, assets, and generation workflows; Timeline and Director Stage provide their corresponding editing surfaces.
- Local work does not require a cloud credential. Cloud collaboration is optional and must not create a second project model or agent workflow.
- Reads and mutations use the shared project contracts, including concurrency checks and copy-on-write for immutable downstream references.
- Media assets and applied text revisions are immutable facts. Timeline outputs retain the revision they were rendered from.
- Every visible control must have a real functional contract. Existing identity, terminology, and accessibility requirements remain binding.

## Evidence on Hand

- [README.md](README.md): product introduction, creative surfaces, and supported working paths.
- [AGENTS.md](AGENTS.md): local-first invariants, mutation contracts, and implementation constraints supplied for this repository.
- [apps/docs/guide](apps/docs/guide): existing product and architecture guides.
- [packages/web-ui](packages/web-ui), [packages/gui](packages/gui), and [apps/desktop](apps/desktop): incumbent shared interface and desktop implementation.
- [DESIGN.md](DESIGN.md): existing visual design authority; this product-record migration does not replace it.

## Product Principles

- Keep humans and agents on one project model and shared operation contracts.
- Make local creation independent of optional hosted collaboration.
- Preserve downstream references through explicit revisions and copy-on-write.
- Expose only controls backed by supported product behavior.

## Brand Personality

Direct, capable, and creative. Clash should feel confident without becoming loud, familiar without becoming generic, and distinctly branded without tinting every working surface.

## Anti-references

- Ornamental AI dashboards with gradients, glows, glass panels, canvas textures, oversized slogans, or decorative metrics.
- Warm cream or editorial treatments that make a working tool feel themed.
- Dense navigation chrome, unsupported dashboard controls, and visual novelty that competes with the task.
- Product surfaces that use the Clash coral like a promotional or warning color.

## Design Principles

- Brand boldly at the perimeter; keep the working product quiet.
- Start with the real task: agent input first, recent work immediately after.
- Prefer familiar product structures and stable densities over visual surprise.
- Every visible control must have a real product contract.
- Use color to communicate identity, selection, and state, never as ambient decoration.

## Accessibility & Inclusion

Meet WCAG AA contrast for text and controls, preserve visible keyboard focus, support reduced motion, and never rely on color alone to communicate state.
