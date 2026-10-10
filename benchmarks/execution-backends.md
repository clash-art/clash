# Execution backends, trials, and the subject under test

An Attempt is one Agent rollout. Three independent choices decide what a run
measures:

| Choice      | Selects                                | Recorded in                                             |
| ----------- | -------------------------------------- | ------------------------------------------------------- |
| **Subject** | which Clash build the Agent is given   | `environment-lock.json` → `clash.subject`               |
| **Backend** | where the Attempt runs                 | `environment-lock.json` → `resolvedEnvironment.runtime` |
| **Trials**  | how many independent Attempts per task | `trial-aggregates/sha256/<digest>.json`                 |

All three change the resolved Environment digest or the aggregate digest, so two
results are comparable exactly when these records agree.

## Subject under test

`--subject` selects the build; the default is the working tree.

| Selector             | Meaning                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `working-tree`       | `plugins/clash` of the checkout, including uncommitted changes. Records the commit, `dirty`, and a digest of the diff plus untracked files. `--subject-build` rebuilds the runtime first; otherwise the record says `build.performed: false`, because a prebuilt runtime cannot be proven to come from the commit. |
| `commit:<rev>`       | One exact commit, checked out into a private worktree and built there (`pnpm install --frozen-lockfile` and `pnpm build:package clash`). The checkout is removed afterwards.                                                                                                                                       |
| `release:<path>`     | A released package: a `.tgz` or an installed package directory.                                                                                                                                                                                                                                                    |
| `release:npm:<spec>` | A published version fetched with `npm pack` (for example `release:npm:clash@0.1.3`).                                                                                                                                                                                                                               |

For a release, `--subject-version` and `--subject-sha256` pin what the artifact
must be. The tarball digest is checked **before** anything is unpacked, and
archives containing links or paths outside `package/` are refused.

The subject record carries the version, the commit (source subjects), the
artifact kind and SHA-256 (built runtime tree, release tarball, or installed
tree), and `runtimeSha256`. Locking fails if `runtimeSha256` or the version
differs from the plugin runtime on disk, or if the Agent's plugin root is not the
selected subject, so the record cannot describe a build that was not run.

## Backends

`--backend` may be repeated. Unit _i_ of the case-major, trial-minor plan runs on
backend _i mod n_, so the trials of one task land on different backends and a
resumed run places a unit where it ran before. `--concurrency` bounds Attempts
per backend and `--parallel` bounds the total.

The Attempt pipeline never changes: `executeBenchmarkAttempt` locks the
Environment, imports the Workspace, runs the Agent, reads the product back, and
seals `attempt.json`. A backend decides only where that runs. For non-local
backends it runs inside a **worker** (`clash-artifact-bench worker --unit …`),
and the dispatcher re-verifies the sealed Attempt (`verifyBenchmarkAttempt`) and
checks that the sealed lock names the backend it dispatched to. A worker crash,
a missing result, or a lock that disagrees is sealed as a retryable
infrastructure failure; the rejected output is kept under
`<run>/.rejected-worker-output/`.

| Backend        | Isolation actually established                                                                                                                                                                                                                                             | Recorded as                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-local` | Fresh temporary workspace and per-case `CLASH_HOME` on the host. No container, no network isolation.                                                                                                                                                                       | `isolation.container: "none"`                                                                                                                                                           |
| `container`    | Fresh container from a content-addressed image; suite, runner, and plugin mounted read-only; one writable mount (the Attempt directory); `--network none` or the engine default; container removed afterwards. No resource limits or extra syscall filtering are asserted. | `level: "container"`, image id, engine version, `attestation: "dispatcher-asserted-worker-observed"`. The worker must see a container marker or the lock refuses to record `container`. |
| `claude-cloud` | None the runner can observe. The Attempt runs in a Claude Code cloud session; its sandbox and network policy belong to the environment that hosts it.                                                                                                                      | `level: "provider-managed-vm"`, `attestation: "dispatcher-declared"`, pool (`anthropic-managed` or `self-hosted` + `ccpool_…` id)                                                       |

### Container backend

```bash
pnpm --filter @clash/artifact-evals benchmark \
  --suite benchmarks/creative-artifacts/v2/suite.json --out /tmp/bench \
  --agent codex --model <model> \
  --backend container --container-image <image> --forward-env OPENAI_API_KEY \
  --subject commit:<rev> --trials 3 --concurrency 4
```

The image needs Node ≥ 24.18 and every executable the Agent uses (`codex`,
`claude`, `pi`, …) on `PATH`. The runner checkout (with dependencies installed)
is mounted read-only at the same absolute path; the Attempt directory is mounted
at its host path, so absolute paths in current-view reports stay valid. The image
tag is resolved to its content id once per run.

### Claude Code cloud backend

```bash
… --backend claude-cloud --cloud-environment ccpool_… --cloud-runner-rev <pushed-rev> \
  --subject commit:<pushed-rev> --forward-env OPENAI_API_KEY
```

Each Attempt launches `claude --cloud` (with `--environment` for a self-hosted
pool) with a prompt that contains one fixed shell script: fetch the pinned
revisions, install, run the worker, archive the Attempt directory, and push it
as a single archive to a `bench-results/<run>/…` branch. The dispatcher polls
`git ls-remote`, fetches that branch, validates the archive (no hard links, no
links or paths leaving the Attempt), unpacks it, and verifies it exactly like any
other Attempt.

Requirements and limits:

- The suite, the runner revision, and the subject commit must be pushed to the
  repository the session works in; a working-tree subject is refused because the
  session cannot see it.
- The session must be allowed to run those commands and push the result branch.
- The Attempt directory must be creatable at the same absolute path in the
  session (it runs as a user that can create it); suite-relative paths are
  remapped with `--suite-root`.
- Results travel through git, so this suits text-heavy Attempts, not large media.
- The runner cannot observe the session's isolation; the record says so.
- The `claude --cloud` launch and the session's ability to push have not been
  exercised against a live cloud session by this change; the protocol is tested
  against a simulated session (see the PR evidence).

### Credentials

Credentials never enter a unit, a prompt, a mount, an argv, or any file under the
run directory. A unit names variables (`envNames`); the container backend passes
them with `--env NAME` so the engine reads the value from its own environment,
and the cloud session reads them from its environment's secrets. A worker that
cannot find a named variable fails the Attempt and names the variable.

## Repeated trials

`--trials k` runs every runnable case _k_ times as independent Attempts. Trial 1
keeps the original layout (`<run>/<case>/…`); later trials live in
`<run>/trials/00N/<case>/…`. The ledger entries and case reports carry `trial`.
Blocked cases are not repeated. Resume refuses a different trial count or
subject.

When `--trials` is given, `suite-report.json` links a content-addressed
**Trial Aggregate** (`trial-aggregates/sha256/<digest>.json`) listing, per task,
each trial's outcome, backend, subject identity, and Attempt digest, plus:

- **pass@1** — passed ÷ scored trials.
- **pass@k** — at least one of the _k_ trials passed.
- **pass^k** — all _k_ trials passed.

An Attempt is _scored_ when it passed or failed for a reason other than runner
infrastructure. Infrastructure failures, pending reviews, and trials that have
not run are _unscored_: they never count as an Agent failure, and pass@k / pass^k
stay `null` for a task while the missing trials could still change the answer.
The suite summary averages determinate tasks and reports how many were left out.
The suite `status` is the strictest reading: any failed trial fails the suite.
