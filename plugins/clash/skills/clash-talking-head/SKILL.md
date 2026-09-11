---
name: clash-talking-head
description: "Edit speech-led material using transcript evidence, selected source ranges, motivated coverage, and continuous audio. Use for 口播、访谈、播客 and presenter videos, including text-based cuts and subtitles."
---

# Talking head and interview editing

Work from the supplied performance and requested edit. In a Clash Project,
use the base `clash` skill and the available Timeline/finishing skills for
product changes. Preserve exact source Asset identities and source ranges.

## Establish the speech evidence

Read the brief and listen to the supplied audio. Use a transcript with source
identity and timestamps where available. Machine text is provisional until
checked against the recording, especially names, quantities, negations, and
speaker changes. If ASR is unavailable, do not invent word timestamps.

Mark semantic beats: question, claim, support, example, and takeaway. Remove
false starts, repeated wording, or dead air only when that improves the intended
delivery without changing meaning. Preserve qualifications and listener context;
do not create a statement the speaker did not make by stitching fragments.

## Make an edit decision, not a transcript rewrite

```text
Source [Asset and selected revision if applicable], speaker [identity].
Keep [source in/out ranges] for [message beat].
Remove [ranges] because [false start/repetition/unneeded pause].
Join at [audible and visible boundary]; retain [breath/reaction/necessary pause].
Cover [specific cut] with [motivated product/detail/context footage].
Caption text [verified words], timed to [observed speech range].
```

Maintain the speaker's pace and performance. Avoid cutting inside consonants,
leaving duplicated syllables, or flattening every pause. Use B-roll where it
explains or supports what is said; a random image does not repair a broken
sentence. Reframe or use a visible jump cut when appropriate to the format.
Use `clash-shot-continuity` for related picture and sound transitions.

## Subtitles and sound

Time captions to actual words or phrases and make line breaks follow syntax.
Preserve names, units, punctuation, and reading order. Inspect overlap with the
face, demonstrations, or other text at the requested output size. Keep speech
intelligible under music; listen to joins and changing ambience. Audio replacement
alone does not prove lip sync.

## Acceptance

Watch and listen to the exported edit. Verify the meaning against the source,
cut boundaries, subtitles, coverage relevance, and audio continuity. Preserve
the source and editable selected ranges. A plausible transcript or a Timeline
duration alone is insufficient evidence of a successful spoken edit. If audio
inspection is unavailable, leave performance and word accuracy unverified.

## Source

Clash-authored method for source-preserving speech editing and product readback.
