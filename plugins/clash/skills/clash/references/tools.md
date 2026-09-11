# Discover the needed operation

For CLI work, navigate from the narrowest level already named by the task. If
the task already names a command group, skip the root help. If it also names
the needed operations, skip the group menu and read only unfamiliar leaf help
for argument shapes. Use the built-in command tree when the group or operation
is actually unknown:

```text
clash --help
clash <command> --help
```

Common command groups include `canvas`, `timeline`, and `director`. Read the
current help before using an unfamiliar subcommand; use `--json` when the
command supports structured output.

For MCP work, use the root `clash` tool only for navigation. Call it without
arguments for the menu, then with `command` to receive the stable dispatcher:

- Use `clash_canvas` for Canvas operations.
- Use `clash_composition` for both temporal composition in Timeline and spatial
  composition in Director Stage. Pass `kind: "timeline"` for Timeline or
  `kind: "director-stage"` for Director Stage when revealing contracts or using
  a short operation.

Call the selected dispatcher without `operation` to reveal its lightweight
operation index when the needed operation names are not already known. Keep
that index for the task; never request the same index twice. Before one
unfamiliar call, request its full live contract with
`contract: "<operation>"`. When the task needs several unfamiliar operations,
request their contracts together in one ordered
`contracts: ["<operation>", "<operation>"]` call. Then execute each operation
with `operation` and `arguments`. Each index entry and contract includes
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
