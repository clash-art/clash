# Structured plugin drafts

A plugin View is a `plugin-view` Canvas node, normally on the implicit `main`
Canvas. Read it with `clash_canvas_get` before changing it. For the Storyboard
View, preserve all four top-level groups: `keyElements`, `shots`,
`audioLayers`, and `uncategorized`. An element, shot, or audio entry owns
material slots; each slot owns zero or more Project Asset candidates and an
optional `selectedCandidateId`. Shot descriptions may contain structured
`entity-reference` parts rather than flattened display text.

Apply the complete draft through `clash_canvas_update` using `viewState`, or
edit a workspace JSON draft and pass `viewStateFile`. The Host validates the
whole View state under the node read receipt, so preserve entries you did not
intend to change and re-read after applying. Never patch the immutable View
definition reference.

When filling a material slot through generation, follow the [generation workflow](generation.md) first. After `output_commit_get`, add the committed Project Asset
as a candidate and retain `generatorId`, `generatorRevisionId`, `actionRunId`,
`outputCommitId`, and `outputSlot` in `generatedBy`. Selecting a final candidate
is a separate View update; the View plugin itself contributes no Generator.
