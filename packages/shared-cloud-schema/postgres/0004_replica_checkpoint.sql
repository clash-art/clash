CREATE TABLE project_replica_checkpoint (
  project_id text PRIMARY KEY,
  cursor bigint NOT NULL CHECK (cursor >= 0),
  snapshot_bytes bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
