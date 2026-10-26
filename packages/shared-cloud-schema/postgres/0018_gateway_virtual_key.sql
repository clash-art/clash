-- Gateway virtual keys for the Node self-host data plane (#367).
-- `sk_gw_<24 hex>.<64 hex>`: only the SHA-256 of the whole token is stored.
-- The row is the identity: tenant, user, model allowlist and credential
-- scope come from here, never from a request header. Unix seconds; no FKs.
CREATE TABLE gateway_virtual_key (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  label text,
  model_allowlist jsonb,
  credential_scope text NOT NULL DEFAULT 'official'
    CHECK (credential_scope IN ('official', 'tenant')),
  expires_at bigint,
  revoked_at bigint,
  created_at bigint NOT NULL
);
CREATE INDEX gateway_virtual_key_tenant_idx ON gateway_virtual_key (tenant_id, user_id);
