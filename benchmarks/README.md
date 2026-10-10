# Clash Agent Benchmark Contract

Clash uses one benchmark pipeline for functional correctness and creative
content quality. Agent execution and scoring are separate stages: functional
and content-effect evaluators can independently score the same immutable
Attempt, and every Evaluation is bound to that Attempt's digest.

The lifecycle follows the same separation used by established agent
benchmarks:

1. **Environment template** — the suite case declares a portable input
   Workspace, public plugin/model/provider requirements, execution policy, and
   expected evidence.
2. **Resolved Agent Environment** — before execution,
   `environment-lock.json` pins the exact Task, Workspace digest,
   Agent/provider/model, executables, Clash runtime, skills, and platform.
3. **Attempt** — one Agent rollout starts from a fresh import of the input
   Workspace and produces a modified Workspace, retained trajectories, trusted
   readback, and a facts-only OTLP trace. `attempt.json` seals those facts under
   one `attemptDigest`; it contains no score, verdict, review, or reward.
4. **Evaluation** — zero or more immutable, content-addressed Evaluation
   records score one Attempt from reusable, versioned dimensions. Re-evaluation
   appends a record and never rewrites the Attempt.
5. **Aggregate / Reward** — an explicit versioned policy may aggregate selected
   Evaluations and optionally derive a Reward. Neither is part of Attempt
   identity.
6. **Result Bundle** — `result-bundle.json` is a replaceable index that
   references one Attempt plus selected Evaluation, Aggregate, and Reward
   records under its own `resultBundleDigest`.

This is analogous to SWE-bench's repository checkout, patch, and tests, except
that a Clash Workspace bundle is the product state and the output is another
portable Workspace bundle rather than a Git patch. It is also analogous to a
Harbor Task and Trial: `task.json` is the immutable Task contract, one Attempt
is one rollout, and the suite run aggregates independently evaluated Attempts.

## Attempt layout

Every admitted Environment attempt contains these standard files:

```text
task.json
environment-lock.json
modified-workspace/
logs/events.jsonl
logs/trajectory.json
logs/trajectory.atif.json            # Codex/Pi structured projection
logs/trajectory.atif-receipt.json
trace.otlp.json
trace-receipt.json
attempt-capture.json                 # runner rollout capture
attempt.json                         # immutable and score-free
evaluations/sha256/<digest>.json     # zero or more
aggregates/sha256/<digest>.json      # optional derived policy output
rewards/sha256/<digest>.json         # optional derived reward
result-bundle.json                   # current record selection
```

`logs/events.jsonl` is the retained adapter-native event stream, not a claim
that private chain-of-thought was captured. `logs/trajectory.json` is Clash's
transport-neutral operational projection. Codex and Pi attempts additionally
emit an ATIF-v1.7 structured projection with reasoning omitted and redactions
recorded; adapters without a lossless-enough mapping are marked unsupported
rather than given invented ATIF. OTLP is the score-free observability view of the Attempt
and never substitutes for the retained Agent rollout. Evaluator traces and
scores belong to Evaluation records, not the Attempt trace.

The runner may also publish `evaluation.json`, `execution.json`,
`outcome-result.json`, or report files as convenient current views. They are
not Attempt evidence or resume identity. Canonical Evaluation, Aggregate, and
Reward records are immutable and content-addressed, so multiple evaluators can
score one trajectory without overwriting each other.

Where an Attempt runs is an **execution backend**, and the lock records which
one and what isolation it established: `native-local` (a fresh temporary
directory and per-case `CLASH_HOME` on the host, not container-hermetic and not
network-isolated), `container`, or the opt-in experimental `claude-cloud`. See
[`execution-backends.md`](execution-backends.md) for the backends, repeated
trials (`pass@1`, `pass@k`, `pass^k`), and how the build under test is selected
and recorded.
Workspace is a Clash product concept; the benchmark Environment wraps it with
Agent/runtime configuration and never places credentials in either portable
bundle. Evaluator identity, specification, and policy are recorded separately
on Evaluation-derived records.
