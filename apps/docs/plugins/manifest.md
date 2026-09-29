# Manifest & Artifacts

## Manifest (`manifest.json`)

```json
{
  "apiVersion": "clash.plugin/v1",
  "id": "acme.media",
  "version": "1.0.0",
  "name": "Acme Media",
  "description": "Acme provider and model bindings.",
  "runtime": {
    "kind": "local",
    "transport": "stdio",
    "entrypoint": "dist/stdio.mjs"
  },
  "contributes": {
    "cards": [],
    "providers": [
      { "id": "acme", "kind": "provider", "path": "providers/acme.json" }
    ],
    "modelBindings": [
      {
        "id": "acme-kling-image-o1",
        "kind": "model-provider-binding",
        "path": "bindings/kling-image-o1.json"
      }
    ],
    "generators": [],
    "views": [],
    "functions": [
      {
        "id": "acme-execute",
        "kind": "provider-executor",
        "operations": ["submit", "poll"]
      }
    ],
    "hostTools": []
  },
  "contractTests": ["contract-tests/acme-submit.json"]
}
```

`contributes` is the only contribution table. Unrecognized manifest fields are
rejected.

- `version` gates activation: executable content cannot change without a
  version bump.
- Every declared artifact path must exist. Every packaged file participates in
  the content hash.
- A Provider's `executorExportId` must match a contributed
  `provider-executor` function.
- Declare the lifecycle arms the entrypoint implements in `operations`.
  `submit` is the default. `callback` is reserved for a future Host adapter and
  also requires `poll`; current Hosts never issue `callbackUrl`.
- `hostTools` is for named Host functionality such as `codex.imagegen`. It is
  an explicit product contribution.

`runtime` describes the package's distributable entrypoint and transport. It is
not a semantic execution-realm declaration. The Local Host may select a trusted
first-party package from its closed bundled-module registry and invoke its
transport-neutral `PluginModule` in-process. Activated third-party packages use
the declared process/stdio entrypoint. Both realms use the same invocation,
result, broker, and failure ABI; realm never enters a Generator Definition,
Action Run, or executable binding. A process is fault isolation, not a security
sandbox.

Clash dependencies follow from contributions. A provider executor or action
receives scoped state and asset primitives; a pure projector does not need
vendor I/O. This is dependency wiring rather than a domain declaration.

## Generator definition (`clash.generator/v1`)

A manifest registers a Generator artifact and the Action executor exports it
uses:

```json
{
  "contributes": {
    "generators": [
      {
        "id": "image-workbench",
        "kind": "generator",
        "path": "generators/image-workbench.json"
      }
    ],
    "functions": [{ "id": "generate-image", "kind": "action" }]
  }
}
```

The artifact declares versioned state, persistent inputs, and one or more named
Actions:

```json
{
  "apiVersion": "clash.generator/v1",
  "kind": "generator",
  "spec": {
    "definitionId": "image-workbench",
    "stateSchema": {
      "type": "object",
      "properties": { "prompt": { "type": "string" } },
      "required": ["prompt"],
      "additionalProperties": false
    },
    "editPolicy": "fork-when-materialized",
    "persistentInputs": [
      {
        "slot": "reference",
        "accepts": [{ "kind": "media", "mediaKind": "image" }],
        "cardinality": { "minItems": 0, "maxItems": 4 }
      }
    ],
    "actions": [
      {
        "id": "generate",
        "executorExportId": "generate-image",
        "parametersSchema": {
          "type": "object",
          "additionalProperties": false
        },
        "invocationInputs": [],
        "outputs": [
          {
            "slot": "image",
            "assetType": { "kind": "media", "mediaKind": "image" },
            "cardinality": { "minItems": 1, "maxItems": 1 }
          }
        ]
      }
    ]
  }
}
```

Actions are materializing methods inside the Definition, not standalone mutable
entities. A Definition may declare multiple Actions and the same immutable
Generator Revision may invoke any of them. The current profile requires exactly
one output Asset per Action. The Host injects exact package provenance and
schema hashes; an artifact never declares a module/process execution realm.

See [Asset + Generator Model](/guide/asset-generator-model) for revision, Run,
copy-on-write, and delivery status.

## View definition (`clash.view/v1`)

A View is a declarative editor and state contract. It does not imply an
executable function or Generator:

```json
{
  "contributes": {
    "views": [
      { "id": "storyboard", "kind": "view", "path": "views/storyboard.json" }
    ],
    "generators": [],
    "functions": []
  }
}
```

Directly adding an activated View creates a `plugin-view` node on the implicit
`main` Canvas. The View owns structured draft state. When it needs generated
media, the product invokes an independently installed native Generator and
attaches its Output Commit Project Asset as a candidate; the View package does
not acquire Generator ownership.

`presentation.type: "storyboard"` selects the current v1 state and reference
contract. `PluginViewResourceSchema` declares each consumed Project Asset in
`candidates` or `uncategorized`; `selectedCandidateId` does not limit reference
membership. The shared `listPluginViewAssetReferences` reader owns enumeration,
and Canvas derives same-Canvas media → View edges from it. Plugins must not write
a second reference list or persist those derived edges. See the normative
[View, Asset reference and Generator protocol](./view-generator-spec.md) for
identity, lifecycle, SDK, graph mutation and compatibility requirements.

## Provider definition (`clash.provider/v1`)

```json
{
  "apiVersion": "clash.provider/v1",
  "kind": "provider",
  "spec": {
    "id": "acme",
    "name": "Acme",
    "upstreamId": "acme",
    "apiShape": "acme",
    "executorExportId": "acme-execute",
    "auth": {
      "methods": [
        {
          "id": "token",
          "label": "API token",
          "form": [
            {
              "kind": "field",
              "key": "apiKey",
              "label": "API token",
              "secret": true
            }
          ]
        }
      ]
    }
  }
}
```

Authentication declarations tell the Host how to configure an account. The
Host stores the selected account's values and scopes `context.store` to it.
The executor reads only the keys its declaration names:

```ts
import { ProviderExecutionError } from "@clash/action-sdk";

const apiKey = await context.store?.get("apiKey");
if (!apiKey) {
  throw new ProviderExecutionError({
    code: "authentication_failed",
    message: "This Acme account has no apiKey stored.",
    retryable: false,
    requestState: "rejected",
  });
}

const response = await globalThis.fetch("https://api.acme.example/generate", {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}` },
  body: JSON.stringify(request),
});
```

Do not accept credentials from `invocation.input.values`. Invocation values
describe the generation request; they do not select or authorize an account.

## References and outputs

Use the SDK context instead of guessing Host storage paths:

```ts
const reference = await context.reference?.(invocation.input.references[0]);

if (reference?.form === "bytes") {
  await sendBytesToVendor(reference.bytes, reference.mediaType);
} else if (reference?.form === "provider-url") {
  await sendUrlToVendor(reference.providerUrl);
} else if (reference?.form === "document") {
  await sendStructuredInput(reference.body);
}
```

The plugin decides how to adapt the resolved form to its vendor. For results,
return typed media, a declared Document output, or use `context.upload` for
large bytes. The Host persists the Asset and returns or publishes the canonical
Clash identity. A Document reference always pins an exact revision, kind, and
schema version; see [Document Assets](/guide/document-assets).

Local, synced, and shared projects use the same plugin code. Only the Host
implementation of store/reference/upload changes.

## Build declarations

A TypeScript draft may declare:

```json
{
  "runtime": {
    "kind": "local",
    "transport": "stdio",
    "language": "node",
    "entrypoint": "dist/stdio.mjs",
    "build": { "source": "src/stdio.ts" }
  }
}
```

`clash plugin validate` and `activate` build that source from the repository's
single CLI build path. Python entrypoints are authored directly and omit
`runtime.build`.
