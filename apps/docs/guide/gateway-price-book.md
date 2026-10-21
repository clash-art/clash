# Gateway Price Book and Credits

The Clash official model gateway charges usage in **credits** from a
configurable price book, and funds tenant wallets with **subscription
packages** and **top-up packs** (#352). Amounts are integer micro-credits
(1 credit = 1,000,000). The tables are described in
[gateway-schema.md](gateway-schema.md); the request flow in
[gateway-data-plane.md](gateway-data-plane.md).

The control-plane API below backs the `/admin` console's *Models & prices*
and *Packages* pages ([gateway-admin.md](gateway-admin.md)).

## Who may call it

Identity is the user the `/api/*` middleware verified (Better Auth session or
`clsh_` token). Caller headers such as `x-user-id` are never identity.
Authorization is the shared admin permission matrix described in
[gateway-admin.md](gateway-admin.md), with roles stored in D1:

- **Platform admin** (`gateway_platform_role`): the price book, packages,
  top-up packs and billing rollover, and purchases for any tenant. This is a
  platform grant, not a tenant role, and is never granted by a Worker
  variable.
- **Team roles** (`tenant_member.role`, `owner` or `member`): the owner holds
  `billing.read` (reads the tenant's billing summary) and `billing.purchase`
  (records purchases for that tenant only); a member holds neither.

Anyone else gets `GATEWAY_FORBIDDEN` (403). A request with no credential gets
`GATEWAY_AUTH_REQUIRED` (401).

## Price book

A **version** is a set of credit rates that share one effective window. A rate
is `(modelCode, upstreamId, unit) → amountMicroCredits per per units`. An empty
`upstreamId` applies the rate to every upstream of the model. The units are
`GATEWAY_PRICE_UNITS` in `@clash/gateway-core`.

| Step    | Rule                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Draft   | `PUT` replaces the whole draft in one batch. A draft has `published_at IS NULL` (0035), and the data plane never charges it.                                                       |
| Publish | One statement stamps every row of the version. A version never takes effect before it is published: if its `effectiveFrom` is already past, it moves to the publish instant.        |
| After   | A published row never changes. To change a price, publish a new version.                                                                                                            |

For each request, the data plane picks the newest published version that is
effective at the moment the request was **admitted** and that prices the route.
A newer version replaces an older one. Within a version, a rate for the exact
upstream wins over a model-wide rate. A failover attempt is priced as of the
same admission instant, so a version published while a request is running
never applies to that request.

Old usage is never repriced. Every `settle` ledger row records the
`price_version` it was charged under, and publishing writes only
`gateway_price`.

The price book holds only the charged amount. It has no markup or percentage
field. Following the catalog policy, DeepSeek is priced through Flash models
only: a rate whose model code or upstream names DeepSeek must use a Flash model
code, or the draft is refused with `GATEWAY_PRICE_MODEL_BLOCKED`.

## Wallet, packages and top-up packs

The tenant wallet is the tenant's `tenant`-scope `gateway_budget`. For a team
tenant, this is the team wallet. Credits raise the wallet's limit and usage
raises its spend, so the balance is `limit − spent − reserved`. A purchase
creates the wallet, at a zero limit, if it does not exist yet. A wallet that
is explicitly unlimited (`NULL` limit) or periodic (`period ≠ 'none'`) cannot
hold credits, and the purchase is refused with `GATEWAY_WALLET_INCOMPATIBLE`.

Purchases fund only the wallet. Member (`user`) and key budgets that the owner
allocated are left unchanged. A member's requests draw on the wallet and on the
member's own budget together. There is no automatic overage: when the wallet
is empty, requests fail with `GATEWAY_BUDGET_EXCEEDED`.

There is no payment provider. A platform admin, or the team owner
(`billing.purchase`), records the purchase, and the credits are
posted immediately:

| Ledger kind | Written by                       | Effect on the wallet limit                                                                   |
| ----------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| `topup`     | buying a top-up pack             | `+ pack credits`. Top-up credits do not expire.                                               |
| `grant`     | subscribing, then each new period | `+ package credits per period`                                                               |
| `expire`    | closing a period (rollover)      | `− the part of that period's grant the period did not consume`                                |

Grant credits for a period are consumed before any other credits in the
wallet. When a period closes, the expired amount is
`min(grant − spend settled on the wallet in the period, current balance)`.
The expiry therefore never removes top-up credits, and never removes credits
that back an open hold.

### Idempotency and atomicity

Every purchase takes a client `idempotencyKey`. Repeating a purchase with the
same key returns the original purchase (`200`, `replayed: true`). Using the
same key for a different pack or package fails with
`GATEWAY_IDEMPOTENCY_CONFLICT`. The ledger `request_id` is the idempotency
anchor:

- `topup:<tenant>:<key>` for a top-up;
- `grant:<subscription>:<period start>` for a grant;
- `expire:<subscription>:<period start>` for an expiry.

The ledger's unique `(request_id, budget_id, kind)` makes a duplicate entry
impossible.

Each operation is a single D1 batch. The ledger entry, the wallet change, the
subscription change and the `gateway_admin_audit` row are written together,
or none of them is.

### Subscriptions and periods

A tenant has at most one live (`active`) subscription. Its periods are UTC
calendar months or years, anchored at the moment of subscribing. A short month
clamps the day: Jan 31 → Feb 28 → Mar 31. The package's `rateLimit` is copied
onto the subscription, and the limits port enforces it per tenant.

Periods are closed by the **rollover** endpoint. It is an explicit, idempotent
function, and nothing runs it in the background, so a scheduler can call it
later.

- For every live subscription whose period has ended, rollover expires the
  unused grant and grants the next period.
- A canceled subscription ends with `status = 'expired'` instead of receiving
  a new grant.
- Each closed period is compare-and-set on the subscription's period start, so
  a repeated or concurrent call does nothing more.
- A subscription that is several periods behind is caught up, up to 24
  periods per call.

Rollover reports an outcome for each subscription. A period close that failed
carries its error code and is retried by the next call.

## Endpoints

Platform admin, `/api/v1/admin/gateway`:

| Method and path                         | Purpose                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /prices`                           | Versions, newest effective first. Optional `?modelCode=` and `?status=draft\|published`.  |
| `GET /prices/versions/:version`         | One version.                                                                                 |
| `PUT /prices/versions/:version`         | Create or replace a draft: `{ effectiveFrom, effectiveTo?, rates[] }`.                       |
| `POST /prices/versions/:version/publish` | Publish a draft.                                                                            |
| `GET /packages`, `POST /packages`       | List packages, or create one: `{ name, billingPeriod, priceMinor, priceCurrency, periodMicroCredits, rateLimit? }`. |
| `POST /packages/:id/archive`            | Stop new subscriptions. Live subscriptions keep renewing.                                    |
| `GET /topup-packs`, `POST /topup-packs` | List packs, or create one: `{ name, priceMinor, priceCurrency, microCredits }`.              |
| `POST /topup-packs/:id/archive`         | Stop new purchases of the pack.                                                              |
| `POST /billing/rollover`                | Close ended periods: `{ tenantId? }`.                                                        |

`priceMinor` is an integer in minor units of the ISO 4217 `priceCurrency`. It
is the list price of the package or pack. The credits it buys are given
separately, in micro-credits.

`billing.read` / `billing.purchase` (or platform admin),
`/api/v1/gateway/tenants/:tenantId`:

| Method and path              | Purpose                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| `GET /billing`               | The wallet, the live subscription, and the newest credit entries.        |
| `POST /subscription`         | Subscribe: `{ packageId, idempotencyKey }`. Grants the first period.      |
| `POST /subscription/cancel`  | End the subscription at its current period end. Repeating it is a no-op. |
| `POST /topups`               | Buy a pack: `{ packId, idempotencyKey }`.                                 |

## Error codes

Errors use the gateway's OpenAI error shape plus `x-clash-error-code`.

| Condition                                                          | Code                                            |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| No credential / the caller's roles lack the permission             | `GATEWAY_AUTH_REQUIRED` 401 / `GATEWAY_FORBIDDEN` 403 |
| Malformed body, parameter, unit, amount or duplicate rate          | `GATEWAY_INVALID_REQUEST` 400                   |
| DeepSeek rate that is not Flash                                    | `GATEWAY_PRICE_MODEL_BLOCKED` 400               |
| Empty window, or publishing a version whose window has ended       | `GATEWAY_PRICE_WINDOW_INVALID` 400              |
| Unknown version / changing or re-publishing a published version    | `GATEWAY_PRICE_VERSION_NOT_FOUND` 404 / `GATEWAY_PRICE_VERSION_PUBLISHED` 409 |
| Unknown or archived package / pack                                 | `GATEWAY_PACKAGE_NOT_FOUND`, `GATEWAY_TOPUP_PACK_NOT_FOUND` 404; `…_ARCHIVED` 409 |
| Unknown tenant                                                     | `GATEWAY_TENANT_NOT_FOUND` 404                  |
| Second live subscription / no live subscription to cancel          | `GATEWAY_SUBSCRIPTION_EXISTS` 409 / `GATEWAY_SUBSCRIPTION_NOT_FOUND` 404 |
| Same idempotency key, different item                               | `GATEWAY_IDEMPOTENCY_CONFLICT` 409              |
| Unlimited or periodic wallet                                       | `GATEWAY_WALLET_INCOMPATIBLE` 409               |
| A concurrent change won the batch                                  | `GATEWAY_CONFLICT` 409 (read again and retry)   |

## Tests

- `packages/gateway-core/src/billing.test.ts`: periods, expiry arithmetic and
  draft policy.
- `apps/api-cf/src/gateway/d1-billing.test.ts`: the D1 adapters on
  node:sqlite, including no repricing through the real data plane.
- `apps/api-cf/src/routes/v1/admin/gateway.test.ts`: platform-only and
  tenant-role enforcement, and the coded errors.
- `apps/api-cf/src/integration/gateway-price-book.integration.test.ts`: the
  publish → request → settle path in workerd.
