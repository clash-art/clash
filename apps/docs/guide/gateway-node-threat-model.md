# Gateway Node Threat Model (Self-Host)

Security + abuse review for the **self-host** gateway (`apps/api-node` +
`packages/gateway-core`, Epic B #342 / #385 / N29). **Staging drills only —
never production.**

Related: [gateway-admin.md](gateway-admin.md#node-admin-listener),
[gateway-ops-runbook.md](gateway-ops-runbook.md),
[gateway-node-backup.md](gateway-node-backup.md),
[gateway-node-rollout.md](gateway-node-rollout.md),
image dependency notes in
[`apps/api-node/deploy/ops/SBOM.md`](../../../api-node/deploy/ops/SBOM.md).

## Scope

| In scope | Out of scope |
| --- | --- |
| Data plane vs admin plane listeners | Hosted Cloudflare Worker staff prompt policy (decision 10) |
| `GATEWAY_ROLE` process roles (`api` \| `admin` \| `all` \| `migrate`) | Load-balancer config (anti-pattern 4 — deployer-owned) |
| Secrets in image/CI, prompt/body logging defaults | Full Postgres abuse-signal store (port is `unavailable` until a later issue) |
| DeepSeek Flash-only catalog default | Production access from CI/dev |

Product locks (2026-10-20) that drive this model:

- **Decision 8** — no prompt/response body logging by default; metadata 30d;
  ledger 13 months.
- **Decision 10** — staff prompt viewing is a **hosted** admin capability;
  self-host must not enable it by default.
- **DeepSeek Flash-only** — any DeepSeek model id must be Flash
  (`scripts/check-anti-patterns.ts` + seed/catalog policy).

## Trust boundaries

```
                    ┌─────────────────────────────────────────┐
 Callers (sk_gw_ /  │  Public listener  PORT (default 8080)   │
 Anthropic/OpenAI   │  HOST 0.0.0.0 in compose api nodes      │
 clients) ─────────►│  /v1/*  /api/v1/gateway/*  /healthz     │
                    │  /readyz  /metrics                      │
                    │  /api/v1/admin/* → always 404           │
                    └───────────────┬─────────────────────────┘
                                    │  createGatewayApp
                                    ▼
                    packages/gateway-core (admission, limits,
                    settlement, Flash catalog policy, coded errors)
                                    │
                    ┌───────────────┴─────────────────────────┐
 Ops (gwa_ tokens / │  Admin listener  GATEWAY_ADMIN_PORT     │
 Better Auth on     │  GATEWAY_ADMIN_HOST default 127.0.0.1   │
 admin\|all) ───────►│  /api/v1/admin/gateway/*  /admin SPA   │
                    │  (admin\|all only)                       │
                    │  no data-plane chat routes              │
                    └─────────────────────────────────────────┘
                                    │
                    PostgreSQL (budgets/ledger/limits authority)
                    + shared /data blobs volume
```

**Separate sockets, not path ACLs alone.** The public fetch wrapper
(`withoutGatewayAdminPaths`) 404s every `/api/v1/admin` spelling; the admin
server never mounts chat completions. Binding admin to the same port as
`PORT` is refused at startup (`GATEWAY_ADMIN_PORT must differ from PORT`).

## `GATEWAY_ROLE` attack surface (#373 / #462)

| Role | Listens | Trust assumption | Abuse notes |
| --- | --- | --- | --- |
| **`api`** (default) | Public `PORT` only. Optional API-only admin if `GATEWAY_ADMIN_PORT` set (no SPA). | Callers hold product credentials (`sk_gw_` / session). | Rate limits + budgets are Postgres-authoritative. Abuse port currently `unavailable` → no auto-suspend yet; operators use budget suspend / key revoke. |
| **`admin`** | Requires `GATEWAY_ADMIN_PORT`. Serves admin API + `/admin` console. Public `PORT` is health-only. | Operators only; loopback or private net. Needs `ADMIN_AUTH_SECRET` / `BETTER_AUTH_SECRET` + web build. | CSRF via `GATEWAY_ADMIN_ORIGINS`. Mutations audited. Prompt view always `GATEWAY_PROMPT_ACCESS_DISABLED`. |
| **`all`** | Both listeners in one process (`profiles: [demo]`). | Demo / single-box only — still Postgres, never SQLite. | Same admin rules; do not publish admin on a public IP without a private overlay. |
| **`migrate`** | No long-lived HTTP. One-shot `gateway-cli migrate`, then exit. | DB credentials only. | Compose gate: every app service waits for `service_completed_successfully`. Server refuses `GATEWAY_ROLE=migrate`. |

Outbox / checkpoint work is a **compose command override**, not a
`GATEWAY_ROLE` — it never opens the admin listener.

## Assets

| Asset | Where | Confidentiality | Integrity |
| --- | --- | --- | --- |
| Upstream provider keys | Sealed envelopes / key ring (`GATEWAY_ENCRYPTION_*`) | Never in responses, audit plaintext, or image layers | Rotation bumps `key_version`; dual-key drain |
| Product API tokens (`sk_gw_`) | Hash in Postgres | Shown once at issue | Revoke stops new traffic |
| Admin tokens (`gwa_`) | Hash in `gateway_admin_token` | Shown once; `Authorization` only | Last `platform_admin` cannot be revoked |
| Prompt / response bodies | **Not retained on self-host** | N/A (decision 8/10) | Staff view refused |
| Ledger / budgets | Postgres | Ops via admin reads | Unique settlement constraints; 13-month audit |
| Catalog / prices | Postgres | Public models list is intentional | Flash-only policy + seed assert |

## Threats and mitigations

| ID | Threat | Plane | Mitigation |
| --- | --- | --- | --- |
| T1 | Admin API reached via public port / LB | Admin | Separate listener; public 404 for admin paths; compose publishes admin on `127.0.0.1` by default; image `EXPOSE`s only `8080` |
| T2 | Admin bound to same port as data plane | Admin | `gatewayAdminListenerFromEnv` throws if ports equal |
| T3 | Prompt/response logged or retained on self-host | Data | `retention: unavailablePort("retention")`; no `retention.enabled` in Node routes; `/prompts/.../access` → `GATEWAY_PROMPT_ACCESS_DISABLED`; no body columns in Node gateway schema |
| T4 | Secrets baked into image or CI artifacts | Supply | Dockerfile forbids secret env assignment; compose injects at runtime; CI redacts `sk_`/`Bearer` in artifacts; secret-scan job on push/PR |
| T5 | Non-Flash DeepSeek model shipped | Catalog | Anti-patterns CI + `assertGatewaySeedFlashOnly` + `applyGatewayCatalogPolicy` |
| T6 | Rate-limit / budget bypass across nodes | Data | Limits and budgets are Postgres (not process memory); optional Redis cache is never the ledger |
| T7 | CSRF on admin mutations from a browser | Admin | Origin allowlist (`GATEWAY_ADMIN_ORIGINS`); tokens not cookie-auto-attached for `gwa_` |
| T8 | Product credential used as admin | Admin | Product `clsh_` / `sk_gw_` / Better Auth cookie → `GATEWAY_ADMIN_SESSION_REQUIRED` |
| T9 | Dependency / base-image compromise | Supply | Digest-pinned `node:24-slim`; non-root `node`; read-only rootfs + tmpfs; SBOM notes for syft/pnpm audit |
| T10 | Migrate run against production | Ops | Runbook + anti-pattern 9; staging DSNs only; never from this checklist |

## Logging policy (self-host default)

Structured logs (`apiNodeLog` / gateway logger) may carry **request ids,
model codes, token counts, error class/SQLSTATE, TTFT**. They must **not**
carry prompt text, response bodies, raw Authorization headers, or upstream
key material. Body retention is a separate, hosted-only feature gated by
`GATEWAY_STAFF_PROMPT_ACCESS=enabled` on Workers — Node does not wire that
flag.

## Verification (CI + tests)

| Check | Where |
| --- | --- |
| Secret patterns in tracked text | `scripts/check-gateway-security.ts` + anti-patterns workflow |
| Flash-only DeepSeek ids | `scripts/check-anti-patterns.ts` |
| Admin ≠ public port; public 404 | `apps/api-node/src/gateway-admin.test.ts` |
| Retention unavailable; prompt refused | `gateway-admin.test.ts` (self-host prompt policy) + `gateway-security.test.ts` |
| Image EXPOSE / compose publish host | `deploy-compose.test.ts` |
| SBOM / audit procedure | `apps/api-node/deploy/ops/SBOM.md` |

```bash
node scripts/check-gateway-security.ts
node scripts/check-anti-patterns.ts repo --base origin/master
pnpm --filter @clash/api-node exec vitest run src/gateway-security.test.ts src/gateway-admin.test.ts src/deploy-compose.test.ts
```
