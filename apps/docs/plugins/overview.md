# Executable Plugins — Overview

Executable plugins extend Clash with declarative Views, Generator Definitions,
runnable Actions, provider projectors, and provider executors. A plugin is ordinary trusted code
installed by the user. It owns its vendor protocol and performs its own HTTP,
filesystem, and process I/O.

## What an executable plugin can ship

| Artifact                  | apiVersion                      | Purpose                                                           |
| ------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| Manifest                  | `clash.plugin/v1`               | Identity, version, runtime, and contributions                     |
| Provider                  | `clash.provider/v1`             | Provider identity and account configuration methods               |
| Model bindings            | `clash.binding/v1`              | Attach the provider to model cards                                |
| Cards (optional)          | `clash.card/v1`                 | Add models that are not already in the catalog                    |
| Generators (optional)     | `clash.generator/v1`            | Declare versioned state and one or more materializing Actions     |
| Views (optional)          | `clash.view/v1`                 | Declare an editor-like structured Project drafting surface        |
| Contract tests            | `clash.plugin.contract-test/v1` | Exercise the real entrypoint with deterministic Host dependencies |
| Executable implementation | ESM module or Python entrypoint | Implements the shared invocation/result ABI                       |

A gateway normally contributes zero cards and several bindings: existing
cards describe the models, while the plugin adds another route to them.
A View-only plugin may contribute no functions or Generators. Its View can
still consume installed native Generators through Clash product commands and
store their Output Commit Project Assets in its structured state.

View 的引用、SDK 和 Canvas 关系见 [View、素材引用与 Generator 协议](./view-generator-spec.md)；尚未实现的 Agent 调用扩展在其中单独标明。
View 保留独立状态并引用基础 Generator 的产物；声明式调用、参考输入和持久结果关联是待实现扩展，不要求 View 自身成为 Generator。

## Lifecycle

```sh
clash plugin create <dir>
# edit the draft
clash plugin validate <dir>
clash plugin activate <dir>
```

Activation validates the package, runs its contracts, and atomically replaces
the active version. The previous version remains available to `clash plugin
rollback`. Executable changes require a version bump.

Curated packages use the same lifecycle through the Host-owned marketplace:

```sh
clash plugin install <package-id>
clash plugin list
clash plugin uninstall <plugin-id>
```

First-party packages that are available for explicit installation live under
`plugins/official/*`. Directory placement establishes publisher ownership, not
startup behavior: only packages named in local-api's closed `BUNDLED_PLUGINS`
registry are preloaded. An official package absent from that registry follows
the normal marketplace install and activation lifecycle.

The CLI never installs executable code into a Project Loro document and never
downloads the retired Python ClashAgent package format. A Project records only
the stable plugin/action binding needed by product state; local-api owns the
active executable package and Host endpoint.

## Runtime and ownership

Executable plugins implement one `PluginModule` invocation/result ABI:

- input: `clash.plugin.invoke/v1`
- output: `clash.plugin.result/v1`

The Local Host chooses one of two execution realms without changing that ABI:

- trusted first-party packages in the closed `bundled-module` registry run as
  imported modules inside local-api;
- explicitly activated third-party packages use the `process-stdio` realm: a
  supervised child process with newline-delimited JSON over stdio.

Execution realm is Host placement and diagnostics, not Generator, Action, Run,
or plugin binding identity. A first-party manifest may still declare its stdio
entrypoint as the distributable compatibility entrypoint; that declaration does
not force the bundled Host realm.

Normal runtime APIs are available in both realms, and provider HTTP uses the language's
normal client (`globalThis.fetch` in Node, an ordinary HTTP library in
Python). Clash does not proxy vendor requests.

The Host still owns Clash-specific dependencies. Once routing selects a
provider account, the SDK context exposes dependencies already scoped to that
plugin and account:

- `context.store` for credentials and settings;
- `context.reference` for typed project references;
- `context.upload` / typed outputs for project assets.

There is no plugin id or account id argument on those APIs. The Host fixes the
scope before invoking the plugin, so code cannot select another account by
forging an invocation field.

A child process is fault isolation, not a security sandbox. Installing a
plugin installs trusted user code with the user's runtime privileges. Bundling
a first-party module is likewise a placement choice, not a broader semantic
contract.

See [Manifest & Artifacts](/plugins/manifest) and [Host-scoped SDK
context](/plugins/sdk-context). Native Generator semantics and current product
migration status are documented in
[Asset + Generator Model](/guide/asset-generator-model).
Views consume those Assets through the shared
[View reference protocol](/plugins/view-generator-spec), which also defines the
SDK reader and derived Canvas connections.
