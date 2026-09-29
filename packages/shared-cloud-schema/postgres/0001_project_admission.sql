-- Initial PostgreSQL admission slice. Apply once through the deployment migration runner.
-- Auth, billing, resource storage and collaboration runtime are separate migrations/adapters.
CREATE TABLE tenant (
  id text PRIMARY KEY, owner_user_id text NOT NULL, name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE tenant_member (
  tenant_id text NOT NULL, user_id text NOT NULL, role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE project (
  id text PRIMARY KEY, owner_id text NOT NULL, tenant_id text, name text NOT NULL,
  description text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE project_cloud_admission (
  project_id text NOT NULL, tenant_id text NOT NULL, user_id text NOT NULL,
  local_replica_id text NOT NULL, sync_base_url text NOT NULL, status text NOT NULL,
  capabilities_json text NOT NULL, admitted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, last_error text,
  PRIMARY KEY (project_id, local_replica_id)
);
CREATE INDEX project_tenant_idx ON project(tenant_id, updated_at);
CREATE INDEX tenant_member_user_idx ON tenant_member(user_id, updated_at);
CREATE INDEX project_cloud_admission_status_idx ON project_cloud_admission(status, updated_at);
