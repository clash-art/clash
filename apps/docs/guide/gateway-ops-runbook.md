# Gateway Ops Runbook (Cloud / Staging)

Operator procedures for the Clash official model gateway on Cloudflare
Workers (`apps/api-cf`) and the `/admin` console. **Staging only** — never
touch production from this runbook. Gateway core and admin live in the
clash repo (`packages/gateway-core`, `apps/api-cf`, `apps/web`).

Related guides: [gateway-admin.md](gateway-admin.md),
[gateway-price-book.md](gateway-price-book.md),
[gateway-teams.md](gateway-teams.md),
[gateway-schema.md](gateway-schema.md),
[gateway-data-plane.md](gateway-data-plane.md).

Self-host (Node + Postgres) backup/restore is covered by Epic B
issue #384 / [gateway-node-backup.md](gateway-node-backup.md) (when present).
Load balancing is the deployer's choice; gateway nodes are stateless and
expose health endpoints.

## Product boundaries (locked 2026-10-20)

| Decision | Rule |
| --- | --- |
| **No separate China region** | Launch is Cloudflare **global** (US/EU PoPs as CF routes them). There is no CN-specific Worker, compose profile, latency SLO, or catalog region promise. The catalog `region` field may exist for future upstream accounts; it does not imply a Clash CN deployment. |
| **No cloud agent at launch** | The gateway is **model-only**. It proxies OpenAI/Anthropic-shaped model traffic and meters it. Cloud-hosted coding agents (`managed-runtime`, Supervisor-as-agent-host) are a separate product and must not block gateway work. Agents stay on the user's machine (ACP / local Host); only model calls go through the gateway. |
| **DeepSeek Flash-only** | Any DeepSeek model in the catalog or price book must be a **Flash** model code. Drafts that name other DeepSeek models are refused (`GATEWAY_CATALOG_MODEL_BLOCKED` / `GATEWAY_PRICE_MODEL_BLOCKED`). |
| **Staging only** | Deploy and incident drills use `wrangler deploy --env staging` / `make deploy-api-staging`. Do not run this runbook against production. |

## Billing model (product)

Documented in full in [gateway-price-book.md](gateway-price-book.md) and
[gateway-teams.md](gateway-teams.md). Summary operators need:

| Concept | Meaning |
| --- | --- |
| **Credits** | Unit of charge. Integer **micro-credits** in storage (1 credit = 1,000,000). The price book lists charged amounts only — no markup % field. |
| **套餐 (subscription packages)** | Recurring package rows (`gateway_package`) that grant credits per period onto the tenant wallet. |
| **加量包 (top-up packs)** | One-off credit packs (`gateway_topup_pack`); a purchase posts a ledger `topup`. |
| **Tenant wallet** | The `tenant`-scope `gateway_budget`. Purchases raise its limit; usage raises spend. Balance ≈ `limit − spent − reserved`. No automatic overage: empty wallet → `402 GATEWAY_BUDGET_EXCEEDED`. |
| **Owner allocation** | The team **owner** allocates member (`user`) and key budgets under the wallet, plus rate limits. Members draw on wallet + their budgets together. Admin console is read-only for those allocations; corrections use `wallet/adjust`. |
| **Settlement shape** | Media/AIGC: prepay exact + refund on failure. Text/LLM: postpay with a credit floor on **hard** admission only; charge bills full actual (see settle design / #399). Ledger kinds (current): `settle`/`debit`/`charge`, `refund`, `adjust`, `grant`, `topup`, `expire`. Legacy `hold`/`release` rows may still exist from the retired reserve path (migration 0042 released them). |

There is no payment-provider integration in-repo: owners record purchases;
platform staff correct wallets with audited `adjust` rows.

## Retention policy

| Data | Kept | Notes |
| --- | --- | --- |
| Usage **metadata** (ledger upstream ids, error codes, ended tokens, retention markers) | **30 days** | Then NULLed or deleted by the metadata retention job (job may still be pending; see schema doc). |
| Prompt / response **bodies** | **30 days** when `GATEWAY_STAFF_PROMPT_ACCESS=enabled` (staging); **0** when the flag is unset (OSS / self-host default) | User decision 2026-10-20 **overrides** the earlier "0 body" default for hosted staging. Bodies live in R2; D1 holds metadata only. Headers (credentials) are never stored. |
| **Ledger** money rows and `gateway_admin_audit` | **13 months** | Audit triggers refuse `UPDATE` and early `DELETE`. |

Purge of expired bodies: Worker `scheduled` + `POST /api/v1/admin/gateway/retention/purge`. Details:
[gateway-admin.md](gateway-admin.md#staff-prompt-access-and-body-retention),
[gateway-schema.md](gateway-schema.md#retention).

## Runbook: rotate upstream keys (staging)

Upstream secrets are write-only (`secret_ref` to a Worker secret name, or a
sealed envelope under `GATEWAY_ENCRYPTION_KEY`). Responses and audit rows
never carry plaintext keys.

1. Confirm you are on **staging** (`wrangler secret` / admin session against
   the staging origin only).
2. Add the new secret value:
   - Prefer a new Worker secret name (`GATEWAY_UPSTREAM_*`) and point
     `secret_ref` at it, **or**
   - Use `POST /api/v1/admin/gateway/upstreams/:id/rotate` with the new key
     material (admin session). Rotation bumps `key_version` and stamps
     `rotated_at`; audit writes a redacted before/after.
3. Leave the previous secret live for a short dual-key window so in-flight
   requests that already selected the old version can finish.
4. Disable or delete the old Worker secret only after:
   - in-flight requests that selected the old `key_version` have finished
     (dual-key window; there is no hold/sweeper path under N2), and
   - staging smoke (`/gateway/v1/chat/completions` or Anthropic messages)
     succeeds on a Flash-allowed model.
5. If upstream returns 401/403 after rotation, the data plane maps to
   `502 UPSTREAM_AUTH_FAILED` and does not charge — fix the secret, do not
   blindly retry the client POST.

UI: `/admin/upstreams`. API table: [gateway-admin.md](gateway-admin.md).

## Runbook: suspend abuse (staging)

1. Open `/admin/abuse` (`abuse.read`) for live rate-window / in-flight
   counters. Denied-request event history may still be `events.available:
   false` until #356 lands full signal storage.
2. **Suspend a budget** (wallet, member, or key):
   - Owner path: team settings budget `status: suspended`.
   - Platform path: `POST .../wallet/status` (or budget status) with
     `suspended` — audited; suspended budgets refuse every request with
     `402 GATEWAY_BUDGET_EXCEEDED`.
3. **Disable an upstream account** (`enabled: false`) if the abuse is
   credential leakage toward a provider — routing skips it.
4. **Revoke keys / tokens** as needed (`gateway_key` revoke, token revoke)
   so new `sk_gw_` traffic stops immediately.
5. Record the reason in the admin mutation (audit row). Reactivate only
   after the owner confirms and counters look sane.

## Runbook: drain / rollback (staging Workers)

Workers do not have a long-lived process drain like Node nodes. Staging
procedure:

### Drain-ish (stop new work before a bad deploy)

1. Optionally disable risky upstreams or suspend a canary tenant wallet so
   new billable traffic fails closed.
2. Wait for in-flight requests on that tenant to finish (text postpay charges
   and media settle/refund Durable Runs). There is no hold sweeper under N2 —
   recovery is the settle journal / Durable Run retry (#399), not a stale-hold
   job.
3. Deploy the known-good version (below).

### Deploy / rollback staging

```bash
# Deploy current tree to staging only
make deploy-api-staging
# or: wrangler deploy --env staging

# Rollback: redeploy the previous known-good commit to staging
git checkout <known-good-sha>
make deploy-api-staging
git checkout -
```

Rules:

- Migrations are expand/contract; rollback of **code** must stay compatible
  with the schema already applied on staging D1 for one release.
- Never run `wrangler deploy` without `--env staging` from this runbook.
- After rollback, re-check `/api/v1/admin/gateway/overview`, a smoke
  chat completion, and wallet / budget health in the admin console
  (`reserved_micro_credits` should stay 0; N2 has no open holds).

## Incident quick links

| Symptom | First check |
| --- | --- |
| `402 GATEWAY_BUDGET_EXCEEDED` spike | Wallet / member / key suspended or empty; `/admin/budgets` |
| `502 UPSTREAM_AUTH_FAILED` | Recent key rotation; upstream `enabled`; Worker secret name |
| `429` with `Retry-After` | Live counters on `/admin/abuse`; owner rate limits |
| Suspected wallet / spend drift | Prefer settle journal / Durable Run recovery (#399); then audited `wallet/adjust` — never rewrite historical `settle`/`charge`/`debit` rows. Hold/sweeper language is historical (pre-N2). |
| Retention view 410 | Body past 30 days or purge already ran |

## Out of scope here

- Production deploys and production secret rotation.
- Node self-host PG base backup / WAL / object-store restore (#384).
- Nightly upstream invoice / AI Gateway reconcile as a product path (dropped; use charge-once ledger + Durable settle recovery / #399, and manual audited `adjust` when needed).
