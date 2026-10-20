-- Parent credential of a short-lived gateway token (#346). Guide:
-- apps/docs/guide/gateway-tokens.md. Drizzle mirror:
-- packages/shared-cloud-schema/src/gateway.ts.
--
-- A token minted from a Better Auth session or a clsh_ API token records which
-- one: 'session' -> sessions.id, 'api_token' -> api_token.id. Renewal requires
-- the same parent, verification fails once the parent is gone, and sign-out
-- revokes every token of the session. Tokens minted from a virtual key use
-- key_id instead and leave these NULL. No foreign keys (AGENTS.md).

ALTER TABLE gateway_token ADD COLUMN parent_kind text
  CHECK (parent_kind IS NULL OR parent_kind IN ('session', 'api_token'));
ALTER TABLE gateway_token ADD COLUMN parent_id text;

CREATE INDEX IF NOT EXISTS gateway_token_parent_idx
  ON gateway_token(parent_kind, parent_id);
