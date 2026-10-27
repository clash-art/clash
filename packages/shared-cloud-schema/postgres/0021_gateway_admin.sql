-- Gateway admin API credentials for the Node admin listener (#371).
--
-- Admins are not product users (#394): an admin token is its own identity,
-- never a Better Auth session, clsh_ or sk_gw_ token. `gwa_<24 hex>.<64 hex>`;
-- only the SHA-256 of the whole token is stored, the prefix is for display.
--
-- Single platform admin role (trimmed #371 AC): no tenant_admin / viewer /
-- support matrix. Team owner/member stay in the product. Permissions live in
-- apps/api-node/src/gateway-admin-authz.ts.
--
-- Conventions as 0016: no foreign keys, unix seconds.
CREATE TABLE gateway_admin_token (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  role text NOT NULL CHECK (role = 'platform_admin'),
  label text,
  created_by text NOT NULL,
  expires_at bigint,
  revoked_at bigint,
  created_at bigint NOT NULL
);
CREATE INDEX gateway_admin_token_live_idx
  ON gateway_admin_token (role) WHERE revoked_at IS NULL;
