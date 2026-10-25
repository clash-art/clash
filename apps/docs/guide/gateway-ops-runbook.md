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

Self-host (Node + Postgres) backup/restore and LB tuning are covered by
Epic B issues #376 (SSE LB) and #384 (backup/restore); they are not part of
this cloud runbook.

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
| **Settlement shape** | Media/AIGC: prepay exact + refund on failure. Text/LLM: postpay with a credit floor (see settle design / #399). Ledger kinds: `hold`, `settle`, `release`, `refund`, `adjust`, `grant`, `topup`, `expire`. |

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
   - no open holds reference the old `key_version`, and
   - staging smoke (`/gateway/v1/chat/completions` or Anthropic messages)
     succeeds on a Flash-allowed model.
5. If upstream returns 401/403 after rotation, the data plane maps to
   `502 UPSTREAM_AUTH_FAILED` and does not charge — fix the secret, do not
   "retry POST" from an LB.

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

## Runbook: reconcile ledger (staging)

Nightly / on-demand checks (D1; same invariants as gateway-core):

```sql
-- Open + settle_failed holds must match budget.reserved_micro_credits
-- (illustrative; run via staging D1 / wrangler d1 execute --env staging)
SELECT b.id AS budget_id,
       b.reserved_micro_credits AS budget_reserved,
       COALESCE(h.hold_sum, 0) AS hold_sum
  FROM gateway_budget b
  LEFT JOIN (
    SELECT budget_id, SUM(amount_micro_credits) AS hold_sum
      FROM gateway_usage_ledger
     WHERE kind = 'hold' AND status IN ('open', 'settle_failed')
     GROUP BY budget_id
  ) h ON h.budget_id = b.id
 WHERE b.reserved_micro_credits <> COALESCE(h.hold_sum, 0);

-- Usage budgets: spent should equal sum of settle amounts
SELECT b.id AS budget_id,
       b.spent_micro_credits AS budget_spent,
       COALESCE(s.settle_sum, 0) AS settle_sum
  FROM gateway_budget b
  LEFT JOIN (
    SELECT budget_id, SUM(amount_micro_credits) AS settle_sum
      FROM gateway_usage_ledger
     WHERE kind = 'settle'
     GROUP BY budget_id
  ) s ON s.budget_id = b.id
 WHERE b.spent_micro_credits <> COALESCE(s.settle_sum, 0);
```

If drift is real (not a race with an in-flight hold):

1. Prefer the **stale-hold sweeper** / settle recovery path so open holds
   expire or settle through normal code (`gateway-data-plane.md`).
2. Only then post a platform `wallet/adjust` (`adjust` ledger kind) with a
   clear `reason` and a unique idempotency key — one correction per key.
3. Never rewrite historical `settle` rows; append `adjust` / `refund`.

Column names follow the D1 schema in [gateway-schema.md](gateway-schema.md).
If a query errors because a column was renamed in a later migration, update
this runbook — do not invent alternate money units.

## Runbook: drain / rollback (staging Workers)

Workers do not have a long-lived process drain like Node nodes. Staging
procedure:

### Drain-ish (stop new work before a bad deploy)

1. Optionally disable risky upstreams or suspend a canary tenant wallet so
   new billable traffic fails closed.
2. Wait for open holds on that tenant to settle or expire (sweeper).
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
  chat completion, and the ledger invariant queries above.

## Incident quick links

| Symptom | First check |
| --- | --- |
| `402 GATEWAY_BUDGET_EXCEEDED` spike | Wallet / member / key suspended or empty; `/admin/budgets` |
| `502 UPSTREAM_AUTH_FAILED` | Recent key rotation; upstream `enabled`; Worker secret name |
| `429` with `Retry-After` | Live counters on `/admin/abuse`; owner rate limits |
| Ledger drift | Invariant SQL above; sweeper; then audited `adjust` |
| Retention view 410 | Body past 30 days or purge already ran |

## Out of scope here

- Production deploys and production secret rotation.
- Node self-host PG base backup / WAL / object-store restore (#384).
- nginx / Caddy / Traefik SSE load balancing (#376).
