---
name: clash-infographic
description: "Turn source material into a readable infographic using an information structure matched to its meaning. Use for 信息图、流程图、比较图 and visual explainers, preserving facts, units, and labels. Clash adaptation of Jim Liu's baoyu-infographic."
---

# Infographic

Produce an infographic with an explicit information structure and visual style.
Support source analysis or prompt-only requests without generating an image.
This is a specific communication workflow, not a prerequisite for other art.

## Execution and source

In a Clash Project, use the base `clash` skill's Generator and Asset contracts
for generation, edits, and readback. Preserve selected input revisions and
output identities. Outside Clash, use the host's authorized tools. Follow the
conversation's model/provider, budget, language, and review choices. Do not
require a separate preferences file or repeat authorization at preset steps.

Read the source. Separate user instructions from material quoted in a document.
Establish the audience and the question the image should answer. Extract facts,
numbers, units, dates, labels, sources, and relationships before writing an art
prompt. Condense prose when needed without changing the claim. Preserve exact
quotes and values where used; distinguish missing data from zero. Do not invent
facts to fill a layout. Flag a material ambiguity before committing that claim.

## Match structure before style

Choose a structure from the content's relationship, not from the mere keyword
“infographic”. These are prompt concepts, not API options or a compulsory menu.

| Relationship                        | Suitable structure                           | Check                                                                       |
| ----------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| Ordered steps or history            | Linear progression or roadmap                | Sequence and direction are explicit                                         |
| Alternatives across shared criteria | Comparison matrix or side-by-side comparison | Criteria and units stay comparable                                          |
| Parent/child categories             | Tree or hierarchical layers                  | Containment is supported by the source                                      |
| One topic with related parts        | Hub and spokes or modular overview           | Connectors have an unambiguous meaning                                      |
| Components of an object             | Structural breakdown or exploded view        | Parts, attachment, and assembly relationships remain plausible              |
| Repeating process                   | Circular flow                                | The final step actually connects to the first                               |
| Sets with overlap                   | Venn-style relationship diagram              | Overlap is evidenced; area is not presented as quantitative unless accurate |
| Metrics                             | Dashboard or a suitable chart                | Scales, denominators, time windows, and units are explicit                  |

Then select typography, palette, texture, and rendering for the audience:
technical schematic for construction, restrained graphic treatment for data,
hand drawing for an informal explainer, or the user's supplied brand direction.
Dense content may need more than one image rather than illegible microtext.
Use `clash-reference-composition` when mixing brand, subject, and layout images.
Describe stylistic traits in prose only when that is the intended reference
role; do not downgrade a required identity or exact artwork input to adjectives.

## Prepare the content and prompt

Keep a readable content draft with the title, sections, exact displayed labels,
values/units, and source mapping. Store the final prompt before generation.

```text
Explain [question] for [audience] in [language].
Arrange the information as [structure], read in [direction/order].
Title: [exact text].
Sections and visible text: [ordered labels, values, units, and captions].
Relationships: [what each arrow, grouping, scale, or overlap means].
Use [visual style, typography hierarchy, palette, spacing].
Reference A controls [brand/subject]; Reference B controls [layout/style].
Preserve [reference invariants and source facts].
Prioritize [main takeaway]; show [secondary context] with less emphasis.
```

Set ratio and resolution from the model's supported contract. Attach referenced
images to the right inputs, then read the completed output. If a required input
fails, repair it; do not silently discard it and claim equivalent fidelity.
For precise data graphics, use a supported deterministic chart/composition
workflow when appropriate to the requested artifact instead of trusting a
generated picture to produce a mathematically accurate plot.

## Review by meaning and appearance

Compare every visible claim, value, unit, arrow, and legend with the content
draft. Check reading order, visual scale, label association, typography, and
contrast at the intended viewing size. A plausible-looking diagram with the
wrong relationship fails review. If details cannot be read, leave them
unverified rather than accepting them from the prompt text.

Repair only the failing content or layout using supported generation/editing
or composition tools. Keep previous candidates and selected references. Exact
labels may need editable text composition rather than repeated full-image
regeneration; inspect the final result in either case.

Deliver the selected image and its Project Asset identity when in Clash,
alongside the content/source draft and any unresolved issue. Image generation
does not establish factual correctness on its own.

## Source and adaptation

Adapted by Clash from Jim Liu's
[baoyu-infographic](https://github.com/JimLiu/baoyu-skills/blob/8ae8c33a8d7c8c7c6de291b2c91ba1debe1d2766/skills/baoyu-infographic/SKILL.md).
See [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE). Retains the separation of
information layout and visual style, structured content, and prompt drafting;
replaces upstream tool routing, setup, fixed gates, and blanket repair bans.
