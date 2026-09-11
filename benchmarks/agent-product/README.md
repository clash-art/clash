# Clash Agent Product Benchmarks

This catalog tests whether a headless agent can leave verifiable product state
in an isolated Clash Project. It complements the creative-artifact benchmark:
the creative suite measures authored media outcomes, while this suite focuses
on product operations, durable identity, and trusted Host readback.

Cases marked `ready` have an agent-facing CLI or MCP contract and independent
product readback. Cases marked `blocked` are executable specifications for a
missing contract. The runner records them without launching an agent, so a
filesystem imitation cannot be mistaken for product support.

Each functional Task selects the `project` skill pack from the shipped Clash
catalog and adds only its required Director, Timeline, or Remotion skills. The
same task-scoped installer and Environment content locks used by the creative
suite preserve that exact selection; packaging does not imply loading all skills.

Ready cases run as one standardized Environment transition. The runner imports
the exact product Workspace bundle declared by digest, executes the Agent, and
exports a verified `modified-workspace` bundle with the same Project identity.
It also emits the adapter-native event stream, a normalized trajectory, a
Codex/Pi ATIF-v1.7 structured projection when supported, a sealed OTLP/JSON trace
plus receipt, trusted readback evidence, and a credential-free
`environment-lock.json` binding the explicit model and adapter-bound provider,
the exact Agent executable bytes/version, each installed skill's content, and
the Clash plugin manifest plus deterministic runtime digest. The runner writes
that lock before Agent execution and verifies the same bytes immediately before
and after the run. Immutable `attempt.json` binds those rollout facts and both
Workspace trees under one score-free `attemptDigest`. Independent evaluators
may append content-addressed Evaluation records; Aggregate, Reward, and the
current `result-bundle.json` are derived separately. Blocked cases record a
truthful `not-run` Attempt without inventing either Workspace state.

The runtime is currently `native-local`, with a fresh temporary Workspace and
fresh per-case `CLASH_HOME`; it is not described as container-hermetic. See
[`../README.md`](../README.md) for the shared Task → Resolved Environment →
Attempt → Evaluation → Aggregate/Reward → Result Bundle contract.

Run one ready case after building the bundled Clash runtime:

```bash
pnpm build:package clash
pnpm benchmark:agent-product -- \
  --agent codex \
  --model gpt-5.6-sol \
  --case asset-image-exact-import-v1 \
  --out artifacts/headless-benchmarks
```

Every ready Environment requires `--model`. Codex binds its provider to
`openai`; Claude binds it to `anthropic`. Pi additionally requires an explicit
`--provider`. Native Agent arguments that can override the locked model or
provider are rejected, and the generic command adapter is limited to portable
non-Environment cases.

The fixture is public, immutable input. Rubrics and trusted readback remain
outside the agent workspace. A submission file names evidence; it never makes
an Agent-authored claim authoritative.

Each runnable Asset case owns a distinct `expectedProjectAssetId`. The task
requires that ID to be preassigned at import, and trusted operation evidence
must show the same ID for every required get, trash, and restore. Host byte
readback is accepted only for that identity; a submission or review cannot
select or rename the product Asset.

The runnable v1 product paths need no live media provider. The headless Agent
still needs its model connection, however, and this runner does not yet emit a
complete non-loopback egress receipt. Treat v1 as product-contract E2E, not as a
hermetic network-isolation benchmark.
