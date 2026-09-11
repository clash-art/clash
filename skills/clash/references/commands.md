# Command Reference

Use `--json` when supported; Generator commands already return JSON. Read the
narrowest unfamiliar command help for its current options. Examples show
`--project` explicitly; omit it in a workspace already bound to that Project.

## Local workspace

Use the existing `.clash/project.toml` binding. Normal CLI or MCP startup owns
Host discovery; no connection or status preflight is required. Only run
`clash init --project <project-id> --json` when the user requests a binding and
the marker is absent. See [setup.md](setup.md) for runtime recovery.

Cloud OAuth is optional: `clash auth login` only enables product-managed
remote sync. Local Project operations do not require it.

## projects

```bash
clash projects list --json
clash projects create --name "Name" --description "..." --json
clash projects get --id <project-id> --json
clash project status --project <project-id> --json
clash doctor storage --project <project-id> --json
clash doctor storage --project <project-id> --repair --json
clash projects delete --id <project-id> --yes --json
clash project get --id <project-id> --include-deleted --json
clash project restore <project-id> --json
```

Local project delete is a recoverable soft-delete. Read the project first;
the CLI records its version in `.clash/observed.json`. Read it again with
`--include-deleted` before restore. Missing or stale observations are rejected.
`project status` and `doctor storage` are diagnostics, not prerequisites for
normal reads or writes. Storage repair is an explicit recovery operation.

## canvas

### Reading

```bash
clash canvas list --project <id> --json                  # All nodes
clash canvas list --project <id> --type text --json      # Filter by type
clash canvas get --project <id> --node <node-id> --json  # Single node
clash canvas edges --project <id> --json                 # Edge graph
clash canvas delete-plan --project <id> --node <id> --node <id> --json
clash canvas search --project <id> --query "sunset" --json
clash canvas search --project <id> --query "hero" --type action-badge --json
```

`get --json` records the node version in `.clash/observed.json` and reports
`immutable`. `edges --json` records the graph version; `delete-plan --json`
records the graph-aware batch-delete version. Writes consume these observations
implicitly. If the target changed after the read, the host returns `STALE_READ`.

### Writing

```bash
# Add nodes
clash canvas add --project <id> --type text --label "Script" --content "..." --json
clash canvas add --project <id> --type group --label "Scene 1" --json
clash canvas add --project <id> --type text --label "Prompt" --content "..." --parent <group-id> --json

# Update
clash canvas update --project <id> --node <id> --label "New Label" --content "New content" --json

# Generic copy-on-write for an immutable node
clash canvas copy --project <id> --node <id> --json

# Copy-on-write media asset replacement
clash canvas replace-asset --project <id> --node <media-node-id> --asset <asset-id> --json

# Delete
clash canvas delete --project <id> --node <id> --yes --json
clash canvas delete-batch --project <id> --node <id> --node <id> --yes --json
# Referenced nodes must be rewired first; batch deletes must describe a closed subgraph.

```

For agents, `canvas update`, `canvas delete`, and `canvas delete-batch` are
direct patch writes, not projection apply commands. Run a fresh `canvas get`
for single-node writes and `canvas delete-plan` for batch deletes. The CLI does
the observation and CAS checks internally. There is no force or overwrite
bypass: re-read, reconcile the intended change, and retry.
Any node with a downstream reference is immutable as a whole. Use
`canvas copy` when an in-place write returns `IMMUTABLE_NODE`; existing
downstream references remain on the source.
Use `canvas replace-asset` instead of `canvas update --asset-id` when changing a
fulfilled image/video/audio node. It creates a copy-on-write media node with
lineage to the source and does not mutate existing downstream references in
place.

## timeline

```bash
clash timeline create --project <id> --id <timeline-id> --name <name> --json
clash timeline pull --project <id> --timeline <timeline-id> --json
clash timeline apply --project <id> --timeline <timeline-id> --json
clash timeline attach --project <id> --timeline <timeline-id> --canvas <canvas-id> --json
clash timeline copy --project <id> --timeline <timeline-id> --canvas <canvas-id> --json
```

`pull` writes `timelines/<timeline-id>.timeline.yaml` and records the Timeline
observation in `.clash/observed.json`. `apply` consumes that observation
implicitly and refuses stale writes. A Timeline is editable state; rendered
assets pin the source Timeline revision. `attach` moves a standalone Timeline
under one Canvas Timeline Action. Cross-Canvas `copy` creates a new Timeline
and Action node, leaving the source unchanged. No lock sidecar is created.

## text

```bash
clash text pull --project <id> --node <text-node-id> --json
clash text apply --project <id> --node <text-node-id> --json
clash text replace --project <id> --node <text-node-id> --json
```

`pull` writes `projections/text/<node-id>.md` and records the text version in
`.clash/observed.json`. `apply` consumes that observation implicitly and
refuses stale writes. `replace` creates a copy-on-write text node from the same
Markdown file; no lock sidecar is created.

## assets

```bash
clash assets list --project <id> --json
clash assets get --project <id> --asset <asset-id> --json
clash assets import --project <id> --file ./hero.png --json
clash assets link --project <id> --asset <asset-id> --name hero.png --json
clash assets refs --project <id> --asset <asset-id> --json
clash assets documents get <documentAssetId> --revision <revisionId>
```

Project Asset identity is distinct from a file path or Provider task token.
`import` registers a native source file as a Project Asset. `link` materializes
read-only media under `assets/links/`; editing that file does not apply changes
to Canvas. `refs` reads downstream references through the Host. For a generated
Document, use its exact Output Commit reference to read the body and provenance;
do not replace that reference with a copied Canvas text node.

## asset metadata

```bash
clash assets metadata kinds --json
clash assets metadata list --asset <asset-id> --json
clash assets metadata get --asset <asset-id> --kind media.transcript --json
clash assets metadata get --asset <asset-id> --kind media.transcript --body --json
clash assets metadata set --asset <asset-id> --kind media.transcript --metadata meta.json --body words.json --json
clash assets metadata apply --file projections/metadata/<asset>.<kind>.json --json
clash assets metadata validate --kind <kind> --metadata meta.json --json
```

`--kind` is a parameter, never a command: declaring a new kind adds no CLI
surface. `kinds` lists what this build accepts — the product-declared kinds plus
any workspace kind declared under `.clash/metadata-kinds/*.json`. An undeclared
kind is refused everywhere.

`set` attaches the identity to the asset and stores any `--body` as an immutable
content-addressed blob, deduplicated by hash. It also materializes an editable
projection under `projections/metadata/` and records an implicit observation.

After editing that JSON, `apply` consumes the linked workspace's observation.
An apply without a prior read fails `READ_REQUIRED`; a changed source is
rejected as stale. Re-read, reconcile the edit, and apply again. The CLI does
not accept a caller-authored version token or a mutation bypass.

`get --body` returns the stored blob
verbatim and fails loudly if the blob no longer hashes to its recorded address.

Attaching does not require an action file — the fill envelope is synthesized
internally, and every attach appends to the asset's `metadataFills` provenance
ledger.

## Generator authoring and execution

```bash
clash generators definitions
clash generators definition <pluginId> <definitionId>
clash generators contract create
clash generators contract advance
clash generators contract submit
clash generators create --project <id> --input '<request JSON>'
clash generators get <generatorId> --project <id>
clash generators advance <generatorId> --project <id> --input '<request JSON>'
clash generators runs submit <generatorId> <actionId> --project <id> --input '<request JSON>'
clash generators runs get <actionRunId> --project <id>
clash generators runs output <actionRunId> <outputSlot> --project <id>
```

Contract disclosure needs no Project setup. Fill request JSON from the live
contract and preserve returned IDs and revisions. For a Model, choose the
`clash.model-generation` Definition for its output kind, then author `modelId`,
`prompt`, `params`, and explicit inputs according to the Model Card. A Provider
such as Hilo supplies execution routing; a requested `providerAccountId` goes
in Action submission input, never into Generator state or Model parameters.

A new Generator can include `placement` to create its Canvas card atomically.
For an existing card, read its `generatorId` and edit that Generator. Copying
retains `forkedFrom` and uses `placement.sourceNodeId`; downstream output stays
pinned to its source. Groups and neighboring text do not implicitly become inputs.

Submission starts a background Run. Poll the returned Run until terminal and
read the persisted Output Commit before claiming completion. A successful
output supplies an immutable media Asset or exact Document revision for the
next operation. Pending nodes and Provider task IDs are not finished Assets.

For a configured local agent's text, use `clash.agent-text` / `text` and its
`generate` Action, with the live Agent Text Card mapping for Canvas placement.
This uses the same Generator lifecycle and does not select a Model Provider.

## actions

An executable plugin is written as ordinary source in your own working directory,
then registered. Registration is what hands it to Clash: `activate` validates the
draft, runs its declared contracts, asks for approval if it wants new capabilities,
and atomically stores the result. From that point Clash owns the stored copy --
content-hashed, recorded as an activation, and rollback-protected -- so the draft is
the input and the stored copy is the output.

For that reason a draft directory must live outside Clash's own storage. Pointing
one inside it is refused, because freely editable source has no place among attested
state.

```bash
# Author a plugin
clash plugin create ./my-plugin --id acme.my-plugin --name "My Plugin"
clash plugin validate ./my-plugin            # schema + declared contract tests
clash plugin activate ./my-plugin            # register; Clash stores and owns it

# Edit one that is already active
clash plugin checkout <id> ./my-plugin       # copy it out to a draft
clash plugin validate ./my-plugin
clash plugin activate ./my-plugin

# Manage what is registered
clash plugin list --local --json
clash plugin search <query> --json
clash plugin install <id>                    # fetch from the server registry
clash plugin uninstall <id>
clash plugin rollback <id>                   # restore the retained prior version
```

The bridge hot-reloads an activated plugin, so no daemon restart is needed.

## remote worker secrets

Remote worker action secrets are managed in hosted/remote Settings, not through
the local-first CLI. Local custom actions use the local host environment and
provider configuration instead of syncing secrets into the project.
