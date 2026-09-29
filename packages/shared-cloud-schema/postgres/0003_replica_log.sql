-- Internal replication infrastructure. Authorize and validate Loro at the transport boundary.
-- Per-project transactional heads establish committed replay order without sequence gaps.
CREATE TABLE project_replica_head (
  project_id text PRIMARY KEY,
  cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0)
);
CREATE TABLE project_replica_event (
  project_id text NOT NULL,
  cursor bigint NOT NULL CHECK (cursor > 0),
  event_id text NOT NULL,
  update_bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, cursor),
  UNIQUE (project_id, event_id)
);
-- Delivered notifications may be removed; the event log remains replayable.
CREATE TABLE project_replica_outbox (
  project_id text NOT NULL,
  cursor bigint NOT NULL,
  lease_id text,
  lease_until timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, cursor)
);
CREATE INDEX project_replica_outbox_available_idx
  ON project_replica_outbox(lease_until, project_id, cursor);
