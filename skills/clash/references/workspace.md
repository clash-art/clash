# Workspace binding and runtime

Treat the Clash daemon as a prerequisite for product work, not as part of the
creative outcome. The normal CLI or plugin MCP bootstrap owns host discovery:
invoke it normally, let it reuse a compatible `local-api` host or start the
bundled host when none exists, and treat its readiness error as authoritative.
Do not manually launch an internal JavaScript entrypoint, a second daemon
command, or a background substitute.

Some headless environments establish the workspace binding and daemon before
the agent starts. When they provide a ready receipt, use that project as-is and
do not run init or start a daemon again. If readiness cannot be established,
stop with an infrastructure error. Never replace a failed product operation
with handwritten lookalike state, a direct FFmpeg render, or other
filesystem-only evidence.

An MCP startup, CLI startup, or transport error is not evidence that a
workspace is unbound or uninitialized. Preserve any existing project binding;
report or recover the runtime failure through the selected interface, and
switch to the peer interface only when the first interface is unavailable. Do
not respond to a transport failure by running init.

## Bind only when requested

Resolve the intended working directory before writing. An existing
`.clash/project.toml` is the workspace binding: use it immediately and do not
run `clash init` or call `clash_workspace_init`. The first product action in a
bound project should be the narrowest relevant read or operation. A
runner-provided ready receipt has the same meaning and also skips init.

Only run `clash init` or call `clash_workspace_init` when the user explicitly
asks to create or bind a Clash workspace and `.clash/project.toml` is missing.
Initialization creates only that project binding; it must not replace the
repository's own instructions or source files:

- CLI: use `clash init --json`, or `clash init --project <id> --json` when the
  project identity is known.
- MCP: use `clash_workspace_init` with the absolute `cwd` and optional
  `projectId`.

Both entry points return the same initialization contract. Inspect the result:
`reused: false` means a new local project binding was created; `reused: true`
means the existing project binding was preserved. A conflicting requested
project identity must fail rather than overwrite `.clash/project.toml`.

Do not assume every working directory is new or backed by Git. If it is already
bound, continue with the marker's `projectId`; if it is unbound and binding was
explicitly requested, let init generate a local ID or provide the intended ID.
In a runner-managed headless workspace, init is infrastructure-owned and should
already be complete before the task is handed to the agent.
