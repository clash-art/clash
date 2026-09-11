# Shared Clash MCP boundary

`@clash/shared-mcp` is the single protocol boundary used by every Clash MCP
server. Project Assets, Canvas, Timeline, and Director keep their own executable schemas and
handlers; the shared server owns progressive discovery and decorates the final
`tools/list` response after the MCP SDK has generated JSON Schema.

```text
authoritative product schemas
  Canvas / Timeline / Director
              |
              v
       ClashMcpServer  <----- stdio MCP
          |       |
          |       +---- root `clash` menu
          |             command -> dispatcher navigation
          |             Assets -> operation index -> bounded live contracts
          |             command + operation -> leaf execution
          v
  registered leaf handlers
              |
       MCP SDK tools/list
              |
              v
McpSchemaCompatibilityTransport
              |
         stdio or HTTP
```

CLI and MCP are peer product interfaces. The CLI discloses commands through
`clash --help` and `clash <command> --help`; MCP advertises the `clash` root,
stable `clash_assets`, `clash_canvas`, and `clash_composition` dispatchers,
and, when present, the bootstrap `clash_workspace_init`. Calling `clash`
without arguments returns command counts. Adding `command` selects the stable
dispatcher. For Assets, calling `clash_assets` without arguments returns a
lightweight index containing operation identity, title, and safety flags; pass
`contracts: ["import_file", "list", "get"]` to fetch a distinct, ordered,
bounded set of live descriptions, input/output schemas, product metadata, and
recovery paths without executing them. Unknown or duplicate operations reject
the whole batch; no partial contracts are returned. `contract: "<operation>"`
remains compatible for one. Existing `operation` plus `arguments` calls still
validate against the leaf schema and invoke its handler exactly once. Canvas,
composition, and plugin dispatchers retain their full-contract disclosure when
`operation` is omitted.
The underlying leaf and former group tools stay registered for compatible
known-name calls, but never expand `tools/list` and are not the model's
discovery surface. There is deliberately no `clash_menu`,
`clash_capabilities`, or model-facing `clash_cli_*` wrapper.

`clash_generators` discloses native Generator request schemas from
`@clash/shared-types`, the same contracts validated by the Local HTTP Host.
Create requires stable caller-selected Generator and Revision IDs and persists
draft state only. Submit requires an Action Run ID and exact Revision ID and
may invoke a paid Provider. Its optional `providerAccountId` is a private
execution preference. These effects are part of tool disclosure so agents and
approval review can distinguish draft creation from execution and recovery.

The higher-level Clash skill teaches an agent how to choose either interface;
it is not part of the protocol boundary, and the runtime does not inject an
`AGENTS.md` into a user's repository.

This placement means a host-compatibility rule is implemented once in
`src/wire-schema.ts` and applies to standalone plugins, the composed Clash
plugin, CLI stdio, and HTTP sessions. Runtime validation is never weakened or
replaced.

The initial policy projects homogeneous fixed tuples from Draft-07 `items` or
2020-12 `prefixItems` into a single `items` schema with exact bounds. A
heterogeneous or open-ended tuple fails the `tools/list` request with a clear
JSON-RPC error rather than silently widening the contract or hanging the host.
Only JSON Schema-bearing keywords are traversed; examples and arbitrary
extension data remain untouched.
