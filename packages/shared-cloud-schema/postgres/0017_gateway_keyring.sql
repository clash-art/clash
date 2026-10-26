-- Gateway encryption key ring + credential scope + admin audit (#366).
--
-- Key material never lives here: the ring (key id -> secret) is deployment
-- configuration (GATEWAY_ENCRYPTION_KEYS). Postgres holds which key id is
-- current (gateway_config key 'encryption.current', versioned) so the next
-- request on every node seals under it, and an append-only admin audit.

-- Official (platform) and tenant (BYOK) credentials never mix: an official
-- row is global (tenant_key ''), a tenant row always names its tenant.
ALTER TABLE gateway_upstream_credential
  ADD CONSTRAINT gateway_upstream_credential_scope_tenant_chk
  CHECK ((scope = 'official' AND tenant_key = '') OR (scope = 'tenant' AND tenant_key <> ''));

-- Append-only record of admin mutations on the Node gateway (rotation, ...).
-- Snapshots are redacted by the writer; never key material or plaintext.
CREATE TABLE gateway_admin_audit (
  id text PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT '',
  actor_kind text NOT NULL CHECK (actor_kind IN ('admin', 'user', 'bootstrap', 'migration')),
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  before_json jsonb,
  after_json jsonb,
  created_at bigint NOT NULL
);
CREATE INDEX gateway_admin_audit_target_idx
  ON gateway_admin_audit (target_type, target_id, created_at);

CREATE FUNCTION gateway_admin_audit_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'gateway_admin_audit is append-only';
END;
$$;
CREATE TRIGGER gateway_admin_audit_no_update
  BEFORE UPDATE OR DELETE ON gateway_admin_audit
  FOR EACH ROW EXECUTE FUNCTION gateway_admin_audit_append_only();
