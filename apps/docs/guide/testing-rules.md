# What a Test May Assert

A test earns its keep by failing when something is broken and staying quiet
otherwise. Two failure modes are common enough in this repository to have their own
rules, and both were found the expensive way: a test that cannot fail, and a test
that fails for reasons nobody caused.

## The ratchet

The worst outcome is not a useless test. It is a test that locks an unverified
invention in place.

```ts
// Implementation, written in the same change:
const SHORT_EDGE_ALIASES = { '720p': '1K', '1080p': '2K', /* ... */ };

// Test, written by the same author from the same assumption:
expect(canonicalResolutionTier('720p')).toBe('1K');
```

That assertion cannot fail while the map exists, and the map exists because the
assertion says it should. Nothing about the outside world was checked — `720p` is
1280×720 = 921600 pixels and a 1K budget is 1048576, so the equality is simply
false.

The damage is not the wasted test. It is that **correcting the code now makes the
suite red**, so the next person sees "31 tests failing" and concludes the fix is
wrong. A mistake has been promoted to a requirement.

::: warning Mutation testing does not catch this
Reverting the map does turn that test red, which is exactly why it feels verified.
Mutation testing proves a test is *wired to* the code. It cannot prove the assertion
is *true*. An implementation and a test written in one change from one assumption
confirm nothing about each other.
:::

## What may be pinned

Ask where the expected value comes from.

| Source of the expected value | Verdict |
| --- | --- |
| Official upstream documentation, a captured API response, a shipped third-party implementation | **Pin it.** There is an external fact to be wrong about. |
| A vocabulary invented in the same change | **Do not pin it,** no matter how green mutation testing looks. |
| Data copied out of the file under test | **Do not pin it.** The test is a second copy that must be edited in lockstep. |
| A count (`length >= 5`, `> 15` cards) | **Do not pin it.** It drifts whenever the catalogue grows and expresses no contract. |

When there is no external source of truth, assert **behaviour** instead of content:

```ts
// Brittle: pins one moment's strings, must be edited when a provider changes a menu
expect(options).toEqual(['0.5K', '1K']);

// Durable: true for every vocabulary, survives new models, and only fails when the
// transport actually stops honouring the card
expect(bodySentUpstream.resolution).toBe(cardDeclaredResolution);
```

A pass-through assertion also fails at the right time. During the resolution-ladder
change above, pass-through was never broken — an extra layer had been inserted
between the card and the wire. A content assertion could not see that; a
pass-through assertion is precisely what would have.

## Don't re-assert the schema

`ModelCardSchema` already refuses a card whose `defaultValue` or `defaultParams`
entry is not among its own `options`, for **every** parameter. A test that checks the
same thing for one parameter has narrower coverage than the schema and one more place
to maintain.

Before writing a data-shape test, check whether a Zod `superRefine` already rejects
it. If it does, delete the test; if it should, move the rule into the schema where
every card gets it.

The exception is a field the schema cannot reach. `defaultAspectRatio` sits on the
card rather than inside `parameters`, so the candidate check never sees it and a card
can advertise a default frame its own control cannot select. That test is worth
having — and it was verified by mutation: setting `nano-banana-2`'s
`defaultAspectRatio` to `3:1` produces
`3:1 not in [1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9]`.

## Source-text assertions

Several suites lock architecture by reading a component's source and asserting a
mechanism appears in it — that a toolbar uses the shared Radix primitive rather than
hand-rolled roles, for instance. These are legitimate: `AGENTS.md` makes shared
primitives mandatory, and no runtime assertion expresses "this file does not
hand-roll a listbox".

They are also the most fragile kind, because the literal form encodes Prettier's
choices. Use `sourceContains` / `sourceMatches` from
`packages/web-ui/src/test-support/source-match.ts` instead of raw `toContain`:

```ts
// Fails after a pure reformat, with no behaviour change
expect(source).toContain(`<Tooltip label="Undo" placement="right">`);

// Survives reflow, still fails when the mechanism is gone
expect(sourceMatches(source, /<Tooltip label="Undo" placement="right">/)).toBe(true);
```

Normalization collapses whitespace, quote style, the space before a wrapped `/>`, and
Prettier's trailing commas — and it applies **the same rule list to the pattern and
the source**. Mirroring those rules in two functions drifted three times in a row;
each time a rule reached the source only, a correct pattern became unmatchable.

Two habits keep these tests honest:

- **Scope the slice.** A whole-file `[\s\S]*` match between two needles will span
  unrelated code. Extract the region under test.
- **Bound every gap.** Normalized source is a single line, so `[^\n]*` and `[\s\S]*`
  stop meaning "nearby". A pattern like `/useState[^\n]*expanded/` will happily match a
  `useState` on line 40 against an `expanded` prop on line 2315 and report a
  hand-rolled disclosure that does not exist. Write `.{0,40}` and say how close.
- **Check the mechanism exists before believing the failure.** A source assertion
  that names something no file contains is describing a design that was never built
  — `MAX_COPILOT_PANEL_FRACTION` appeared only in test files, while the real cap
  lived in `copilotPanelLayout.ts` under a different name with its own behaviour
  test.

## Triaging a failing legacy suite

When a suite fails and the code looks right, the discriminator is: **does the
assertion test behaviour, or source text?**

Behaviour assertions are usually right. In one triage pass they caught four real
violations of the shared-primitive rule and one functional regression where a
new music model silently turned an "Audio Prompt" node from speech into music.

Source-text assertions are usually noise. In the same pass, 22 of 31 failures were
Prettier reflow and the rest asserted designs that were never implemented.

Delete a test only when its subject is deliberately gone. Then **reverse it** —
assert the absence — so the deletion becomes the locked invariant instead of a gap.

## Source quality gate

`make lint` first validates generated source-check profiles and checks the small
configuration tool itself, then runs workspace TypeScript checks and the existing
ESLint tasks. `make typecheck` uses the same configuration validation but omits
ESLint. This is a source gate; it does not run release builds or the root Turbo
test task, whose existing dependencies include builds. CI retains Desktop tests
after this gate.

`tsconfig.source.json` owns common workspace source paths. Each check profile
extends the package's actual development/base config without reducing strictness
or excluding failing implementation files. Browser entrypoints and app-local
aliases are sparse overrides in `source-check-profiles.json`; the generated full
`paths` maps are necessary because TypeScript replaces that map rather than
merging it. Edit the authoritative mapping/overrides and run
`pnpm quality:configs:write`; normal gates only detect drift. Release targets and
artifact generation configs remain separate.

Turbo `typecheck` depends on upstream `typecheck`, and ESLint depends on relevant
source checks. Root source-profile, configuration-tool and ESLint files are global
cache inputs. To verify changes to the gate, inspect `--dry=json` task hashes using
a temporary shared-source probe and a root-config probe, restoring both afterward;
confirm downstream CLI/Host/API/UI hashes change and no build task is scheduled.
Use `tsc --listFilesOnly` to distinguish repository source from stale repository
`dist`; third-party dependencies' own distribution files are expected.

Maintained packaging and runner tools use native Node 24 TypeScript. Their strict
checks live in `tsconfig.quality.json`; isolated tests cover import guards, runner
selection, and staging already-built plugin artifacts. Large opt-in E2E scripts
are syntax-checked with `node --check <script.ts>` separately from their browser,
Host, or real-agent execution. Renaming a script does not authorize executing
those workflows. Published `dist/*.js`, `dist/*.mjs`, and `runtime/*.js` names
remain generated external contracts.
