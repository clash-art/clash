# Discover the needed operation

The main skill contains the ordinary find → Action → Timeline workflow. Its
examples can be used directly when applicable; help is for missing information,
not a preflight. Root help routes by task, `actions --help` includes execution
and continuation examples, and `timeline --help` includes a minimal video track.

For CLI work, navigate from the narrowest level already named by the task. If
the task already names a command group, skip the root help. If it also names
the needed operations, skip the group menu and read only unfamiliar leaf help
for argument shapes. Use the built-in command tree when the group or operation
is actually unknown:

```text
clash --help
clash <command> --help
```

Common command groups include `actions`, `assets`, `canvas`, `timeline`, and `director`. Read the
current help before using an unfamiliar subcommand; use `--json` when the
command supports structured output.

For MCP work, use the root `clash` tool only for navigation. Call it without
arguments for the menu, then with `command` to receive the stable dispatcher:

- Use `clash_canvas` for Canvas operations.
- Use `clash_composition` for both temporal composition in Timeline and spatial
  composition in Director Stage. Pass `kind: "timeline"` for Timeline or
  `kind: "director-stage"` for Director Stage when revealing contracts or using
  a short operation.

`clash_assets` without `operation` reveals a lightweight operation index.
For one unfamiliar Asset operation use `contract: "<operation>"`; for several,
use `contracts: ["<operation>", "<operation>"]`. These selective contract
parameters belong to Assets. Other dispatchers reveal their live contracts
when `operation` is omitted (Composition still needs its `kind`). Reuse the
returned contracts during the task, then execute each operation with
`operation` and `arguments`. Each index entry and contract includes
`operation`, the command-local short name such as `get`, and `name`, the
complete `clash_*` leaf name retained for compatibility. Prefer the short name
on the appropriate dispatcher. The advertised tool list does not change. Use
the selected operation's live description, schemas, structured result, and
recovery guidance; there are no `clash_cli_*` MCP namespace wrappers.

For the common Asset workflow, a task that already names Asset `import`,
`list`, and `get` does not need the index first: use `clash_assets` and request
the `import_file`, `list`, and `get` contracts together, then execute those
short operations. Use the index when the required Asset operation is not
already identified.

For media processing, `clash actions list --query <operation>` reveals installed
project-available Actions, including project custom Actions, with their real
state, parameters and input/output contracts. `actions run <key>` invokes the
selected contract and returns a visible native Run plus usable committed output
references. `actions wait <run-id>` continues reading that Run without submitting
again. Named `--inputs` can carry exact Document revision references; `--asset`
is shorthand for a single source slot. The full MCP equivalents are
`clash_generators_actions_list`, `clash_generators_action_invoke`, and
`clash_generators_action_wait`, available as `actions_list`, `action_invoke`, and
`action_wait` through the Generators dispatcher.

For content lookup, use the smallest useful sequence:

1. `clash ls [--kind <kind>]` returns a Project overview without loading bodies.
2. `clash search <query> [--kind <kind>] [--within <refJSON>]` finds names and
   declared prose in Documents and attached analysis.
3. `clash read <refJSON>` opens an exact `items[].ref` or `items[].matches[].document`
   object from the result. Preserve that returned JSON object verbatim.

These commands return structured JSON and resolve the cwd Project, with
`--project <id>` available for explicit scope. MCP uses `content_list`,
`content_search`, and `content_read` on the Assets dispatcher; `within` and
`ref` are objects in MCP. They reuse existing Media and exact Document revision
references, without a virtual filesystem or a new reference syntax. A Media
read returns its descriptor and delivery information; a Document read returns
the pinned body and provenance even if its head has advanced.

List and search default to 50 items, accept `--limit` up to 200, and report
`truncated` when more pages remain. Repeat the same query, kind and `within`
scope with `--cursor '<nextCursor>'` (MCP: `cursor`) until `nextCursor` is null.
Content or scope changes invalidate a cursor; restart without it when told.
Search is normalized
literal text, with no embeddings or semantic ranking. Content matches cite
exact Document revisions and any proven source Asset/time range; unanalysed
media is not automatically interpreted. `clash assets search` (MCP `search`)
remains the narrower attached-evidence compatibility operation.

Both list and search return `countsByKind` for all five kinds, including zeros.
Counts match the Project, query, and `within` scope before kind filtering and
the limit, and count each object once even when several fragments match.

When processing happened externally,
`clash actions record` (MCP `record_operation`) retains imported source/output
references and command detail as an inert record. `clash actions observe`
(MCP `record_observation`) retains external analysis with actor/tool attribution.
These recording operations do not execute detail, install a custom Action, or
claim that an external operation was a successful native Run. Consult their
leaf contracts for current arguments and recovery identities.
