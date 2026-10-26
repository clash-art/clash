-- BYOK vs official credential priority (#369, product decision N12): user
-- configurable, never hardcoded. One row per tenant (user_id = '') and
-- optionally per member (user_id set); the member row wins over the tenant
-- row. No row: the credential's own scope only (no cross-scope fallback).
-- A request is planned in the first listed scope that has a route and every
-- attempt stays in that scope. Unix seconds; no FKs.
CREATE TABLE gateway_credential_priority (
  tenant_id text NOT NULL,
  user_id text NOT NULL DEFAULT '',
  priority text NOT NULL
    CHECK (priority IN ('official_only', 'tenant_only', 'official_first', 'tenant_first')),
  updated_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
