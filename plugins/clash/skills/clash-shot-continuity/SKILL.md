---
name: clash-shot-continuity
description: "Plan, review, or repair continuity between adjacent shots: subject state, spatial relationships, action phase, gaze, and sound. Use for connected AI video, ads, tutorials, animation, or live-action edits."
---

# Shot continuity

Make adjacent views read as the intended event. Use this for a single cut or
sequence; it does not require planning an entire film or regenerating every shot.
For repairs in a Clash Project, follow the base `clash` skill's Generator,
Asset, and Timeline contracts. Honor the user's model/provider choices and
retain selected input revisions, takes, and edit decisions in the project.

## Specify what the cut carries

Read both shots and the intended transition. Separate stable identity/design
from changing **state** and **performance**. Record just the information needed
to join them: subject positions, camera side, active hand, object orientation
and assembly state, action phase, gaze, speech, and sound perspective.

The incoming shot inherits the outgoing event's state unless a deliberate
ellipsis, reset, or scene change explains the difference. A tutorial's close-up
cannot silently reassemble the part just removed; a product ad's new angle
should preserve the selected lid state unless it shows the opening action.

```text
Shot A ends at [observed action/speech phase and subject/object state].
Shot B begins at [matching or explicitly advanced phase/state].
The cut means [continuous action, reaction, elapsed time, or scene change].
Keep [identity, geography, gaze, object state, shared performance] consistent.
Change [camera/framing and any intentional narrative changes].
Join at [the observable action or audio cue]; retain usable edit handles.
```

These are working notes, not a new project schema or mandatory field list.

## Preserve geography and performance

Locate cameras and subjects relative to the set and action line. A change in
screen-left can be correct after a legible camera/subject move; an unexplained
reversal can make the same location appear different. Reconcile backgrounds,
entrances, light sources, sight lines, and contact points against world positions.

For generated coverage, compose each camera's opening image from the selected
design and event state. Use the available `clash-reference-composition` skill
when input roles or framing need work. Matching the final and first stills is
insufficient if the action between them is physically incoherent.

Keep a speaker's intention, listener reaction, pauses, and ongoing action
continuous across coverage. For dialogue, reuse selected voice/performance
inputs where supported. Listen to actual words and delivery; inspect visible
articulation and audio joins. Replacing audio alone does not validate lip sync.
J/L cuts and shared ambience can connect pictures when motivated by the scene.

## Inspect the join and repair the smallest cause

Watch at normal speed with sound, then inspect frames around the cut and any
interaction. Check for identity drift, state resets, duplicated action/words,
missing motion, eye-line errors, and unintended sound changes. Distinguish an
intentional edit from a failure before correcting it.

| Failure                                                | Useful repair                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| Correct takes join at different action phases          | Select compatible ranges or revise the cut                                |
| Wrong hand, lid state, clothing variant, or background | Correct the incoming shot's state/composition before another take         |
| Motion fails inside an otherwise consistent shot       | Simplify or split the action into meaningful coverage                     |
| Words, voice, or visible articulation disagree         | Repair performance/audio inputs with supported controls and review again  |
| Needed coverage does not exist                         | Produce the missing view/action rather than padding with repeated footage |

Preserve accepted inputs and previous takes. Record the selected ranges and
remaining defects. Claim only the continuity actually inspected; if listening
or motion inspection is unavailable, leave that part unverified.

## Source

Clash-authored application of general editing/continuity practice and observed
AI-generation failures. This is not a vendored upstream skill or a claim that
prompt wording guarantees temporal consistency.
