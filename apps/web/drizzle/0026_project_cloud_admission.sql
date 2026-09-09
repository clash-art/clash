-- Project-level cloud admission is deliberately separate from Loro state.
-- No foreign keys: Better Auth and local replicas may use different identity stores.
CREATE TABLE IF NOT EXISTS tenant (
  id text PRIMARY KEY NOT NULL,
  owner_user_id text NOT NULL,
  name text NOT NULL,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS tenant_member (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL,
  created_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (tenant_id, user_id)
);

ALTER TABLE project ADD COLUMN tenant_id text;

CREATE TABLE IF NOT EXISTS project_cloud_admission (
  project_id text NOT NULL,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  local_replica_id text NOT NULL,
  sync_base_url text NOT NULL,
  status text NOT NULL,
  capabilities_json text NOT NULL,
  admitted_at integer,
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  last_error text,
  PRIMARY KEY (project_id, local_replica_id)
);

CREATE INDEX IF NOT EXISTS tenant_member_user_idx
  ON tenant_member(user_id, updated_at);
CREATE INDEX IF NOT EXISTS project_tenant_idx
  ON project(tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS project_cloud_admission_status_idx
  ON project_cloud_admission(status, updated_at);
CREATE INDEX IF NOT EXISTS project_cloud_admission_project_idx
  ON project_cloud_admission(project_id, updated_at);
