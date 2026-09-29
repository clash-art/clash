# Clash Timeline Codex plugin

This package is the installable Codex boundary for Clash Timeline. It bundles:

- a `.codex-plugin/plugin.json` manifest;
- typed `clash_timeline_*` MCP tools;
- a self-contained MCP App GUI;
- a typed adapter to the same local Host contracts as `clash timeline`;
- a bundled skill that routes Timeline work through this interface.

The package does not import Canvas MCP internals. It reads and writes the same
Project Timeline entities as the CLI, including the normal read-proof and YAML
projection apply behavior.

`clash timeline list --json` and MCP Timeline `list` return summaries by default:
identity, revision, dimensions when authored, and track/item counts. Use CLI
`--full` or MCP `full: true` for complete batch state. Pull one Timeline through
the CLI or use MCP `get` when editing it. Internal Host transport still reads
the full list; this change bounds agent-visible discovery, not Host I/O.

The unified Clash runtime disables this package's legacy standalone App and
opens the complete Project App instead. The standalone App implementation is
not acceptance evidence for the unified distribution.

## Build and verify

```bash
pnpm test:package @clash/timeline-plugin
pnpm typecheck:package @clash/timeline-plugin
pnpm build:package @clash/timeline-plugin
```

The build produces `runtime/index.js` and `runtime/app-client.js`, which are the
files launched from `.mcp.json` after the plugin is installed.
