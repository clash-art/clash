CREATE TABLE project_resource (
  project_id text NOT NULL,
  resource_id text NOT NULL,
  resource jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, resource_id)
);
