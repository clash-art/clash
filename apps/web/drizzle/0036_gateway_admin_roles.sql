-- Admin console roles and append-only audit (#353). Guide:
-- apps/docs/guide/gateway-admin.md. Drizzle mirror:
-- packages/shared-cloud-schema/src/gateway.ts. No foreign keys (AGENTS.md).
--
-- Tenant roles stay in tenant_member.role (owner, admin, finance, support,
-- viewer; 'member' has no admin permission). Platform staff hold a separate
-- grant here, never a tenant role, so a tenant role can never reach another
-- tenant. The first platform_admin is bootstrapped explicitly with
-- apps/api-cf/scripts/gateway-platform-admin.ts (local or staging only); there
-- is no environment-variable grant.

CREATE TABLE IF NOT EXISTS gateway_platform_role (
  user_id text NOT NULL,
  role text NOT NULL,
  -- NULL for the bootstrap grant.
  granted_by_user_id text,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (user_id, role),
  CHECK (role IN ('platform_admin'))
);

-- gateway_admin_audit is append-only: no row is ever updated, and a row may
-- only be deleted by the retention job once it is past the 13-month retention
-- (396 days). Both are enforced here as well as by the absence of any API.
CREATE TRIGGER IF NOT EXISTS gateway_admin_audit_no_update
BEFORE UPDATE ON gateway_admin_audit
BEGIN
  SELECT RAISE(ABORT, 'gateway_admin_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS gateway_admin_audit_retention_delete
BEFORE DELETE ON gateway_admin_audit
WHEN OLD.occurred_at > CAST(strftime('%s', 'now') AS INTEGER) - 34214400
BEGIN
  SELECT RAISE(ABORT, 'gateway_admin_audit rows are kept for 13 months');
END;

CREATE INDEX IF NOT EXISTS gateway_admin_audit_time_idx
  ON gateway_admin_audit(occurred_at);
