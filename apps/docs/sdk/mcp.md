# MCP

The installable `clash` npm package owns the supported stdio MCP entry point.
Configure an MCP client to run the same package users install for the CLI:

```json
{
  "mcpServers": {
    "clash": {
      "command": "npx",
      "args": ["-y", "clash", "mcp"]
    }
  }
}
```

The package's bundled Codex plugin config enters the same dispatcher locally.
`clash mcp serve` and the standalone Streamable HTTP server are retired.

MCP and CLI are peer clients. For Assets, Canvas, Timeline, and Director, an
agent can choose either surface and receives the same Host-owned semantics.
Host/project/component lifecycle commands and working-tree projection
conveniences remain CLI-only rather than being mirrored mechanically. Both
clients call the discovered `local-api` host directly; neither invokes the
other or owns a Project replica, persistence, plugin processes, or cloud
replication:

```text
clash mcp ─┐
           ├─> local-api
clash CLI ─┘
```

### Current parity boundary

- Canvas node read/write/execute/delete is equivalent across CLI and MCP.
  Canvas collection `list/create/rename/delete` is not yet exposed through MCP.
- Project Asset list/read/import/reference/delete/restore is equivalent.
  CLI workspace links and composed file-import-plus-COW helpers are filesystem
  conveniences, not separate Asset semantics.
- Timeline and Director MCP `get/save` cover the same persisted state as CLI
  file `pull/apply`; Timeline state includes text and effect items. Effect
  package authoring/install is a local developer workflow rather than a Project
  mutation.
- Text Revision `history/content/restore` remains a real MCP gap. Generic Canvas
  get/update/copy does not replace revision indexing and revision-aware CAS/COW.
- A Canvas execution returns a child or target node; reading that node to a
  terminal state is the MCP equivalent of the CLI's convenience polling loop.

The advertised MCP surface stays compact: `clash` is the root menu,
`clash_assets` dispatches Project Asset operations, `clash_canvas` dispatches
Canvas operations, and `clash_composition` dispatches Timeline or Director
Stage operations. Calling `clash_assets` without arguments returns a lightweight
operation index. Request exactly one full live contract with
`{ "contract": "import_file" }`, or request the small set needed for a flow in
one ordered batch with
`{ "contracts": ["import_file", "list", "get"] }`. Batch entries must be
distinct and are bounded; an unknown entry rejects the whole batch without a
partial response. Execute each operation with the existing
`{ "operation": "import_file", "arguments": { ... } }` shape. Contract
disclosure never invokes the operation. Other dispatchers continue to return
their live contracts when `operation` is omitted.

## Project Asset tool surface

All Asset tools use the cwd-selected Project and the same storage-neutral
`ResolvedAsset` shape as CLI, Desktop, and local-api. They never return a
storage key or Host CAS receipt.

| Operation           | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `list`              | List Project-scoped `ResolvedAsset` values                    |
| `get`               | Read one Asset and privately record its Host observation      |
| `references`        | Read Action-level references and privately record observation |
| `import_file`       | Import a workspace file through the Host multipart route      |
| `trash` / `restore` | Apply logical lifecycle changes using the private observation |

Use these as `clash_assets` dispatcher operations; the compatible leaf names
are `clash_assets_list`, `clash_assets_get`, and so on. `trash` and `restore`
do not accept `readToken`, `if-match`, `receipt`, or `force`. Call `get` or
`references` first; the MCP session keeps the opaque receipt in memory and
sends it to local-api internally. A missing observation returns
`READ_REQUIRED` with a `retryTool` pointing to `get`.

## Canvas tool surface

Registered under server name `clash`:

| Tool                                                              | Purpose                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| `clash_canvas_list` / `clash_canvas_edges`                        | Enumerate nodes and edges                             |
| `clash_canvas_get` / `clash_canvas_search`                        | Inspect nodes                                         |
| `clash_canvas_add`                                                | Add nodes (generation nodes, assets, text)            |
| `clash_canvas_execute`                                            | Run a node's generation task                          |
| `clash_canvas_update` / `clash_canvas_move` / `clash_canvas_copy` | Mutate layout and content                             |
| `clash_canvas_replace_asset`                                      | Swap a node's asset                                   |
| `clash_canvas_delete_plan` / `_delete_batch` / `_delete`          | Safe deletes (plan first)                             |
| `clash_canvas_open` / `clash_canvas_snapshot`                     | MCP App surfaces (only when app surfaces are enabled) |

Tools carry MCP annotations and UI metadata; `open`/`snapshot` bind to the
bundled Canvas MCP App resource and are skipped when `appSurfaces` is off.

## Implementation boundary

```ts
import {
  registerClashAssetMcp,
  registerClashCanvasMcp,
} from "@clash/mcp-server";

registerClashAssetMcp(server, assetGateway);
registerClashCanvasMcp(
  server,
  canvasGateway,
  bundledAppJs,
  bundledStudioAppJs,
  {
    appSurfaces: true,
  },
);
```

`@clash/mcp-server` is an internal typed capability surface used by the bundled
plugin, not a second deployable daemon. Its host client calls `local-api`
directly and results normalize to agent-friendly text rather than raw JSON
blobs. CLI and MCP bindings are checked against the same capability catalog;
all business behavior and state authority remain in `local-api`.

## Agent-editable projections (CLI-side alternative)

For file-oriented agents, the CLI offers the same underlying capabilities
without MCP:
`clash timeline pull/apply` (YAML projections with stale-write refusal),
`clash text` (text node files), `clash director` (stage scenes). Both roads
end in the same Loro-backed project state.


### Fullscreen project App

`clash_project_open` resolves a project by `projectId` or working folder (`cwd`)
and opens the shared ProjectEditor in a fullscreen MCP App. The host must support
MCP Apps, fullscreen, and embedding the daemon origin. The resource is
`ui://clash/project`; old miniature Studio/Canvas Apps remain disabled.

The daemon serves the same `apps/web/dist/client` assets packaged for the GUI.
The Clash distribution copies them into `runtime/project-ui`; its Turbo build
orders the web artifact before packaging. Direct host-runtime packaging requires
that shared renderer output to exist first. No Vite or Electron process is
started at runtime. `CLASH_PROJECT_RENDERER_ROOT` can override the asset directory.
An MCP-started daemon defaults to `CLASH_AGENT_RUNTIME=disabled`, skipping ACP
initialization; an already-running desktop daemon is reused without changing its
runtime configuration.

The MCP view mounts no Copilot, agent annotation menus, or agent selection
panels. Returning to the conversation requests inline mode and retains the
mounted editor. Selection identity and names are sent through
`updateModelContext` when accepted by the host. Native host annotations remain
host-owned: no undocumented annotation protocol is assumed. Shared DOM project
identity and accessible node names help browser tools identify real Canvas IDs;
Codex annotation support inside nested MCP iframes still needs host verification.

Other standard MCP App capabilities include host-mediated messages, downloads,
links, sampling, and App-defined tools. These are optional host capabilities,
not automatically enabled project controls. See the
[MCP App API](https://apps.extensions.modelcontextprotocol.io/api/classes/app.App.html)
and [native browser annotation documentation](https://learn.chatgpt.com/docs/browser?surface=app).
