# Contributing

Coding agents: read [`AGENTS.md`](AGENTS.md) first, then this file. Every PR
must clear the [anti-patterns](#anti-patterns) below.

## Pull requests

- One PR closes one issue: put `Closes #<n>` (or `Fixes`/`Resolves`) in the body.
- Add an `## Evidence` section: the commands you ran, their results, and links
  to the real CI runs.
- Run `make lint`, `make typecheck`, and the tests you touched before pushing.

## Anti-patterns

The owner rejects these on sight. Each rule says why and what to do instead.
`scripts/check-anti-patterns.ts` enforces the ones marked **[CI]** through
`.github/workflows/anti-patterns.yml`; the rest are enforced in review. There is
no override label.

### 1. Single-backend scoping **[CI]**

Don't: write "api-cf only", "CF only", "Node later", "Node/self-host out of
scope", "只做 CF", "Node 以后" in issues, PRs, code, or docs.
Why: shared abstractions (e.g. the Durable Run journal in
`packages/shared-runtime`, backed by D1/Workflows on api-cf and the Postgres
journal + BullMQ-on-Postgres adapters on api-node) exist so platform
differences never decide scope.
Do instead: build once on the shared abstraction and wire api-cf **and**
api-node in the same PR. Missing abstraction? Add it to the shared package.

### 2. Hand-rolled vendor clients verified on mocks

Don't: write your own HTTP client for a vendor that ships an official SDK, test
it only against mocks, then claim support.
Why: mocks agree with whoever wrote them. A hand-rolled OpenSandbox client that
passed every mock broke against a real server.
Do instead: use the official SDK, verify against the real service (sandbox or
staging), and claim support only with that evidence.

### 3. Reinventing the wheel

Don't: add a CF Queue plus a second intent table, a nightly reconcile job as the
main settlement path, or a new heavy dependency an existing one already covers.
Why: every parallel mechanism is a second source of truth and a second set of
bugs.
Do instead: reuse the Durable Run journal and existing dependencies. Reconcile
jobs are a safety net, never the main path.

### 4. Shipping load balancer configs **[CI]**

Don't: commit `nginx.conf`, `Caddyfile`, `traefik*.yml`, `haproxy.cfg`, or
`lb-lite*` as product deliverables.
Why: load balancing is the deployer's job; we can't own their topology.
Do instead: keep nodes stateless and LB-friendly (health endpoints, no sticky
state, graceful shutdown) and document the contract.

### 5. More than one zod version **[CI]**

Don't: let `pnpm-lock.yaml` resolve two zod versions.
Why: schemas from different zod copies fail `instanceof` and type checks in
confusing ways.
Do instead: align on the workspace zod version (catalog/override).

### 6. DeepSeek models other than DeepSeek Flash **[CI]**

Don't: name `deepseek-chat`, `deepseek-reasoner`, `deepseek-v3`, `deepseek-*-pro`
or any non-Flash DeepSeek id in code, configs, tests, docs, or seeds.
Why: only DeepSeek Flash is approved.
Do instead: use a Flash id (`deepseek-flash`, `deepseek-v4-flash`). Only the
policy tests that prove non-Flash ids are rejected, and captured upstream
fixtures, are allow-listed in the script.

### 7. Looks-wrong-but-isn't states (似错非错)

Don't: ship states, UI, logs, or errors that look like failures but aren't, or
silently degrade to a fallback.
Why: users and agents can't tell a real failure from noise, so they stop
trusting both.
Do instead: fail clearly with a structured error, or succeed clearly. No
red-but-fine, no quiet fallback.

### 8. PRs without an issue and evidence **[CI]**

Don't: open a PR without `Closes #N` and an `## Evidence` section, or merge on
mock-only evidence.
Why: unverifiable claims are how regressions ship.
Do instead: link the issue, list commands and results, link real CI runs, and
show real-service verification where a vendor is involved. Bot PRs
(Dependabot etc.) are exempt.

### 9. Touching production from dev, test, or CI

Don't: point local runs, tests, scripts, or CI at production databases, Workers,
buckets, or accounts.
Why: one stray migration or seed is an outage.
Do instead: use local services or staging only.

### What CI checks

| Check | Trigger | Rule |
| --- | --- | --- |
| PR body has `Closes #N` + `## Evidence`, no scoping phrases | `pull_request` opened/edited/synchronize/reopened | 1, 8 |
| Issue title/body has no scoping phrases (fails the run; never comments or labels) | `issues` opened/edited | 1 |
| No LB config files tracked | push, PR | 4 |
| `pnpm-lock.yaml` resolves one zod version | push, PR | 5 |
| No non-Flash DeepSeek ids in tracked text files | push, PR | 6 |
| No scoping phrases in added lines | push, PR | 1 |

Run locally: `node scripts/check-anti-patterns.ts repo --base origin/master`
and `node --test scripts/check-anti-patterns.test.ts`.
