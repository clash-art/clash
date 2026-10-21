-- Team roles are owner and member only (#392). Guide:
-- apps/docs/guide/gateway-admin.md. Drizzle mirror:
-- packages/shared-cloud-schema/src/app.ts. No foreign keys (AGENTS.md).
--
-- The only platform role stays gateway_platform_role 'platform_admin' (0036).
-- Every other team role a row may hold from earlier releases becomes
-- 'member': it keeps gateway access and loses console permissions. Re-running
-- this file changes nothing.
--
-- SQLite cannot add a CHECK to an existing table, so triggers refuse any
-- other role on insert and update, like a CHECK would.

UPDATE tenant_member
   SET role = 'member', updated_at = CAST(strftime('%s', 'now') AS INTEGER)
 WHERE role NOT IN ('owner', 'member');

UPDATE tenant_invite
   SET role = 'member', updated_at = CAST(strftime('%s', 'now') AS INTEGER)
 WHERE role NOT IN ('owner', 'member');

CREATE TRIGGER IF NOT EXISTS tenant_member_role_insert_check
BEFORE INSERT ON tenant_member
WHEN NEW.role NOT IN ('owner', 'member')
BEGIN
  SELECT RAISE(ABORT, 'tenant_member.role must be owner or member');
END;

CREATE TRIGGER IF NOT EXISTS tenant_member_role_update_check
BEFORE UPDATE OF role ON tenant_member
WHEN NEW.role NOT IN ('owner', 'member')
BEGIN
  SELECT RAISE(ABORT, 'tenant_member.role must be owner or member');
END;

CREATE TRIGGER IF NOT EXISTS tenant_invite_role_insert_check
BEFORE INSERT ON tenant_invite
WHEN NEW.role NOT IN ('owner', 'member')
BEGIN
  SELECT RAISE(ABORT, 'tenant_invite.role must be owner or member');
END;

CREATE TRIGGER IF NOT EXISTS tenant_invite_role_update_check
BEFORE UPDATE OF role ON tenant_invite
WHEN NEW.role NOT IN ('owner', 'member')
BEGIN
  SELECT RAISE(ABORT, 'tenant_invite.role must be owner or member');
END;
