# Clash

One headless npm package for the complete local Clash workspace:

- `clash <command>` runs the CLI client;
- `clash mcp` runs the peer stdio MCP client;
- the packaged `local-api` host is an internal runtime, started on demand.

Install it globally with `npm install -g clash`, or configure an MCP client to
run `npx -y clash mcp`.

## Runtime model

The package contains the CLI, MCP tools, skills, bundled GUI resources,
`local-api`, Loro WASM, agent templates, and the exact immutable payloads for
its first-party plugins. The Host imports those trusted modules in-process from
a closed registry; it does not copy them into `~/.clash/actions`, create
activation receipts for them, or launch them as child processes. Explicitly
activated third-party plugins remain isolated process/stdio packages under the
actions directory, and cannot shadow a reserved first-party id. The source stays
split across internal workspace modules; those modules are not separate user installs.
Clash Desktop is optional and carries the same host runtime for standalone
installation. A daemon-only installer may also carry that host artifact for
service deployments; it is a packaging mode of the same implementation and
data model, not another local-api product or replica.

The stable packaged layout is declared by `package.json#clashRuntime`.
Desktop copies that runtime tree unchanged and resolves `localApi`, `cli`, and
`agents` from the manifest instead of compiling a second daemon entry.
Daemon-only release tooling consumes the same `localApi` artifact.

The `clash` distribution is also the canonical component-management surface.
npm, Desktop installers, daemon-only archives, and Homebrew are bootstrap
acquisition channels, not separate runtime managers. They share one installer
core, signed release manifest, `~/.clash/components` registry,
content-addressed runtime store, and singleton service lifecycle. A future
`clash install desktop` command is intentionally not exposed until a real
downloadable, verified, atomically activated Desktop artifact exists.

On first product operation, the package reuses an active Desktop or standalone
`local-api` host when one is already published through
`~/.clash/run/host.json`. Otherwise it starts its bundled host against the same
`~/.clash/local-api` data directory. The CLI, MCP process, and Desktop do not
stop that shared daemon when they exit.

CLI and MCP are peer clients of the active host. Both preserve the same
local-api validation, read-proof, CAS, and copy-on-write behavior. There is one
local replica and one compatible host per `CLASH_HOME` and profile, not a
package- or Desktop-specific project database.

## GUI model

The package's MCP runtime contains several focused MCP Apps:

- `ui://clash/studio` — host and project overview;
- `ui://clash/canvas` — interactive node Canvas;
- `ui://clash/timeline` — Timeline editor;
- `ui://clash/director` — Director Stage editor.

Assets, models, tasks, actions, text, production, effects, audit, auth, and
diagnostics are exposed through typed or exact-argv MCP tools. New GUI surfaces
should be added only after they have a real view model and mutation contract.

The Studio App is the entry surface. Opening Canvas, Timeline, or Director does
not launch a hidden Desktop window or iframe the web app; each is an MCP App
backed by the same tools and host state.

## Hosted agent working trees

Clash-hosted sessions seed a short `AGENTS.md` with the assistant's identity,
project scope, and responsibility. `CLAUDE.md`, `CODEBUDDY.md`, and `GEMINI.md`
are symlinks to that file. Existing instructions are preserved. Host policy is
never appended to user messages, including after resume or compaction; native
harness instruction loading owns that lifecycle.

The hosted policy preserves the user's current task, corrections, and explicit
planning limits. Multi-step work uses a compact session checkpoint with decisions,
artifact identities, progress, and the next action. The base Clash skill is a
task-oriented entry point; workspace setup, tool discovery, generation, plugin
Views, and creative-method routing live in references read only when needed.
Standalone and bundled skill entry points share those same operation references.

The Host's existing `config.yaml` owns skill installation scope. The marketplace
install endpoint accepts either a global scope or selected project IDs; agents
can also edit this Host configuration directly:

```yaml
skills:
  storyboard:
    scope: projects
    projectIds: [my-project-id]
  reference-composition:
    scope: global
```

Project creation prepares the agent working tree, instruction files, and native
skill directories before publishing the project. Workspace preparation mounts
applicable installed skills from `~/.agents/skills` into `.agents/skills/`;
`.claude/skills/` and other selected harness directories alias those links. There
is no project-local enabled-list file. Scope changes do not prune existing
links: agents remove obsolete links explicitly. A harness may need to reopen its
session to refresh its skill catalog. The Host does not override a harness's
separate global discovery settings.

A new hosted workspace starts with the base Clash skill; the full bundled
catalog is not automatically mounted. Existing files are preserved. Legacy
native directories are consolidated; conflicting skill names are left intact
for the agent or user to merge.

Each session gets a temporary working area under
`sessions/session-<encoded-session-id>/scratchpad`, exposed to the agent as
`CLASH_SESSION_SCRATCHPAD`. Notes survive session resume; the project root stays
the working directory. Scratch notes are not appended to user messages.

Standalone CLI initialization, MCP connections, and external repositories do
not receive hosted instructions or skill setup. Users select the Clash skill
themselves in those contexts.

## Development

```sh
pnpm test:package clash
pnpm typecheck:package clash
pnpm build:package clash
```

## Source validation

`pnpm --dir plugins/clash typecheck` and `lint` use the development workspace
aliases through `tsconfig.typecheck.json`. The bundled runtime is checked with
Bundler resolution and the Host's Web API types, against current Local API and
MCP source contracts rather than previously emitted declarations. Strictness
and source/test coverage are retained. Incremental checker metadata lives in
the package's ignored `.cache/typecheck.tsbuildinfo`; no JavaScript or
declarations are emitted and no Node heap override is set. Package-boundary tests that inspect `runtime/`
remain checks of the built release artifact and require matching build outputs.
