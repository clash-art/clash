# Local setup

Use the existing Clash CLI or MCP when present. Its normal bootstrap discovers
or starts the compatible local Host. In an already bound workspace, start with
the relevant product read, for example `clash canvas list --json`; neither
cloud authentication nor a status preflight is required.

## Installation and binding

For a standalone CLI installation, use `npm install -g clash` and consult
`clash --help`. The Clash plugin includes its own runtime. Do not manually
launch internal runtime entrypoints or create a second daemon.

`.clash/project.toml` identifies the workspace's Project. Preserve an existing
marker and any runner-provided ready receipt. Only when the user requests a
new workspace or binding and the marker is absent, run:

```bash
clash init --json
# Or, when the requested Project identity is known:
clash init --project <project-id> --json
```

Initialization is not a repair for transport errors. A conflicting Project
identity must fail instead of overwriting the existing binding.

## Optional cloud sync

`clash auth login` supplies cloud authentication for product-managed remote
synchronization. Local reads, editing and generation use the same local
Project and do not require cloud login. A Model Provider account is separate
execution configuration; inspect the available accounts when choosing a route.

## Diagnostics

Use `clash host status --json` or `clash project status --json` only to diagnose
a reported problem. A failed normal bootstrap is an infrastructure failure;
preserve the workspace and report the error. If CLI or MCP is unavailable,
the other interface may operate the same Project. Do not create substitute
Project state or rerun initialization after a connection failure.

For an intentionally configured endpoint, `CLASH_API_URL` overrides discovery.
`CLASH_HOME` selects the local Clash root; normally retain the host's supplied
profile and configuration. These settings do not grant cloud permissions.
