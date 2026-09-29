# Authoring Workflow

## 1. Scaffold or check out

```sh
clash plugin create ~/plugins/my-gateway
# or copy an attested active plugin into an editable draft:
clash plugin checkout my-gateway ~/plugins/my-gateway
```

TypeScript drafts import `@clash/action-sdk` (or its `/browser` and
`/executable-failure` entries). `plugin validate` and `plugin activate` bundle
the SDK shipped with Clash automatically, including when the draft lives outside
the installation. No separate SDK npm install or Clash source checkout is needed.
The generated handler uses `definePlugin`; `context.reference` reads frozen
inputs and `context.upload` publishes media through the Host.

`checkout` currently copies attested user-installed plugins; built-in packages
are not stored in that installation area. For a new project-specific operation,
start with `plugin create` and activate using `--project <project-id>`.

## 2. Study the official upstream docs first

Before writing any request builder, collect for **every model you bind**:

- the exact parameter enums (resolution, duration, ratio, …)
- conditional constraints (e.g. MiniMax-H3: text-to-video requires a concrete
  ratio, `adaptive` is only valid with references; image-to-video ignores the
  ratio entirely)
- reference-media limits (formats, sizes, counts, per-clip durations)
- mutual exclusions (e.g. H3 first/last-frame vs reference-* roles)

Encode value domains in **binding `parameterOverrides`**, not in executor code.
Do not discover parameter domains by firing paid requests.

## 3. Write the executor against scoped SDK fixtures

The handler receives an invocation plus Host-scoped Clash services. Unit-test
account-store, reference, upload, and Host-tool dependencies with in-memory SDK
implementations; instrument external HTTP at the process boundary. Assert the
exact submit URL and body per model family, poll transitions, and failure
mapping.

Non-obvious executor duties, all learned from production traffic:

- **Failure reasons**: gateway envelopes may keep `message: "success"` while
  the task fails; read the task-level status message
  (e.g. `data.task_status_msg`) before any envelope message, and never
  surface a literal `"success"` as an error.
- **Single-step execution**: one plugin invocation performs at most one
  upstream submit or one upstream status request. A transient poll failure is
  returned with `retryable: true` and `requestState: "accepted"`; the Host's
  durable step policy schedules the next poll without discarding the
  checkpointed task. Plugins do not loop or retry submit/poll calls themselves.
- **Unit normalization**: convert upstream units to card units explicitly
  (e.g. duration seconds → milliseconds) and lock it with a test.
- **Conditional rules** that static defaults can't express stay in the
  executor, with the official rule cited in a comment and a test.

## 4. Add contract tests

One JSON per representative flow (see
[Contract Tests](/plugins/contract-tests)). Cover each API family you
implement — submit/poll/file for video, direct-result for images, TTS, music —
not just one happy path.

## 5. Validate, activate, verify composition

```sh
clash plugin validate ~/plugins/my-gateway
clash plugin activate ~/plugins/my-gateway   # requires version bump
curl "$HOST/api/v1/models/catalog"           # bindings merged? overrides live?
```

## 6. Verify against the real upstream once

Contract tests are self-consistent by construction — they prove your request
shape matches your own fixtures, **not** that the upstream accepts it. Run one
real, minimal-cost generation per API family with
[traffic recording](/plugins/traffic-replay) enabled, and keep the recordings
as regression fixtures. Budget for it; announce billing before you spend.

Replay that capture through the shared local-api backend and assert the final
Canvas node plus persisted text revision or media asset. This is the reusable
backend E2E for GUI, CLI, and MCP; do not maintain one vendor generation test
per client.

## Checklist

- [ ] Bindings reference existing cards by official model id
- [ ] No provider-flavoured card ids; no invented tiers
- [ ] Value domains live in `parameterOverrides`, defaults in
      `defaultParamOverrides`, dead controls in `excludedParameterIds`
- [ ] Executor: real failure reasons; exactly one submit or poll request per invocation
- [ ] Contract tests per API family, strict URL + body deep-equal
- [ ] One recorded real run per family; fixtures checked in
- [ ] Recorded traffic replays through local-api to the final Canvas entity
- [ ] Version bumped; `clash plugin activate` green
